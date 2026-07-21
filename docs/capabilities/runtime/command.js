// Schema: { name: "ops", char: "…d9c", type: "command" }
// Op-name vocabulary must match Pi's `_ops_handle_write` dispatcher.
import { UUIDS_BY_CAP, encodeJson } from "../../ble/ble.js";
import { logFor } from "../../log.js";
import { state } from "../../state.js";

export async function sendCommand(entry, capName, msg) {
  const ch = entry?.[`${capName}Char`];
  if (!ch) return false;
  try {
    await ch.writeValueWithResponse(encodeJson(msg));
    return true;
  } catch (err) {
    logFor(entry, `${capName} write failed: ${err.message}`);
    return false;
  }
}

// restartService / rebootRobot share the confirm → ops-write → log flow;
// only the strings differ.
async function confirmedOpsCommand(id, op, confirmText, logText) {
  const entry = state.devices.get(id);
  if (!entry?.opsChar) {
    logFor(entry || { name: "?", lastEvent: null }, `${op} unavailable on this robot`);
    return;
  }
  if (!confirm(confirmText)) return;
  if (await sendCommand(entry, "ops", { op })) {
    logFor(entry, logText);
  }
}

export function restartService(id) {
  return confirmedOpsCommand(id, "restart-service",
    `Restart the robot's service?\n\nThis disconnects BLE briefly. ` +
    `Click Reconnect on the robot card once the service is back (~5–10 s).`,
    "service restart requested");
}

export function rebootRobot(id) {
  return confirmedOpsCommand(id, "reboot",
    `Reboot the robot?\n\nFull system reboot — needed when a kernel-owned ` +
    `resource is stuck (camera, USB gadget, etc.) and a service restart ` +
    `can't clear it. BLE drops for 30–60 s.`,
    "reboot requested");
}

export async function installPackage(id, name, opts = {}) {
  const entry = state.devices.get(id);
  if (!entry?.opsChar) {
    logFor(entry || { name: "?", lastEvent: null }, "ops unavailable on this robot");
    return;
  }
  if (opts.confirm && !confirm(opts.confirm)) return;
  if (await sendCommand(entry, "ops", { op: "install-pkg", args: { name } })) {
    logFor(entry, `${name} install requested`);
  }
}

export async function getLog(id, lines = 200, unit = null) {
  const entry = state.devices.get(id);
  if (!entry?.opsChar) return false;
  // `unit` selects a systemd unit on hosts that have one; ESP32 has a single
  // ring buffer and ignores it, so it's omitted unless a caller asks for one.
  const args = unit ? { lines, unit } : { lines };
  return sendCommand(entry, "ops", { op: "get-log", args });
}

export async function getConfig(id) {
  const entry = state.devices.get(id);
  if (!entry?.opsChar) return false;
  return sendCommand(entry, "ops", { op: "get-config" });
}

export function makeCommandCap(schema) {
  const { name } = schema;
  const char = schema.char || UUIDS_BY_CAP[name];
  const charField = `${name}Char`;
  return {
    name,
    schema,
    initEntry: () => ({ [charField]: null }),
    async probe(entry, service) {
      try {
        entry[charField] = await service.getCharacteristic(char);
      } catch {
        entry[charField] = null;
      }
    },
    cleanup(entry) { entry[charField] = null; },
    renderSection() { return ""; },  // commands surface at the menu level, not per-card
    wireActions() {},
  };
}
