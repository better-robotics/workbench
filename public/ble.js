// UUIDs are generated from protocol/uuids.json (see tools/gen-uuids.py).
// `ble.js` re-exports them so existing import sites keep working unchanged
// AND adds the dashboard-side helpers nobody else needs (CHUNK_BYTES,
// UUIDS_BY_CAP, decodeJson, encodeJson). Edit the JSON + run
// `make gen-uuids` to add a new BLE characteristic; both firmwares pull
// from the same source so a typo can't silently desync the protocol.
export * from "./uuids.js";
import {
  LED_CHAR_UUID, FLASH_CHAR_UUID, MOTOR_CHAR_UUID,
  WIFI_SCAN_CHAR_UUID, WIFI_JOIN_CHAR_UUID, WIFI_STATUS_CHAR_UUID,
  OTA_DATA_CHAR_UUID, OTA_STATUS_CHAR_UUID,
  CAMERA_SIGNAL_CHAR_UUID, CAMERA_STATUS_CHAR_UUID,
  OPS_CHAR_UUID,
  SNAPSHOT_REQUEST_CHAR_UUID, SNAPSHOT_DATA_CHAR_UUID,
} from "./uuids.js";

// Chunked-frame protocol shared by OTA and camera signaling: begin carries a
// u32 big-endian length, chunks append, commit parses + acts, stop tears down.
export const CHUNK_BYTES = 180;  // safe under ATT MTU on macOS/Chrome.

// Canonical capability-name → char UUID(s). Lets fw-info.caps stay tiny (must
// fit in one ~180 B ATT read) — the dashboard looks up chars by cap name.
export const UUIDS_BY_CAP = {
  led:    LED_CHAR_UUID,
  flash:  FLASH_CHAR_UUID,
  motors: MOTOR_CHAR_UUID,
  wifi:   { scan: WIFI_SCAN_CHAR_UUID, join: WIFI_JOIN_CHAR_UUID, status: WIFI_STATUS_CHAR_UUID },
  ota:    { data: OTA_DATA_CHAR_UUID, status: OTA_STATUS_CHAR_UUID },
  camera: { signal: CAMERA_SIGNAL_CHAR_UUID, status: CAMERA_STATUS_CHAR_UUID },
  ops:    OPS_CHAR_UUID,
  snapshot: { request: SNAPSHOT_REQUEST_CHAR_UUID, data: SNAPSHOT_DATA_CHAR_UUID },
};

export const decodeJson = (dv) => {
  try {
    const text = new TextDecoder().decode(dv);
    return text ? JSON.parse(text) : null;
  } catch { return null; }
};
export const encodeJson = (obj) => new TextEncoder().encode(JSON.stringify(obj));
