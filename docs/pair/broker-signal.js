// WebRTC signaling for phone↔desktop pairing: <prefix>pair/<roomId>/s/<peerId>,
// retained. Two rendezvous, picked by what the page's origin is allowed to open:
//
//   http-served  → the hub broker, ws://<host>:9001. No prefix: that topic
//                  space is better-robotics/hub CONTRACT.md § pair, and the
//                  namespace IS the contract.
//   https-served → a public MQTT broker over wss. A https page cannot open
//                  ws:// at all (mixed content), and with the hub broker as
//                  the only rendezvous that severed pairing on the deployed
//                  site — the one URL the README hands users.
//
// The peers never negotiate which: the QR is built from the desktop's own
// origin (phones.js — new URL("phone.html", location.href)), so the phone
// resolves the same scheme from the same origin and lands on the same broker.
// &hub= carries WHICH hub, never the scheme.
//
// A rendezvous is a phone book, not a data path — SDP and ICE, nothing else.
// The pair path still has no ICE servers (webrtc/ice.js owns TURN for the
// robot↔desktop paths), so media rides host/mDNS candidates and both devices
// must share a network. Internet signaling does NOT bring back the phone-on-
// LTE case; it brings back pairing from a https page for two devices on one
// wifi.
//
// openSignalChannel(roomId, myPeerId) returns a WebSocket-shaped facade —
// send / close / readyState / addEventListener("open"|"message"|"error"|
// "close") — so pairing.js's ws call sites work unchanged. Semantics mapping:
//   - {type:"signal"} sends → retained publish on the sender's peer topic.
//     Retention IS the old server's `state` snapshot: a (re)joining peer
//     receives each peer's last signal on subscribe, which the facade
//     delivers wrapped as {type:"state", peers:{...}} so pairing.js keeps
//     its already-connected guard against stale-offer replay.
//   - {type:"ping"} heartbeats are dropped — the MQTT keepalive owns that.
//   - close() clears this side's retained topics; a pagehide handler calls it
//     when the tab goes away, and a retained empty-payload Last Will is the
//     backstop for a socket that dies with no close frame at all. A tab must
//     not strand SDP on a broker we don't own.
import { connectMqtt } from "../hub/mqtt.js";
import { WS_PORT } from "../protocol-constants.js";

// EMQX's open broker speaks MQTT 3.1.1 over wss on 8084 under the 'mqtt'
// subprotocol connectMqtt already sends. It is explicitly a test broker: no
// SLA, and every message on it is world-readable.
const PUBLIC_RENDEZVOUS = "wss://broker.emqx.io:8084/mqtt";
// Namespaced so we neither collide with strangers on the shared broker nor
// leave litter nobody can attribute. Collision-avoidance and hygiene, NOT
// privacy: anyone may subscribe <prefix>#, so a reader learns room ids,
// pubkeys, SDP, and timing.
//
// Be precise about why that is survivable, because it is NOT "the ECDSA
// ceremony covers it" — that authenticates the desktop to the phone, never
// the phone to the desktop. A reader of this broker CAN join a room; what
// stops them is that the pair path has no ICE servers, so an off-LAN peer
// has no media path. Read "Who is authenticated" in pairing.js before
// treating this fallback as safe, and before touching iceServers there.
const PUBLIC_PREFIX = "better-robotics/";

// Can this page open the hub's plain-ws listener at all? A https page can't
// (mixed content). Feature-detected — the WebSocket constructor throws
// synchronously when blocked — rather than protocol-sniffed, so Chrome's
// per-site "Insecure content: Allow" override still passes (DEV.md
// serving-context matrix).
//
// Signaling answers "no" by switching rendezvous, so pairing works either
// way. The always-on presence lobby (broker-lobby.js) has no such escape and
// gates on this instead — see the note there for why it must not follow.
let _blocked = null;
export function lanBrokerBlocked() {
  if (_blocked === null) {
    if (location.protocol !== "https:") {
      _blocked = false;
    } else {
      try { new WebSocket("ws://mixed-content-probe.invalid").close(); _blocked = false; }
      catch { _blocked = true; }
    }
  }
  return _blocked;
}

