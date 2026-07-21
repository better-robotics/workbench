# Exploration

Open architectural directions, design rationale, runtime state under validation, and forks evaluated but not taken. The thinking-in-progress layer. Live pilot state lives in the pinned tracker (issue #45); positioning research in `field.md`.

---

# Architectural directions

Long-horizon shape decisions. Updated when the shape of the system changes.

## 1. Generic typed-characteristic runtime

**Claim.** Every capability today exists in ~3 places (browser module, Pi handler, ESP32 handler). 80% of those files are boilerplate isomorphic to the capability's TYPE, not its identity. A generic runtime keyed on type eliminates the boilerplate.

**The data already exists.** `fw-info.caps` declares typed schemas:

```json
{ "name": "led",    "char": "…d92", "type": "toggle" }
{ "name": "motors", "char": "…d99", "type": "signed-pair", "range": [-100, 100] }
{ "name": "wifi",   "chars": {...}, "type": "wifi-scan" }
{ "name": "ota",    "chars": {...}, "type": "bundle-ota" }
{ "name": "camera", "type": "mjpeg-stream" }
{ "name": "ops",    "char": "…d9c", "type": "command" }
```

**The runtime (browser side).** A per-type constructor `makeXxxCap(schema)` returns `{probe, cleanup, renderSection, wireActions, postRender?}`. Adding a capability of a known type = one schema entry + zero JS code.

**Firmware-side direction (farther out).** ESP32 firmware has repetitive ceremony: register char, parse read/write, notify on change, gate on config. A "typed char runtime" on firmware reads the capability declaration and handles generic typed chars with a small driver binding per capability (`{ on_write: fn, on_read: fn }`).

**Where it stands** is readable from the code: `docs/capabilities/runtime/index.js`'s `RUNTIMES` map lists the migrated types; OTA (`docs/capabilities/ota.js`) is the one capability still on the older per-capability pattern.

**Migration strategy.** Per-type, not per-capability. When we migrate `signed-pair`, both motors AND any future 2-axis input use the same runtime. The compound payoff is the Nth capability, not the first.

## 2. AI-maintained documentation

**Claim.** `README.md`, `HARDWARE.md`, and per-capability comments all describe what `fw-info.caps` + the code already know. They drift. An AI agent watching the schema + commit log can regenerate docs per release.

**Scope.** ~2 days to wire a pre-commit generator plus a CI check that fails if docs aren't regenerated. Starts small: capability reference page auto-generated from the live schema. Expands to change-log summarization from commit messages.

**Not urgent.** Doc drift isn't causing failures today. Worth doing when the project has contributors outside the core, or when we promise backward-compatibility guarantees that require accurate docs.

## 3. Transparent-data-plane OTA

**Claim.** Every robot should have three OTA lanes with a clear fallback order. The dashboard picks the fastest available without user intervention. Iteration-loop speed is the core dev experience; "how fast does code get onto the robot" sets the tone for everything else.

**The three lanes, decreasing friction:**

1. **BLE-stream** — always works, no WiFi needed, no LAN co-location required. Baseline for every robot on every network. Today: `writeValueWithResponse` + ATT ack per 180-byte frame → 3-10 min for a 1.6 MB bin. Switching to `writeValueWithoutResponse` + software flow control over `ota-status` gets it to ~30 sec.

2. **PNA direct to target robot** — dashboard fetches `http://<robot-ip>/ota` straight from the browser. Chrome/Edge's Private Network Access (shipped 2022) gates the first request on a one-time user consent per origin. No TLS on the robot, no cert ceremony, no crypto IRAM pressure. ~1 sec for a 1.6 MB bin over LAN. Works whenever the dashboard and robot share a network. (Pi doesn't need this lane — BLE bundle OTA is already fast enough for Pi-sized updates.)

