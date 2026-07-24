// Minimal MQTT 3.1.1 client over WebSocket, QoS 0 only — exactly the subset
// the hub contract uses (sprocket-robotics/hub CONTRACT.md). Hand-rolled
// because the alternative is vendoring the ~300 KB mqtt.js bundle for
// four packet types; if this ever needs QoS>0, retained handling, or
// MQTT5 request/reply properties, vendor mqtt.js instead of growing this.
const enc = new TextEncoder();
const dec = new TextDecoder();

// Remaining-length varint (spec 2.2.3): 7 bits per byte, MSB = continuation.
function varint(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

// UTF-8 string field: u16 BE length prefix + bytes.
function mqttString(s) {
  const b = enc.encode(s);
  return [(b.length >> 8) & 0xff, b.length & 0xff, ...b];
}

function packet(typeAndFlags, body) {
  return Uint8Array.from([typeAndFlags, ...varint(body.length), ...body]);
}

// Resolves once CONNACK accepts; rejects on refusal, socket error, or close
// before connect. After that, failures surface through onClose.
// `will` = { topic, payload } publishes retained on an UNGRACEFUL exit (crash,
// kill, lost wifi) — the broker sends it for us. A retained empty payload
// clears a topic, so `{ topic, payload: "" }` is the crash-path twin of a
// close() that clears its own retained state. Omit it and the CONNECT bytes
// are byte-identical to before, which is what hub-transport.js still sends.
export function connectMqtt(url, {
  clientId, username, password, keepalive = 30, onMessage, onClose, will = null,
} = {}) {
  return new Promise((resolve, reject) => {
    // Mosquitto's WS listener requires the 'mqtt' subprotocol.
    const ws = new WebSocket(url, "mqtt");
    ws.binaryType = "arraybuffer";
    let settled = false;
    let pingTimer = null;
    let packetId = 1;
    let recvBuf = new Uint8Array(0);

    const api = {
      publish(topic, payload, { retain = false } = {}) {
        const bytes = typeof payload === "string" ? enc.encode(payload) : payload;
        ws.send(packet(0x30 | (retain ? 1 : 0), [...mqttString(topic), ...bytes]));
      },
      subscribe(filter) {
        const id = packetId++ & 0xffff || packetId++;
        ws.send(packet(0x82, [(id >> 8) & 0xff, id & 0xff, ...mqttString(filter), 0]));
      },
      close() {
        try { ws.send(Uint8Array.of(0xe0, 0)); } catch { /* already dead */ }
        ws.close();
      },
    };

    function fail(err) {
      if (!settled) { settled = true; reject(err); }
      api.close();
    }

    ws.onopen = () => {
      const flags = 0x02 /* clean session */
        | (will ? 0x04 | 0x20 : 0) /* will flag + will retain, will QoS 0 */
        | (username ? 0x80 : 0) | (password ? 0x40 : 0);
      ws.send(packet(0x10, [
        ...mqttString("MQTT"), 4 /* protocol level = 3.1.1 */, flags,
        (keepalive >> 8) & 0xff, keepalive & 0xff,
        // Payload field order is fixed by the spec: ClientId, Will Topic,
        // Will Message, Username, Password.
        ...mqttString(clientId || `workbench-${Math.random().toString(16).slice(2, 10)}`),
        ...(will ? [...mqttString(will.topic), ...mqttString(will.payload ?? "")] : []),
        ...(username ? mqttString(username) : []),
        ...(password ? mqttString(password) : []),
      ]));
    };

    ws.onerror = () => fail(new Error(`websocket error (${url})`));
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (!settled) { settled = true; reject(new Error(`closed before CONNACK (${url})`)); }
      else onClose?.();
    };

    // A WS frame may carry partial or multiple MQTT packets — buffer and
    // re-slice on every message.
    ws.onmessage = (ev) => {
      const chunk = new Uint8Array(ev.data);
      const merged = new Uint8Array(recvBuf.length + chunk.length);
      merged.set(recvBuf); merged.set(chunk, recvBuf.length);
      recvBuf = merged;
      for (;;) {
        if (recvBuf.length < 2) return;
        let remLen = 0, mult = 1, i = 1;
        for (;;) {
          if (i >= recvBuf.length) return;           // varint incomplete
          const b = recvBuf[i++];
          remLen += (b & 0x7f) * mult;
          if (!(b & 0x80)) break;
          mult *= 128;
          if (mult > 128 ** 3) return fail(new Error("malformed length"));
        }
        if (recvBuf.length < i + remLen) return;      // body incomplete
        handle(recvBuf[0], recvBuf.subarray(i, i + remLen));
        recvBuf = recvBuf.slice(i + remLen);
      }
    };

    function handle(header, body) {
      const type = header >> 4;
      if (type === 2) {                               // CONNACK
        if (body[1] !== 0) return fail(new Error(`broker refused connection (rc ${body[1]})`));
        pingTimer = setInterval(() => ws.send(Uint8Array.of(0xc0, 0)), keepalive * 500);
        if (!settled) { settled = true; resolve(api); }
      } else if (type === 3) {                        // PUBLISH (we subscribe QoS 0 only)
        const topicLen = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + topicLen));
        let off = 2 + topicLen;
        if ((header >> 1) & 3) off += 2;              // packet id rides along on QoS>0
        // retain bit distinguishes replayed-on-subscribe state from live
        // traffic — the pairing facade turns retained into a state snapshot.
        onMessage?.(topic, dec.decode(body.subarray(off)), { retain: !!(header & 1) });
      }
      // SUBACK / PINGRESP need no action at QoS 0.
    }
  });
}
