# Developer reference

Diagnostic flags, console handles, debug paths. User-facing → `README.md`. Agent-facing → `.claude/CLAUDE.md`.

## URL flags

### Dashboard (`index.html`)
- `?robot=<name>` — pre-selects a robot by name (useful for direct-link workflows). Implementation: `app.js`.
- `?hub=<host>[&hubuser=<team>&hubpass=<code>]` — connects to a classroom hub's
  MQTT broker over WebSockets (`ws://<host>:9001`, `sprocket-robotics/hub`
  CONTRACT.md) and surfaces its rovers as robot cards: joypad/keyboard drive,
  LED toggle, sys-derived telemetry, and the Pip/user-code motion tools all
  work through the same capability runtimes as BLE robots. Anonymous (no
  `hubuser`) is the broker-ACL read-only fleet view — cards appear, drive
  publishes are silently dropped. **http-served pages only**: a https page
  (github.io) can't open `ws://` (mixed content), so use a local dev server
  or a hub-served copy. Covered: motors, led, telemetry. Not covered (BLE-
  only): camera, OTA, ops, wifi provisioning. The same host also
  carries phone↔desktop pairing signaling (`pair/#` — see phone.html flags);
  without `?hub=`, pairing signaling falls back to `hub.local`. Card
  gotcha: Disconnect
  on a hub card is futile — the next `sys` beat (2 s) re-marks it connected;
  use `window.hub.disconnect()` to leave the hub. Implementation:
  `docs/hub/hub-transport.js` (lazy-imported by `app.js`).
- `?sig=<wss-url>` — overrides the public signaling rendezvous used when the
  page is https-served (the default is a no-SLA public test broker). The escape
  hatch for a broker outage: post one `?sig=` link and pairing recovers without
  a redeploy. `wss://` only (a `ws://` override is mixed-content-blocked from
  https and is ignored); no effect on http-served pages, where `?hub=` selects
  the broker. Carried into the pair QR so the phone joins the same broker.
  Implementation: `pair/broker-signal.js` (`getSignalRendezvous`).

### Phone (`phone.html`)
- `#pair=<uuid>[&pk=<pubkey>&s=<secret>&hub=<host>]` — the pairing room id, normally injected by the QR. `pk` binds in-person trust (desktop→phone); `s` is the room secret that authenticates the other direction (phone→desktop) — signals are HMAC'd with it and the desktop drops any that aren't, so a broker eavesdropper on the public rendezvous can't inject an offer (`pair/room-mac.js`). `s` only ever rides the QR or the signed lobby accept, never an open topic. `hub` names the broker carrying signaling (`pair/#` topics — defaults to `hub.local`) and carries *which* hub, never the scheme: each side derives that from its own origin, and since the QR is built from the desktop's origin both land on the same rendezvous. **Media is same-LAN only** (no ICE servers on the pair path), but signaling is not: a https page signals over a public wss broker under a `better-robotics/` prefix. Implementation: `mobile.js`, `pair/broker-signal.js`, `pair/room-mac.js`.

## Serving contexts — what works from where

The origin the dashboard is served from decides which transports exist.
There is no single context that does everything:

| served from | BLE (secure context) | LAN http/ws — hub transport, pairing signaling, presence, MJPEG |
|---|---|---|
| `http://localhost` (`make serve`) | ✓ | ✓ — the dev sweet spot |
| `https://…github.io` | ✓ | ✗ mixed content (Chrome-only override degrades the badge; iOS has no override). **Pairing still works**: signaling falls back to a public wss rendezvous (`pair/broker-signal.js`, `getSignalRendezvous()`). Hub transport, presence lobby, and MJPEG have no such escape and stay dark — gate is `lanBrokerBlocked()`, feature-detected so the Chrome override still passes |
| `http://<LAN-IP>` / `http://hub.local` | ✗ | ✓ — the phone/classroom context (the hub serves the IDE at `http://hub.local/ide/?hub=hub.local`) |

Consequences: show the pair QR from a page the *phone* can reach over http
(LAN IP, not `localhost`, never the https tunnel); `sw.js`/PWA only
registers on secure contexts, degrades silently elsewhere.

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
- `window.hub` — `{ client, disconnect() }`, present only when `?hub=` is active. `client.publish(topic, json)` / `client.subscribe(filter)` for raw contract-topic poking; `disconnect()` closes the broker session (the per-card Disconnect button can't — see URL flags).
- `window.probeIceReachability(iceServers, { timeoutMs })` — per-server reachability + first-hit latency for any ICE-server array. Returns `[{urls, reachable, latencyMs, types}]`. (The LAN pair path uses no ICE servers; this is a generic reachability probe.)

## Chrome internal pages

State the page can't see:

- `chrome://webrtc-internals/` — every active RTCPeerConnection, ICE candidate pair tried, which got disqualified and why, DTLS/SCTP state, getStats output. **First stop** when phone-pair signaling fails. Auto-records on connection start; "candidate-pair selected" vs "channel open" timing is usually what you want.
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
