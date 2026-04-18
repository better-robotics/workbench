# Better Robotics

BLE-first robotics kit. Turn on a robot, open a Chrome tab, see it appear. No WiFi credentials, no network joining, no configuration files.

## Why BLE-first

Classroom and demo environments rarely give you a joinable WiFi network. The ones that do usually block multicast (so mDNS fails), require captive-portal logins (so ESP32s can't join), or have client isolation (so peers can't see each other). Every WiFi-first onboarding story collapses in a real classroom.

BLE avoids the problem entirely:
- Robot advertises the moment it boots — no network to join
- Laptop scans and sees every robot in the room
- Multi-robot discovery is just multi-scan
- Laptop's own WiFi stays connected (for internet, AI APIs)
- Zero credentials, ever

## Architecture

Two channels, each doing what it's best at:

- **BLE — control plane.** Always on. Carries commands, telemetry, state changes, and update triggers. Low bandwidth (~1–3 Mbps) but reliable and network-free. The browser's pairing UI is the gatekeeper; no credentials cross the air.
- **WiFi — data plane, optional.** Onboarded via BLE when a robot wants it. Carries anything too big for BLE: large OTA payloads, video streams, cloud ML inference. Robots work fully without it.

Each robot advertises a single BLE GATT service. Capabilities (LED, motors, sensors, WiFi config, OTA) are characteristics inside it. A `fw-info` characteristic reports the robot's type and where to fetch its firmware — BLE-streamed for small payloads (Pi's 9 KB Python), WiFi-fetched when that's faster (ESP32's 1.6 MB binary). Same control protocol, different data plane per robot.

```
┌──────────────────┐      BLE GATT (always on)       ┌──────────────────┐
│  Chrome browser  │ ◄──────────────────────────────► │  Robot firmware  │
│  (Web Bluetooth) │   commands · state · triggers    │  (ESP32 or Pi)   │
└──────────────────┘                                  └──────────────────┘
          ▲                                                     ▲
          └───────────── WiFi (data plane, optional) ───────────┘
                  large OTA · video · cloud calls
```

- **No server, no broker, no cloud in the critical path.** The browser pairs directly with the robot over BLE. WiFi, when present, is used only for content fetched from the same GitHub Pages deploy that serves the dashboard itself.

### Safety on disconnect

Every actuator characteristic (motor, servo, pump, relay — anything that moves, heats, or draws current) ships with a watchdog built into the firmware. Writes reset a timer; if no write lands within the window (default 500 ms), the firmware reverts to a safe default on its own and notifies the dashboard so the UI stays honest.

This is the architecture's answer to "what happens when the channel drops?" — operator out of range, browser tab closes, laptop sleeps. A second comms channel doesn't help with any of those (the operator is just gone), but a watchdog does. The rule applies to any new actuator capability we add — don't layer safety above; make silence itself the trigger for the safe state.

## Scope of this repo (today)

- `firmware/esp32_robot/` — ESP32 variant. Advertises BLE, handles LED control, WiFi onboarding, and OTA self-update.
- `firmware/pi_robot/` — Raspberry Pi variant (Python + `bless`). Same service UUID, same characteristic UUIDs — indistinguishable from the ESP32 side of the dashboard. Same capabilities plus offline-first install.
- `public/index.html` — Chrome dashboard: scans over BLE, pairs, controls LED, onboards WiFi, triggers OTA, prints QR labels per robot.
- `public/prepare.html` — browser-based SD-card prep for fresh Pis (File System Access API).

Each robot's capabilities grow by adding characteristics to the shared service. Motors, sensors, cameras, and more are future characteristics, not future protocols.

## Quickstart

### Using the project (no install)

1. Open [neevs.io/better-robotics](https://neevs.io/better-robotics/) in Chrome or Edge.
2. Flash or prepare hardware:
   - **ESP32 on USB:** click **Flash firmware** — bins come from GitHub Pages, no local toolchain.
   - **Pi 4 with a flashed SD card:** open [prepare.html](https://neevs.io/better-robotics/prepare.html) and point it at the mounted boot partition.
3. Click **Scan for new**, pair a robot, toggle LED, onboard WiFi, drive motors. Future updates go over BLE via **Update firmware**.

### Editing firmware (contributors)

```bash
make setup          # one-time — arduino-cli + ESP32 core (macOS)
make flash          # compile local source, upload over USB — fast iteration
make preview        # serve the dashboard locally while you iterate
```

Commit + push when ready. CI rebuilds firmware artifacts on every change under `firmware/**` and commits them back; devices pick up the new version via OTA. No need to run `make publish-*` locally unless you want to preview before pushing.

## Hardware

### Recommended: ESP32-S3 with native USB

For new builds, pick an **ESP32-S3 board with native USB** — ESP32-S3-CAM, Freenove ESP32-S3-WROOM dev kit, or any DevKitC-S3. The S3 exposes USB CDC directly from the chip, so Web Serial talks straight to it on macOS, Windows, and Linux with **no drivers to install**. Same Arduino core, same BLE stack, same firmware with minor board-knob changes (below).

### Legacy: ESP32-CAM-MB

The published binaries currently target the **ESP32-CAM-MB** (AI Thinker ESP32-CAM + MB programmer carrier) — the original development hardware. Its USB-UART bridge is CP210x (Silicon Labs) or FT232R (FTDI). macOS has the FTDI driver built in; CP210x requires a [one-time kernel extension install](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers). Works, but it's the friction the S3 recommendation is meant to sidestep.

### Board-specific knobs

Two variables need to match your board:

- **`FQBN`** in `Makefile` — `esp32:esp32:esp32cam:PartitionScheme=min_spiffs` for CAM-MB; for S3, something like `esp32:esp32:esp32s3:PartitionScheme=min_spiffs,USBMode=default,CDCOnBoot=cdc` (run `arduino-cli board listall` for exact identifiers on your core version).
- **`LED_PIN`** in `firmware/esp32_robot/esp32_robot.ino` — GPIO 33 active-low on CAM-MB. S3 boards vary; many use a WS2812 neopixel on GPIO 48, which needs a different driver entirely.

`min_spiffs` is load-bearing across both: its dual 1.9 MB app partitions are what OTA needs to stage an update without wiping the running image.

After changing either, push to `main` — CI rebuilds and publishes the new binary automatically. (Run `make publish-firmware` locally only to preview before pushing.)

## Browser support

Web Bluetooth works in Chrome, Edge, and Opera (desktop + Android). It does **not** work in Safari on iOS or macOS, and it is behind a flag in Firefox. This is a deliberate constraint — the laptop is the central brain.

## Status

End-to-end loop works on Pi 4 and ESP32-CAM-MB hardware: pair over BLE, toggle LED, onboard WiFi, OTA the firmware, print QR labels. Control/data channel split validated. Expanding to motors, sensors, and multi-robot coordination from this shape.

## License

TBD.
