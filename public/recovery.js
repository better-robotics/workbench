// Works even when BLE is dead: the USB gadget runs under its own systemd unit
// (usb-gadget.service) independently of pi-robot. xterm.js is dynamic-imported
// on first Connect so the ~250KB library only downloads when actually used.
import { $ } from "./dom.js";
import { log } from "./log.js";

let _port = null;
let _reader = null;
let _writer = null;
let _term = null;
let _xtermModule = null;

function setStatus(msg) { $("recovery-status").textContent = msg; }

async function ensureXtermLoaded() {
  if (_xtermModule) return _xtermModule;
  if (!document.querySelector('link[data-xterm-css]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.css";
    link.dataset.xtermCss = "1";
    document.head.appendChild(link);
  }
  _xtermModule = await import("https://cdn.jsdelivr.net/npm/@xterm/xterm@5/+esm");
  return _xtermModule;
}

async function connect() {
  if (!("serial" in navigator)) {
    log("Web Serial not supported — use Chrome or Edge on desktop");
    setStatus("unsupported browser");
    return;
  }
  try {
    _port = await navigator.serial.requestPort();
    await _port.open({ baudRate: 115200 });
  } catch (err) {
    if (err.name !== "NotFoundError") log(`Recovery connect error: ${err.message}`);
    setStatus("disconnected");
    return;
  }
  setStatus("connected");
  $("recovery-connect").textContent = "Disconnect";

  const { Terminal } = await ensureXtermLoaded();
  const container = $("recovery-term");
  container.innerHTML = "";
  _term = new Terminal({
    fontSize: 13,
    fontFamily: '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace',
    cursorBlink: true,
    convertEol: false,
    theme: { background: "#1e1e1e", foreground: "#e4e4e4", cursor: "#e4e4e4" },
  });
  _term.open(container);
  _term.focus();

  _term.onData(async (data) => {
    if (!_writer) return;
    try { await _writer.write(new TextEncoder().encode(data)); }
    catch (err) { _term?.writeln(`\r\n[write error: ${err.message}]`); }
  });

  _writer = _port.writable.getWriter();
  _reader = _port.readable.getReader();
  (async () => {
    try {
      while (true) {
        const { value, done } = await _reader.read();
        if (done) break;
        if (value) _term?.write(value);
      }
    } catch (err) {
      _term?.writeln(`\r\n[read error: ${err.message}]`);
    }
  })();
}

async function disconnect() {
  try { await _reader?.cancel(); } catch {}
  try { _writer?.releaseLock(); } catch {}
  try { await _port?.close(); } catch {}
  _reader = _writer = _port = null;
  _term?.dispose();
  _term = null;
  setStatus("disconnected");
  $("recovery-connect").textContent = "Connect via USB serial";
}

export function openRecoveryDialog() {
  $("recovery-modal").showModal();
}

export function initRecovery() {
  $("recovery-close").addEventListener("click", () => $("recovery-modal").close());
  $("recovery-connect").addEventListener("click", () => _port ? disconnect() : connect());
  // No outside-click dismiss — terminal session is real work; accidental
  // clicks outside the modal used to kill the connection and scrollback.
  // Explicit × button is the only way out.
  $("recovery-modal").addEventListener("close", () => { if (_port) disconnect(); });
}
