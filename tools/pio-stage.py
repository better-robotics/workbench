#!/usr/bin/env python3
"""Stage a PlatformIO-built board's bins into docs/firmware/bins/<board>/
for the dashboard web-flasher + BLE-OTA paths, with a manifest.json carrying
the per-chip flash offsets. The pio successor to build.sh's copy+manifest tail
— run after `pio run -e <board>`.

    python3 tools/pio-stage.py <board>        # e.g. s3_cam

Reads the target from the pio-generated sdkconfig.<board>; the ESP32-S3 and
C3 bootloaders sit at 0x0 (no ROM stub at 0x1000), the classic ESP32 at 0x1000.
"""
import datetime
import json
import os
import shutil
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IDF_DIR = os.path.join(REPO_ROOT, "firmware", "esp32_robot_idf")


def target_of(board):
    """Read CONFIG_IDF_TARGET from the pio-generated sdkconfig.<board>."""
    path = os.path.join(IDF_DIR, f"sdkconfig.{board}")
    if not os.path.exists(path):
        sys.exit(f"no sdkconfig.{board} — build first: pio run -e {board}")
    with open(path) as f:
        for line in f:
            if line.startswith("CONFIG_IDF_TARGET="):
                return line.split('"')[1]
    sys.exit(f"CONFIG_IDF_TARGET not found in sdkconfig.{board}")


def version():
    try:
        v = subprocess.check_output(["git", "describe", "--always"], cwd=REPO_ROOT).decode().strip()
    except Exception:
        v = "unknown"
    try:
        subprocess.check_call(["git", "diff-index", "--quiet", "HEAD", "--"], cwd=REPO_ROOT)
    except Exception:
        v += "-dirty"
    return v


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: pio-stage.py <board>")
    board = sys.argv[1]
    target = target_of(board)
    # esp32 bootloader lands at 0x1000; esp32s3 / esp32c3 have no ROM stub there
    # and boot from 0x0.
    boot_offset = "0x1000" if target == "esp32" else "0x0"

    build_dir = os.path.join(IDF_DIR, ".pio", "build", board)
    out_dir = os.path.join(REPO_ROOT, "docs", "firmware", "bins", board)
    os.makedirs(out_dir, exist_ok=True)

    # pio output name → published name. boot_app0.bin keeps the arduino-era
    # name the OTA-data slot has always shipped under.
    copies = {
        "firmware.bin": "firmware.bin",
        "bootloader.bin": "bootloader.bin",
        "partitions.bin": "partitions.bin",
        "ota_data_initial.bin": "boot_app0.bin",
    }
    for src_name, dst_name in copies.items():
        src = os.path.join(build_dir, src_name)
        if not os.path.exists(src):
            sys.exit(f"missing {src} — did `pio run -e {board}` succeed?")
        shutil.copy(src, os.path.join(out_dir, dst_name))

    manifest = {
        "board": board,
        "chip": target,
        "version": version(),
        "built_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "files": [
            {"path": "bootloader.bin", "offset": boot_offset},
            {"path": "partitions.bin", "offset": "0x8000"},
            {"path": "boot_app0.bin", "offset": "0xE000"},
            {"path": "firmware.bin", "offset": "0x10000"},
        ],
    }
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    print(f"staged {board} ({target}) → docs/firmware/bins/{board}/")


if __name__ == "__main__":
    main()
