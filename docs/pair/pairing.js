// Transient drops recover via ICE restart, not a fresh pair flow. Only a
// hard failure (channel closed and ICE restart didn't recover within the
// grace window) counts as "disconnected, rescan QR".
//
// Signal protocol (hub broker, pair/<room>/s/<peer> — broker-signal.js):
//   send   { type: "signal", peer: myPeerId, data: { offer|answer|ice } }
//   recv   { type: "state",  peers: { peerId: lastSignal } }  // retained replay
//          { type: "signal", peer: theirPeerId, data: {...} }
//
// Phone is OFFERER (joins second), desktop is ANSWERER. peerId = role +
// "-" + nonce so a stale tab doesn't collide with a fresh session under a
// fixed role key. The retained-message replay recovers signals sent before
// late-joiners arrive; applied only when we're not already on a healthy
// connection.
//
// LAN-only MEDIA by design: no ICE servers, no TURN — host/mDNS candidates
// carry the connection, so both peers must be on the same network.
//
// Signaling is a separate question and may leave the LAN: broker-signal.js
// picks the hub broker or a public one by what the page's origin can open.
// That widens WHERE THE PAGE CAN BE SERVED FROM, never where the phone can
// be — a phone on LTE still has no media path.
//
// ── Who is authenticated, and by what ───────────────────────────────────
// Read this before touching iceServers.
//
// The QR's &pk= authenticates the DESKTOP TO THE PHONE: scanning in person
// is the trust act (mobile.js stores it before WebRTC starts).
//
// The PHONE TO THE DESKTOP is authenticated by &s=, the room secret (room-
// mac.js). The desktop mints it, delivers it only through the QR or the
// signed lobby accept — channels a broker eavesdropper can't read — and drops
// any signal that doesn't carry a matching HMAC. So a stranger who reads the
// room off the public rendezvous can't inject an offer: no secret, no MAC.
//
// Two lines still hold this shut, and both matter:
//   1. &s= — above. Without it the desktop applied whatever offer arrived.
//   2. THE EMPTY iceServers BELOW. Defence in depth: even a signal that
//      somehow passed the MAC check has no media path to a host/mDNS-only
//      peer from off-LAN. This is why the MAC is not a license to add TURN —
//      the two guards are independent, and dropping this one alone would put
//      full weight on &s= against an attacker who has, by then, the room id.
//
// So adding STUN/TURN here — the obvious "finally fix cross-network pairing"
// move — is a security change, not a connectivity tweak. Only do it with &s=
// enforcement intact and its replay gap (room-mac.js) closed first.
import { openSignalChannel, getSignalRendezvous } from "./broker-signal.js";
import { newRoomSecret, wrapSignalChannel } from "./room-mac.js";
const DISCONNECT_GRACE_MS = 10000;  // Transient ICE `disconnected` can recover on its own.
// Backpressure: DataChannel.bufferedAmount grows unbounded if we outrun the
// peer. Text/joypad traffic is tiny so we rarely get near this; the queue is
// insurance for whoever later ships camera frames or audio chunks over the
// same channel. Queue drops oldest at QUEUE_MAX so a wedged receiver doesn't
// OOM the sender.
const BACKPRESSURE_HIGH = 1_000_000;
const BACKPRESSURE_LOW  =   200_000;
const QUEUE_MAX = 1000;
// 30s is for ICE negotiation specifically — the post-offer handshake between
// desktop and phone. We deliberately do NOT time the pre-offer wait (user
// picking up phone, unlocking, scanning the QR) because that easily exceeds
// 30s for normal humans and isn't a real failure. Pre-offer wait stays open
// as long as the dialog is — cleanup happens on dialog close.
const ICE_TIMEOUT_MS = 30000;

import { parseCandidate, probeNetwork } from "../net-probe.js";

