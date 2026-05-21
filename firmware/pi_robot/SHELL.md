# Shell over BLE — not pursuing

**Status:** not pursuing (2026-04-19, reaffirmed 2026-04-23). Typed ops verbs (`get-log`, `get-config`, `restart-service`, `reboot`, `install-pkg`, `enroll-key`) plus heartbeat plus USB-C recovery xterm cover every concrete debug case. Each verb is a deliberate, reviewable decision; a shell is "everything you can run."

## Why not

- **Rescue is Recovery's job** — over USB, independent of pi-robot.
- **File transfer** — use `scp` over the WiFi the robot already joined.
- **Long jobs** — BLE shell is latency-sensitive; not the right transport.

## Rejected paths (so they don't get re-litigated)

- **Restricted shell (rbash)** — too restrictive for education.
- **SELinux / AppArmor confinement** — out of v1 scope.
- **Key-based auth at BLE layer** — BLE bonding does the equivalent.
- **Full command audit (auditd)** — `PROMPT_COMMAND` logging would have sufficed.

## Revisit trigger

Concrete use case appears that typed ops + USB-C recovery genuinely can't cover, **and** uid separation has landed (so a spawned shell can't read NetworkManager's root-only connection files).

Design exploration (BLE service shape, framing, firmware, security model, frontend) lives in git history at `firmware/pi_robot/SHELL.md@f0fd25c~1` if revisited.
