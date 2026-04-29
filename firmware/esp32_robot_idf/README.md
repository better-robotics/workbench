# esp32_robot — ESP-IDF migration

Replaces `firmware/esp32_robot/esp32_robot.ino` (Arduino single-file sketch).
Lives in parallel during the migration; the Arduino project stays the
shipping firmware until this one is feature-complete and tested.

## Why migrate

Per `working.md` item I, the project commits to **WebRTC as the
unified byte transport across the fleet**. The Pi side runs aiortc
(Python). The ESP32 side needs to be a peer too — own its camera as
a video track, expose DataChannels for control / OTA / logs, signal
through `wss://signal.neevs.io/esp32-rtc-<robotId>/ws` symmetric with
the Pi's `pi-rtc-<robotId>`.

`libpeer` (sepfy) is the chosen WebRTC C library — pure C, ~6 KLOC,
designed for ESP32. Its first-class build target is **ESP-IDF**, not
Arduino. Trying to embed it as an Arduino library is multi-day setup
and ongoing maintenance pain. Migrating once to ESP-IDF lets the
component-manager handle dependency wiring and gives us a clean path
to managed updates.

End-state architecture: every robot is a WebRTC peer, every byte
stream rides the same substrate, the dashboard speaks one language
to everything.

## Migration arc

The migration ships across many commits. Each lands a verified subset
so the project always has a working firmware target.

**Phase 2.A — Foundation (this commit, scaffold only).**
- Project skeleton: top-level `CMakeLists.txt`, `sdkconfig.defaults`,
  `partitions.csv` matching the Arduino project's OTA layout.
- `main/idf_component.yml` declaring `libpeer` and `esp32-camera`
  managed-component dependencies.
- `main/app_main.c` with init-order placeholder + TODO list pointing
  at the Arduino .ino sections each migrated subsystem comes from.
- No actual functional code migrated. Arduino sketch is still the
  shipping firmware.

**Phase 2.B — Connectivity skeleton.**
- WiFi STA bring-up (matches `setup()` order in .ino).
- NimBLE server skeleton — service UUID + empty characteristics.
- mDNS publish.
- Build verifies, flashes, boots, advertises BLE and joins WiFi. No
  capabilities yet.

**Phase 2.C — Capability port.**
- Motors (LEDC PWM). Pin config via NVS (Preferences-equivalent).
- LED + Flash.
- WiFi-scan + WiFi-join characteristic handlers.
- OTA characteristic handler (esp_ota_write).
- Snapshot characteristic.
- Camera init + MJPEG HTTP server on `:81`.

**Phase 2.D — WebRTC peer.**
- `webrtc_peer.c/.h` integrating libpeer.
- Signaling client connecting to `wss://signal.neevs.io/esp32-rtc-<robotId>/ws`.
- DataChannel handlers for `shell` (limited / sandboxed),
  `ota` (ESP32 OTA via WebRTC), `logs` (UART tail equivalent).
- Camera video track — H.264 hardware encode on ESP32-S3, MJPEG-in-RTP
  on classic ESP32 (no H.264 encoder).
- Dashboard's `webrtc-robot.js` extends to receive media tracks (the
  current code is data-channel-only).

**Phase 2.E — Cutover.**
- Build the IDF firmware as the canonical bin.
- Update `Makefile`'s `publish-firmware` target to publish the IDF
  build instead of the Arduino build.
- Field-test the IDF firmware on real hardware against the
  dashboard's Phase 1 surface (motors, LED, OTA).
- Once verified, delete `firmware/esp32_robot/` (the Arduino project)
  and rename `firmware/esp32_robot_idf/` → `firmware/esp32_robot/`.

## Targets

- **ESP32-S3** (canonical): Octal PSRAM + hardware H.264 encoder make
  WebRTC video tracks efficient. Same firmware binary as the classic
  ESP32 path with build-time camera-pipeline selection.
- **ESP32-CAM-MB** (AI-Thinker, classic ESP32 + 4 MB SPI PSRAM): the
  user's current hardware. No H.264 — camera path uses MJPEG-in-RTP
  (RFC 2435). Tighter SRAM budget; libpeer footprint matters.

Build:
```sh
idf.py set-target esp32s3   # or esp32 for the CAM-MB
idf.py build
idf.py flash monitor
```

## Status

**Phase 2.A — scaffold only.** No code migrated yet. The Arduino
sketch at `firmware/esp32_robot/esp32_robot.ino` is still the
shipping firmware. Each subsequent migration phase lands as its own
commit with explicit "what now works" notes.
