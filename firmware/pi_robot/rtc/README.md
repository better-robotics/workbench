# pi-robot-rtc

WebRTC peer for the Pi side. Bridges browser DataChannels to local services.
Built on libpeer (sepfy, pure C, ~6 KLOC) so the same stack runs on
ESP32-CAM-MB later (Phase 2 of working.md item I).

**Status: implementation written, untested on hardware.** The C daemon
(`main.c`) plus build pipeline (`Makefile`) plus systemd unit + first-
run integration are all in place. Needs a real Pi prepare to verify:
the build succeeds, the binary listens on `:82`, the SDP exchange
returns a valid answer, the data channel opens and the PTY bridge
delivers a working bash session. Speculative C until tested — the
libpeer API surface is matched against the upstream RPi example.

## Wire format

Single round-trip, non-trickle ICE, LAN-direct:

```
POST http://<robot-host>:82/webrtc/offer
Content-Type: application/json
Origin: https://neevs.io  (PNA preflight required)

{ "sdp": "<full SDP including all gathered ICE candidates>" }
```

Response:

```
200 OK
Content-Type: application/json
Access-Control-Allow-Origin: *
Access-Control-Allow-Private-Network: true   (on OPTIONS preflight)

{ "sdp": "<Pi's answer SDP including its host candidates>" }
```

Why non-trickle: LAN-direct, no TURN, host candidates are stable, gathering
completes in <1 s. One HTTP round-trip is cleaner than a separate signaling
channel.

PNA: this endpoint is reached from `https://neevs.io` (or any HTTPS origin)
talking to a private IP. Chrome's Private Network Access requires the same
preflight envelope `pi_robot_health.py` uses for `/health` on `:81`.

## DataChannels

Phase 1.A defines one label:

| Label | Direction | Bytes | Server-side bridge |
|---|---|---|---|
| `shell` | bidirectional | binary (raw PTY bytes) | spawn `bash -i` with PTY, pipe stdin/stdout |

Future phases add:
- `ota` — DataChannel push of firmware bytes; replaces BLE-chunked OTA path.
- `logs` — `journalctl -f` line stream.
- Camera media track (Phase 2 ESP32-CAM-MB primarily; Pi-side optional).

Each future channel is a `peer.createDataChannel(name)` from the dashboard;
the Pi side handles the label in its `on_data_channel` callback.

## Build (planned)

`Makefile` will:
1. Vendor libpeer at a pinned SHA into `vendor/libpeer/`.
2. Link against system mbedTLS (Pi OS Trixie ships `libmbedtls-dev`),
   libsrtp2 (`libsrtp2-dev`), libusrsctp (`libusrsctp-dev`).
3. Produce `pi-robot-rtc` ELF binary.

Build runs on the Pi during `firstrun.sh` (apt-get the dev libs +
`make`). Cross-compile from a Mac is possible but not the default
path; the Pi's first boot is already a multi-minute setup phase, a
~30 s C compile fits.

## Service

`pi-robot-rtc.service` runs the binary as a separate systemd unit
(parallel to `pi-robot.service` and `pi-robot-health.service`) so that
a crash in one doesn't take the others down — same recovery-plane
discipline as the existing health/heartbeat services.

User: `robot` (not root). The PTY spawned for `shell` runs as the same
user, matching how `ssh robot@<host>.local` would land today.

## Trust model (Phase 1.A)

Peer-trust at the WebRTC layer is the auth boundary: anyone who can
reach `<robot>:82/webrtc/offer` over the LAN gets a shell. This matches
the trust extended for OTA-over-PNA today (any device on the LAN
reaches the OTA endpoint without per-request auth).

If the trust model needs hardening (e.g., desktop-only access via the
dashboard's enrolled ed25519 key), Phase 1.A.2 layers ssh2 inside a
WebContainer over the same DataChannel — real SSH crypto end-to-end,
key auth via `auth.js`'s existing keypair which the prepare flow
already enrolls in `authorized_keys`. That's a swap of the dashboard
side; the Pi-side bridge stays the same (DataChannel ↔ localhost:22
TCP instead of ↔ direct PTY).
