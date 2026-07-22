# Hardware guide

## Current: ESP32-CAM-MB

The kit ships with the **ESP32-CAM-MB**: AI Thinker ESP32-CAM on a programmer carrier with a USB micro-B port. Plug in, flash from the dashboard. CI publishes prebuilt binaries in `docs/firmware/bins/` for every supported board — `aithinker_cam`, `devkit`, `s3_cam`, and `c3_supermini`; the dashboard's Flash button picks the right one from the detected chip.

**Bare ESP32-CAM ≠ ESP32-CAM-MB.** Two SKUs ship under the same name. The bare module has no USB; flashing requires an external FTDI/CP2102 adapter wired to U0R/U0T/GND with IO0 grounded for boot. The MB carrier *is* the USB-to-serial bridge. Buy the kit version unless you want the wiring exercise.

USB-UART chip on the MB carrier is CP2102 on most units, FT232R on some (silkscreened). macOS has the FTDI driver built in; CP2102 needs a [one-time kernel extension from Silicon Labs](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers).

Buy: AI Thinker ESP32-CAM-MB on Amazon and AliExpress. Confirm the listing includes the MB programmer carrier, not just the bare camera.

### Camera on the CAM-MB

The 24-pin socket accepts OV2640, OV3660, and OV5640 modules; Espressif's `esp_camera` driver auto-detects. Firmware uses the stock AI-Thinker pin map (XCLK 0, SIOD 26, SIOC 27, data 5/18/19/21/36/39/34/35, VSYNC 25, HREF 23, PCLK 22, PWDN 32). QVGA (320×240) JPEG at quality 18, fb_count=2 in PSRAM. One transport: **HTTP MJPEG** — `:81/stream` once WiFi joins; dashboard opens the stream as `<img>`. Same-LAN only.

Firmware advertises a `camera` capability and broadcasts the LAN IP on `wifi-status`.

### Motor wiring (L298N)

Default firmware pins: left `forward=14, backward=15`, right `forward=13, backward=4`. The schema names match gpiozero's `Motor(forward=, backward=, enable=)` constructor vocabulary. Camera + PSRAM consume 15 GPIOs; 13/14/15/4 are the survivors. GPIO 4 doubles as the white flash LED, so it flickers visibly when the right motor is driven — cosmetic only.

"Forward" / "backward" only mean what they say *after* the wiring is calibrated. The chip side speaks IN1..IN4 (silkscreen on the L298N/DRV8833/TB6612 board); each per-motor pair wires to two of those chip terminals. If a wheel spins the wrong direction, swap the motor leads at the driver — or swap the two GPIO assignments in the Pinout editor.

**Leave the L298N's ENA/ENB jumpers ON.** The 5V tie-up keeps the H-bridge enabled and lets PWM ride the direction pins. Forward = `forward-pin=PWM, backward-pin=LOW`; reverse = swap. Separate direction + enable control needs 6 GPIOs we don't have.

GPIO 15 is a strap pin — needs HIGH at boot for normal serial output. L298N's IN pins are high-impedance CMOS, but if your board has a weak pull-down on IN that fights the strap, add a 10k pull-up from GPIO 15 to 3.3V. Symptom: garbled serial during the first second of boot. Harmless if you don't need that bootloader log.

### Optional hardware mods (for stability under load)

The AI-Thinker module's onboard AMS1117 LDO sags hard when WiFi TX bursts coincide with camera DMA + BLE radio activity. Firmware disables the brownout detector to survive this (otherwise the chip resets mid-stream every few seconds); the hardware fix is two capacitors:

