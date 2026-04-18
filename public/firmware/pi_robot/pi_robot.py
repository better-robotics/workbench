#!/usr/bin/env python3
"""Better Robotics — robot firmware for Raspberry Pi.

Mirrors firmware/esp32_robot/esp32_robot.ino: advertises a single BLE
service; each capability (LED, WiFi, motors, sensors, ...) is a
characteristic within that service. The dashboard connects to Pi and
ESP32 robots identically.

Run:
    pip install -r requirements.txt
    python3 pi_robot.py
"""

import asyncio
import json
import logging
import socket

from bless import (
    BlessServer,
    BlessGATTCharacteristic,
    GATTCharacteristicProperties,
    GATTAttributePermissions,
)
from gpiozero import LED

# UUIDs — must match firmware/esp32_robot/esp32_robot.ino exactly.
SERVICE_UUID          = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d91"
LED_CHAR_UUID         = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d92"
WIFI_SCAN_CHAR_UUID   = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d93"
WIFI_JOIN_CHAR_UUID   = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d94"
WIFI_STATUS_CHAR_UUID = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d95"

# Shared BLE WiFi spec (also implemented on ESP32):
#   wifi-scan   — read + notify. UTF-8 JSON: [{"s":ssid,"r":0..100,"p":0|1}].
#                 Reading triggers a rescan; notify fires when done. Strongest first.
#   wifi-join   — write. UTF-8 JSON: {"s":ssid,"p":password}. Empty p for open nets.
#   wifi-status — read + notify. UTF-8 JSON: {"st":state,"ssid":name,"err":msg}.
#                 States: idle, joining, joined, failed. (Scan activity is
#                 tracked client-side via wifi-scan notifications; it doesn't
#                 change connection state.)

LED_PIN = 17       # BCM pin — change to match your wiring.
SCAN_MAX = 10      # Bounded so the full JSON fits in one ATT read.

logging.basicConfig(format="%(asctime)s %(message)s", level=logging.INFO)
log = logging.getLogger("pi_robot")

led = LED(LED_PIN)
_led_state = 0
_server: BlessServer | None = None
_loop: asyncio.AbstractEventLoop | None = None
_wifi_status: dict = {"st": "idle"}
_wifi_scan: list[dict] = []


def device_name() -> str:
    """BetterRobot-XXXX with a stable per-chip suffix, matching ESP32 naming."""
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
    return f"BetterRobot-{suffix}"


def _json_bytes(obj) -> bytearray:
    return bytearray(json.dumps(obj, separators=(",", ":")).encode("utf-8"))


def _publish(char_uuid: str, value: bytearray) -> None:
    """Set a characteristic's current value and notify subscribers."""
    if _server is None:
        return
    ch = _server.get_characteristic(char_uuid)
    if ch is not None:
        ch.value = value
    _server.update_value(SERVICE_UUID, char_uuid)


def _set_status(st: str, ssid: str | None = None, err: str | None = None) -> None:
    global _wifi_status
    _wifi_status = {"st": st}
    if ssid:
        _wifi_status["ssid"] = ssid
    if err:
        _wifi_status["err"] = err
    _publish(WIFI_STATUS_CHAR_UUID, _json_bytes(_wifi_status))
    log.info("wifi-status → %s", _wifi_status)


