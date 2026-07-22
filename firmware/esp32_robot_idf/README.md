# esp32_robot — ESP-IDF firmware

Firmware for the ESP32 robot tier. Built with **PlatformIO** (ESP-IDF 5.5.3 via `espressif32@6.13.0`), NimBLE host, esp32-camera. One env per board in `platformio.ini`.

## Build

```sh
pio run -e s3_cam              # build one board
pio run -e s3_cam -t upload    # flash it
pio device monitor -b 115200   # serial monitor
pio run                        # build every board
```

Boards: `aithinker_cam` · `devkit` · `s3_cam` · `c3_supermini`. Each env composes `sdkconfig.defaults` + `sdkconfig.defaults.board.<board>` (which sets the `CONFIG_BR_BOARD_*` Kconfig choice) via `board_build.cmake_extra_args`.

From repo root: `make compile` (all boards), `make flash BOARD=s3_cam`, `make monitor`.

`make publish-firmware` builds every board and stages the bins + `manifest.json` to `docs/firmware/bins/<board>/` (via `tools/pio-stage.py`) for the dashboard's web-flasher and OTA paths. CI runs the same steps on every push to `firmware/**`.

## Subsystem map

```
main/
  app_main.c        — init order: NVS → camera → caps → BLE → WiFi → HTTP
  pin_config.{c,h}  — NVS-backed pin overrides for LED / flash / motors
  led.{c,h}         — active-low GPIO toggle
  flash.{c,h}       — LEDC PWM (channel 4)
  motors.{c,h}      — H-bridge PWM (channels 0-3) + watchdog + LLM pulse safety
  camera.{c,h}      — esp32-camera w/ AI-Thinker pin map; QVGA q=18, fb_count=2
  http_stream.{c,h} — :81 MJPEG stream — the only camera video transport
  ota.{c,h}         — esp_ota_* state machine; BLE protocol + HTTP shared
  snapshot.{c,h}    — BLE single-frame transfer (begin/chunk/commit)
  ble_host.{c,h}    — NimBLE init + advertising + active-conn tracking
  gatt_svr.{c,h}    — GATT service table + access callbacks
  wifi_sta.{c,h}    — STA bring-up + scan/join/status (event-driven)
  fw_info.{c,h}     — capability advertisement JSON, built once at boot
  telemetry.{c,h}   — uptime / heap / IP, every 10s
  restart_util.{c,h} — deferred restart (used by pin/cam/ota commit paths)
```

## Partition table

Matches arduino-esp32's `min_spiffs` so an OTA from .ino-firmware → IDF-firmware writes to the same slot. Only the app bin gets pushed over BLE OTA; bootloader and partition table stay put.

```
nvs       0x9000   20K
otadata   0xE000    8K
ota_0    0x10000 1920K
ota_1   0x1F0000 1920K
```

## Boards

- **aithinker_cam** — AI-Thinker ESP32-CAM (classic ESP32 + 4 MB SPI PSRAM). The headline board; camera over HTTP MJPEG (`:81/stream`).
- **devkit** — ESP32 DevKitV1 / WROOM-32. No camera, ~25 usable GPIOs.
- **s3_cam** — Freenove ESP32-S3-WROOM CAM (octal PSRAM, OV2640, onboard WS2812 RGB). See `HARDWARE.md`.
- **c3_supermini** — ESP32-C3 SuperMini (RISC-V, native USB). No camera.
