// Classroom-hub transport (better-robotics/hub CONTRACT.md): rovers that
// publish robots/<team>/sys on the hub's broker appear as robot cards and
// are drivable over MQTT-over-WebSockets, no BLE pairing.
//
// The seam is a fake GATT service: capability runtimes only ever call
// service.getCharacteristic(uuid) and then writeValueWithResponse /
// readValue / startNotifications / addEventListener on the result, so
// satisfying that duck-type per characteristic makes every runtime, card,
// user script, and Pip tool work unchanged — the write handlers translate
// the BLE byte payloads into contract envelopes (±100 percent → ±255 duty
// for pwm; the firmware's own safety floor bounds everything we send).
//
// Reach: page must be http-served (localhost dev server or hub-served) —
// a https page can't open ws:// (mixed content). Anonymous connects are
// read-only fleet view per the broker ACL; drive/led need a team or
// instructor credential.
import { state, makeEntry } from "../state.js";
import { MOTOR_CHAR_UUID, LED_CHAR_UUID } from "../ble/uuids.js";
import { RUNTIMES } from "../capabilities/runtime/index.js";
import { renderEntry } from "../capabilities/runtime/render-bus.js";
import { log } from "../log.js";
import { connectMqtt } from "./mqtt.js";
import { WS_PORT } from "../protocol-constants.js";

const JOY_HOLD_MS = 400;       // contract default; joypad re-writes refresh it
const OFFLINE_AFTER_MS = 15000; // sys cadence is 2 s; 15 s silent = offline

const pctToDuty = (pct) => Math.round(pct * 255 / 100);
const int8 = (b) => (b >= 128 ? b - 256 : b);

// Same renderer-injection shape as ble-lifecycle's setBleRenderers: app.js
// plumbs its surgical patchSecondaryRow through so the 2 s sys tick doesn't
// pay a full-card innerHTML rebuild (wireActions, focus save/restore,
// camera transplant) per rover.
let renderers = {
  patchSecondaryRow: () => {},
};
export function setHubRenderers(r) {
  renderers = { ...renderers, ...r };
}

let client = null;
let sweepTimer = null;

function makeChar({ read, write }) {
  const listeners = new Set();
  return {
    async writeValueWithResponse(buf) { await write(buf); },
    async writeValue(buf) { await write(buf); },
    async readValue() { const b = read(); return new DataView(b.buffer, b.byteOffset, b.byteLength); },
    async startNotifications() {},
    async stopNotifications() {},
    addEventListener(type, fn) { if (type === "characteristicvaluechanged") listeners.add(fn); },
    removeEventListener(_type, fn) { listeners.delete(fn); },
    _notify(bytes) {
      const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (const fn of listeners) fn({ target: { value } });
    },
  };
}

// Publishes address one physical board: boards sharing a team topic (the
// unassigned pool) all see it, so "target" narrows to this board.
function publishTo(entry, channel, body) {
  if (!client) return;
  client.publish(`robots/${entry.hubTeam}/${channel}`,
    JSON.stringify({ ...body, target: entry.hubBoard }));
}

function makeMotorChar(entry) {
  let last = Uint8Array.of(0, 0);
  let stopTimer = null;
  const char = makeChar({
    read: () => last,
    write: (buf) => {
      const l = int8(buf[0]), r = int8(buf[1]);
      // 4-byte = planner pulse with explicit duration; 2-byte = joypad
      // stream — give it the contract default so motion holds between
      // re-writes, and zero drive an immediate expiry (= stop now).
      const durationMs = buf.length >= 4 ? (buf[2] << 8) | buf[3]
        : (l || r ? JOY_HOLD_MS : 0);
      publishTo(entry, "pwm", {
        timestamp: Date.now() / 1000,
        left_motor: pctToDuty(l), right_motor: pctToDuty(r),
        duration_ms: durationMs,
      });
      last = Uint8Array.of(buf[0], buf[1]);
      // Mirror the firmware's self-expiry on the card, like the BLE
      // watchdog notify does — after the pulse the rover IS stopped.
      clearTimeout(stopTimer);
      if ((l || r) && durationMs) {
        stopTimer = setTimeout(() => {
          last = Uint8Array.of(0, 0);
          char._notify(last);
        }, durationMs);
      }
    },
  });
  return char;
}

