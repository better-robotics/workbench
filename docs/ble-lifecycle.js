import { SERVICE_UUID, HEARTBEAT_SVC_UUID, HEARTBEAT_CHAR_UUID,
  FW_INFO_CHAR_UUID, ROBOT_STATUS_CHAR_UUID,
  OPS_RESPONSE_CHAR_UUID, TELEMETRY_CHAR_UUID, SIGNAL_CHAR_UUID,
  decodeJson } from "./ble.js";
import { log, logFor } from "./log.js";
import {
  state, persist, loadKnown,
  makeEntry, entryFor, attachDevice, setDisconnectHandler,
} from "./state.js";
import { ALL as CAPABILITIES } from "./capabilities/index.js";
import { RUNTIMES } from "./capabilities/runtime/index.js";
import { dispatchOpsResponse } from "./ops-response.js";
import { broadcastTargetInfo } from "./phones.js";
import { renderHelpers } from "./phone-helpers.js";
import { stopWatcher } from "./watcher.js";

let renderers = {
  renderEntry: () => {},
  render: () => {},
  patchSecondaryRow: () => {},
  patchRobotStateLine: () => {},
};
export function setBleRenderers(r) {
  renderers = { ...renderers, ...r };
}

// Hoisted indirection so the registration sees onDisconnected (defined below).
setDisconnectHandler((id) => onDisconnected(id));

// gatt.connect() has no browser-exposed timeout; a wedged robot can leave the
// amber "Connecting…" pulse on indefinitely. Healthy connects complete in
// under 2s — 6s is plenty of margin and fails fast enough that the user
// gets a real "Reconnect" button instead of staring at a spinner.
const GATT_CONNECT_TIMEOUT_MS = 6000;
function gattConnectWithTimeout(device) {
  return Promise.race([
    device.gatt.connect(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`connect timeout after ${GATT_CONNECT_TIMEOUT_MS / 1000}s`)),
                 GATT_CONNECT_TIMEOUT_MS)),
  ]);
}

// Chrome serializes BLE choosers (one at a time) and silently delays the
// second concurrent requestDevice() call. Without our own gate, a user who
// clicks Re-pair on two robots quickly sees both buttons stuck on
// "Connecting…" with no feedback on which chooser is actually live.
// Reject the second click immediately so its status reverts to Re-pair.
// Also wraps a hard timeout so a dismissed-but-not-cancelled chooser
// doesn't keep the entry pinned in "Connecting…" forever.
const CHOOSER_TIMEOUT_MS = 30000;
let chooserBusy = false;
async function pickDeviceOrFail(options) {
  if (chooserBusy) {
    throw new Error("Another robot's pairing dialog is already open — finish that one first");
  }
  chooserBusy = true;
  try {
    return await Promise.race([
      navigator.bluetooth.requestDevice(options),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("pairing dialog timed out — click Re-pair to try again")),
                   CHOOSER_TIMEOUT_MS)),
    ]);
  } finally {
    chooserBusy = false;
  }
}

export async function loadPaired() {
  // Rehydrate paired entries from localStorage. We deliberately don't call
  // navigator.bluetooth.getDevices() to repopulate cached BluetoothDevice
  // handles: cached-handle reconnect was the source of the post-restart
  // wedge (gatt.connect on a stale handle, no way to recover without a
  // fresh requestDevice). Every click goes through the chooser now —
  // predictable, one shape, no timing races against the robot's boot.
  for (const { id, name, fwType, lastConnectedAt, arucoMarkerId, cameraFlip } of loadKnown()) {
    if (!state.devices.has(id)) {
      state.devices.set(id, makeEntry(id, name, fwType, { lastConnectedAt, arucoMarkerId, cameraFlip }));
    }
  }
  renderers.render();
}

