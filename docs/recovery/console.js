// Unified serial console. Auto-detects Raspberry Pi (USB-CDC gadget) vs
// ESP32 (USB-UART bridge) from the picked port's VID *after* connecting,
// instead of making the user pre-declare which one they have before they
// even know what's plugged in — connect first, classify what came back.
// Replaces the old recovery.js (Pi-only) + esp-serial.js's console half;
// esp-serial.js now owns only the flash/install flow, reused here for the
// Flash firmware button.
import { $, wirePopover } from "../dom.js";
import { log } from "../log.js";
import { mountTerminal } from "./xterm-host.js";
import { portLabel, ESP_USB_VIDS } from "./boards.js";
import { installEsp32 } from "./esp-serial.js";

let _port = null;
let _reader = null;
let _writer = null;
let _readPump = null;
let _term = null;
let _fit = null;
let _resizeObs = null;
let _profile = null;  // detected PROFILES entry for the current connection, or null

const ENCODER = new TextEncoder();

// Recognized device profiles. VIDs are unique across the two lists, so a
// single lookup classifies any picked port. Pi's is the Linux Foundation
// gadget VID (usb-gadget-setup.sh's PID varies by firmware version, but
// VID-only matching catches all of them); ESP32's are the common USB-UART
// bridges + native USB (see boards.js's ESP_USB_VIDS for the per-board why).
const PI_VID = 0x1d6b;
const PROFILES = [
  { key: "pi",  label: "Raspberry Pi", vids: [PI_VID] },
  { key: "esp", label: "ESP32",        vids: ESP_USB_VIDS },
];
const ALL_FILTERS = PROFILES.flatMap((p) => p.vids.map((usbVendorId) => ({ usbVendorId })));

function profileForVid(vid) {
  return PROFILES.find((p) => p.vids.includes(vid)) || null;
}
function knownConsolePorts(ports) {
  return ports.filter((p) => {
    try { return !!profileForVid(p.getInfo().usbVendorId); } catch { return false; }
  });
}

// state: "" (idle) | "connecting" | "connected" | "error". Drives the dot
// color; the pill always carries a word too — the dot alone encodes state by
// color, which no screen reader and no colorblind operator can read.
const STATUS_LABEL = { "": "Disconnected", connecting: "Connecting…", connected: "Connected", error: "Error" };
function setStatus(state, text = "") {
  $("console-status-dot").className = `dot${state ? ` ${state}` : ""}`;
  const label = text || STATUS_LABEL[state];
  const el = $("console-status");
  el.textContent = label;
  el.title = label;  // pill ellipsizes; hover recovers long error detail
}

// Terminal well shows the placeholder until a session exists. The term div
// can't just stay mounted-and-empty behind it: xterm's FitAddon measures the
// host on mount, so it has to be visible by then — swap, don't overlay.
function setTermVisible(on) {
  $("console-term").hidden = !on;
  $("console-empty").hidden = on;
}

async function pickPort({ unfiltered = false } = {}) {
  if (unfiltered) return await navigator.serial.requestPort();
  // Auto-reconnect shortcut: exactly one previously-authorized Pi-or-ESP
  // port skips the chooser entirely — the common single-board case. Two
  // or more known ports (multi-board desk) falls through to the chooser
  // so the operator picks which one.
  let known = [];
  try { known = await navigator.serial.getPorts(); } catch {}
  const candidates = knownConsolePorts(known);
  if (candidates.length === 1) return candidates[0];
  return await navigator.serial.requestPort({ filters: ALL_FILTERS });
}

// Two-attempt open: macOS sometimes fails the first open() right after a
// prior disconnect (kernel /dev/cu.* not fully released); a port that came
// back already-open from a prior tab/page session needs an explicit
// close() before the retry will take.
async function openWithRetry(port) {
  try { await port.open({ baudRate: 115200 }); }
  catch (err) {
    if (err.name === "InvalidStateError") { try { await port.close(); } catch {} }
    await new Promise((r) => setTimeout(r, 200));
    await port.open({ baudRate: 115200 });
  }
}