// Per-attempt diagnostic capture: every local + remote ICE candidate this
// side has seen during the most recent pair attempt. The Diagnostics
// dialog reads this via lastPairDiagnostic() — candidate sets reveal
// whether STUN succeeded, both sides gathered, etc., which is usually
// what answers "why did the pair fail." Resets per host/joinPairingRoom call.
//
// `_pc` holds the active RTCPeerConnection so lastPairDiagnostic() can
// pull a live pc.getStats() snapshot — same data chrome://webrtc-internals
// shows (candidate-pair states, transport, certificates, dataChannel),
// without the privileged-page hop. Snapshot is async; the getter returns
// a Promise that DevTools console auto-awaits.
const _diag = { local: [], remote: [], iceServers: [], role: null, roomId: null, startedAt: 0, _pc: null };
function diagReset(role, roomId, iceServers) {
  _diag.local = [];
  _diag.remote = [];
  _diag.iceServers = (iceServers || []).map((s) => ({ urls: s.urls }));
  _diag.role = role;
  _diag.roomId = roomId;
  _diag.startedAt = Date.now();
  _diag._pc = null;
}
function diagLocal(c)  { const p = parseCandidate(c); if (p) _diag.local.push(p); }
function diagRemote(c) { const p = parseCandidate(c); if (p) _diag.remote.push(p); }
function diagPc(pc)    { _diag._pc = pc; }

export async function getPairDiagnostic() {
  const { _pc, ...base } = _diag;
  const out = { ...base };
  if (_pc) {
    try {
      const report = await _pc.getStats();
      const stats = [];
      report.forEach((s) => stats.push(s));
      out.stats = stats;
      // Pull the current ICE/conn/signaling/dtls state up to top-level
      // so the answer to "what happened?" is one glance, not a stats grep.
      out.state = {
        iceConnection: _pc.iceConnectionState,
        connection: _pc.connectionState,
        signaling: _pc.signalingState,
        iceGathering: _pc.iceGatheringState,
      };
    } catch (err) {
      out.statsError = err.message || String(err);
    }
  }
  return out;
}

if (typeof window !== "undefined") {
  window.lastPairDiagnostic = getPairDiagnostic;
}
function makePeerId(role) {
  return role + "-" + Math.random().toString(36).slice(2, 8);
}

// State snapshots can carry stale entries from prior sessions. Apply only
// semantic-describe (offer/answer); ICE candidates tied to a dead pc would
// be rejected anyway. Filter to the opposite role's prefix so our own stale
// entries from a previous tab don't echo back into this session.
function extractFromState(peers, selfPeerId, otherRolePrefix) {
  const out = [];
  for (const k of Object.keys(peers || {})) {
    if (k === selfPeerId) continue;
    if (!k.startsWith(otherRolePrefix + "-")) continue;
    const d = peers[k];
    if (d && (d.offer || d.answer)) out.push(d);
  }
  return out;
}

// JSON-framed data channel wrapper with a multi-state status channel
// (connecting / connected / reconnecting / failed) for UI.
class Peer {
  constructor({ pc, channel, ws, myPeerId, otherRolePrefix, roomId, secret }) {
    this._pc = pc;
    this._channel = channel;
    this._ws = ws;
    this._myPeerId = myPeerId;
    this._otherRolePrefix = otherRolePrefix;
    // roomId lets us reopen the signaling WS when iOS backgrounds the tab
    // and silently kills it — we rejoin the same room instead of a fresh pair.
    this._roomId = roomId;
    // Same room secret, so a reopened channel keeps MAC'ing its signals.
    this._secret = secret;
    this._onMessage = () => {};
    this._onStatus = () => {};
    this._onClose = () => {};
    this._status = "connected";
    this._graceTimer = null;
    this._sendQueue = [];
    this._reopening = false;
    this._visibilityHandler = null;

    channel.bufferedAmountLowThreshold = BACKPRESSURE_LOW;
    channel.addEventListener("bufferedamountlow", () => this._drainQueue());
    channel.addEventListener("message", (e) => {
      try { this._onMessage(JSON.parse(e.data)); } catch { /* drop malformed */ }
    });
    channel.addEventListener("close", () => {
      // Data channel gone is terminal — can't recover without rebuilding PC.
      this._setStatus("failed", "Data channel closed");
      this._finalClose();
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") {
        if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
        this._setStatus("connected");
      } else if (s === "disconnected") {
        // Often recovers on its own (e.g. phone tab re-foregrounded). Wait.
        this._setStatus("reconnecting", "Connection dropped, waiting…");
        if (!this._graceTimer) {
          this._graceTimer = setTimeout(() => {
            this._graceTimer = null;
            if (pc.iceConnectionState === "disconnected") {
              // Still stuck — ask WebRTC to rebuild the path.
              this._attemptIceRestart();
            }
          }, DISCONNECT_GRACE_MS);
        }
      } else if (s === "failed") {
        this._setStatus("reconnecting", "Restarting connection…");
        this._attemptIceRestart();
      }
    });