let _host = null;
export function setSignalBrokerHost(host) { _host = host || null; }
export function getSignalBrokerHost() {
  if (_host) return _host;
  const q = new URLSearchParams(location.search).get("hub");
  if (q) return q;
  const h = new URLSearchParams(location.hash.replace(/^#/, "")).get("hub");
  return h || "hub.local";
}

// ?sig=<wss-url> / #sig=<wss-url> — override for the public rendezvous, the
// escape hatch for a broker outage: the hardcoded PUBLIC_RENDEZVOUS is a
// no-SLA test broker, and when it's down the deployed site can't pair with no
// other recourse. Post one ?sig= link and a room recovers. Read live from the
// URL (search first, then hash) so it reaches the phone through the QR the
// same way &hub= does — no setter, no build step.
//
// wss:// only, and only on the blocked (https) branch: a ws:// override from a
// https page is mixed-content-blocked anyway, and on the http branch ?hub=
// already selects the broker. Anything else is ignored — a bad override falls
// back to the default rather than silently wedging pairing.
function getSigOverride() {
  const raw = new URLSearchParams(location.search).get("sig")
    || new URLSearchParams(location.hash.replace(/^#/, "")).get("sig");
  if (raw && /^wss:\/\//i.test(raw)) return raw;
  if (raw) console.warn(`[pair] ignoring ?sig= override (not wss://): ${raw}`);
  return null;
}
export function hasSigOverride() { return getSigOverride() !== null; }

// The rendezvous this page will actually use. `public` is for callers that
// need to say so out loud (error copy); `prefix` is "" on the hub.
export function getSignalRendezvous() {
  return lanBrokerBlocked()
    ? { url: getSigOverride() || PUBLIC_RENDEZVOUS, prefix: PUBLIC_PREFIX, public: true }
    : { url: `ws://${getSignalBrokerHost()}:${WS_PORT}`, prefix: "", public: false };
}

export function openSignalChannel(roomId, myPeerId) {
  const { url, prefix } = getSignalRendezvous();
  const topicBase = `${prefix}pair/${roomId}/s/`;
  const listeners = { open: [], message: [], error: [], close: [] };
  const fire = (type, ev = {}) => { for (const fn of listeners[type]) { try { fn(ev); } catch {} } };
  const published = new Set();   // this side's retained topics, cleared on close
  let client = null;
  let closed = false;

  const facade = {
    readyState: WebSocket.CONNECTING,
    addEventListener(type, fn) { listeners[type]?.push(fn); },
    send(str) {
      if (!client || facade.readyState !== WebSocket.OPEN) return;
      let msg;
      try { msg = JSON.parse(str); } catch { return; }
      if (msg.type !== "signal" || !msg.peer) return;   // pings die here
      const topic = `${topicBase}${msg.peer}`;
      published.add(topic);
      client.publish(topic, str, { retain: true });
    },
    close() {
      closed = true;
      facade.readyState = WebSocket.CLOSED;
      window.removeEventListener("pagehide", onPageHide);
      if (client) {
        for (const t of published) { try { client.publish(t, "", { retain: true }); } catch {} }
        try { client.close(); } catch {}
        client = null;
      }
    },
  };

  // Closing the tab sends a normal WS close frame, and a broker is entitled
  // to read that as a graceful disconnect and drop the will — measured
  // against EMQX, which does exactly that. So the will alone would leave our
  // retained SDP behind on the single most common exit; clear it ourselves
  // while we still can. `persisted` = bfcache, where the page may yet come
  // back and pairing.js's reopen path should keep the room.
  const onPageHide = (e) => { if (!e.persisted) facade.close(); };
  window.addEventListener("pagehide", onPageHide);

  connectMqtt(url, {
    clientId: `pair-${roomId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`,
    // Last line of defence, not the first: the only topic we ever retain is
    // our own peer's, and this clears it if the socket dies with no close
    // frame at all (crash, kill, wifi drop). A clean close is the pagehide
    // handler's job — EMQX suppresses the will there. Unverified against a
    // real RST: a browser gives no way to fake one.
    will: myPeerId ? { topic: `${topicBase}${myPeerId}`, payload: "" } : null,
    onMessage(topic, payload, { retain } = {}) {
      if (!payload) return;                             // cleared retained topic
      if (!topic.startsWith(topicBase)) return;
      if (!retain) { fire("message", { data: payload }); return; }
      // Retained replay → state snapshot, so pairing.js applies it only
      // when not already on a healthy connection.
      let msg;
      try { msg = JSON.parse(payload); } catch { return; }
      if (msg.type !== "signal" || !msg.peer) return;
      fire("message", { data: JSON.stringify({ type: "state", peers: { [msg.peer]: msg.data } }) });
    },
    onClose() {
      if (closed) return;
      facade.readyState = WebSocket.CLOSED;
      fire("close", {});
    },
  }).then((c) => {
    if (closed) { try { c.close(); } catch {} return; }
    client = c;
    c.subscribe(`${topicBase}+`);
    facade.readyState = WebSocket.OPEN;
    fire("open", {});
  }).catch((err) => {
    facade.readyState = WebSocket.CLOSED;
    fire("error", { error: err });
  });

  return facade;
}
