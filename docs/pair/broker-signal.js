// WebRTC signaling over the hub broker (better-robotics/hub CONTRACT.md §
// pair): pair/<roomId>/s/<peerId>, retained. Replaces wss://signal.neevs.io.
//
// openSignalChannel(roomId) returns a WebSocket-shaped facade — send /
// close / readyState / addEventListener("open"|"message"|"error"|"close")
// — so pairing.js's ws call sites work unchanged. Semantics mapping:
//   - {type:"signal"} sends → retained publish on the sender's peer topic.
//     Retention IS the old server's `state` snapshot: a (re)joining peer
//     receives each peer's last signal on subscribe, which the facade
//     delivers wrapped as {type:"state", peers:{...}} so pairing.js keeps
//     its already-connected guard against stale-offer replay.
//   - {type:"ping"} heartbeats are dropped — the MQTT keepalive owns that.
//   - close() clears this side's retained topics (room hygiene; rooms are
//     one-shot UUIDs either way).
//
// Host resolution: explicit setSignalBrokerHost() (the phone sets it from
// the pair QR's &hub= param) → the page's ?hub=/#hub= param → "hub.local"
// (both hub shapes set that hostname). LAN-only by design: no TURN, no
// internet rendezvous — the pair ceremony (ECDSA P-256, peer-key.js)
// authenticates peers end-to-end, transport carries no trust.
import { connectMqtt } from "../hub/mqtt.js";

const WS_PORT = 9001;   // fixed convention — hub pi/mosquitto.example.conf

let _host = null;
export function setSignalBrokerHost(host) { _host = host || null; }
export function getSignalBrokerHost() {
  if (_host) return _host;
  const q = new URLSearchParams(location.search).get("hub");
  if (q) return q;
  const h = new URLSearchParams(location.hash.replace(/^#/, "")).get("hub");
  return h || "hub.local";
}

export function openSignalChannel(roomId) {
  const listeners = { open: [], message: [], error: [], close: [] };
  const fire = (type, ev = {}) => { for (const fn of listeners[type]) { try { fn(ev); } catch {} } };
  const published = new Set();   // this side's retained topics, cleared on close
  let client = null;
  let closed = false;

  const facade = {
    readyState: WebSocket.CONNECTING,
    addEventListener(type, fn) { listeners[type]?.push(fn); },
    removeEventListener(type, fn) {
      const a = listeners[type]; const i = a?.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    send(str) {
      if (!client || facade.readyState !== WebSocket.OPEN) return;
      let msg;
      try { msg = JSON.parse(str); } catch { return; }
      if (msg.type !== "signal" || !msg.peer) return;   // pings die here
      const topic = `pair/${roomId}/s/${msg.peer}`;
      published.add(topic);
      client.publish(topic, str, { retain: true });
    },
    close() {
      closed = true;
      facade.readyState = WebSocket.CLOSED;
      if (client) {
        for (const t of published) { try { client.publish(t, "", { retain: true }); } catch {} }
        try { client.close(); } catch {}
        client = null;
      }
    },
  };

  connectMqtt(`ws://${getSignalBrokerHost()}:${WS_PORT}`, {
    clientId: `pair-${roomId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`,
    onMessage(topic, payload, { retain } = {}) {
      if (!payload) return;                             // cleared retained topic
      if (!topic.startsWith(`pair/${roomId}/s/`)) return;
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
    c.subscribe(`pair/${roomId}/s/+`);
    facade.readyState = WebSocket.OPEN;
    fire("open", {});
  }).catch((err) => {
    facade.readyState = WebSocket.CLOSED;
    fire("error", { error: err });
  });

  return facade;
}
