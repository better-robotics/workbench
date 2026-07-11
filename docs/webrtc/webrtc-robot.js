// Robot WebRTC signaling (Pi only — ESP32 has no signal char) rides BLE —
// chunked SDP on the SIGNAL char. The dashboard writes the offer; pi_robot.py
// (root, owns the GATT server) forwards it to a local aiortc daemon over a
// Unix socket and notifies the answer back over BLE. No internet rendezvous
// — pair = signal.
//
// Wire format on the SIGNAL char (both directions, mirrors OTA/snapshot):
//   0x01 [u16 BE total]                       offer begin
//   0x02 [bytes]                              offer chunk (≤ 100 B payload)
//   0x03                                      offer commit
//   0xFF [utf8 msg]                           error (notify-only)

import { fetchIceServers } from "./ice.js";
import { SIGNAL_CHUNK_BYTES, OP_BEGIN, OP_CHUNK, OP_COMMIT } from "../protocol-constants.js";

// aiortc on the Pi completes ICE in ~2-3s on a healthy LAN; 90s is a
// conservative cap for a bad network, not the expected case.
const ICE_TIMEOUT_MS = 90000;

// Per-robot peer connections, lazy-built. Keyed by robot id.
const _peers = new Map();  // robotId → { pc, channels: Map<label, ch> }

// PCs owned by other modules (e.g. webrtc-installable's Pi camera path)
// that want to appear in lastRobotWebRTCDiagnostic alongside the channels
// _peers tracks. Keyed by `${robotId}::${label}`.
const _externalPeers = new Map();
export function registerExternalPc(robotId, label, pc) {
  _externalPeers.set(`${robotId}::${label}`, { robotId, label, pc });
}
export function unregisterExternalPc(robotId, label) {
  _externalPeers.delete(`${robotId}::${label}`);
}

// Open (or replace) a peer connection to the Pi, ensure a DataChannel
// with the requested label is open, return the channel. Single-PC model
// per robot — opening a second time tears the prior peer down.
//
// opts:
//   signalChar:  BluetoothRemoteGATTCharacteristic — required
//   onStatus:    (msg) => void    — progress messages for UI
//
// BLE pair = signal. If signalChar is missing, the robot's firmware is
// too old to support this — surface that directly rather than falling
// back to a backend the user may not even have access to.
export async function openChannel(robotId, robotName, label, opts = {}) {
  const { signalChar } = opts;
  if (!signalChar) {
    throw new Error("WebRTC signaling needs a BLE signal characteristic — pair the robot first, or update its firmware");
  }
  return openChannelViaBLE(robotId, label, signalChar, opts);
}

// ── BLE signaling path ──────────────────────────────────────────────────

async function openChannelViaBLE(robotId, label, signalChar, opts) {
  const { onStatus = () => {} } = opts;
  closePeer(robotId);

  onStatus("Opening peer over BLE…");
  // STUN-only is fine — for LAN both peers' local candidates are enough;
  // STUN as fallback covers any in-house NAT segments.
  const iceServers = await fetchIceServers();
  const pc = new RTCPeerConnection({ iceServers });
  const entry = { pc, channels: new Map() };
  _peers.set(robotId, entry);

  // Every label (shell: PTY, logs: journalctl tail, ota: firmware bundle)
  // is a byte stream where a single dropped or reordered chunk corrupts
  // the result, so all get SCTP's default ordered+reliable behavior.
  const channel = pc.createDataChannel(label);
  entry.channels.set(label, channel);

  // Listener for chunked answer notify. Installed before we send the
  // offer so we can't miss a fast reply.
  let answerResolve, answerReject;
  const answerPromise = new Promise((resolve, reject) => {
    answerResolve = resolve;
    answerReject = reject;
  });
  let total = 0, received = 0;
  const chunks = [];
  const onSignal = (e) => {
    const data = new Uint8Array(e.target.value.buffer);
    if (data.length === 0) return;
    const op = data[0];
    if (op === OP_BEGIN) {
      if (data.length < 3) return;
      total = (data[1] << 8) | data[2];
      received = 0;
      chunks.length = 0;
    } else if (op === OP_CHUNK) {
      chunks.push(data.subarray(1));
      received += data.length - 1;
    } else if (op === OP_COMMIT) {
      signalChar.removeEventListener("characteristicvaluechanged", onSignal);
      if (received !== total) {
        answerReject(new Error(`answer size mismatch ${received}/${total}`));
        return;
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }
      answerResolve(new TextDecoder().decode(merged));
    } else if (op === 0xFF) {
      signalChar.removeEventListener("characteristicvaluechanged", onSignal);
      const msg = new TextDecoder().decode(data.subarray(1));
      answerReject(new Error(`signaling: ${msg}`));
    }
  };
  signalChar.addEventListener("characteristicvaluechanged", onSignal);

  try {
    onStatus("Generating offer…");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Non-trickle ICE: wait for gathering to complete so the SDP carries
    // every candidate inline. Bounded — if mDNS / private candidates
    // hang, we ship what we have after 3 s rather than stalling forever.
    await waitForIceGathering(pc, 3000);

    // Pi fetches its own ICE servers in pi_robot_rtc.py and accepts only
    // opcodes 0x01-0x03 on this char.
    onStatus("Writing offer over BLE…");
    const sdpBytes = new TextEncoder().encode(pc.localDescription.sdp);
    await sendChunked(signalChar, sdpBytes);

    onStatus("Waiting for answer…");
    const answerSdp = await Promise.race([
      answerPromise,
      timeoutAfter(ICE_TIMEOUT_MS, "BLE signaling timeout"),
    ]);

    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    onStatus("Answer received, opening channel…");

    return await openWhenReady(channel, robotId);
  } catch (err) {
    closePeer(robotId);
    signalChar.removeEventListener("characteristicvaluechanged", onSignal);
    throw err;
  }
}

