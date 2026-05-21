#!/usr/bin/env bash
# Per-board build wrapper. Composes the right sdkconfig defaults overlay,
# sets the IDF target, builds, and stages outputs to docs/firmware/bins/
# <BOARD>/. Locally reproducible — CI invokes the same script from its
# build matrix.
#
# Usage:
#   BOARD=aithinker_cam ./build.sh
#   BOARD=aithinker_cam_webrtc ./build.sh
#   BOARD=devkit ./build.sh
#   BOARD=c3_supermini ./build.sh

set -euo pipefail

BOARD="${BOARD:?BOARD env var required (aithinker_cam | aithinker_cam_webrtc | devkit | c3_supermini)}"

case "$BOARD" in
  aithinker_cam)
    TARGET=esp32
    DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.board.aithinker_cam"
    BOOTLOADER_OFFSET="0x1000"
    WANT_ESP_PEER=0
    ;;
  aithinker_cam_webrtc)
    TARGET=esp32
    DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.board.aithinker_cam;sdkconfig.defaults.board.aithinker_cam_webrtc"
    BOOTLOADER_OFFSET="0x1000"
    WANT_ESP_PEER=1
    ;;
  devkit)
    TARGET=esp32
    DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.board.devkit"
    BOOTLOADER_OFFSET="0x1000"
    WANT_ESP_PEER=0
    ;;
  c3_supermini)
    TARGET=esp32c3
    DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.board.c3_supermini"
    # esp32c3 has no ROM bootloader stub at 0x1000 — boot ROM jumps to 0x0.
    BOOTLOADER_OFFSET="0x0"
    WANT_ESP_PEER=0
    ;;
  *)
    echo "Unknown BOARD=$BOARD" >&2
    exit 1
    ;;
esac

# espressif/esp-idf-ci-action sets IDF_TARGET=esp32 by default in its
# docker -e flag. That clashes with `idf.py set-target esp32c3` (IDF
# refuses to override a target specified by the environment). Unset
# here so set-target picks the per-board target without interference.
unset IDF_TARGET

# Drive component inclusion via env var, not Kconfig. project()'s
# EXCLUDE_COMPONENTS has to be set before project() runs, but CONFIG_*
# vars from sdkconfig.cmake aren't populated until project() does. And
# in main/CMakeLists.txt, `if(CONFIG_*)` during idf_component_register
# was unreliable in the multi-overlay setup. Env var is set once here
# and consumed by both project-root and main CMakeLists.
if [ "$WANT_ESP_PEER" = "1" ]; then
  export BR_WANT_ESP_PEER=1
else
  unset BR_WANT_ESP_PEER
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# SDKCONFIG_DEFAULTS must be exported BEFORE set-target — that's the call
# that generates sdkconfig from the defaults files. `idf.py build` only
# re-reads defaults when sdkconfig is missing, so setting the env var
# on just the build line silently skips the overlays. Found via three
# CI runs that all defaulted BR_BOARD to AITHINKER_CAM regardless of
# what BOARD said.
export SDKCONFIG_DEFAULTS="$DEFAULTS"

# Version: mirrors what IDF embeds in esp_app_desc and what fw_info
# reports at runtime, so a user can cross-reference "what got flashed"
# against "what the chip says it's running." `--always` falls back to
# a short SHA if there's no tag yet. -dirty suffix when the working tree
# has uncommitted changes (local dev path; CI builds are always clean).
VERSION="$(git describe --always 2>/dev/null || echo unknown)"
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
  VERSION="${VERSION}-dirty"
fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Fresh sdkconfig per board — sdkconfig.defaults is only consulted when
# sdkconfig is absent or stale, so cross-board contamination is real if
# a previous build's sdkconfig persists. fullclean removes build/ so a
# restored cache from a different sdkconfig doesn't leak stale objects
# (worth ~2 min compile time but reliable; without it, CI ran with an
# old build/sdkconfig.h while sdkconfig said something else).
rm -f sdkconfig sdkconfig.old
idf.py fullclean || true
idf.py set-target "$TARGET"
idf.py build

# Stage outputs to docs/firmware/bins/<BOARD>/. Per-variant dirs so OTA
# self-update can route to the matching binary — fw_info advertises the
# variant-specific URL.
OUT="../../docs/firmware/bins/$BOARD"
mkdir -p "$OUT"
cp build/esp32_robot.bin                       "$OUT/firmware.bin"
cp build/bootloader/bootloader.bin             "$OUT/bootloader.bin"
cp build/partition_table/partition-table.bin   "$OUT/partitions.bin"
cp build/ota_data_initial.bin                  "$OUT/boot_app0.bin"

# Per-board manifest. Flasher reads this to learn flash offsets — bootloader
# offset differs between esp32 (0x1000) and esp32c3 (0x0). version/built_at
# are surfaced in the install dialog so the operator knows what they're
# about to flash before committing.
cat > "$OUT/manifest.json" <<EOF
{
  "board": "$BOARD",
  "chip": "$TARGET",
  "version": "$VERSION",
  "built_at": "$BUILT_AT",
  "files": [
    { "path": "bootloader.bin",  "offset": "$BOOTLOADER_OFFSET" },
    { "path": "partitions.bin",  "offset": "0x8000" },
    { "path": "boot_app0.bin",   "offset": "0xE000" },
    { "path": "firmware.bin",    "offset": "0x10000" }
  ]
}
EOF

echo "Built $BOARD ($TARGET) → $OUT/"
