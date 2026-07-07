#!/usr/bin/env python3
# Heartbeat BLE — recovery plane. Runs as its own systemd unit so the
# dashboard can still find the robot when pi-robot.service is dead. Code
# has zero dependency on pi_robot.py — a crash in the main firmware can't
# take this down. Same bless/dbus-fast deps as pi-robot because isolating
# deps isn't the goal; isolating _process_ is.
import asyncio
import json
import socket
import subprocess
import time

from bless import (
    BlessServer,
    GATTCharacteristicProperties,
    GATTAttributePermissions,
)

# Distinct UUID family from pi-robot's main service — dashboard scans for
# either, so the robot appears whether or not the main firmware is alive.
# Constants generated from protocol/uuids.json (see tools/gen-uuids.py).
from uuids import HEARTBEAT_SVC_UUID, HEARTBEAT_CHAR_UUID  # noqa: F401

REFRESH_S = 10
_started_at = time.monotonic()


def _device_name() -> str:
    # Duplicates pi_robot.device_name() by design — no import across the
    # recovery-plane / firmware-plane boundary.
    suffix = None
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("Serial"):
                    suffix = line.split(":")[1].strip()[-4:].upper()
                    break
    except OSError:
        pass
    if not suffix:
        suffix = socket.gethostname()[-4:].upper().ljust(4, "0")
    return f"PI-{suffix}"


def _ip() -> str | None:
    try:
        out = subprocess.check_output(["hostname", "-I"], text=True, timeout=2).split()
        return out[0] if out else None
    except Exception:
        return None


# Recovery-plane units the dashboard wants visibility into even when
# pi-robot.service itself is healthy. usb_gadget = the CDC console + ECM
# ethernet stay reachable when WiFi + BLE drop. ssh = the WiFi recovery
# rung. Reporting them through heartbeat means a chip can surface "your
# recovery is degraded" *before* the operator needs it — they won't
# discover it's broken at the moment they need it most.
_WATCHED_UNITS = ("pi-robot.service", "usb-gadget.service", "ssh.service")


def _svc_states() -> dict[str, str]:
    # `systemctl is-active a b c` writes one state per line in the same order.
    # Non-zero exit (any unit not active) is normal — don't raise on it.
    try:
        rc = subprocess.run(
            ["systemctl", "is-active", *_WATCHED_UNITS],
            capture_output=True, text=True, timeout=2,
        )
        lines = rc.stdout.strip().split("\n")
    except Exception:
        lines = []
    out = {}
    for i, unit in enumerate(_WATCHED_UNITS):
        state = lines[i].strip() if i < len(lines) else ""
        out[unit] = state or "unknown"
    return out


def _payload() -> bytearray:
    svc = _svc_states()
    return bytearray(json.dumps({
        "ip": _ip(),
        "host": socket.gethostname(),
        "uptime_s": int(time.monotonic() - _started_at),
        "pi_robot": svc["pi-robot.service"],
        "usb_gadget": svc["usb-gadget.service"],
        "ssh": svc["ssh.service"],
    }, separators=(",", ":")).encode("utf-8"))


async def main() -> None:
    server = BlessServer(name=_device_name())
    await server.add_new_service(HEARTBEAT_SVC_UUID)
    await server.add_new_characteristic(
        HEARTBEAT_SVC_UUID, HEARTBEAT_CHAR_UUID,
        GATTCharacteristicProperties.read | GATTCharacteristicProperties.notify,
        _payload(),
        GATTAttributePermissions.readable,
    )
    await server.start()
    while True:
        await asyncio.sleep(REFRESH_S)
        try:
            char = server.get_characteristic(HEARTBEAT_CHAR_UUID)
            if char is not None:
                char.value = _payload()
        except Exception:
            pass


if __name__ == "__main__":
    asyncio.run(main())