async function sendChunked(char, bytes) {
  const total = bytes.length;
  if (total === 0 || total > 0xFFFF) {
    throw new Error(`payload size out of range: ${total}`);
  }
  const begin = new Uint8Array(3);
  begin[0] = OP_BEGIN;
  begin[1] = (total >> 8) & 0xff;
  begin[2] = total & 0xff;
  await char.writeValueWithResponse(begin);
  for (let off = 0; off < total; off += SIGNAL_CHUNK_BYTES) {
    const take = Math.min(SIGNAL_CHUNK_BYTES, total - off);
    const buf = new Uint8Array(1 + take);
    buf[0] = OP_CHUNK;
    buf.set(bytes.subarray(off, off + take), 1);
    await char.writeValueWithResponse(buf);
  }
  await char.writeValueWithResponse(new Uint8Array([OP_COMMIT]));
}

function waitForIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", onChange);
        clearTimeout(timer);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, timeoutMs);
  });
}

function timeoutAfter(ms, msg) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
}

function openWhenReady(channel, robotId) {
  return new Promise((resolve, reject) => {
    if (channel.readyState === "open") return resolve(channel);
    let resolved = false;
    const fail = (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      closePeer(robotId);
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error("ICE timeout")), ICE_TIMEOUT_MS);
    channel.addEventListener("open", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(channel);
    });
    channel.addEventListener("error", (e) => fail(new Error(e.message || "channel error")));
  });
}

export function closePeer(robotId) {
  const entry = _peers.get(robotId);
  if (!entry) return;
  for (const ch of entry.channels.values()) try { ch.close(); } catch {}
  try { entry.pc?.close(); } catch {}
  _peers.delete(robotId);
}

// DevTools / Diagnostics-dialog handle: snapshot every active robot
// peer connection's getStats() output. Tells you which candidate-pair
// won (look for type=candidate-pair, state=succeeded) so you can
// answer "host vs srflx vs relay" without chrome://webrtc-internals.
// Returns a Promise — DevTools auto-awaits.
export async function getRobotWebRTCDiagnostic() {
  const out = [];
  for (const [robotId, entry] of _peers.entries()) {
    const row = {
      robotId,
      state: {
        iceConnection: entry.pc?.iceConnectionState,
        connection: entry.pc?.connectionState,
        signaling: entry.pc?.signalingState,
        iceGathering: entry.pc?.iceGatheringState,
      },
      channels: [...entry.channels.keys()],
    };
    try {
      const report = await entry.pc.getStats();
      const stats = [];
      report.forEach((s) => stats.push(s));
      row.stats = stats;
    } catch (err) {
      row.statsError = err.message || String(err);
    }
    out.push(row);
  }
  for (const { robotId, label, pc } of _externalPeers.values()) {
    const row = {
      robotId, label,
      state: {
        iceConnection: pc?.iceConnectionState,
        connection: pc?.connectionState,
        signaling: pc?.signalingState,
        iceGathering: pc?.iceGatheringState,
      },
    };
    try {
      const report = await pc.getStats();
      const stats = [];
      report.forEach((s) => stats.push(s));
      row.stats = stats;
    } catch (err) {
      row.statsError = err.message || String(err);
    }
    out.push(row);
  }
  return out;
}

if (typeof window !== "undefined") {
  window.lastRobotWebRTCDiagnostic = getRobotWebRTCDiagnostic;
}