    // Media-track plumbing. Either side may addTrack; negotiationneeded
    // fires, _renegotiate offers, the other side answers via the existing
    // _applySignal offer handler (which rolls back if it catches itself
    // mid-negotiation). Glare is bounded by _negotiating + signalingState
    // guards. Not full Perfect Negotiation but sufficient for sequential
    // addTrack flows (the common case: one side shares, the other receives).
    this._onTrack = null;
    this._pendingTracks = [];
    this._negotiating = false;
    // Buffer track events that arrive before the consumer wires onTrack —
    // happens when desktop initiates a renegotiation immediately after the
    // channel opens, before mobile.js has its handlers attached.
    pc.addEventListener("track", (e) => {
      if (this._onTrack) { try { this._onTrack(e); } catch {} }
      else this._pendingTracks.push(e);
    });
    pc.addEventListener("negotiationneeded", () => this._renegotiate());

    this._installSignalHandlers();
    this._installVisibilityRecovery();
  }

  async _renegotiate() {
    // Either role may initiate a media-add renegotiation. The _negotiating
    // flag + stable-signalingState check keep us from offering on top of
    // an in-flight negotiation; _applySignal's rollback handles the rare
    // glare case where both sides offer simultaneously.
    if (this._negotiating) return;
    if (this._pc.signalingState !== "stable") return;
    this._negotiating = true;
    try {
      const offer = await this._pc.createOffer();
      await this._pc.setLocalDescription(offer);
      this._ws.send(JSON.stringify({ type: "signal", peer: this._myPeerId, data: { offer } }));
    } catch (err) {
      console.warn("[pair] renegotiate failed", err);
    } finally {
      this._negotiating = false;
    }
  }

  _setStatus(status, detail) {
    if (this._status === status) return;
    this._status = status;
    try { this._onStatus(status, detail); } catch {}
  }

  _isConnected() {
    const s = this._pc.iceConnectionState;
    return s === "connected" || s === "completed";
  }

  // Only the phone (offerer) initiates an ICE restart. Desktop sits and waits
  // for the fresh offer — its existing signal handler will set the remote
  // description and answer, same as initial negotiation.
  async _attemptIceRestart() {
    if (!this._myPeerId.startsWith("phone-")) return;
    try {
      this._pc.restartIce();
      const offer = await this._pc.createOffer({ iceRestart: true });
      await this._pc.setLocalDescription(offer);
      this._ws.send(JSON.stringify({ type: "signal", peer: this._myPeerId, data: { offer } }));
    } catch (err) {
      // If restart itself fails, mark failed and let the caller rebuild.
      this._setStatus("failed", `Restart failed: ${err.message || err}`);
      this._finalClose();
    }
  }

  // Signals after data channel is up — subsequent offer/answer rounds for
  // ICE restart, and late-arriving ICE candidates. Handles `state` too for
  // the case where a visibility-recovery WS reopen picks up an offer that
  // arrived while we were backgrounded.
  _installSignalHandlers() {
    this._ws.addEventListener("message", async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "signal") {
        if (msg.peer === this._myPeerId) return;
        await this._applySignal(msg.data);
      } else if (msg.type === "state") {
        // Healthy connection → skip. Replaying an old offer on a working pc
        // would tear it down. We only want state during initial connect and
        // during active reconnect.
        if (this._isConnected()) return;
        for (const d of extractFromState(msg.peers, this._myPeerId, this._otherRolePrefix)) {
          await this._applySignal(d);
        }
      }
    });
  }

  async _applySignal(data) {
    if (!data) return;
    try {
      if (data.offer) {
        // If we're mid-negotiation (phone sent a rapid-fire ICE-restart
        // before our prior answer made it through), rollback to stable so
        // setRemoteDescription doesn't InvalidStateError. Safe on already-
        // stable pc; try/catch because rollback on "stable" itself throws
        // on some UAs.
        if (this._pc.signalingState !== "stable") {
          try { await this._pc.setLocalDescription({ type: "rollback" }); } catch {}
        }
        await this._pc.setRemoteDescription(data.offer);
        const answer = await this._pc.createAnswer();
        await this._pc.setLocalDescription(answer);
        this._ws.send(JSON.stringify({ type: "signal", peer: this._myPeerId, data: { answer } }));
      }
      if (data.answer) await this._pc.setRemoteDescription(data.answer);
      if (data.ice)    { diagRemote(data.ice); try { await this._pc.addIceCandidate(data.ice); } catch {} }
    } catch {}
  }

  // iOS Safari kills idle WebSockets when the tab backgrounds; even a 20s
  // heartbeat can't save it. When the tab comes back, the data channel may
  // still negotiate but the signal WS is gone, so any ICE restart we try
  // sends into the void. Rejoin the same room first, rewire handlers, then
  // kick an ICE restart — gets us from "frozen" to recovered in ~1s instead
  // of waiting for the eventual ICE failure timeout.
  _installVisibilityRecovery() {
    if (typeof document === "undefined") return;
    this._visibilityHandler = () => {
      if (document.visibilityState !== "visible") return;
      const s = this._ws.readyState;
      if (s === WebSocket.OPEN || s === WebSocket.CONNECTING) return;
      if (this._reopening) return;
      this._reopenSignal();
    };
    document.addEventListener("visibilitychange", this._visibilityHandler);
  }

  _reopenSignal() {
    this._reopening = true;
    this._setStatus("reconnecting", "Signal channel dropped, reopening…");
    const newWs = openSignalWs(this._roomId, this._myPeerId, this._secret);
    newWs.addEventListener("open", () => {
      const oldWs = this._ws;
      this._ws = newWs;
      this._installSignalHandlers();
      // ICE-trickle handler on the PC uses this._ws via the closure in
      // wireIceTrickle — old handler still exists but its captured ws is
      // closed, so its send() guard (readyState === OPEN) skips. Harmless
      // extra listener; avoids an awkward removeEventListener dance.
      wireIceTrickle(this._pc, this._ws, this._myPeerId);
      try { oldWs.close(); } catch {}
      this._reopening = false;
      this._attemptIceRestart();
    });
    newWs.addEventListener("error", () => {
      this._reopening = false;
      this._setStatus("failed", "Signal reconnect failed");
      this._finalClose();
    });
  }

  _drainQueue() {
    while (this._sendQueue.length > 0
           && this._channel.readyState === "open"
           && this._channel.bufferedAmount < BACKPRESSURE_HIGH) {
      try { this._channel.send(this._sendQueue.shift()); } catch { break; }
    }
  }

  _finalClose() {
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
    if (this._visibilityHandler) {
      document.removeEventListener("visibilitychange", this._visibilityHandler);
      this._visibilityHandler = null;
    }
    try { this._ws.close(); } catch {}
    try { this._onClose(); } catch {}
  }

  send(obj) {
    if (this._channel.readyState !== "open") return;
    const payload = JSON.stringify(obj);
    // Queue if we're above the high-water mark OR the queue is already
    // draining — draining in order matters, so never jump the line.
    if (this._channel.bufferedAmount > BACKPRESSURE_HIGH || this._sendQueue.length > 0) {
      if (this._sendQueue.length >= QUEUE_MAX) this._sendQueue.shift();
      this._sendQueue.push(payload);
      return;
    }
    try { this._channel.send(payload); } catch {}
  }
  onMessage(cb) { this._onMessage = cb; }
  onStatus(cb)  { this._onStatus = cb; try { cb(this._status); } catch {} }  // fire initial
  onClose(cb)   { this._onClose = cb; }
  onTrack(cb)   {
    this._onTrack = cb;
    if (this._pendingTracks.length) {
      const queued = this._pendingTracks;
      this._pendingTracks = [];
      for (const e of queued) { try { cb(e); } catch {} }
    }
  }
  // addTrack returns the RTCRtpSender so caller can later removeTrack(sender).
  // Triggers negotiationneeded → _renegotiate. Caller does not await.
  addTrack(track, stream) {
    if (this._pc.signalingState === "closed") return null;
    return this._pc.addTrack(track, stream);
  }
  removeTrack(sender) {
    if (!sender || this._pc.signalingState === "closed") return;
    try { this._pc.removeTrack(sender); } catch {}
  }
  close() {
    this._setStatus("failed", "Closed by caller");
    this._finalClose();
    try { this._channel.close(); } catch {}
    try { this._pc.close(); } catch {}
  }
}

