#!/usr/bin/env bash
# Write Raspberry Pi OS Lite 64-bit to an SD card. macOS only.
# After this, use the dashboard's "Customize card" dialog to stage pi_robot.
set -euo pipefail

IMAGE_URL="https://downloads.raspberrypi.com/raspios_lite_arm64_latest"
SHA_URL="${IMAGE_URL}.sha256"
CACHE_DIR="${HOME}/.cache/better-robotics"
IMG="${CACHE_DIR}/raspios_lite_arm64_latest.img.xz"
SHA="${IMG}.sha256"

[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS only (uses diskutil)." >&2; exit 1; }
for bin in curl shasum diskutil xzcat dd; do
  command -v "$bin" >/dev/null || { echo "Missing: $bin" >&2; exit 1; }
done

if [[ -n "${DISK:-}" ]]; then
  TARGET="$DISK"
  [[ -b "$TARGET" || -c "$TARGET" ]] || { echo "Not a block device: $TARGET" >&2; exit 1; }
else
  # diskutil list prints one "/dev/diskN (external, physical):" line per disk.
  # Portable to bash 3.2 (macOS default) — no mapfile/readarray.
  DISKS=()
  while IFS= read -r line; do DISKS+=("$line"); done < <(diskutil list external physical | awk '/^\/dev\/disk[0-9]+ / {print $1}')
  if (( ${#DISKS[@]} == 0 )); then
    echo "No external disk found. Plug in the SD card reader and retry." >&2
    exit 1
  elif (( ${#DISKS[@]} > 1 )); then
    echo "Multiple external disks found — pick one explicitly:" >&2
    for d in "${DISKS[@]}"; do
      name=$(diskutil info "$d" | awk -F': *' '/Device \/ Media Name/ {print $2}')
      size=$(diskutil info "$d" | awk -F': *' '/Disk Size/ {print $2; exit}')
      printf '  %s  %s  (%s)\n' "$d" "$name" "$size" >&2
    done
    echo "Rerun with: make install-pi-os DISK=/dev/diskN" >&2
    exit 1
  fi
  TARGET="${DISKS[0]}"
fi

# Belt-and-suspenders: even if someone passes DISK=/dev/disk0, refuse if it's
# not an external disk. The external-physical filter above already protects
# the auto-detect path; this covers the explicit-override path.
location=$(diskutil info "$TARGET" | awk -F': *' '/Device Location/ {print $2; exit}')
if [[ "$location" != "External" ]]; then
  echo "Refusing to write to $TARGET — Device Location is '$location', not 'External'." >&2
  echo "This tool only writes to external disks." >&2
  exit 1
fi

echo "Target: $TARGET"
diskutil info "$TARGET" | awk -F': *' '
  /Device \/ Media Name/ {print "  Model:     " $2}
  /Disk Size/            {print "  Size:      " $2}
  /^ *Protocol:/         {print "  Protocol:  " $2}
  /Device Location/      {print "  Location:  " $2}
  /Removable Media/      {print "  Removable: " $2}
'
read -r -p "Everything on $TARGET will be ERASED. Type 'yes' to continue: " ans
[[ "$ans" == "yes" ]] || { echo "Aborted."; exit 1; }

mkdir -p "$CACHE_DIR"
echo "Fetching Pi OS Lite 64-bit (cached at $IMG, resumable)…"
curl -L --fail -C - -o "$IMG" "$IMAGE_URL"
curl -L --fail -o "$SHA" "$SHA_URL"

echo "Verifying SHA-256…"
expected=$(awk '{print $1}' "$SHA")
actual=$(shasum -a 256 "$IMG" | awk '{print $1}')
if [[ "$expected" != "$actual" ]]; then
  echo "Checksum mismatch. Delete $IMG and retry." >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  exit 1
fi

# /dev/rdiskN is the raw/character device — roughly 10x faster than /dev/diskN
# for large writes because it bypasses the buffer cache.
RAW="/dev/r${TARGET#/dev/}"
echo "Unmounting ${TARGET}..."
diskutil unmountDisk "$TARGET"

echo "Writing to $RAW — 5–15 min depending on card speed."
echo "macOS dd has no progress bar; press Ctrl-T any time to print status."
xzcat "$IMG" | sudo dd of="$RAW" bs=4m

sync
diskutil eject "$TARGET" || true
echo ""
echo "Done. Reinsert the card; it will mount as /Volumes/bootfs."
echo "Then open the dashboard and run 'Customize card' to stage pi_robot."