- **470 µF electrolytic + 0.1 µF ceramic across the AMS1117 3.3V output.** Solder between 3V3 and GND on the back of the AI-Thinker module. Absorbs camera-flash and WiFi TX transients. Single biggest reliability mod for ESP32-CAM.
- **100 µF on the 5V rail near the AI-Thinker 5V pin** (after the CAM-MB's LDO). Mostly relevant when battery-powered through the MB's 5V pin where there's no bulk cap upstream — USB from a Mac is generally fine without it.

The brownout-disabled firmware runs without these, trading "auto-protect on real undervolt" for "doesn't reset on transient dips."

## Freenove ESP32-S3-WROOM CAM

A published board (`s3_cam`) — CI builds it and the dashboard's Flash button
routes to it. The S3 upgrade over the AI-Thinker CAM: octal PSRAM, more free
GPIOs, and an onboard addressable RGB.

- **Camera** — OV2640 on the Freenove S3 pin map (XCLK 15, SIOD 4, SIOC 5, data 11/9/8/10/12/18/17/16, VSYNC 6, HREF 7, PCLK 13, no PWDN/RESET). Same `esp_camera` auto-detect + HTTP MJPEG (`:81/stream`) transport as the CAM-MB.
- **Onboard RGB** — a single WS2812 on GPIO48, driven by `ws2812.c` (led_strip/RMT). It backs the dashboard's **RGB** color-picker cap: the firmware fans the RGB characteristic write to both the 3-pin LEDC driver and the WS2812, so the same cap + UI works on either board with no client change.
- **Motors** — default to GPIO 1/2/42/41 (PWM-on-direction), chosen clear of the camera lines, the flash/octal-PSRAM block (26–37), USB (19/20), UART0 (43/44), and strapping pins. Remap in the Pinout editor for your carrier.
- **Flash offset** — the S3 bootloader lands at `0x0` (not `0x1000`); each board's `manifest.json` (written by `tools/pio-stage.py`) carries the per-target offset.
- **Flashing** — `make flash BOARD=s3_cam` (`pio run -e s3_cam -t upload`), or the dashboard web-flasher (auto-detects the S3 and picks the `s3_cam` bins).

## Forward path: ESP32-C6

Source compiles for the **ESP32-C6** too, but CI doesn't publish it yet — clone
and `make flash` locally. C6 is the BLE-first match: native USB CDC, Bluetooth
5.3 LE, better RAM headroom than S3 when TLS shares memory with BLE during OTA.
DevKitC-1 or any WROOM-based C6 board.

Buy in US: [Adafruit](https://www.adafruit.com/?q=ESP32-S3) (S3, C6), DigiKey, Mouser. Espressif's official store ships globally. The Freenove ESP32-S3-WROOM CAM kit ships from Amazon.

## Raspberry Pi (the classroom hub)

A Raspberry Pi doesn't run workbench firmware — it runs the classroom **hub**
(MQTT broker + dashboard the rovers talk to). Flash the flash-and-go image from
[`better-robotics/hub`](https://github.com/better-robotics/hub) and it
self-provisions: its own `hub-XXXX` Wi-Fi, the dashboard at `hub.local`, and a
USB-C recovery console. Hub wiring, the recovery plane, and image build all live
in that repo — workbench itself only drives ESP32 rovers.

## Board-specific knobs

Two variables track the ESP32 board:

- **board** — one PlatformIO env per board (`platformio.ini`): `pio run -e aithinker_cam|devkit|s3_cam|c3_supermini` (or `make compile BOARD=…`) sets the target and composes `sdkconfig.defaults` + `sdkconfig.defaults.board.<board>`. The `CONFIG_BR_BOARD_*` choice drives the pin-map defaults, forbidden-pin set, and camera/PSRAM/WS2812 presence.
- **LED pin** in `firmware/esp32_robot_idf/main/pin_config.c` — GPIO 33 active-low on the CAM-MB; no plain LED on the S3-CAM (its onboard LED is the WS2812 RGB, GPIO48, handled by `ws2812.c`). The dashboard's Pinout editor overrides pins at runtime via NVS, no rebuild.

The IDF partition layout (1.9 MB OTA slots, otadata at 0xE000) matches arduino-esp32's `min_spiffs` so a fielded ESP32 originally flashed with the .ino can OTA into this firmware without bricking.

After changing either, push to `main` — CI rebuilds and publishes. `make publish-firmware` previews locally before pushing.
