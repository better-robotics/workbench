const STORAGE_KEY = "better-robotics:known";

export const state = {
  devices: new Map(),
};

// Lazy injection to avoid a circular dep with connect.js.
let _onDisconnectedById = () => {};
export function setDisconnectHandler(fn) { _onDisconnectedById = fn; }

export function persist() {
  const out = [];
  for (const e of state.devices.values()) out.push({ id: e.id, name: e.name });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
}

export function loadKnown() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}

export function makeEntry(id, name) {
  return {
    id, name,
    device: null,
    status: "idle",
    ledChar: null, ledOn: false,
    wifiScanChar: null, wifiJoinChar: null, wifiStatusChar: null,
    wifiStatus: { st: "idle" }, wifiNetworks: null, wifiScanning: false,
    otaDataChar: null, otaStatusChar: null, otaStatus: { st: "idle" }, fwInfo: null,
    // Motors fields (motorsChar, motorsLeft/Right, motorsSending, motorsPending)
    // are assigned by the signed-pair runtime's initEntry() on connect.
    cameraSignalChar: null, cameraStatusChar: null,
    cameraPc: null, cameraStream: null,
    cameraRecvBuf: null, cameraStatus: null,
    lastEvent: null,
    capSchema: null,
    runtimeCaps: [],
    node: null,
  };
}

export function attachDevice(entry, device) {
  entry.device = device;
  device.addEventListener("gattserverdisconnected", () => _onDisconnectedById(entry.id));
}

export function entryFor(device) {
  const existing = state.devices.get(device.id);
  if (existing) {
    if (!existing.device) attachDevice(existing, device);
    return existing;
  }
  const entry = makeEntry(device.id, device.name || device.id);
  attachDevice(entry, device);
  state.devices.set(device.id, entry);
  persist();
  return entry;
}
