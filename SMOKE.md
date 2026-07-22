# Smoke checklist

Manual verification before merging structural changes (UI redesign, render-pattern shifts, capability refactors, BLE protocol tweaks). A broken row means user-visible value broke.

Pure-function tests live in `tests/`; run with `make smoke`. Below needs hardware.

## Robot lifecycle

- [ ] Pair a fresh ESP32 → Connect → see capabilities → Disconnect cycle works.
- [ ] Robot reboots mid-session → reconnect succeeds OR button flips to Re-pair (not "Connect that does nothing").
- [ ] BLE drops out-of-range → status reads "Out of range" → button still says Connect → ranging in re-establishes.
- [ ] Two robots paired → connect-all works → both render independently.
- [ ] Pair → Forget → robot disappears → Pair again succeeds.

## Dashboard rendering

- [ ] Robot card renders with no console errors after 30 s of telemetry/robot-status updates (no flash on every notify).
- [ ] Cap headers show state inline ("L: 0 · R: 0", "off", "Not configured").
- [ ] Primary action visible without expanding (Turn on / Stop / Take photo / Scan).
- [ ] Chevron only appears on caps with body content (not on LED, not on Snapshot when no image).
- [ ] Card stripe color matches connection state (green/connected, amber/connecting, red/error).
- [ ] Meta row truncates with ellipsis on long content; CTA stays right-aligned.

## Capabilities

- [ ] **LED** toggle from header without expanding → state updates without card flash.
- [ ] **Motors — human joypad:** drag drives the robot; releasing → watchdog stops within 500 ms.
- [ ] **Motors — pulse-bounded LLM path:** Pip-issued motor command with `duration_ms` stops at end of window without a separate stop call (firmware auto-stop). Control-loop invariant; regression means planner-layer code can leave the robot moving between decisions.
- [ ] **Pairing over the hub broker:** with `?hub=<host>` set (http-served page) and phone on the hub's Wi-Fi, the pair QR connects the phone — offer/answer/ICE ride `pair/<room>/s/+` on the broker, media flows LAN-direct. Without a reachable broker, both sides surface the hub-oriented error (not a hang). After pairing, kill the broker: the live WebRTC session (video, ask-human, joypad relay) must keep working — signaling is needed again only for ICE restart / renegotiation.
- [ ] **Phone Stop button:** from a paired phone, tapping Stop relays through the desktop's BLE session and halts a moving robot. With no robot connected, button surfaces "no robot connected" inline. Safety primitive must be legible, no silent no-op.
- [ ] **Phone Share camera:** Front is selected by default; tapping Share opens the front camera and a helper card appears on the desktop. While sharing, tapping Back swaps to the rear camera within ~1 s — same helper card, no flash/disconnect (replaceTrack path). Tapping Stop sharing clears the helper card.
- [ ] **Phone attached-mode:** mount the phone on a robot via the robot card's "Mount camera" picker. Phone screen flips to full-screen Pip face (no operator chrome, no Stop button — operator is remote, audience in-room reaches for the robot itself if needed). Detaching restores normal phone UI. Disconnect mid-attach → phone shows normal reconnect surface; reconnecting re-flips to attached.
- [ ] **Pip face on attached phone (default):** mount the phone; default is `phoneAttachedMode: "pip-face"` so the screen shows Pip's robot icon (head, antennas, ears, spark) with two morphing eyes inside. Eyes blink at jittered 2–5s intervals when idle. `/demo dance` → eyes shift direction in sync with motor calls. `get_robot_detections` → eyes scan left/right oscillating. `ask_human` → eyes rotate asymmetrically (raised brows). `/demo stopsign` with a stop sign held up → eyes briefly widen (alert, gold), then halted-squint (gray + sleep Z's drift) after the halt.
- [ ] **WiFi** Scan returns networks (or empty if none); Join succeeds → status shows "WiFi <ip>" in meta.
- [ ] **Camera (ESP32)** renders when WiFi joined. HTTP MJPEG live view starts without page reload.
- [ ] **Snapshot** completes in <5 s; stalls trigger watchdog with retry.
- [ ] **Reflex watcher**: open the Reflex section on a connected robot with a camera → Start → hold a stop sign to the camera → button flips to Start (fire-once), state shows "saw stop sign at HH:MM", motors halt if a Motors cap is present. Pip variant: `start_robot_watcher` from chat with `classes: ["stop sign"]` does the same.
- [ ] **OTA** progress smoothly reports per chunk; "100% receiving → committing → done" transitions visible.
- [ ] **OTA orphan** state cleared on next connect (no stuck "1% receiving" forever).

## Pip chat

- [ ] Send a prompt → trace appears live (one row per tool call).
- [ ] Stop button visible while iterating; click → loop ends with "(stopped)".
- [ ] `ask_human` when no phone paired → renders option buttons in chat bubble; click resolves.
- [ ] Notify ≠ chat: opening multiple dialogs in sequence shows latest tip in notify slot, not stacked turns.
- [ ] Prior turns auto-collapse on new prompt; click summary re-expands with full trace.
- [ ] Conversation context sent to the LLM is bounded (HISTORY_LIMIT in `assistant.js`) — the planner doesn't see unbounded history.

## Recovery

- [ ] ESP32 serial console: Serial console → Connect → boot log + serial output streams.
- [ ] ESP32 flash: Serial console → Flash firmware → bins stream, chip reboots.

## Offline / PWA

- [ ] First load online → DevTools Network → Offline → reload → dashboard still loads.
- [ ] Bump `VERSION` in docs/sw.js → deploy → visit → "New dashboard version available" banner appears.
- [ ] Click Reload on the banner → page reloads with new version, no stale assets.
- [ ] Dismiss banner with × → no reload, banner gone for the session.

## Scripts (IDE view)

- [ ] Open Scripts → editor loads → "New from template…" seeds each template as a Local draft → Run executes.
- [ ] Typing `robot.` offers API completions (move, led, op, watchFor, …) with hover docs — the Monaco TS worker + workbench.d.ts are live.
- [ ] Cmd/Ctrl-Enter runs the active file; output pane shows log lines + return value.
- [ ] `pip.ask` template fires Claude call → returns text.
- [ ] `stop-sign` template: hold a stop sign to the robot camera → cruise halts within ~1 s, output logs detection + score. Confirms MediaPipe reflex path (closed-vocab, ~10–30ms) is live.
- [ ] Offline: with no robot connected, the Local section + editor still work (draft create / edit / run).

## On-robot files (BLE file service)

- [ ] Fresh-flashed board → connect → IDE tree shows "On <robot>" section (fs mounted). A board updated app-only over an old partition table shows no board section and all other caps work (fs reports unavailable).
- [ ] Round-trip: New file under "On <robot>" → edit → Save → tree lists it with size. Reload the page → reconnect → reboot the robot → reopen the file → content is byte-identical (LittleFS survived the reboot).
- [ ] Save a 10 KB file while toggling the LED mid-transfer → LED stays responsive (ops not starved by the file stream).
- [ ] Quota errors surface in the UI, not the console: a >32 KB file → "file too large"; deleting works and the tree updates.