3. **Pi-as-gateway** — for multi-robot orchestration and offline-first classroom deployments. Pi runs an `aioquic` WebTransport server with a self-signed cert; dashboard uses `serverCertificateHashes` pinning (cert sha256 published in Pi's fw-info) to connect without PKI ceremony. Pi proxies raw TCP to the target ESP32 on the LAN. Same ~1 sec speed as PNA direct, with bonus orchestration surface (mesh multiple ESP32s, serve dashboard offline). Earns its slot when multi-robot coord or offline-first use cases land, not purely for OTA speed.

**Why the three-lane shape:**
- Lane 1 works on BLE only. No WiFi assumption.
- Lane 2 works when browser and robot share a LAN. Most common case.
- Lane 3 works when the fleet has a Pi (most Better Robotics fleets do).

Dashboard tries fastest available, falls back automatically. User never picks a lane.

**Sequencing.** BLE-WithoutResponse first (universal, smallest change). PNA + ESP32 `/ota` second (big bang for effort). Pi-as-gateway when its orchestration/offline story earns it.

## 4. ESP32 build-as-a-service

**Claim.** ESP32 firmware is purely deterministic from `{board, caps}`. Users currently install `arduino-cli` + core + toolchain to compile. If a service accepts a config and returns a signed `.bin`, the dashboard's "Flash firmware" button fetches a per-robot-config binary; no local dev environment is needed for adding capabilities.

**Constraint.** The service has to be reliable enough that users aren't stuck if it's down. Either (a) same-origin build on GitHub Actions, or (b) a small hosted build service, or (c) in-browser compile via something like Wokwi's WebAssembly toolchain (the bold option).

**The compound effect.** Combined with #1, adding an ESP32 capability becomes: declare schema, bind driver code in a capability driver DSL, click Flash. No C++, no toolchain, no linker flags.

**Worth it when.** Project has contributors who want to add capabilities without learning the ESP32 toolchain. Today the audience is small enough that `make flash` is fine.

## 5. NFC tap-to-pair

The original NFC role (handing the phone the puck's SoftAP creds) died with BLE-first. Tags still earn a slot as a *tap-to-pair-this-specific-robot* shortcut — collapses "scan → find robot-7 in a list of 12 → confirm" to a single tap.

- **Tag content:** NDEF URL → `https://better-robotics.github.io/workbench/?pair=<robot-id>`. Dashboard reads `pair` from `location.search`, filters the BLE scan to that device.
- **Android Chrome:** tap → URL → filtered scan → confirm.
- **iPhone:** iOS opens the URL but Web Bluetooth is unavailable. Workaround rides the phone↔desktop pair layer (hub-broker signaling + signed pair-request, `phone.html`): encode `phone.html?pair=<robot-id>`; the phone forwards `{type:"pair-robot", robotId}` over WebRTC and the desktop surfaces a "Phone wants to pair robot-7 — click to confirm" banner (the desktop click is required — `navigator.bluetooth.requestDevice` needs a user gesture). Same-LAN only: both devices on the hub's network.
- **Bootstrap caveat:** first-ever use still needs the phone↔desktop pair ceremony.

## Open questions

- **Visual / block-based authoring tier.** Capability cards and `pip.ask` are the only non-code surfaces — no block editor for "when distance < 30cm, stop and turn right." XRP and MicroBlocks (`field.md`) ship Blockly. Do cards + Pip cover non-coder authoring, or is a drag-drop tier needed?
- **Inter-robot messaging.** Every message fans out through the browser as hub — no robot↔robot path. Tied to the pub/sub direction but a separate architectural commitment.
- **Coordinate frames + time sync.** Required for sensor fusion and any multi-robot localization. Nothing in the scaffold addresses them.

## Rejected / deferred

- **Running without Linux on the Pi (bare-metal).** Loses Python, gpiozero, systemd, apt. Not a simplification; a regression. The Pi being a real computer is the feature.
- **Replacing BLE GATT with a custom protocol.** GATT is a standard with tooling, debuggers (`bluetoothctl`, `nRF Connect`), and cross-platform support. Reinventing would be faster to design and slower forever.
- **Making the dashboard a conversational (chat-only) UI.** Visual feedback for video, logs, and pinout has better throughput than text. The LLM-orchestrator direction adds chat alongside, doesn't replace.

---

# Pip's proactive messages come from project state, not external feeds

No scheduled pipeline scraping external robotics sources (X, Reddit, HN, ArXiv, Hackaday RSS). No notification backend, no content channel.

## What we do instead

Situational observations from state the dashboard already has. A colleague leaning over your desk saying *"hey, I notice X,"* not a newsletter.

Inputs, all same-origin:

- Robot telemetry — firmware version drift, last-seen timestamps, which robots are `firmware-down` vs `connected`, which capabilities have never been exercised.
- User scripts (`scripts.js` + localStorage) — saved but never run, errored on last run, related to a stalled goal.
- Project intent — `.claude/CLAUDE.md`.

One short observation, tied to a user-activity boundary (session start, session end, robot reconnect after > 24h), not a wall-clock cron. Dismissable without consequence.

Shape examples:

```
Your "line-follow" script errored on BLE drop last Thursday.
Heartbeat shipped — worth retrying?

You've paired Pi-03 twice but never opened the camera capability.
Want me to walk through it?

Firmware on Pi-01 is 4 versions behind. New pulse caps landed in
between — OTA when convenient?
```

Each names a *specific* thing *this user* did or didn't do — signal a generic feed can't carry.

## Why this shape

Pip runs in the browser; every input that would change what Pip says is also in the browser, or one `fetch()` away in `.claude/*.md`. Putting signal source on a schedule outside the browser separates thinking from data and pays the cost of keeping them in sync.

- **Zero new infrastructure.** No cron, scraper, CI job, JSON corpus, filter pipeline. Just `assistant.js` plus a small observation reader.
- **Zero new trust boundary.** Same-origin reads of the dashboard's own stores.
- **High signal by construction.** An observation referencing the user's own script by name clears "is this relevant?" before it's written. A trending-reddit link does not.
- **Dismissal is free.** Observations are ephemeral; ignoring one builds no unread debt.

## Failure mode this avoids

"Give Pip a feed so messages aren't boring" is the engagement reflex every newsletter SaaS tries: push content on a schedule, hope relevance averages out. Generic feeds get ignored because the user pays a translation cost from *"someone built X"* to *"does this matter for me right now?"* That cost kills engagement.

## When would an external feed earn its way in?

When the state-aware layer saturates — Pip has mined what the browser knows and the ceiling becomes *"Pip doesn't know about the new ESP32-S3 cam module that would unblock the perception loop."* Then:

1. GitHub Action on the `pulse` pattern — public-API-only, no-auth, committing JSON to `docs/feed/`. Sources: Reddit `.json`, HN Algolia, GitHub trending by topic, Hackaday/Adafruit/Sparkfun RSS, ArXiv. **Not X**: free tier died.
2. Feed is a **secondary input to the same filter** reading project state. Filter stays in the browser; the Action is dumb by design.
3. Observations referencing external content still clear *"and here's why it matters for your current work."*

State-aware layer first, let it saturate, then add the corpus.

---

# Wired but unproven — pending real-world validation

Loads at runtime but not confirmed end-to-end against hardware. Kept out of `README.md`, `DEV.md`, and the GitHub repo About until a real run confirms the path.

## Grounding DINO open-vocab detector — deleted (May 2026)

Lived in `docs/grounding.js` as the open-vocab fallback when MediaPipe COCO's 80 classes couldn't cover a target. Disabled after real-world false positives (medium-confidence "stop sign.[SEP]" matches against a robot-vacuum dock — BERT separator token leaking through the post-processor). Deleted entirely once Claude vision via `view_robot_frame` was confirmed to fill the same role with scene reasoning the bbox-only detector couldn't do.

**Why deleting rather than fixing.** The role this module filled — "give Pip a way to localize 'the yellow can' or 'the book on the bag'" — is now served by the planner itself. Pip sends a frame to Claude, Claude reads the scene, plans the next action. No bbox needed when the planner can reason. Re-arming the closed-vocab variant would duplicate the role with worse semantics (no scene context, false-positive history) AND keep a 151 MB model download in the asset graph.

**What to revisit if it comes back.** A future need for sub-second open-vocab bboxes at the rate the LLM can't serve (Claude vision is ~1–2 s round-trip; bbox-rate use cases want ~100 ms). At that point: re-evaluate Grounding DINO 1.5, owlv2, or YOLO-World — but only after a use case earns it. Reactive open-vocab is not on the wedge today.

## YOLO26n closed-vocab detector (`docs/perception/yolo26.js`)

Faster sibling for reactive-tier use cases (visual servo, gamepad-overlay tracking). Wired behind `/detector yolo26` with the registry in `docs/perception/detectors.js`; MediaPipe stays the default. ONNX runtime via WebGPU EP with WASM fallback, ~10 MB COCO model fetched from HuggingFace on first use.

**What hasn't been confirmed.** End-to-end accuracy vs MediaPipe EfficientDet-Lite0 on the same scenes, WebGPU EP stability across the Chrome/Edge versions students will run, first-fetch UX on classroom WiFi (10 MB ONNX + onnxruntime-web bytes). Promote to default — or remove from the registry — only after a side-by-side run. Out of `README.md` and `DEV.md` until then.

## Laptop camera → phone feed (helper card "Send to phone" toggle)

Local-cam helper card's only job: a "Send to phone" toggle button. Turning it on opens the camera via getUserMedia and `peer.addTrack`s the video track on every paired phone; the phone displays it in the existing `phone-cam-section` since it's "incoming forwarded video from desktop" — the same sink robot cameras already use. Runtime-only state (`_phoneFeedLocalId` in phone-helpers.js), not persisted across reloads.

**Latent.** `phone-cam-section` displays one stream at a time (`v.srcObject = e.streams[0]`, last-wins). When both a robot camera and the laptop-cam are routed to the same phone simultaneously, whichever fires `peer.onTrack` last wins; there is no UI on the phone to switch back. The existing `available-sources` / `subscribe-source` picker handles this per-robot but is not yet generalized across owner types. Acceptable for the single-source case the prototype is built around; if multi-source coexistence becomes the steady-state demo, generalize the picker (own-id namespace = `"robot:<id>" | "local:<deviceId>"`, single global active per phone) before adding more source kinds.

---

# Forks in the road — alternatives evaluated, with revisit triggers

Adjacent technical paths declined, with the specific change in project direction that would trigger a revisit. (Distinct from `field.md`, which audits adjacent work.)

## ESP32 WebRTC (esp_peer/libpeer) — removed 2026-07

**What it was.** A vendored esp_peer/libpeer peer connection (BLE-signaled, four hand-patched chip-quirk fixes — forced DTLS client role, dashboard-supplied cert, dashboard-side SDP rewriting, mbedTLS Kconfig) carrying two data channels: camera video (chunked JPEG over an unreliable DataChannel, 3-5 fps — not real RTP video, the classic-ESP32 watchdog couldn't survive libpeer's video packetizer) and a WebRTC OTA fast-path (seconds vs ~30s BLE-stream).

**Why removed.** The video path's only payoff over the already-shipped HTTP MJPEG fallback was cross-NAT reachability (STUN/TURN) — never a validated need for a classroom/hobbyist robot on the same LAN as its operator, per `field.md`'s own "not a teleop dashboard" positioning. The four-patch surface was fragile (hand-debugged against libpeer internals, ~215 KB flash) for a benefit nobody asked for. Removing it also meant losing the WebRTC OTA speedup that rode the same PeerConnection — accepted as the simpler, smaller-surface trade; ESP32 OTA is back to BLE-stream only (Lane 1) until the PNA-direct HTTP OTA lane (Lane 2, still "not yet implemented") lands.

**Update (2026-07): the Pi robot was retired to the hub.** The Pi's WebRTC peer (shell, logs, OTA via aiortc) and its separate `webrtc-installable` camera were later removed outright when Pi provisioning moved to `better-robotics/hub` — a Pi now runs the classroom hub, not workbench firmware. Workbench has no robot↔desktop WebRTC path at all anymore; the only WebRTC left is phone↔desktop pairing.

**Revisit trigger.** If a validated cross-NAT camera-viewing use case shows up (not just theoretical), evaluate Espressif's first-party KVS WebRTC SDK ([awslabs/amazon-kinesis-video-streams-webrtc-sdk-c@beta-reference-esp-port](https://github.com/awslabs/amazon-kinesis-video-streams-webrtc-sdk-c/tree/beta-reference-esp-port)) rather than reviving libpeer — it eliminates 3 of the 4 chip-quirk patches at the cost of hardwiring signaling to AWS KVS/`webrtc.espressif.com`, which would need a custom `signaling_client_if` to keep BLE-only signaling. Also carries KVS WebRTC Split Mode (ESP32-C6 signaling + ESP32-P4 streaming, wake-on-signal) — the only battery-powered WebRTC camera architecture in the ecosystem, relevant only if low-power ever becomes a constraint.

## Overhead ArUco localization (`docs/perception/aruco.js`) — removed 2026-07

**What it was.** Headless marker detection (`js-aruco2` from jsDelivr) reading frames from a designated phone or laptop camera, writing `entry.arucoPosition = {x, y, headingDeg, updatedAt}` on the matching robot once a second. Surfaced as an "Overhead localization" role on the Helpers section's phone and local-camera cards, with an SVG marker overlay painted on the live preview and a printable marker sheet (`docs/assets/aruco_markers_*.pdf`).

**Why removed.** Never load-bearing — grep-confirmed nothing ever read `entry.arucoPosition` (the planned consumer, item 5's closed-loop draw-a-path follower, was never built). It was pure-cost UI surface: a second "Camera role" designation to explain, an SVG-overlay rendering path, a CDN script load, a persisted-settings pair (`arucoOverheadPhoneId`/`arucoOverheadLocalId`/`arucoMarkerSizeMm`), and marker-printing instructions — none of it doing anything a user could point to.

**What's unaffected.** The Helpers section's other two jobs — mounting a phone's camera onto a robot as a second eye (`attachPhoneCameraTo`, robot-card driven) and forwarding a laptop camera to paired phones (now a plain "Send to phone" toggle, no role picker) — are untouched; neither ever depended on ArUco.

**Revisit trigger.** A real want for closed-loop visual servo (draw a path on the phone, robot follows it) without a depth sensor. If that materializes, re-add pose *and* the follower together rather than pose alone — validate metric accuracy against tape-measured ground truth before building the controller on top, per the original scope-honesty note: claiming spatial awareness before it works is worse than not having the feature.
