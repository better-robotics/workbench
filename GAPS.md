# Gaps

Where the scaffold trails the **Physical Agents OS** plan (`duke-ai/better-robotics/CLAUDE.md`), ranked by leverage for the Fall 2026 course pilot.

## Ranked

1. **Live parameters get/set.** Learning step 2 — "tune parameters live without editing code." Capabilities are already structured; add a param characteristic + getter/setter + a tuner row per capability card. Cheapest gap to close.

2. **Sensor/motor hot-plug auto-discovery.** Learning step 3 — "add physical components." Today capabilities are firmware-declared, not detected at runtime. The "smart breadboard" promise. Tractable on ESP32 with an i2c scan + a discovery characteristic.

3. **Pub/sub vocabulary for messaging.** Learning step 5 and the explicit ROS2-transition story. Could be a topic layer over BLE notify, with MQTT as the "once WiFi is on" tier. Earns its keep only if the ROS2-prep framing stays.

4. **Discovery graph view.** Cheap once (3) lands. Makes pub/sub legible — pedagogical payoff for low effort.

5. **Simulation hook.** A `MockRobot` so a student can iterate scripts without a working kit on the table. Classroom-critical; not everyone has hardware ready every session.

## NFC tap-to-pair

The plan's original NFC role (handing the phone the puck's SoftAP creds) is dead post-BLE-first. Tags can still earn their keep as a *tap-to-pair-this-specific-robot* shortcut — collapses "scan → find robot-7 in a list of 12 → confirm" to a single tap.

- **Tag content:** NDEF URL → `https://better-robotics.github.io/?pair=<robot-id>`. Dashboard reads `pair` from `location.search`, filters BLE scan to that device.
- **Android Chrome:** tap → URL → filtered scan → confirm.
- **iPhone:** iOS opens the URL but Web Bluetooth is unavailable. Workaround uses the existing phone↔desktop pair layer (`signal.neevs.io`, signed pair-request, `phone.html`): encode `phone.html?pair=<robot-id>`. Phone forwards `{type:"pair-robot", robotId}` over WebRTC; desktop surfaces a "Phone wants to pair robot-7 — click to confirm" banner. Desktop click is required because `navigator.bluetooth.requestDevice` needs a user gesture. Cross-network works for free.
- **Bootstrap caveat:** first-ever use still needs the existing phone↔desktop pair ceremony.

~An afternoon to prototype. Concrete iOS+NFC demo defuses the "BLE-first leaves iPhones out" objection.

## Other gaps

- **Visual / block-based authoring tier.** Plan promises "no coding knowledge required" out of box. Today this is honored by capability cards (drive motors, toggle LED) and `pip.ask` natural language — no block-editor surface for "when distance < 30cm, stop and turn right." Competitors (XRP, MicroBlocks — see `.claude/notes.md`) ship Blockly. Decide: do cards + Pip cover learning steps 1–3, or is a drag-drop tier needed for non-coders to author behavior?

- **Inter-puck messaging.** Plan: "Supports inter-device communication." Today every message fans out through the browser as hub — no puck↔puck path. Tied to (3) but a separate architectural commitment.

- **Coordinate frames + time sync.** Plan flags both as key technical challenges. Nothing in scaffold addresses them. Required for sensor fusion (learning step 7) and any multi-puck localization.

## Out of scope (superseded)

NFC+SoftAP captive-portal onboarding, touch screen on the puck, Python server-side API, "more than one robot is V1 out-of-scope." Built has eclipsed these — the plan needs updating, not the scaffold.
