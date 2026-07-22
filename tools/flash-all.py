#!/usr/bin/env python3
"""Flash one board's image to every connected ESP32 over USB, skipping ports
that aren't one.

Loops `pio run -e <BOARD> -t upload --upload-port <port>` over every serial
port whose USB vendor ID matches a known ESP32 bridge chip (FTDI, CP210x,
CH340, Espressif native USB-CDC) — the same allowlist the browser recovery
flasher uses (docs/recovery/boards.js:ESP_USB_VIDS). A hub's USB-gadget
console or any unrelated serial device reports a different vendor ID and gets
skipped instead of getting an esptool sync thrown at it.

All matched ports get the SAME board's image — set BOARD to the variant on the
bench. Usage:
    make flash-all BOARD=s3_cam    # builds s3_cam, flashes every ESP32 found
    BOARD=s3_cam tools/flash-all.py
"""
import json
import os
import subprocess
import sys
from pathlib import Path

try:
    import serial.tools.list_ports as list_ports
except ImportError:
    sys.exit("pyserial missing — `pip install pyserial` (PlatformIO bundles it in its venv)")

BOARD = os.environ.get("BOARD")
if not BOARD:
    sys.exit("BOARD env var required (aithinker_cam | devkit | s3_cam | c3_supermini)")

ROOT = Path(__file__).resolve().parent.parent
BOARDS_JS = ROOT / "docs/recovery/boards.js"
IDF_DIR = ROOT / "firmware/esp32_robot_idf"


def esp_vids():
    """Pull the VID allowlist from boards.js instead of duplicating it —
    single source of truth, shared with the browser recovery flasher."""
    out = subprocess.run(
        ["node", "-e", f"import({json.dumps(str(BOARDS_JS))}).then(m => console.log(JSON.stringify(m.ESP_USB_VIDS)))"],
        capture_output=True, text=True, cwd=ROOT,
    )
    if out.returncode != 0:
        sys.exit(f"couldn't read ESP_USB_VIDS from {BOARDS_JS}:\n{out.stderr}")
    return set(json.loads(out.stdout))


def main():
    vids = esp_vids()
    # Only USB devices report a vid at all — Bluetooth-Incoming-Port, the
    # macOS debug console, etc. come back None and aren't worth mentioning.
    usb_ports = [p for p in list_ports.comports() if p.vid is not None]
    matched = [p for p in usb_ports if p.vid in vids]
    skipped = [p for p in usb_ports if p.vid not in vids]

    # flush=True: without it, these interleave out of order with the flash
    # subprocesses' inherited-fd output once stdout isn't a TTY (e.g. piped
    # through `tail` or a CI log) — Python buffers, the child processes don't.
    for p in skipped:
        print(f"skip {p.device} (vid=0x{p.vid:04x}, {p.manufacturer or 'unknown vendor'} — not an ESP32 bridge)", flush=True)

    if not matched:
        sys.exit("no ESP32 boards found on USB (checked vid in " +
                  ", ".join(f"0x{v:04x}" for v in sorted(vids)) + ")")

    print(f"found {len(matched)} ESP32 board(s): {', '.join(p.device for p in matched)}", flush=True)

    failed = []
    for p in matched:
        print(f"\n==== flashing {BOARD} → {p.device} ====", flush=True)
        r = subprocess.run(["pio", "run", "-e", BOARD, "-t", "upload", "--upload-port", p.device], cwd=IDF_DIR)
        if r.returncode != 0:
            failed.append(p.device)

    ok = len(matched) - len(failed)
    print(f"\n{ok}/{len(matched)} flashed" + (f" — failed: {', '.join(failed)}" if failed else ""), flush=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
