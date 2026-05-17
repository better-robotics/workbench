#!/usr/bin/env python3
"""One-shot shell commands to the Pi over USB-CDC.

For diagnostic loops where SSH/BLE are down and the only path is the
recovery serial console (USB-C cable to the Pi's ttyGS0). The Pi's
autologin lands at `robot@betterpi:~$` — this script wraps a single
command-and-response cycle so output comes back cleanly to the host shell
(or to Claude in an interactive session).

Usage:
    tools/pi-serial.py "uname -a"
    tools/pi-serial.py --wait 12 "journalctl -u pi-robot.service -n 40"
    tools/pi-serial.py --dev /dev/cu.usbmodem104 "ls /boot/firmware"

Discovery:
    With no --dev, picks the first /dev/cu.usbmodem* (macOS) or
    /dev/ttyACM* (Linux). Override with --dev or BR_PI_SERIAL=<path>.

Assumes:
    - Pi's autologin landed at a bash prompt (the dotfiles-supplied
      `[Mac]>` REPL is auto-escaped via Ctrl-D if detected on attach).
    - 115200 8N1 — matches firstrun's `agetty --keep-baud 115200,…`.
"""
import argparse
import os
import re
import sys
import time
import uuid
from glob import glob

try:
    import serial
except ImportError:
    sys.exit("pyserial missing — `pip install pyserial`")

BAUD = 115200
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def _autodetect_device():
    env = os.environ.get("BR_PI_SERIAL")
    if env:
        return env
    cands = sorted(glob("/dev/cu.usbmodem*") + glob("/dev/ttyACM*"))
    if not cands:
        sys.exit("no /dev/cu.usbmodem* or /dev/ttyACM* found — connect the Pi over USB-C")
    return cands[0]


def _read_until(sp, marker, timeout):
    end = time.monotonic() + timeout
    buf = bytearray()
    while time.monotonic() < end:
        n = sp.in_waiting
        if n:
            buf += sp.read(n)
            if marker.encode() in buf:
                break
        else:
            time.sleep(0.05)
    return buf.decode("utf-8", errors="replace")


def _ensure_bash(sp):
    # Wake the prompt, then check whether we're in a bash shell or some
    # wrapper REPL (the user's dotfiles-injected `[Mac]>` lander, e.g.).
    # Ctrl-D escapes one level — but a second Ctrl-D logs out of bash
    # and re-triggers getty, so apply it conditionally.
    sp.write(b"\n")
    time.sleep(0.4)
    peek = sp.read(sp.in_waiting or 1).decode("utf-8", errors="replace")
    if "@" not in peek or "$" not in peek:
        sp.write(b"\x04")
        time.sleep(1.0)
    sp.reset_input_buffer()


def run(cmd, wait, dev):
    with serial.Serial(dev, BAUD, timeout=0.2) as sp:
        _ensure_bash(sp)
        # Tag the output between unique markers so we know when the
        # command finishes and can slice the echoed line + prompt.
        h = uuid.uuid4().hex[:10]
        start_tag, end_tag = "STA" + h, "END" + h
        sp.write(
            f"printf '%s\\n' {start_tag}; {cmd}; printf '%s\\n' {end_tag}\n".encode()
        )
        out = _read_until(sp, "\n" + end_tag, wait)

        clean = ANSI.sub("", out).replace("\r", "")
        s = clean.find("\n" + start_tag + "\n")
        if s >= 0:
            clean = clean[s + len(start_tag) + 2 :]
        e = clean.find("\n" + end_tag)
        if e >= 0:
            clean = clean[:e]
        return clean


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wait", type=float, default=6.0,
                    help="seconds to wait for the end-of-output marker")
    ap.add_argument("--dev", default=None,
                    help="serial device path (default: auto-detect / $BR_PI_SERIAL)")
    ap.add_argument("cmd", help="shell command to run on the Pi")
    args = ap.parse_args()
    print(run(args.cmd, args.wait, args.dev or _autodetect_device()), end="")


if __name__ == "__main__":
    main()
