# Developer reference

Diagnostic flags, console handles, debug paths. User-facing → `README.md`. Agent-facing → `.claude/CLAUDE.md`.

## URL flags

### Dashboard (`index.html`)
- `?prepare` — opens the Customize-card SD-prep dialog on load. Implementation: `app.js`.
- `?robot=<name>` — pre-selects a robot by name (useful for direct-link workflows). Implementation: `app.js`.

### Phone (`phone.html`)
- `#pair=<uuid>` — the pairing room id, normally injected by the QR. Required for the phone to find the room. Implementation: `mobile.js`.

## Keyboard control

WASD / arrow keys drive the **active motors target** — one robot at a time,
mutually exclusive. With a single connected robot, it's the auto-pick.
With two or more, the active card's Motors section shows `Motors · Driving`.
Switch via:

- Click anywhere on a card's **Motors section** → that robot becomes active.
- Number keys **`1`–`9`** → activate the Nth connected robot (in `state.devices`
  insertion order — same as the card list).

Active disconnects → auto-pick re-runs on the next key/joypad event.
Implementation: `docs/capabilities/runtime/signed-pair.js`. State key:
`state.activeMotorsRobotId` (session-only, not persisted).

## Window handles (DevTools console)

Live on both desktop and phone while `pairing.js` is loaded.

- `window.lastPairDiagnostic()` — **async**, returns a Promise. Local + remote ICE candidates from this side's most recent pair attempt, plus role/roomId/iceServers, **plus a live `pc.getStats()` snapshot** (candidate-pair states, transport, certificates, dataChannel) and the four pc state strings. Same data `chrome://webrtc-internals/` shows, no privileged-page hop. Resets on each new `hostPairingRoom`/`joinPairingRoom` call. DevTools console auto-awaits the Promise — `await window.lastPairDiagnostic()` from elsewhere.
- `window.probeNetwork({ timeoutMs })` — runs a unilateral STUN probe on demand and returns `{stunReachable, candidateTypes, publicIp, mdnsObfuscated, candidates, durationMs}`. Stashes the result in `window.lastNetProbe()`.
- `window.lastNetProbe()` — last `probeNetwork()` result, or `null` if never run.
- `window.probeIceReachability(iceServers, { timeoutMs })` — per-server reachability + first-hit latency. Returns `[{urls, reachable, latencyMs, types}]`. Pass the array `fetchIceServers()` returns to test the TURN-enabled config a real pair uses.

## Robot endpoints

- `:81/health` (per-Pi HTTP) — wifi-presence probe. JSON `{ok, type, robotId, ip, uptime_s, pi_robot_service}`. Implementation: `firmware/pi_robot/pi_robot_health.py`. PNA preflight supported.
- **WebRTC peer** (per-Pi). The dashboard writes a chunked SDP offer to the BLE `SIGNAL` characteristic; `pi_robot.py` (root) reassembles and forwards to a local aiortc daemon (`pi_robot_rtc.py`, non-root) over `/run/pi-robot-rtc.sock`. The daemon answers non-trickle (all candidates inline); pi_robot.py chunks the answer back via BLE notify. Used by `docs/webrtc-robot.js` for the Shell dialog, OTA bundle staging, and log tail. No internet rendezvous — BLE pair is the signal substrate.

## Pi serial console

When BLE pairing won't go through and SSH isn't reachable (firmware crash-looping, no WiFi joined, fresh prepare not yet booted), the USB-C cable to the Pi exposes a CDC-ACM serial console with autologin.

- `tools/pi-serial.py "<cmd>"` — runs a single shell command on the Pi over USB-CDC and prints the response. Auto-detects `/dev/cu.usbmodem*` (macOS) or `/dev/ttyACM*` (Linux); override with `--dev` or `BR_PI_SERIAL`. Auto-escapes the `[Mac]>` wrapper REPL (dotfiles lander) into bash. Use for service status, journal reads, in-place edits when OTA is dead.
- For longer-running commands pass `--wait 12` (default 6 s) so the end-of-output marker has time to print.

## Chrome internal pages

State the page can't see:

- `chrome://webrtc-internals/` — every active RTCPeerConnection, ICE candidate pair tried, which got disqualified and why, DTLS/SCTP state, getStats output. **First stop** when WebRTC video or pair signaling fails. Auto-records on connection start; "candidate-pair selected" vs "channel open" timing is usually what you want.
- `chrome://bluetooth-internals/` — Web Bluetooth devices Chrome knows, services discovered, last scan results. Useful when a robot doesn't appear in the chooser or GATT operations stall. "Adapter" section surfaces OS-level state (powered, discoverable, paired).
- `chrome://device-log/` — per-event log for BLE, USB, serial. Captures errors the page never sees (e.g. "GATT operation already in progress").
- `chrome://inspect/#devices` — remote DevTools for Chrome on USB-connected Android. Full console + Sources + Network on the phone's tab.
- `chrome://serial-internals/` — Web Serial state. Useful when the recovery-console terminal stalls.
- `chrome://net-export/` — full network capture. Heavyweight; for sharing a `.json` log or correlating cross-protocol failures.

## When to reach for what

- Pairing hangs or fails silently → open the Diagnostics dialog (menu) and Refresh — captures STUN probe + last pair attempt's `getStats()` + connected-robot telemetry into one JSON. If even the unilateral probe returns no `srflx`, the network is blocking outbound STUN/UDP — pair will fail before it starts.
- Spatial grounding (which way to turn toward a target) → `get_robot_detections` Pip tool, backed by MediaPipe COCO (~10–30 ms on GPU, ~80 ms on CPU). Returns normalized bboxes for the 80 closed-vocab classes. For open-vocab queries ("the orange book on the bag") use `view_robot_frame` — sends the raw frame to Claude, which reasons about the scene without needing a bbox.

## House rules

- **Dev flags → URL.** Per-session diagnostics that shouldn't persist.
- **User preferences → Settings.** Build the panel once there are 3+ real persistent preferences.
