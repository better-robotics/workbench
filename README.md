# Better Robotics

**Open a tab, pair a robot, ship code.**

[![Build firmware](https://github.com/better-robotics/better-robotics.github.io/actions/workflows/build-firmware.yml/badge.svg)](https://github.com/better-robotics/better-robotics.github.io/actions/workflows/build-firmware.yml)

## What this is

Browser is the IDE. Coding panel + capability cards. localStorage is the file system; BLE is the runtime link.

## Architecture

```
┌──────────────────┐                                        ┌──────────────────┐
│  Chrome browser  │ ◄────── BLE GATT (control plane) ────► │  Robot firmware  │
│  (Web Bluetooth) │            commands · state            │  (ESP32 or Pi)   │
└──────────────────┘                                        └──────────────────┘
          ▲                                                           ▲
          ├──────────────────── WiFi (data plane) ────────────────────┤
          │                  camera (WebRTC · HTTP)                   │
          │                                                           │
          └───────────────── USB-C (recovery plane) ──────────────────┘
                        ECM ethernet · ACM serial console
```

- **Control plane — BLE.** Always on. Commands, telemetry, state changes, ops. ~1–3 Mbps, reliable, network-free. Pairing UI is the gatekeeper; no credentials cross the air.
- **Data plane — WiFi, optional.** Onboarded via BLE when needed. Carries video, large OTA, cloud LLM calls. Robots work fully without it.
- **Recovery plane — USB-C.** Composite USB gadget (ECM + ACM serial) under its own systemd unit, independent of robot firmware. Dashboard exposes an xterm.js terminal over this.

## Quickstart

### Use it

1. Open [better-robotics.github.io](https://better-robotics.github.io/) in Chrome or Edge.
2. Flash or prepare hardware:
   - **ESP32 on USB:** click **Flash firmware**
   - **Pi 4 with a flashed SD card:** click **Customize card** and point it at the mounted boot partition.
3. Click **Scan**, pair a robot, toggle LED, onboard WiFi, drive motors.

### Develop locally

```bash
make setup          # one-time ESP-IDF + arduino-cli setup (macOS)
make flash          # build ESP32 firmware, upload over USB
make preview        # serve the dashboard at http://localhost:8000
```

## Repo layout

```
firmware/esp32_robot_idf/   ESP32 firmware (ESP-IDF)
firmware/pi_robot/          Raspberry Pi firmware (Python + bless)
docs/                     Dashboard — static ES modules, no build step
tests/                      Pure-function unit tests · make smoke
.claude/                    Agent + project context
```

ESP32 and Pi expose the same service UUID and characteristic UUIDs, so the dashboard talks to either without conditional logic. `docs/` is the GitHub Pages publish root — the site is the directory, no build step.

## Browser support

Web Bluetooth: Chrome, Edge, Opera on desktop and Android. Not Safari. Firefox only behind a flag.

