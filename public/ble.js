// UUIDs must match firmware/pi_robot/pi_robot.py and firmware/esp32_robot/esp32_robot.ino exactly.
export const SERVICE_UUID          = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d91";
export const LED_CHAR_UUID         = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d92";
export const WIFI_SCAN_CHAR_UUID   = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d93";
export const WIFI_JOIN_CHAR_UUID   = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d94";
export const WIFI_STATUS_CHAR_UUID = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d95";
export const OTA_DATA_CHAR_UUID    = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d96";
export const OTA_STATUS_CHAR_UUID  = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d97";
export const FW_INFO_CHAR_UUID     = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d98";
export const MOTOR_CHAR_UUID       = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d99";
export const CAMERA_SIGNAL_CHAR_UUID = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d9a";
export const CAMERA_STATUS_CHAR_UUID = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d9b";
export const OPS_CHAR_UUID            = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d9c";
export const ROBOT_STATUS_CHAR_UUID   = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d9d";
export const OPS_RESPONSE_CHAR_UUID   = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d9e";
export const TELEMETRY_CHAR_UUID      = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d9f";

// Heartbeat is a separate, always-on service from firmware/pi_robot/heartbeat.py.
// Distinct UUID family so the dashboard can scan for the heartbeat alone when
// pi-robot.service is dead and only the recovery-plane process is advertising.
export const HEARTBEAT_SVC_UUID       = "b6e8d5f3-2c9d-4bba-ae5e-6f9b8c7d5eb0";
export const HEARTBEAT_CHAR_UUID      = "b6e8d5f3-2c9d-4bba-ae5e-6f9b8c7d5eb1";

// BLE snapshot — ESP32 firmware. One-shot JPEG over BLE notify, no WiFi
// required. Distinct from the WebRTC camera-signal pair (different intent:
// snapshot is BLE-native, not signaling for an out-of-band stream). Same
// chunked envelope as OTA: 0x01 begin+u32 len, 0x02 chunk, 0x03 commit,
// 0xff err+text.
export const SNAPSHOT_REQUEST_CHAR_UUID = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4da0";
export const SNAPSHOT_DATA_CHAR_UUID    = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4da1";
// Camera profile picker — write JSON {"profile":"compact|standard|full"}.
// Firmware persists to Preferences and restarts. Current profile + available
// profile names live in fw-info's camera cap entry.
export const CAMERA_PROFILE_CHAR_UUID    = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4da2";

// Chunked-frame protocol shared by OTA and camera signaling: begin carries a
// u32 big-endian length, chunks append, commit parses + acts, stop tears down.
export const CHUNK_BYTES = 180;  // safe under ATT MTU on macOS/Chrome.

// Canonical capability-name → char UUID(s). Lets fw-info.caps stay tiny (must
// fit in one ~180 B ATT read) — the dashboard looks up chars by cap name.
export const UUIDS_BY_CAP = {
  led:    LED_CHAR_UUID,
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
