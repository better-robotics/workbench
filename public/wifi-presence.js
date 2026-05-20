import { $, fetchWithTimeout } from "./dom.js";
import { state, loadKnown } from "./state.js";

// Probe each paired robot's :81/health endpoint to show "BR-XXXX on wifi"
// when the dashboard isn't BLE-connected to it. Pi-only; ESP32 firmware
// doesn't run an HTTP server (everything flows over BLE + WebRTC). ESP32
// still appears via BLE wifi-status notify when paired. Pi exposes
// pi_robot_health.py on :81 for service-crash detection (pi_robot_service
// field).
const HEALTH_PORT = 81;
const PROBE_TIMEOUT_MS = 4000;
const PROBE_INTERVAL_MS = 30000;

let wifiRobots = [];
let probeTimer = null;

async function probeUrl(url) {
  try {
    const res = await fetchWithTimeout(url, { mode: "cors" }, PROBE_TIMEOUT_MS);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function probeRobot(known) {
  // ESP32 firmware doesn't expose /health — presence shows up via the
  // BLE wifi-status notify when paired, not via passive probing.
  if (known.fwType === "esp32") return null;
  const candidates = [];
  if (known.name) {
    candidates.push(`http://${known.name.toLowerCase()}.local:${HEALTH_PORT}/health`);
  }
  const liveIp = state.devices.get(known.id)?.wifiStatus?.ip;
  if (liveIp) candidates.push(`http://${liveIp}:${HEALTH_PORT}/health`);
  if (!candidates.length) return null;
  const results = await Promise.allSettled(candidates.map(probeUrl));
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) return r.value;
  }
  return null;
}

async function probeTick() {
  const known = loadKnown();
  const found = [];
  await Promise.all(known.map(async (r) => {
    const health = await probeRobot(r);
    if (!health) return;
    found.push({ id: r.id, name: r.name, ...health });
  }));
  // Skip the render when the set didn't change — common case is the same
  // single Pi every 30s, and there's no reason to rewrite badge.textContent
  // to the same string forever.
  const sameSet = found.length === wifiRobots.length
    && found.every((r, i) => r.id === wifiRobots[i].id && r.name === wifiRobots[i].name);
  if (sameSet) return;
  wifiRobots = found;
  renderRobotPresence();
}

function renderRobotPresence() {
  const badge = $("robot-presence");
  if (!badge) return;
  if (wifiRobots.length === 0) { badge.hidden = true; return; }
  badge.hidden = false;
  badge.textContent = wifiRobots.length === 1
    ? `${wifiRobots[0].name || "Robot"} on wifi`
    : `${wifiRobots.length} robots on wifi`;
}

export function initRobotPresence() {
  if (probeTimer) return;
  probeTick();
  probeTimer = setInterval(probeTick, PROBE_INTERVAL_MS);
}
