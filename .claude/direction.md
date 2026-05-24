# Direction

What we're committing to close for the Fall 2026 course pilot. Open exploration lives in `exploration.md`; positioning research in `field.md`.

## Ranked gaps

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

- **Visual / block-based authoring tier.** Today: capability cards (drive motors, toggle LED) and `pip.ask` natural language — no block-editor surface for "when distance < 30cm, stop and turn right." XRP and MicroBlocks (see `.claude/field.md`) ship Blockly. Open question: do cards + Pip cover non-coder authoring, or is a drag-drop tier needed?

- **Inter-puck messaging.** Every message fans out through the browser as hub — no puck↔puck path. Tied to (3) but a separate architectural commitment.

- **Coordinate frames + time sync.** Required for sensor fusion and any multi-puck localization. Nothing in the scaffold addresses them.