export async function scanForNew() {
  try {
    // If ?robot=X hint is present and that robot isn't already paired,
    // pre-filter the chooser by name so the user picks from one entry.
    const hintedName = new URLSearchParams(location.search).get("robot");
    const useHint = hintedName
      && ![...state.devices.values()].some(e => e.name === hintedName);
    // Match devices advertising EITHER the main service OR the heartbeat —
    // a robot whose pi-robot.service is dead still appears via heartbeat.
    const filters = useHint
      ? [{ name: hintedName, services: [SERVICE_UUID] },
         { name: hintedName, services: [HEARTBEAT_SVC_UUID] }]
      : [{ services: [SERVICE_UUID] }, { services: [HEARTBEAT_SVC_UUID] }];
    // Hide already-paired robots from the chooser — Scan is the "add new"
    // path, Reconnect on the existing card is the re-pair path. Names are
    // unique per chassis (BR-XXXX hash from MAC) so name-exclusion is safe.
    // exclusionFilters is Chrome 114+; older browsers silently ignore the
    // option and show every match as before — graceful degradation.
    const exclusionFilters = [...state.devices.values()]
      .filter(e => e.name)
      .map(e => ({ name: e.name }));
    const device = await pickDeviceOrFail({
      filters,
      optionalServices: [SERVICE_UUID, HEARTBEAT_SVC_UUID],
      ...(exclusionFilters.length ? { exclusionFilters } : {}),
    });
    const name = device.name || device.id;
    entryFor(device);
    log("paired", name);
    renderers.render();
    connect(device.id);
  } catch (err) {
    if (err.name !== "NotFoundError") log(`Scan error: ${err.message}`);
  }
}

async function restoreDevice(entry) {
  // Required on browsers without getDevices(): chooser filtered to the saved name.
  const device = await pickDeviceOrFail({
    filters: [{ name: entry.name, services: [SERVICE_UUID] },
              { name: entry.name, services: [HEARTBEAT_SVC_UUID] }],
    optionalServices: [SERVICE_UUID, HEARTBEAT_SVC_UUID],
  });
  attachDevice(entry, device);
}