function makeLedChar(entry) {
  let on = 0;
  return makeChar({
    read: () => Uint8Array.of(on),
    write: (buf) => {
      on = buf[0] ? 1 : 0;
      publishTo(entry, "led", { method: "set_led", on: !!on, red: 0, green: 0, blue: 0 });
    },
  });
}

// probeRuntimeCaps' shape (ble-lifecycle.js), pointed at the fake service.
async function buildCaps(entry) {
  const service = {
    async getCharacteristic(uuid) {
      const chars = {
        [MOTOR_CHAR_UUID]: entry._hubMotorChar,
        [LED_CHAR_UUID]: entry._hubLedChar,
      };
      if (!chars[uuid]) throw new Error(`no hub mapping for ${uuid}`);
      return chars[uuid];
    },
  };
  for (const schema of entry.capSchema) {
    const make = RUNTIMES[schema.type];
    if (!make) continue;
    const cap = make(schema);
    Object.assign(entry, cap.initEntry());
    try { await cap.probe(entry, service); } catch { /* cap stays absent */ }
    entry.runtimeCaps.push(cap);
  }
}

async function upsert(team, sys) {
  const board = sys.board || team;
  const id = `hub:${board}`;
  let entry = state.devices.get(id);
  if (!entry) {
    entry = makeEntry(id, board, sys.hw || "hub");
    entry.ephemeral = true;   // presence-driven; never persisted (state.js)
    entry.capSchema = [
      { name: "motors", type: "signed-pair", range: [-100, 100] },
      { name: "led", type: "toggle" },
    ];
    entry._hubMotorChar = makeMotorChar(entry);
    entry._hubLedChar = makeLedChar(entry);
    state.devices.set(id, entry);
    entry.hubTeam = team;
    entry.hubBoard = board;
    await buildCaps(entry);
    log(`${board} online (team ${team})`, "hub");
  }
  entry.hubTeam = team;       // reassignment moves the board's topic
  const cameOnline = entry.status !== "connected";
  if (cameOnline) entry.status = "connected";
  entry.telemetry = {
    uptime_ms: sys.uptime_ms, free_heap: sys.free_heap,
    ...(sys.ip ? { ip: sys.ip } : {}),
  };
  entry.telemetryUpdatedAt = Date.now();
  entry.lastSysAt = Date.now();
  // Full render only on creation and offline→online; the steady-state 2 s
  // sys tick is telemetry-only, same surgical path as the BLE telemetry
  // notify (ble-lifecycle.js).
  if (cameOnline) renderEntry(entry);
  else renderers.patchSecondaryRow(entry);
}

function sweep() {
  const cutoff = Date.now() - OFFLINE_AFTER_MS;
  for (const entry of state.devices.values()) {
    if (!entry.ephemeral || entry.status !== "connected") continue;
    if ((entry.lastSysAt || 0) < cutoff) {
      entry.status = "idle";
      log(`${entry.hubBoard} went silent`, "hub");
      renderEntry(entry);
    }
  }
}

function dropAll(reason) {
  for (const entry of state.devices.values()) {
    if (!entry.ephemeral) continue;
    entry.status = "idle";
    renderEntry(entry);
  }
  log(`disconnected (${reason})`, "hub");
}

// ?hub=<host>[&hubuser=team1&hubpass=…] — see DEV.md.
export async function connectHub(host, { username, password } = {}) {
  const url = `ws://${host}:${WS_PORT}`;
  log(`connecting ${url}${username ? ` as ${username}` : " (anonymous, read-only)"}`, "hub");
  client = await connectMqtt(url, {
    username, password,
    onMessage(topic, payload) {
      const m = /^robots\/([^/]+)\/sys$/.exec(topic);
      if (!m) return;
      let sys;
      try { sys = JSON.parse(payload); } catch { return; }
      upsert(m[1], sys).catch(err => console.error("[hub] upsert", err));
    },
    onClose: () => dropAll("broker closed the session"),
  });
  client.subscribe("robots/+/sys");
  sweepTimer = setInterval(sweep, 5000);
  window.hub = { client, disconnect: () => { clearInterval(sweepTimer); client.close(); } };
  log("connected — watching robots/+/sys", "hub");
}