function openSignalWs(roomId, myPeerId, secret) {
  return wrapSignalChannel(openSignalChannel(roomId, myPeerId), { roomId, myPeerId, secret });
}

function wireIceTrickle(pc, ws, myPeerId) {
  pc.addEventListener("icecandidate", (e) => {
    if (e.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "signal", peer: myPeerId, data: { ice: e.candidate } }));
    }
  });
}

// Desktop: opens the room, waits for the phone's offer, answers.
// Returns { roomId, waitForPeer: () => Promise<Peer>, cancel() }.
// onStatus fires at pre-Peer stages ("phone connected, negotiating…",
// "establishing channel…") so the pair dialog can show distinct states
// instead of a frozen "waiting for phone" when something's silently wedged.
export async function hostPairingRoom({ onStatus = () => {} } = {}) {
  const roomId = crypto.randomUUID();
  // Minted here, by the side that owns the room, and handed to the phone only
  // through the QR or the signed lobby accept — both channels a stranger on
  // the broker can't read. A signal without a matching MAC is dropped, so this
  // is what authenticates the phone TO the desktop. The caller must deliver it
  // (phones.js puts it in the QR and the accept payload).
  const secret = newRoomSecret();
  const myPeerId = makePeerId("desktop");
  const otherRolePrefix = "phone";
  // LAN-only: host/mDNS candidates. Load-bearing for security, not just
  // scope — with a public rendezvous, the room secret + this empty ICE list
  // are the two things standing between a broker eavesdropper and a hijack.
  // See "Who is authenticated" in the module header before adding anything.
  const iceServers = [];
  diagReset("desktop", roomId, iceServers);
  const pc = new RTCPeerConnection({ iceServers });
  diagPc(pc);
  pc.addEventListener("icecandidate", (e) => { if (e.candidate) diagLocal(e.candidate); });
  const ws = openSignalWs(roomId, myPeerId, secret);
  wireIceTrickle(pc, ws, myPeerId);
  let resolvePeer, rejectPeer;
  const peerPromise = new Promise((res, rej) => { resolvePeer = res; rejectPeer = rej; });
  let resolved = false;
  const pendingIce = [];

  // ICE timer — armed only when the phone's offer arrives (in applySignal).
  // Until then the room is just a WebSocket waiting; no time pressure.
  let timeoutId = null;
  const armIceTimeout = () => {
    if (timeoutId) return;
    timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch {}
      try { pc.close(); } catch {}
      rejectPeer(new Error("Phone connected but couldn't establish a peer-to-peer link within 30s. Network may be blocking WebRTC."));
    }, ICE_TIMEOUT_MS);
  };


  pc.addEventListener("datachannel", (e) => {
    try { onStatus("Phone connected, establishing channel…"); } catch {}
    e.channel.addEventListener("open", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      resolvePeer(new Peer({ pc, channel: e.channel, ws, myPeerId, otherRolePrefix, roomId, secret }));
    });
  });

  const applySignal = async (data) => {
    if (!data) return;
    if (data.offer) {
      try { onStatus("Phone connected, negotiating…"); } catch {}
      armIceTimeout();
      await pc.setRemoteDescription(data.offer);
      for (const c of pendingIce) { try { await pc.addIceCandidate(c); } catch {} }
      pendingIce.length = 0;
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: "signal", peer: myPeerId, data: { answer } }));
    }
    if (data.ice) {
      diagRemote(data.ice);
      if (pc.remoteDescription) { try { await pc.addIceCandidate(data.ice); } catch {} }
      else pendingIce.push(data.ice);
    }
  };

  ws.addEventListener("message", async (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "signal") {
      if (msg.peer === myPeerId) return;
      // Accept signals from phone-prefixed peers OR, defensively, anything
      // not prefixed with our own role — tolerates legacy clients on older
      // code until both sides have updated.
      if (msg.peer && msg.peer.startsWith("desktop-")) return;
      await applySignal(msg.data);
    } else if (msg.type === "state") {
      // Pre-Peer state: only apply if phone already dropped a signal before
      // we arrived. Ignore our own role's stale entries.
      for (const d of extractFromState(msg.peers, myPeerId, otherRolePrefix)) {
        await applySignal(d);
      }
    }
  });

  ws.addEventListener("error", () => {
    if (!resolved) {
      resolved = true;
      clearTimeout(timeoutId);
      pc.close();
      const { url, public: isPublic } = getSignalRendezvous();
      rejectPeer(new Error(
        `Couldn't reach the pairing rendezvous (${url}). ` +
        (isPublic
          ? "This page signals over a public broker — check this machine is online."
          : "Pairing signals over the hub — check ?hub=<host> is right and both devices are on the hub's network."),
      ));
    }
  });

  return {
    roomId,
    secret,   // caller embeds this in the QR + lobby accept; see hostPairingRoom
    waitForPeer: () => peerPromise,
    cancel: () => { clearTimeout(timeoutId); ws.close(); pc.close(); },
  };
}

