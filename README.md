# Better Robotics

**Open a tab, pair a robot, ship code.**

[![Build firmware](https://github.com/better-robotics/workbench/actions/workflows/build-firmware.yml/badge.svg)](https://github.com/better-robotics/workbench/actions/workflows/build-firmware.yml)

## What this is

Browser is the IDE. Coding panel + capability cards. localStorage is the file system; BLE is the runtime link.

## Architecture

```
┌──────────────────┐                                        ┌──────────────────┐
│  Chrome browser  │ ◄────── BLE GATT (control plane) ────► │  Robot firmware  │
│  (Web Bluetooth) │            commands · state            │     (ESP32)      │
└──────────────────┘                                        └──────────────────┘
          ▲                                                           ▲
          ├──────────────────── WiFi (data plane) ────────────────────┤
          │                    camera (HTTP MJPEG)                    │
          │                                                           │
          └───────────────────── USB (recovery plane) ────────────────┘
                             serial console (Web Serial)
```

- **Control plane — BLE.** Always on. Commands, telemetry, state changes, ops. ~1–3 Mbps, reliable, network-free. Pairing UI is the gatekeeper; no credentials cross the air.
- **Data plane — WiFi, optional.** Onboarded via BLE when needed. Carries video (MJPEG), large OTA, cloud LLM calls. Robots work fully without it.
- **Recovery plane — USB.** The ESP32's USB-UART bridge exposes a serial console the workbench drives over Web Serial (xterm.js), independent of the BLE link.

## Quickstart

### Use it

1. Open the workbench — the **About** link on this repo — in Chrome or Edge.
2. Flash or set up hardware:
   - **ESP32 on USB:** click **Flash firmware**
   - **Raspberry Pi:** it runs the classroom **hub**, not workbench firmware — flash the flash-and-go image from [`better-robotics/hub`](https://github.com/better-robotics/hub) and it self-provisions.
3. Click **Scan**, pair a robot, toggle LED, onboard WiFi, drive motors.

### Develop locally

```bash
make setup          # one-time ESP-IDF + arduino-cli setup (macOS)
make flash          # build ESP32 firmware, upload over USB
make preview        # serve the workbench at http://localhost:8000
```

## Repo layout

```
firmware/esp32_robot_idf/   ESP32 firmware (ESP-IDF)
docs/                     Workbench — static ES modules, no build step
tests/                      Pure-function unit tests · make smoke
.claude/                    Agent + project context
```

The workbench drives ESP32 rovers over BLE; a Raspberry Pi runs the classroom hub ([`better-robotics/hub`](https://github.com/better-robotics/hub)), not workbench firmware. `docs/` is the GitHub Pages publish root — the site is the directory, no build step.

## Browser support

Web Bluetooth: Chrome, Edge, Opera on desktop and Android. Not Safari. Firefox only behind a flag.