async function connect({ unfiltered = false } = {}) {
  if (_port) return;
  if (!("serial" in navigator)) {
    log("Console: Web Serial not supported — use Chrome or Edge on desktop");
    setStatus("error", "unsupported browser");
    return;
  }
  setStatus("connecting");
  let port;
  try {
    port = await pickPort({ unfiltered });
  } catch (err) {
    setStatus("");
    if (err.name !== "NotFoundError") log(`Console connect error: ${err.message}`);
    return;
  }

  const info = (() => { try { return port.getInfo(); } catch { return {}; } })();
  _profile = profileForVid(info.usbVendorId);
  if (unfiltered && !_profile) {
    log(`Console: picked port vid=0x${(info.usbVendorId || 0).toString(16)} pid=0x${(info.usbProductId || 0).toString(16)} — not a recognized Pi/ESP32 VID, connecting anyway`);
  }

  try {
    await openWithRetry(port);
    // Deassert DTR/RTS — both the Pi gadget and ESP32 dev boards wire
    // those through transistors to EN/reset lines. Chrome's default
    // asserted state on open() pulses them, resetting the board (and, on
    // a Pi, killing any active BLE session).
    try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {}
  } catch (err) {
    setStatus("error", `open failed: ${err.message}`);
    return;
  }
  _port = port;

  setTermVisible(true);
  ({ term: _term, fit: _fit, resizeObs: _resizeObs } = await mountTerminal($("console-term")));
  _term.focus();
  if (_profile?.key === "pi") {
    // Clear before any serial buffer flush — a getty session from before
    // this connect can flush stale lines in as soon as the reader starts.
    _term.write("\x1b[2J\x1b[H");
  }

  _term.onData(async (data) => {
    if (!_writer) return;
    try { await _writer.write(ENCODER.encode(data)); }
    catch (err) { _term?.writeln(`\r\n[write error: ${err.message}]`); }
  });

  _writer = _port.writable.getWriter();
  _reader = _port.readable.getReader();
  _readPump = (async () => {
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

  $("console-connect").textContent = "Disconnect";
  const label = _profile?.key === "esp" ? portLabel(info.usbVendorId)
              : _profile?.label || `Unknown device (vid=0x${(info.usbVendorId || 0).toString(16)})`;
  setStatus("connected", label);
}

async function disconnect() {
  // Release order matters: reader.cancel() resolves before the in-flight
  // read() promise settles, so releaseLock() must wait for the read pump
  // to actually exit — otherwise it throws "pending read", port.close()
  // then rejects with "stream is locked", and the port stays open. The
  // next port.open() fails with "port is already open" even though the
  // session looks gone.
  try { await _reader?.cancel(); } catch {}
  try { await _readPump; } catch {}
  try { _reader?.releaseLock(); } catch {}
  try { _writer?.releaseLock(); } catch {}
  try { await _port?.close(); } catch {}
  // Brief grace for the OS to release the device node before a follow-up
  // open() (e.g. install-then-reconnect) races it.
  await new Promise((r) => setTimeout(r, 100));
  _reader = _writer = _readPump = _port = null;
  _profile = null;
  _resizeObs?.disconnect();
  _resizeObs = null;
  _fit?.dispose();
  _fit = null;
  _term?.dispose();
  _term = null;
  setTermVisible(false);
  setStatus("");
  $("console-connect").textContent = "Connect";
}

let _initialized = false;
export function init() {
  if (_initialized) return;
  _initialized = true;
  $("console-close").addEventListener("click", () => $("console-modal").close());
  $("console-connect").addEventListener("click", () => _port ? disconnect() : connect());
  // Port-pick escape hatch and Flash firmware live behind ⋯ so Connect reads
  // as the one primary action. Both are rare, deliberate detours from the
  // default path, and Flash keeps its destructive weight via .destructive.
  wirePopover("console-menu-btn", "console-menu", { anchor: "right" });
  const menu = $("console-menu");
  $("console-show-all").addEventListener("click", () => {
    menu.hidePopover();
    connect({ unfiltered: true });
  });
  // No outside-click dismiss — terminal session is real work; an
  // accidental click would kill the connection and scrollback. Explicit
  // × button, Escape, or Disconnect only.
  $("console-modal").addEventListener("close", () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
    if (_port) disconnect();
  });
  // Flash firmware: independent action with its own port pick and dialog,
  // not gated by what this console session detected — release any active
  // console connection first (same port could be the flash target), then
  // reopen it afterward if one was active.
  $("esp-serial-flash").addEventListener("click", async () => {
    menu.hidePopover();
    const wasConnected = !!_port;
    if (_port) await disconnect();
    await installEsp32();
    if (wasConnected) await connect();
  });
}

export async function releasePort() { if (_port) await disconnect(); }