export async function connect(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  if (!entry.device) {
    // requestDevice requires user activation — we only get here from a
    // direct click, so userActivation should be live. Visual feedback
    // BEFORE the chooser opens so the click registers in the UI even if
    // Chrome takes a moment to surface the picker.
    entry.status = "connecting";
    renderers.renderEntry(entry);
    try {
      log("re-pairing…", entry.name);
      await restoreDevice(entry);
    } catch (err) {
      // NotFoundError = user cancelled an empty/wrong picker. Either way
      // we drop back to whatever status the entry had before this click,
      // and re-render so the button stops saying "Connecting…".
      if (err.name !== "NotFoundError") logFor(entry, `re-pair cancelled: ${err.message}`);
      entry.status = entry.lastConnectError ? "error" : "idle";
      renderers.renderEntry(entry);
      return;
    }
  }
  entry.status = "connecting";
  renderers.renderEntry(entry);
  // Defensive disconnect-before-connect. Chrome's gatt.connect() is meant
  // to be idempotent, but in practice a cached "connected" state (or a
  // previous attempt that left internal state dirty) can hang the next
  // connect indefinitely. An explicit disconnect resets Chrome's
  // bookkeeping and is a no-op on the wire when actually disconnected.
  if (entry.device.gatt.connected) {
    try { entry.device.gatt.disconnect(); } catch {}
  }
  let server;
  try {
    server = await gattConnectWithTimeout(entry.device);
  } catch (err) {
    // gatt.connect on the just-picked device failed. We drop the handle so
    // the next click starts a fresh chooser instead of retrying a maybe-
    // stale BluetoothDevice.
    entry.device = null;
    entry.status = "error";
    entry.lastConnectError = err.message || String(err);
    logFor(entry, `connect failed: ${entry.lastConnectError}`);
    renderers.renderEntry(entry);
    return;
  }
  try {
    let service;
    try {
      service = await server.getPrimaryService(SERVICE_UUID);
    } catch (svcErr) {
      // pi-robot.service is dead but the robot's heartbeat plane is still up.
      // Surface the recovery info instead of bouncing the user back to "Error".
      if (await tryConnectHeartbeatOnly(entry, server)) {
        renderers.renderEntry(entry);
        return;
      }
      throw svcErr;
    }
    // A robot advertising only the service (no chars) is still "connected".
    // Every capability is optional.
    entry.status = "connected";
    // lastConnectedAt feeds phones.js's "most recently active dashboard"
    // tiebreaker for cross-tab phone pair signaling.
    entry.lastConnectedAt = Date.now();
    entry.lastConnectError = null;
    persist();
    renderHelpers();  // phone "Mount camera" picker now has a new destination.

    // Read fw-info before cap probes — it carries the capability schema.
    // Also subscribe to notifications: ESP32 re-publishes fw-info after
    // deferred camera init (post WiFi-join), so the camera cap only appears
    // mid-session. Old firmware without NOTIFY silently skips the subscribe.
    //
    // Retry the read with exponential backoff: BlueZ has a known MTU-race
    // (bluez/bluez#65) where the first read after connect can return "GATT
    // operation failed for unknown reason" because the ATT-MTU exchange
    // hasn't settled. Same shape Google's automatic-reconnect sample uses
    // (max=3, delay 200/400/800 ms instead of seconds since GATT round-
    // trips are sub-100 ms, not multi-second like full reconnect).
    try {
      const info = await service.getCharacteristic(FW_INFO_CHAR_UUID);
      const raw = await retryGattRead(() => info.readValue(), "fw-info", entry);
      const rawText = new TextDecoder().decode(raw);
      logFor(entry, `fw-info: ${rawText.slice(0, 200)}`);
      entry.fwInfo = decodeJson(raw);
      entry.capSchema = entry.fwInfo?.caps || null;
      if (entry.fwInfo?.type && entry.fwType !== entry.fwInfo.type) {
        entry.fwType = entry.fwInfo.type;
        persist();  // survive disconnect/reload so the badge stays visible
      }
      try {
        await info.startNotifications();
        info.addEventListener("characteristicvaluechanged", (e) => {
          const updated = decodeJson(e.target.value);
          if (!updated) return;
          entry.fwInfo = updated;
          entry.capSchema = updated.caps || null;
          logFor(entry, `fw-info updated: caps=${(updated.caps||[]).map(c=>c.name).join(",")}`);
          // Rebuild runtime caps so newly-advertised ones (camera) probe + render.
          probeRuntimeCaps(entry, service).then(() => renderers.renderEntry(entry));
        });
      } catch { /* firmware without NOTIFY — one-shot read is fine */ }
    } catch (err) {
      logFor(entry, `fw-info read failed: ${err.message}`);
      entry.fwInfo = null;
      entry.capSchema = null;
    }

    // robot-status: a top-level "what am I doing" notify channel. Optional —
    // older firmware / ESP32 don't expose it, and the card still works fine
    // without it.
    try {
      const statusChar = await service.getCharacteristic(ROBOT_STATUS_CHAR_UUID);
      entry.robotStatus = decodeJson(await statusChar.readValue()) || null;
      await statusChar.startNotifications();
      statusChar.addEventListener("characteristicvaluechanged", (e) => {
        const next = decodeJson(e.target.value) || null;
        // Firmware sometimes re-publishes identical status; skip the
        // DOM patch when the payload hasn't changed.
        if (JSON.stringify(next) === JSON.stringify(entry.robotStatus)) return;
        entry.robotStatus = next;
        renderers.patchRobotStateLine(entry);  // surgical, no full-card flash
      });
    } catch {
      entry.robotStatus = null;
    }
    // Fresh connection clears any sticky disconnect status.
    if (entry.stickyStatusTimer) { clearTimeout(entry.stickyStatusTimer); entry.stickyStatusTimer = null; }
    entry.stickyStatus = null;

    // Telemetry (read + notify) — optional; ESP32 / older Pi don't expose it.
    // telemetryUpdatedAt stamped on every value change so get_robot_state
    // can surface freshness to Pip — research showed unstamped sensor data
    // gets treated as live ("Your LLM Agents are Temporally Blind", arxiv
    // 2510.23853; matches what we saw on the BR-0D08 patrol run).
    try {
      const telChar = await service.getCharacteristic(TELEMETRY_CHAR_UUID);
      entry.telemetry = decodeJson(await telChar.readValue()) || null;
      if (entry.telemetry) entry.telemetryUpdatedAt = Date.now();
      await telChar.startNotifications();
      telChar.addEventListener("characteristicvaluechanged", (e) => {
        entry.telemetry = decodeJson(e.target.value) || null;
        if (entry.telemetry) entry.telemetryUpdatedAt = Date.now();
        renderers.patchSecondaryRow(entry);  // surgical patch, no full-card re-render
      });
    } catch {
      entry.telemetry = null;
    }

    // Recovery-plane heartbeat — best-effort read alongside the main service.
    // Pi-only: ESP32 doesn't advertise HEARTBEAT_SVC_UUID. Surfaces the state
    // of usb-gadget + ssh so a degraded recovery path shows as a warning chip
    // *before* the operator needs it (i.e., before BLE also drops).
    await readHeartbeatPlane(entry, server);

    // ops-response (notify, chunked) — dispatches request/response ops like
    // get-log / get-config to the right handler. Same opcode protocol as OTA
    // and camera: 0x01 begin+u32 len, 0x02 chunk, 0x03 commit.
    try {
      const respChar = await service.getCharacteristic(OPS_RESPONSE_CHAR_UUID);
      entry.opsRespBuf = null;
      await respChar.startNotifications();
      respChar.addEventListener("characteristicvaluechanged", (e) => {
        const data = new Uint8Array(e.target.value.buffer);
        if (data.length === 0) return;
        const op = data[0];
        if (op === 0x01) entry.opsRespBuf = [];
        else if (op === 0x02 && entry.opsRespBuf) entry.opsRespBuf.push(data.subarray(1));
        else if (op === 0x03 && entry.opsRespBuf) {
          const total = entry.opsRespBuf.reduce((n, c) => n + c.length, 0);
          const merged = new Uint8Array(total);
          let o = 0;
          for (const c of entry.opsRespBuf) { merged.set(c, o); o += c.length; }
          entry.opsRespBuf = null;
          const msg = decodeJson(merged);
          if (!msg) return;
          dispatchOpsResponse(entry, msg);
        }
      });
    } catch { /* ops-response char absent on older firmware — optional */ }

    // signal char — chunked SDP exchange for WebRTC over BLE. When
    // present, webrtc-robot.js uses BLE for signaling instead of
    // wss://signal.neevs.io — fully P2P over LAN, no internet rendezvous.
    // Older firmware silently skips and falls back to the wss path.
    try {
      entry.signalChar = await service.getCharacteristic(SIGNAL_CHAR_UUID);
      await entry.signalChar.startNotifications();
      // The signaling state machine in webrtc-robot.js installs its own
      // characteristicvaluechanged listener when it initiates a session.
    } catch {
      entry.signalChar = null;
    }

    entry.runtimeCaps = [];
    for (const cap of CAPABILITIES) {
      try { await cap.probe(entry, service); } catch { /* optional */ }
    }
    await probeRuntimeCaps(entry, service);
    // Tell paired phones that motors / target are now available. Without
    // this, a phone that paired before the robot connected stays wedged
    // with target=null forever (joypad + panic-stop hidden).
    try { broadcastTargetInfo(); } catch {}
  } catch (err) {
    entry.status = "error";
    entry.lastConnectError = err.message || String(err);
    logFor(entry, `connect failed: ${entry.lastConnectError}`);
  }
  renderers.renderEntry(entry);
}