async def _wifi_scan_task() -> None:
    # nmcli SIGNAL is 0..100 already; we pass it through as our unified "strength".
    # Doesn't touch wifi-status — scan activity is orthogonal to connection state.
    global _wifi_scan
    try:
        proc = await asyncio.create_subprocess_exec(
            "nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY",
            "dev", "wifi", "list", "--rescan", "yes",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate()
        if proc.returncode != 0:
            log.warning("wifi scan failed: %s", err.decode(errors="replace").strip())
            return
        seen: set[str] = set()
        results: list[dict] = []
        for line in out.decode(errors="replace").splitlines():
            # -t uses ':' as delimiter; embedded ':' in fields is escaped as '\:'.
            parts = line.replace("\\:", "\x00").split(":")
            if len(parts) < 3:
                continue
            ssid = parts[0].replace("\x00", ":").strip()
            if not ssid or ssid in seen:
                continue
            seen.add(ssid)
            try:
                strength = int(parts[1])
            except ValueError:
                strength = 0
            secured = 1 if parts[2].strip() else 0
            results.append({"s": ssid[:32], "r": strength, "p": secured})
        results.sort(key=lambda x: x["r"], reverse=True)
        _wifi_scan = results[:SCAN_MAX]
        _publish(WIFI_SCAN_CHAR_UUID, _json_bytes(_wifi_scan))
    except Exception as e:
        log.warning("wifi scan error: %s", e)


async def _check_current_wifi() -> None:
    """On startup, reflect the actual current connection state."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "nmcli", "-t", "-f", "NAME,TYPE", "conn", "show", "--active",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await proc.communicate()
        for line in out.decode(errors="replace").splitlines():
            parts = line.replace("\\:", "\x00").split(":")
            if len(parts) >= 2 and parts[1] == "802-11-wireless":
                _set_status("joined", ssid=parts[0].replace("\x00", ":"))
                return
        _set_status("idle")
    except Exception as e:
        log.warning("initial wifi check failed: %s", e)


async def _wifi_join_task(ssid: str, password: str) -> None:
    _set_status("joining", ssid=ssid)
    cmd = ["nmcli", "dev", "wifi", "connect", ssid]
    if password:
        cmd += ["password", password]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate()
        if proc.returncode == 0:
            _set_status("joined", ssid=ssid)
        else:
            msg = (err.decode(errors="replace") or out.decode(errors="replace")).strip()
            _set_status("failed", ssid=ssid, err=msg[:120] or "join failed")
    except Exception as e:
        _set_status("failed", ssid=ssid, err=str(e)[:120])


def _schedule(coro) -> None:
    """Schedule a coroutine from the BLE callback thread onto the main loop."""
    if _loop is not None:
        asyncio.run_coroutine_threadsafe(coro, _loop)


def on_read(characteristic: BlessGATTCharacteristic, **_) -> bytearray:
    uuid = characteristic.uuid.lower()
    if uuid == LED_CHAR_UUID:
        return bytearray([_led_state])
    if uuid == WIFI_SCAN_CHAR_UUID:
        _schedule(_wifi_scan_task())  # refresh in background; client sees it via notify.
        return _json_bytes(_wifi_scan)
    if uuid == WIFI_STATUS_CHAR_UUID:
        return _json_bytes(_wifi_status)
    return characteristic.value


def on_write(characteristic: BlessGATTCharacteristic, value: bytearray, **_) -> None:
    global _led_state
    uuid = characteristic.uuid.lower()
    if uuid == LED_CHAR_UUID:
        if len(value) == 0:
            return
        _led_state = 1 if value[0] else 0
        led.on() if _led_state else led.off()
        _publish(LED_CHAR_UUID, bytearray([_led_state]))
        log.info("LED → %s", "on" if _led_state else "off")
        return
    if uuid == WIFI_JOIN_CHAR_UUID:
        try:
            payload = json.loads(bytes(value).decode("utf-8"))
            ssid = str(payload.get("s", "")).strip()
            password = str(payload.get("p", ""))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            _set_status("failed", err=f"bad payload: {e}"[:120])
            return
        if not ssid:
            _set_status("failed", err="missing ssid")
            return
        _schedule(_wifi_join_task(ssid, password))


async def main() -> None:
    global _server, _loop
    _loop = asyncio.get_running_loop()
    name = device_name()
    log.info("Starting %s", name)

    _server = BlessServer(name=name)
    _server.read_request_func = on_read
    _server.write_request_func = on_write

    await _server.add_new_service(SERVICE_UUID)
    await _server.add_new_characteristic(
        SERVICE_UUID, LED_CHAR_UUID,
        GATTCharacteristicProperties.read
        | GATTCharacteristicProperties.write
        | GATTCharacteristicProperties.notify,
        bytearray([_led_state]),
        GATTAttributePermissions.readable | GATTAttributePermissions.writeable,
    )
    await _server.add_new_characteristic(
        SERVICE_UUID, WIFI_SCAN_CHAR_UUID,
        GATTCharacteristicProperties.read | GATTCharacteristicProperties.notify,
        _json_bytes(_wifi_scan),
        GATTAttributePermissions.readable,
    )
    await _server.add_new_characteristic(
        SERVICE_UUID, WIFI_JOIN_CHAR_UUID,
        GATTCharacteristicProperties.write,
        bytearray(b"{}"),
        GATTAttributePermissions.writeable,
    )
    await _server.add_new_characteristic(
        SERVICE_UUID, WIFI_STATUS_CHAR_UUID,
        GATTCharacteristicProperties.read | GATTCharacteristicProperties.notify,
        _json_bytes(_wifi_status),
        GATTAttributePermissions.readable,
    )

    await _server.start()
    log.info("Advertising on service %s", SERVICE_UUID)
    log.info("Ctrl+C to stop.")
    asyncio.create_task(_check_current_wifi())
    try:
        await asyncio.Event().wait()
    finally:
        await _server.stop()


if __name__ == "__main__":
    asyncio.run(main())
