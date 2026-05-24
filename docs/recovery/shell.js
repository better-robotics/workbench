// Browser-resident terminal into a Pi over a WebRTC DataChannel.
//
// Architecture: dashboard opens a `shell` DataChannel to the Pi via
// webrtc-robot.js. The Pi's libpeer-based pi-robot-rtc daemon spawns a PTY
// running `bash -i` and bridges its stdin/stdout to the channel. xterm.js
// renders the byte stream; user keystrokes flow back through channel.send().
//
// Auth model: the WebRTC peer-trust IS the auth boundary. Today this is
// "if you can reach <robot>.local:82/webrtc/offer, you're trusted" — same
// LAN trust the dashboard already extends for OTA over PNA. SSH-over-
// DataChannel can be layered on top later if the trust model needs upgrade
// (run ssh2 in a WebContainer, hand it a Duplex over the channel).

import { $ } from "../dom.js";
import { state } from "../state.js";
import { log } from "../log.js";
import { openChannel, closePeer } from "../webrtc/webrtc-robot.js";
import { mountTerminal } from "./xterm-host.js";

let _wired = false;
let _activeRobotId = null;
let _channel = null;
let _term = null;
let _fit = null;
let _resizeObs = null;

// state: "" (idle) | "connecting" | "connected" | "error". Same shape
// as recovery.js / esp-serial.js — keeps the patterns parallel.
function setStatus(s, text = "") {
  $("shell-status-dot").className = `dot${s ? ` ${s}` : ""}`;
  $("shell-status").textContent = text;
}

async function connect() {
  const id = _activeRobotId;
  if (!id) return;
  const entry = state.devices.get(id);
  if (!entry) return;
  setStatus("connecting", "Negotiating peer connection…");
  try {
    _channel = await openChannel(id, entry.name, "shell", {
      onStatus: (s) => setStatus("connecting", s),
      robotType: entry.fwType,
      signalChar: entry.signalChar,
    });
  } catch (err) {
    setStatus("error", `Couldn't reach pi-robot-rtc: ${err.message || err}`);
    log(`shell: ${err.message || err}`);
    return;
  }
  setStatus("connected");
  $("shell-connect").textContent = "Disconnect";

  ({ term: _term, fit: _fit, resizeObs: _resizeObs } = await mountTerminal($("shell-term")));
  _term.focus();
  _term.write("\x1b[2J\x1b[H");

  // Channel binary-mode for raw PTY bytes; xterm.js can write Uint8Array
  // directly. Prefer ArrayBuffer for fewer allocs on hot path.
  _channel.binaryType = "arraybuffer";
  _channel.addEventListener("message", (e) => {
    if (typeof e.data === "string") _term?.write(e.data);
    else _term?.write(new Uint8Array(e.data));
  });
  _channel.addEventListener("close", () => {
    _term?.writeln("\r\n[channel closed]");
    setStatus("error", "Disconnected");
    $("shell-connect").textContent = "Connect";
  });
  // Keystrokes → bytes over the channel. Encoder reused per onData call;
  // hot path on terminal input.
  const enc = new TextEncoder();
  _term.onData((data) => {
    if (_channel?.readyState !== "open") return;
    try { _channel.send(enc.encode(data)); }
    catch (err) { _term?.writeln(`\r\n[send error: ${err.message}]`); }
  });
  // Send terminal dimensions over the control channel (text/JSON, distinct
  // from binary stdin). Sent once at open + on every xterm resize so the
  // PTY's TIOCSWINSZ matches what the user actually sees.
  const sendResize = () => {
    if (_channel?.readyState !== "open") return;
    try {
      _channel.send(JSON.stringify({
        type: "resize", cols: _term.cols, rows: _term.rows,
      }));
    } catch {}
  };
  sendResize();
  _term.onResize(sendResize);
}

function disconnect() {
  try { _channel?.close(); } catch {}
  _channel = null;
  _resizeObs?.disconnect();
  _resizeObs = null;
  _fit?.dispose();
  _fit = null;
  _term?.dispose();
  _term = null;
  if (_activeRobotId) closePeer(_activeRobotId);
  setStatus("");
  $("shell-connect").textContent = "Connect";
}

function initOnce() {
  if (_wired) return;
  _wired = true;
  $("shell-close").addEventListener("click", () => $("shell-modal").close());
  $("shell-connect").addEventListener("click", () => _channel ? disconnect() : connect());
  $("shell-modal").addEventListener("close", () => { if (_channel) disconnect(); });
}

export function openShellDialog(robotId) {
  initOnce();
  _activeRobotId = robotId;
  const entry = state.devices.get(robotId);
  $("shell-subtitle").textContent = entry ? ` · ${entry.name}` : "";
  setStatus("");
  $("shell-modal").showModal();
}