// Wrap a GATT read with exponential-backoff retry. Matches Google's
// Web Bluetooth automatic-reconnect sample shape (max retries + doubling
// delay), tuned for intra-session reads instead of full reconnect: 3
// attempts at 200/400/800 ms absorb the BlueZ MTU-race (bluez/bluez#65)
// and other "GATT operation failed for unknown reason" transients that
// the spec doesn't ask the page to surface, but in practice every page
// has to handle.
async function retryGattRead(readFn, label, entry, { max = 3, baseDelayMs = 200 } = {}) {
  let delay = baseDelayMs;
  let lastErr;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return await readFn();
    } catch (err) {
      lastErr = err;
      if (attempt === max) break;
      logFor(entry, `${label} read failed (try ${attempt + 1}/${max + 1}): ${err.message} — retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
  throw lastErr;
}

// Read the heartbeat plane's status char + subscribe to its notifications.
// Best-effort: ESP32 doesn't advertise HEARTBEAT_SVC_UUID and old Pi
// firmware predates it — both cases leave entry.heartbeat null and the
// caller keeps going. Returns true if heartbeat is readable, false
// otherwise. Shared by tryConnectHeartbeatOnly (firmware-down recovery)
// and the successful main-connect path (surfaces usb-gadget / ssh chips
// while the main firmware is healthy).
async function readHeartbeatPlane(entry, server) {
  try {
    const svc = await server.getPrimaryService(HEARTBEAT_SVC_UUID);
    const ch  = await svc.getCharacteristic(HEARTBEAT_CHAR_UUID);
    entry.heartbeat = decodeJson(await ch.readValue()) || {};
    try {
      await ch.startNotifications();
      ch.addEventListener("characteristicvaluechanged", (e) => {
        entry.heartbeat = decodeJson(e.target.value) || entry.heartbeat;
        renderers.renderEntry(entry);
      });
    } catch { /* notify optional */ }
    return true;
  } catch {
    entry.heartbeat = null;
    return false;
  }
}

// Recovery-plane connect. The robot's main GATT service is gone, but
// heartbeat.py is still advertising. Read its status char so the card can
// show the IP + a recovery-console shortcut instead of an opaque error.
async function tryConnectHeartbeatOnly(entry, server) {
  if (!(await readHeartbeatPlane(entry, server))) return false;
  entry.status = "firmware-down";
  entry.lastConnectedAt = Date.now();
  entry.lastConnectError = null;
  persist();
  logFor(entry, `firmware down — heartbeat ip=${entry.heartbeat?.ip || "?"} pi_robot=${entry.heartbeat?.pi_robot || "?"}`);
  return true;
}

// Build + probe only runtime caps that aren't already live. Used both at
// connect time and when fw-info notifies a schema change mid-session (ESP32
// adds camera post-WiFi-join). Keyed by name so an existing cap's state
// (wifi scan cache, etc.) survives a re-notify.
async function probeRuntimeCaps(entry, service) {
  entry.runtimeCaps = entry.runtimeCaps || [];
  const have = new Set(entry.runtimeCaps.map(c => c.name));
  for (const capSchema of entry.capSchema || []) {
    if (have.has(capSchema.name)) continue;
    const make = RUNTIMES[capSchema.type];
    if (!make) continue;
    const cap = make(capSchema);
    Object.assign(entry, cap.initEntry());
    try { await cap.probe(entry, service); } catch { /* optional */ }
    entry.runtimeCaps.push(cap);
  }
}

export async function disconnect(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  if (entry.device && entry.device.gatt.connected) entry.device.gatt.disconnect();
  onDisconnected(id);
}

export function onDisconnected(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  entry.status = "idle";
  // Picker on phone helper cards drops this robot now.
  renderHelpers();
  // Phones see target=null and tuck the joypad / panic-stop away.
  try { broadcastTargetInfo(); } catch {}
  // Remember the last-known status for 30s so 'rebooting' → disconnect reads
  // as "was rebooting" on the card instead of an unexplained drop.
  if (entry.robotStatus) {
    entry.stickyStatus = entry.robotStatus;
    if (entry.stickyStatusTimer) clearTimeout(entry.stickyStatusTimer);
    entry.stickyStatusTimer = setTimeout(() => {
      entry.stickyStatus = null;
      entry.stickyStatusTimer = null;
      renderers.renderEntry(entry);
    }, 30000);
  }
  entry.robotStatus = null;
  entry.heartbeat = null;
  for (const cap of CAPABILITIES) cap.cleanup(entry);
  for (const cap of entry.runtimeCaps || []) cap.cleanup(entry);
  entry.runtimeCaps = [];
  // Stop any running reflex watcher — its detect loop would otherwise
  // poll a now-vanished camera element forever (transient-null tolerance
  // is for blips, not disconnects).
  stopWatcher(entry, { silent: true });
  // Drop the BluetoothDevice handle on every disconnect so the next click
  // forces a fresh requestDevice — no stale-handle traps after a Pi reboot.
  entry.device = null;
  renderers.renderEntry(entry);
}

export async function forgetDevice(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  // Without a BluetoothDevice handle, forget() can't run and Chrome keeps the
  // per-origin paired list — next requestDevice would show it as already paired.
  let device = entry.device;
  if (!device && navigator.bluetooth.getDevices) {
    try {
      const all = await navigator.bluetooth.getDevices();
      device = all.find(d => d.id === id);
    } catch {}
  }
  if (device) {
    if (device.gatt?.connected) device.gatt.disconnect();
    if (device.forget) {
      try { await device.forget(); } catch {}  // Chrome 114+, ignore if unsupported
    }
  }
  const name = entry.name;
  state.devices.delete(id);
  persist();
  log("forgotten", name);
  renderers.render();
}