// Phone: joins the room, creates data channel + offer on WS open, processes answer.
// onStatus fires at each negotiation stage ("opening signal channel…",
// "offer sent, waiting…", etc.) so mobile.js can surface exactly where the
// pair is — instead of a single "connecting…" blob that hides every stall.
export async function joinPairingRoom(roomId, { onStatus = () => {}, secret = null } = {}) {
  const myPeerId = makePeerId("phone");
  const otherRolePrefix = "desktop";
  try { onStatus("Opening signal channel…"); } catch {}
  // LAN-only: host/mDNS candidates. Load-bearing for security, not just
  // scope — with a public rendezvous, the room secret + this empty ICE list
  // are the two things standing between a broker eavesdropper and a hijack.
  // See "Who is authenticated" in the module header before adding anything.
  const iceServers = [];
  diagReset("phone", roomId, iceServers);
  const pc = new RTCPeerConnection({ iceServers });
  diagPc(pc);
  pc.addEventListener("icecandidate", (e) => { if (e.candidate) diagLocal(e.candidate); });
  const channel = pc.createDataChannel("pip");
  const ws = openSignalWs(roomId, myPeerId, secret);
  wireIceTrickle(pc, ws, myPeerId);

  pc.addEventListener("iceconnectionstatechange", () => {
    const s = pc.iceConnectionState;
    if (s === "checking") { try { onStatus("Finding network path…"); } catch {} }
    else if (s === "connected" || s === "completed") { try { onStatus("Network path ready, opening channel…"); } catch {} }
  });

  return new Promise((resolve, reject) => {
    let resolved = false;
    let timeoutId;
    const pendingIce = [];
    const fail = (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      try { ws.close(); } catch {}
      try { pc.close(); } catch {}
      reject(err);
    };

    // Phone-side ICE timer — page is already loaded by the time we get here,
    // so this measures negotiation only (no human reaction time included).
    timeoutId = setTimeout(() => {
      fail(new Error("Couldn't reach the desktop within 30s — try refreshing the QR there."));
    }, ICE_TIMEOUT_MS);

    channel.addEventListener("open", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      resolve(new Peer({ pc, channel, ws, myPeerId, otherRolePrefix, roomId, secret }));
    });

    const applySignal = async (data) => {
      if (!data) return;
      if (data.answer) {
        try { onStatus("Desktop answered. Negotiating…"); } catch {}
        await pc.setRemoteDescription(data.answer);
        for (const c of pendingIce) { try { await pc.addIceCandidate(c); } catch {} }
        pendingIce.length = 0;
      }
      if (data.ice) {
        diagRemote(data.ice);
        if (pc.remoteDescription) { try { await pc.addIceCandidate(data.ice); } catch {} }
        else pendingIce.push(data.ice);
      }
    };

    ws.addEventListener("open", async () => {
      try {
        try { onStatus("Signal channel open. Creating offer…"); } catch {}
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: "signal", peer: myPeerId, data: { offer } }));
        try { onStatus("Offer sent. Waiting for desktop…"); } catch {}
      } catch (err) { fail(err); }
    });

    ws.addEventListener("message", async (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "signal") {
        if (msg.peer === myPeerId) return;
        if (msg.peer && msg.peer.startsWith("phone-")) return;
        await applySignal(msg.data);
      } else if (msg.type === "state") {
        for (const d of extractFromState(msg.peers, myPeerId, otherRolePrefix)) {
          await applySignal(d);
        }
      }
    });

    ws.addEventListener("error", () => {
      const { url, public: isPublic } = getSignalRendezvous();
      fail(new Error(`Couldn't reach the pairing rendezvous (${url}). ` +
        (isPublic ? "Is this phone online?" : "Is this phone on the hub's Wi-Fi?")));
    });
    pc.addEventListener("connectionstatechange", () => {
      // Only fail the INITIAL connect this way; once Peer is constructed,
      // its own iceconnectionstatechange handler owns lifecycle.
      if (!resolved && pc.connectionState === "failed") fail(new Error("Couldn't reach the desktop's network. Check both devices are online."));
    });
  });
}
