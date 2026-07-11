// Discovery lobby over the hub broker: pair/lobby/<adId>, retained.
// Replaces the signal.neevs.io /discover lobby with the same client API
// (publish/remove/onChange/ads/close + signed mode), so pair-request.js
// and its consumers work unchanged. Scope changes from "everyone behind
// my NAT" to "everyone on this hub's broker" — strictly tighter, and the
// same trust rule holds: ads are hints; trust comes from the ECDSA P-256
// signatures and the consumer's trust store, never from the lobby.
//
// TTL: MQTT retention has none, so each ad carries a publisher timestamp
// and receivers drop ads past data-independent `ts + ttl` client-side.
// Publishers refresh their own ads on a timer and clear their retained
// topics on close; a crashed publisher's ad ages out of every client's
// view at ttl and only lingers as inert broker crud in an unguessable-id
// namespace.
import { connectMqtt } from "../hub/mqtt.js";
import { getMyPubkeyB64, signBytes, verifyBytes, canonical } from "./peer-key.js";
import { getSignalBrokerHost } from "./broker-signal.js";

const WS_PORT = 9001;
const REPUBLISH_MS = 25_000;
const SWEEP_MS = 5_000;
const DEFAULT_AD_TTL_MS = 60_000;
const RECONNECT_MS = 3_000;

// Same signed envelope as the retired discover.js: signature covers
// canonical({id, data, pubkey}); _pubkey/_sig ride inside data.
async function envelopeForPublish(id, data) {
  const pubkey = await getMyPubkeyB64();
  const bytes = new TextEncoder().encode(canonical({ id, data, pubkey }));
  const sig = await signBytes(bytes);
  return { ...data, _pubkey: pubkey, _sig: sig };
}

async function verifyAd(ad) {
  const data = ad && ad.data;
  if (!data || !data._sig || !data._pubkey) return false;
  const { _sig, _pubkey, ...rest } = data;
  const bytes = new TextEncoder().encode(canonical({ id: ad.id, data: rest, pubkey: _pubkey }));
  return verifyBytes(bytes, _sig, _pubkey);
}

class BrokerLobby {
  constructor({ sign = false, host = null } = {}) {
    this._sign = !!sign;
    this._host = host;
    this._client = null;
    this._closed = false;
    this._ads = new Map();            // id -> { id, data, expiresAt }
    this._verified = [];              // current ads() snapshot
    this._listeners = new Set();
    this._myAds = new Map();          // id -> { data, ttl }
    this._republishTimer = setInterval(() => this._republishMine(), REPUBLISH_MS);
    this._sweepTimer = setInterval(() => this._sweep(), SWEEP_MS);
    this._connect();
  }

  _connect() {
    if (this._closed) return;
    connectMqtt(`ws://${this._host || getSignalBrokerHost()}:${WS_PORT}`, {
      clientId: `lobby-${Math.random().toString(36).slice(2, 10)}`,
      onMessage: (topic, payload) => this._onAd(topic, payload),
      onClose: () => {
        this._client = null;
        if (!this._closed) setTimeout(() => this._connect(), RECONNECT_MS);
      },
    }).then((c) => {
      if (this._closed) { try { c.close(); } catch {} return; }
      this._client = c;
      c.subscribe("pair/lobby/+");
      this._republishMine();          // re-assert our ads after a reconnect
    }).catch(() => {
      if (!this._closed) setTimeout(() => this._connect(), RECONNECT_MS);
    });
  }

  async _onAd(topic, payload) {
    const id = topic.split("/").pop();
    if (!topic.startsWith("pair/lobby/")) return;
    if (!payload) { this._ads.delete(id); return this._recompute(); }
    let body;
    try { body = JSON.parse(payload); } catch { return; }
    const ttl = Number(body.ttl) || DEFAULT_AD_TTL_MS;
    const ts = Number(body.ts) || Date.now();
    if (ts + ttl < Date.now()) return;               // stale retained ad
    this._ads.set(id, { id, data: body.data, expiresAt: ts + ttl });
    this._recompute();
  }

  async _recompute() {
    let ads = [...this._ads.values()].filter((a) => a.expiresAt > Date.now());
    if (this._sign) {
      const checks = await Promise.all(ads.map(verifyAd));
      ads = ads.filter((_, i) => checks[i]);
    }
    this._verified = ads.map(({ id, data }) => ({ id, data }));
    for (const fn of this._listeners) { try { fn(this._verified); } catch {} }
  }

  _sweep() {
    const before = this._ads.size;
    for (const [id, ad] of this._ads) if (ad.expiresAt <= Date.now()) this._ads.delete(id);
    if (this._ads.size !== before) this._recompute();
  }

  async _sendPublish(id, data, ttl) {
    if (!this._client) return;
    let payload = data;
    if (this._sign) {
      try { payload = await envelopeForPublish(id, data); }
      catch { return; }                              // never send unsigned in signed mode
      if (!this._client) return;
    }
    this._client.publish(`pair/lobby/${id}`,
      JSON.stringify({ data: payload, ttl, ts: Date.now() }), { retain: true });
  }

  _republishMine() {
    for (const [id, { data, ttl }] of this._myAds) this._sendPublish(id, data, ttl);
  }

  // ── Public API (DiscoveryClient-compatible) ─────────────────────
  publish(id, data, ttlMs) {
    this._myAds.set(id, { data, ttl: ttlMs || DEFAULT_AD_TTL_MS });
    return this._sendPublish(id, data, ttlMs || DEFAULT_AD_TTL_MS);
  }
  remove(id) {
    this._myAds.delete(id);
    this._ads.delete(id);
    if (this._client) { try { this._client.publish(`pair/lobby/${id}`, "", { retain: true }); } catch {} }
    this._recompute();
  }
  onChange(cb) {
    this._listeners.add(cb);
    try { cb(this._verified); } catch {}
    return () => this._listeners.delete(cb);
  }
  ads() { return this._verified.slice(); }
  close() {
    this._closed = true;
    clearInterval(this._republishTimer);
    clearInterval(this._sweepTimer);
    if (this._client) {
      for (const id of this._myAds.keys()) {
        try { this._client.publish(`pair/lobby/${id}`, "", { retain: true }); } catch {}
      }
      try { this._client.close(); } catch {}
      this._client = null;
    }
    this._listeners.clear();
    this._myAds.clear();
    this._ads.clear();
  }
}

export function discover(opts) { return new BrokerLobby(opts); }
