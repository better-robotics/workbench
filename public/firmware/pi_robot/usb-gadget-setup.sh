#!/bin/bash
# USB composite gadget (ECM ethernet + ACM serial) via ConfigFS. Runs
# independently of pi-robot.service so a crashed firmware still exposes
# `ssh pi@10.55.0.1` (ECM) and a serial console at /dev/ttyGS0 (ACM).
set -euo pipefail

GADGET=/sys/kernel/config/usb_gadget/g1
if [ -d "$GADGET" ]; then
  exit 0  # already configured (reboot-safe idempotency)
fi

# Wait for dwc2 to register a UDC on /sys/class/udc. systemd-modules-load
# returns as soon as modprobe finishes, but dwc2's USB-device-controller
# registration is async on top of that — racing past it would leave us
# with an empty /sys/class/udc and a silent skip (ConditionPathExists
# previously masked this; we dropped it so the unit actually runs).
# 10s is generous: dwc2 publishes within ~200 ms on a healthy boot.
for _ in $(seq 1 50); do
  if ls /sys/class/udc 2>/dev/null | grep -q .; then
    break
  fi
  sleep 0.2
done
if ! ls /sys/class/udc 2>/dev/null | grep -q .; then
  echo "usb-gadget: no UDC after 10s — dwc2 not loaded or in host mode" >&2
  exit 1
fi

mkdir -p "$GADGET"
cd "$GADGET"

echo 0x1d6b > idVendor    # Linux Foundation
echo 0x0104 > idProduct   # Multifunction Composite Gadget
echo 0x0100 > bcdDevice
echo 0x0200 > bcdUSB

mkdir -p strings/0x409
SN=$(awk '/Serial/ { print $NF; exit }' /proc/cpuinfo 2>/dev/null || echo "0000000000")
# Per-chip product string so two Pis plugged into the same host can be
# told apart in System Information / lsusb. Derivation matches the BLE
# name (pi_robot.py device_name, pi_robot_health._device_name): last 4
# hex of /proc/cpuinfo Serial, uppercased.
SUFFIX=$(echo "$SN" | tail -c 5 | tr '[:lower:]' '[:upper:]')
[ -z "$SUFFIX" ] && SUFFIX="0000"
echo "$SN" > strings/0x409/serialnumber
echo "Better Robotics" > strings/0x409/manufacturer
echo "BR-$SUFFIX" > strings/0x409/product

mkdir -p configs/c.1/strings/0x409
echo "ECM + ACM" > configs/c.1/strings/0x409/configuration
echo 250 > configs/c.1/MaxPower

mkdir -p functions/ecm.usb0
mkdir -p functions/acm.usb0

ln -s functions/ecm.usb0 configs/c.1/
ln -s functions/acm.usb0 configs/c.1/

# Bind to the first available USB Device Controller.
UDC=$(ls /sys/class/udc | head -n 1)
echo "$UDC" > UDC
