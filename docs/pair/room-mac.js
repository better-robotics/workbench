// Per-room shared secret + signal MAC (HMAC-SHA256).
//
// Why this exists: the QR's &pk= authenticates the DESKTOP TO THE PHONE, and
// nothing authenticated the phone to the desktop — hostPairingRoom applied
// whatever offer arrived, so the room's secrecy was the only thing keeping a
// stranger out. The public rendezvous (broker-signal.js) spends that secrecy
// by putting room ids on a world-readable broker. This puts a real boundary
// back: no valid MAC, no offer.
//
// The secret only ever travels on channels that already carry trust — the QR
// a human scans in person, or the lobby's signed, pubkey-targeted accept
// payload (pair-request.js). Both funnel into the same #pair=<room>&s=<secret>
// hash, so mobile.js has one parse site. Someone reading every byte on the
// broker still cannot forge a signal.
//
// What this does NOT stop: replay. A MAC is not a nonce, so a captured offer
// can be re-published verbatim. That stays a nuisance rather than a takeover —
// replayed SDP carries the original peer's DTLS fingerprint, so the replayer's
// handshake can't complete. Closing that needs a nonce or a counter, and the
// hijack was the line that mattered.
import { canonical, b64urlEncode, b64urlDecode } from "./peer-key.js";

// 128 bits. It rides in a QR beside a pubkey and only has to survive the
// seconds a one-shot room is open.
export function newRoomSecret() {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

// importKey per signal would dominate the cost of signing one small object.
const _keys = new Map();
async function keyFor(secret) {
  if (!secret) throw new Error("room-mac: no room secret");
  let k = _keys.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey(
      "raw", b64urlDecode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
    );
    _keys.set(secret, k);
  }
  return k;
}

// roomId and peer are inside the MAC, not just the payload: without roomId a
// captured signal replays into another room, and without peer an attacker
// re-attributes a captured signal to a peer id of their choosing.
function macBytes(roomId, peer, payload) {
  return new TextEncoder().encode(canonical({ r: roomId, p: peer, v: payload }));
}

// { v: payload, m: mac }. The wrapper lives INSIDE the signal's `data` so
// broker-signal.js's retained→state rewrite carries it through untouched —
// that facade treats `data` as opaque.
export async function macWrap(secret, roomId, peer, payload) {
  // Deliberately no unsigned fallback. A caller without a secret is a bug,
  // and quietly emitting an unMAC'd signal would reopen the exact hole this
  // module closes — better a throw at the send site.
  const sig = await crypto.subtle.sign("HMAC", await keyFor(secret), macBytes(roomId, peer, payload));
  return { v: payload, m: b64urlEncode(sig) };
}

// Returns the payload, or null if this didn't come from someone holding the
// secret. Callers MUST treat null as "drop it".
export async function macOpen(secret, roomId, peer, data) {
  if (!secret || !data || typeof data !== "object" || !data.v || !data.m) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC", await keyFor(secret), b64urlDecode(data.m), macBytes(roomId, peer, data.v),
    );
    return ok ? data.v : null;
  } catch {
    return null;
  }
}

// Decorate a signal channel (broker-signal.js's facade) so pairing.js sees
// plaintext payloads while only MAC'd bytes cross the wire. The seam is here,
// not at pairing.js's six send sites, because ICE restart and media
// renegotiation keep signaling after the channel is up — every send and every
// receive has to be covered, forever, not just the initial handshake.
//
// Same shape as the inner facade (send / close / readyState /
// addEventListener open|message|error|close), so openSignalChannel and this
// are interchangeable. When secret is falsy this returns inner untouched.
//
// Compatibility is asymmetric, by design:
//   - new phone + OLD desktop → the old desktop's QR carries no &s=, so the
//     phone's secret is null, the wrapper no-ops, bytes are exactly as before.
//     Fine — an old desktop has no secret to check anyway.
//   - new desktop + OLD phone → BREAKS: the desktop always mints a secret and
//     drops unMAC'd signals, the stale phone never sends one. Accepted: both
//     ends ship from one deploy and sw.js bumps its cache version every
//     deploy, so the skew is one failed pair on a stale PWA, then it updates.
//   The alternative — a desktop that accepts unMAC'd "for compatibility" — is
//   not a boundary at all, since an attacker would just omit the MAC.
export function wrapSignalChannel(inner, { roomId, myPeerId, secret }) {
  if (!secret) return inner;
  const listeners = { open: [], message: [], error: [], close: [] };
  const fire = (t, ev) => { for (const fn of listeners[t]) { try { fn(ev); } catch {} } };

  inner.addEventListener("open", (e) => fire("open", e));
  inner.addEventListener("error", (e) => fire("error", e));
  inner.addEventListener("close", (e) => fire("close", e));
  inner.addEventListener("message", async (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "signal") {
      if (!msg.peer) return;
      const payload = await macOpen(secret, roomId, msg.peer, msg.data);
      if (!payload) return;   // forged, replayed into another room, or legacy — drop
      fire("message", { data: JSON.stringify({ ...msg, data: payload }) });
    } else if (msg.type === "state") {
      // Retained-replay snapshot: each peer's value is independently MAC'd.
      const peers = {};
      for (const [peer, wrapped] of Object.entries(msg.peers || {})) {
        const payload = await macOpen(secret, roomId, peer, wrapped);
        if (payload) peers[peer] = payload;
      }
      fire("message", { data: JSON.stringify({ type: "state", peers }) });
    } else {
      fire("message", e);
    }
  });

  // HMAC-sign is a microtask, so two back-to-back sends could resolve out of
  // order (an offer's trailing ICE overtaking the offer). Chain them.
  let tail = Promise.resolve();
  return {
    get readyState() { return inner.readyState; },
    addEventListener(t, fn) { listeners[t]?.push(fn); },
    close() { return inner.close(); },
    send(str) {
      let msg; try { msg = JSON.parse(str); } catch { return; }
      if (msg.type !== "signal" || !msg.peer) { inner.send(str); return; }
      tail = tail.then(async () => {
        const wrapped = await macWrap(secret, roomId, msg.peer, msg.data);
        inner.send(JSON.stringify({ ...msg, data: wrapped }));
      }).catch(() => {});
    },
  };
}
