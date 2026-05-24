# Exploration

Open architectural directions, design rationale, runtime state under validation, and forks evaluated but not taken. The thinking-in-progress layer. Committed work lives in `direction.md`; positioning research in `field.md`.

---

# Architectural directions

Long-horizon shape decisions. Updated when the shape of the system changes.

## 1. Generic typed-characteristic runtime (in flight)

**Claim.** Every capability today exists in ~3 places (browser module, Pi handler, ESP32 handler). 80% of those files are boilerplate isomorphic to the capability's TYPE, not its identity. A generic runtime keyed on type eliminates the boilerplate.

**The data already exists.** `fw-info.caps` declares typed schemas:

```json
{ "name": "led",    "char": "…d92", "type": "toggle" }
{ "name": "motors", "char": "…d99", "type": "signed-pair", "range": [-100, 100] }
{ "name": "wifi",   "chars": {...}, "type": "wifi-scan" }
{ "name": "ota",    "chars": {...}, "type": "bundle-ota" }
{ "name": "camera", "chars": {...}, "type": "webrtc-installable" }
{ "name": "ops",    "char": "…d9c", "type": "command" }
```

**The runtime (browser side).** A per-type constructor `makeXxxCap(schema)` returns `{probe, cleanup, renderSection, wireActions, postRender?}`. Adding a capability of a known type = one schema entry + zero JS code.

**Firmware-side direction (farther out).** Pi and ESP32 firmware have identical ceremony: register char, parse read/write, notify on change, gate on config. A "typed char runtime" on firmware reads the capability declaration and handles generic typed chars with a small driver binding per capability (`{ on_write: fn, on_read: fn }`).

**Progress so far:**
- fw-info.caps carries the typed schema (shipped)
- Browser reads + stores `entry.capSchema` (shipped)
- Each capability module exports its own `schema` for cross-check (shipped)
- First type migrated: `toggle` → LED
- Future types to migrate: `signed-pair`, `wifi-scan`, `bundle-ota`, `webrtc-installable`, `command`. Each is ~2–4 hours.

**Migration strategy.** Per-type, not per-capability. When we migrate `signed-pair`, both motors AND any future 2-axis input use the same runtime. The compound payoff is the Nth capability, not the first.

## 2. AI-maintained documentation (cheap, deferred)

**Claim.** `README.md`, `HARDWARE.md`, `firmware/pi_robot/README.md`, and per-capability comments all describe what `fw-info.caps` + the code already know. They drift. An AI agent watching the schema + commit log can regenerate docs per release.

**Scope.** ~2 days to wire a pre-commit generator plus a CI check that fails if docs aren't regenerated. Starts small: capability reference page auto-generated from the live schema. Expands to change-log summarization from commit messages.

**Not urgent.** Doc drift isn't causing failures today. Worth doing when the project has contributors outside the core, or when we promise backward-compatibility guarantees that require accurate docs.

## 3. Transparent-data-plane OTA (partially in flight)

**Claim.** Every robot should have three OTA lanes with a clear fallback order. The dashboard picks the fastest available without user intervention. Iteration-loop speed is the core dev experience; "how fast does code get onto the robot" sets the tone for everything else.

**The three lanes, decreasing friction:**

1. **BLE-stream** — always works, no WiFi needed, no LAN co-location required. Baseline for every robot on every network. Today: `writeValueWithResponse` + ATT ack per 180-byte frame → 3-10 min for a 1.6 MB bin. Switching to `writeValueWithoutResponse` + software flow control over `ota-status` gets it to ~30 sec. **Not yet implemented.**

2. **PNA direct to target robot** — dashboard fetches `http://<robot-ip>/ota` straight from the browser. Chrome/Edge's Private Network Access (shipped 2022) gates the first request on a one-time user consent per origin. No TLS on the robot, no cert ceremony, no crypto IRAM pressure. ~1 sec for a 1.6 MB bin over LAN. Works whenever the dashboard and robot share a network. **Not yet implemented on ESP32** (Pi doesn't need this lane — BLE bundle OTA is already fast enough for Pi-sized updates).

3. **Pi-as-gateway** — for multi-robot orchestration and offline-first classroom deployments. Pi runs an `aioquic` WebTransport server with a self-signed cert; dashboard uses `serverCertificateHashes` pinning (cert sha256 published in Pi's fw-info) to connect without PKI ceremony. Pi proxies raw TCP to the target ESP32 on the LAN. Same ~1 sec speed as PNA direct, with bonus orchestration surface (mesh multiple ESP32s, serve dashboard offline). **Not yet implemented.** Earns its slot when multi-robot coord or offline-first use cases land, not purely for OTA speed.

**Why the three-lane shape:**
- Lane 1 works on BLE only. No WiFi assumption.
- Lane 2 works when browser and robot share a LAN. Most common case.
- Lane 3 works when the fleet has a Pi (most Better Robotics fleets do).

Dashboard tries fastest available, falls back automatically. User never picks a lane.

**Sequencing.** BLE-WithoutResponse first (universal, smallest change). PNA + ESP32 `/ota` second (big bang for effort). Pi-as-gateway when its orchestration/offline story earns it.

## 4. ESP32 build-as-a-service (bold, later)

**Claim.** ESP32 firmware is purely deterministic from `{board, caps}`. Users currently install `arduino-cli` + core + toolchain to compile. If a service accepts a config and returns a signed `.bin`, the dashboard's "Flash firmware" button fetches a per-robot-config binary; no local dev environment is needed for adding capabilities.

**Constraint.** The service has to be reliable enough that users aren't stuck if it's down. Either (a) same-origin build on GitHub Actions, or (b) a small hosted build service, or (c) in-browser compile via something like Wokwi's WebAssembly toolchain (the bold option).

**The compound effect.** Combined with #1, adding an ESP32 capability becomes: declare schema, bind driver code in a capability driver DSL, click Flash. No C++, no toolchain, no linker flags.

**Worth it when.** Project has contributors who want to add capabilities without learning the ESP32 toolchain. Today the audience is small enough that `make flash` is fine.

## 5. Closed-loop visual control: draw-a-path (next, after overhead ArUco validates)

**Claim.** Once an overhead camera + marker is established (the `aruco.js` work — overhead localization writing `entry.arucoPosition` per scan), the natural next layer is closed-loop control driven from that pose. Operator props the phone (or local webcam) overhead, finger-draws a path on the phone screen, the robot follows it. New sensor isn't needed; the pose primitive is already shipping.

**The hard sub-problem isn't drawing or motor control — it's pose reliability.** Without knowing where the robot is each frame, the closed loop doesn't close and the robot drifts within seconds. The overhead ArUco surface gates this — until metric accuracy is validated against tape-measure ground truth (see "Wired but unproven" below), don't build the follower on top.

**Right primitives, in order of load-bearing-ness:**
- **Pose**: ArUco overhead, already shipped. Producer writes `entry.arucoPosition`; consumer (this work) must gate on `Date.now() - updatedAt` for staleness.
- **Where compute lives**: dashboard runs detector + controller + emits pulse-bounded BLE motor writes. Phone is I/O. Robot unchanged. Same control-plane / data-plane split as everything else.
- **Tech**: `js-aruco2` already in. Pure-pursuit controller in plain JS (~50 lines).
- **Control loop budget**: detect (~15 ms) + plan (~1 ms) + BLE pulse (~50 ms) ≈ 70 ms / iter → ~14 Hz. Each iteration emits a short pulse (`duration_ms ≈ 100 ms`); firmware watchdog auto-stops if the next iter doesn't arrive. The existing pulse-bounded-motion + watchdog invariants are the safety floor — same discipline as Pip / user scripts.

**Phases:**
1. **Path source.** `<canvas>` overlay on `phone.html` viewfinder; touch listeners build a stroke-point array; send over the existing WebRTC data channel as a typed message (`{type: "path", points: [[x, y], ...]}`). Dashboard receives and renders on the helper's SVG overlay alongside marker outlines. No motors yet.
2. **Closed-loop follower.** Pure-pursuit drives the most-recent path; pulse-bounded each iter; safety stops on marker-loss ≥ 1 s, end-of-path, or tap-to-cancel from the phone.
3. **Pip tool surface.** `get_robot_pose(robot_id)` returns `{x, y, theta, confidence}` from `entry.arucoPosition`. Optional; not on the MVP critical path.

**Validation criterion.** Tape marker on a rover, prop a phone or webcam overhead, draw a curved path on the phone screen, watch the robot trace within ~5 cm of the line over 1-2 m. If shipping leaves the rover drifting off-line within seconds, or the loop falls below 5 Hz on target hardware, the primitive isn't load-bearing — redesign before extending.

**Scope honesty.** This flips part of CLAUDE.md's "Not spatially aware" stance: when an overhead camera + marker is present, the robot has a known 2D pose. Not SLAM, not depth — just fiducial-bounded planar pose. CLAUDE.md updates only after phase 2 lands and the validation criterion passes; claiming a capability before it works is the worst kind of scope drift.

**Failure modes to watch.** Marker lost > 1 s → safety stop (this IS the safety story for this loop). Phone-held-at-angle breaks the co-planar assumption: small angles tolerable, larger paths earn a homography. Open-vocab "drive toward the yellow cup" routes through Claude vision (~1–2 s) — too slow for a 5 Hz loop; ArUco-pose stays self-contained until reactive open-vocab earns its way.

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
- Project intent — `.claude/CLAUDE.md` and `.claude/working.md` when present.

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

## Overhead ArUco localization (`docs/perception/aruco.js`)

**What's wired.**
- Headless detection service — no UI panel. Helper-card "Camera role" select on each paired phone offers `Operator / Overhead localization / Mount on <robot>`. Choosing Overhead sets `settings.arucoOverheadPhoneId` (persisted) and points the detection loop at that phone's existing preview tile in the helpers card. No second video element, no second decoder.
- SVG overlay paints detected markers directly on the helper's preview (`patchArucoOverlay`-style — same shape as the deleted phone-on-robot tracker, retargeted at the helpers tile).
- Detection via `js-aruco2` from jsDelivr (`cv.js` + `aruco.js` + `posit1.js`), dictionary `ARUCO_4X4_50`. Printable marker sheets in `docs/assets/aruco_markers_0.pdf` and `_1.pdf`. Pose via `POS.Posit` using `settings.arucoMarkerSizeMm` + focal-length heuristic (`max(w,h) * 0.85`) — no calibration file.
- Marker → robot binding: prefers explicit `entry.arucoMarkerId` (persisted in localStorage; set via `window.bindArucoMarker(robotId, markerId)`). Falls back to positional `entries[m.id]` only when NO entry has claimed that id. Hits write `entry.arucoPosition = { x, y, headingDeg, markerSizeMm, updatedAt }`.

**What hasn't been confirmed.**
- Focal-length heuristic accuracy against a real ruler ("perfect" to "off by 30%" both plausible without ground truth).
- ARUCO_4X4_50 detection reliability on a phone-camera feed via WebRTC (compression, autofocus hunting, rolling-shutter under motion).
- Multi-robot orchestration end-to-end: two robots, two markers, two bindings, both `arucoPosition`s update on the same scan, motion planner consumes both without drift. Wedge demo for the primitive.
- Ultra-wide-by-default for "Back" sharing (`docs/mobile.js` `openCameraStream`) means a phone designated for overhead localization will feed an ultra-wide stream — barrel distortion + a much shorter focal length than the `max(w,h)*0.85` heuristic assumes. The aruco detector itself will likely still find markers; pose estimation will be biased. If overhead aruco gets promoted out of unproven, the right fix is to force a non-widening lens on phones designated as overhead, or take a per-deviceId intrinsic from a one-time calibration.

**To validate.** Print sheet 0 + sheet 1, tape marker 0 on Pi-01 and marker 1 on Pi-02. Pair a phone, share its camera, set role to "Overhead localization." Bind explicitly: `window.bindArucoMarker("<pi-01-id>", 0)` and `window.bindArucoMarker("<pi-02-id>", 1)`. Confirm both robots' `arucoPosition` update simultaneously on each detection, metric XY within ~20 mm of tape-measured ground truth at ~50 cm camera height. If it holds, promote: line in `README.md` perception section, bullet in `DEV.md` "When to reach for what."

**Why bother.** Sub-pixel deterministic pose for a tagged object is the only roadmap primitive that closes the visual-servo loop without a depth sensor — and the substrate for multi-robot orchestration. Drives `entry.arucoPosition` which the motion controller consumes as ground truth (subject to its staleness gate — `aruco.js` does not clear stale entries when a robot leaves frame; consumer's job).

## Grounding DINO open-vocab detector — deleted (May 2026)

Lived in `docs/grounding.js` as the open-vocab fallback when MediaPipe COCO's 80 classes couldn't cover a target. Disabled after real-world false positives (medium-confidence "stop sign.[SEP]" matches against a robot-vacuum dock — BERT separator token leaking through the post-processor). Deleted entirely once Claude vision via `view_robot_frame` was confirmed to fill the same role with scene reasoning the bbox-only detector couldn't do.

**Why deleting rather than fixing.** The role this module filled — "give Pip a way to localize 'the yellow can' or 'the book on the bag'" — is now served by the planner itself. Pip sends a frame to Claude, Claude reads the scene, plans the next action. No bbox needed when the planner can reason. Re-arming the closed-vocab variant would duplicate the role with worse semantics (no scene context, false-positive history) AND keep a 151 MB model download in the asset graph.

**What to revisit if it comes back.** A future need for sub-second open-vocab bboxes at the rate the LLM can't serve (Claude vision is ~1–2 s round-trip; bbox-rate use cases want ~100 ms). At that point: re-evaluate Grounding DINO 1.5, owlv2, or YOLO-World — but only after a use case earns it. Reactive open-vocab is not on the wedge today.

## YOLO26n closed-vocab detector (`docs/perception/yolo26.js`)

Faster sibling for reactive-tier use cases (visual servo, gamepad-overlay tracking). Wired behind `/detector yolo26` with the registry in `docs/perception/detectors.js`; MediaPipe stays the default. ONNX runtime via WebGPU EP with WASM fallback, ~10 MB COCO model fetched from HuggingFace on first use.

**What hasn't been confirmed.** End-to-end accuracy vs MediaPipe EfficientDet-Lite0 on the same scenes, WebGPU EP stability across the Chrome/Edge versions students will run, first-fetch UX on classroom WiFi (10 MB ONNX + onnxruntime-web bytes). Promote to default — or remove from the registry — only after a side-by-side run. Out of `README.md` and `DEV.md` until then.

## Laptop camera → phone feed (helper card role "Send to phone")

Local-cam helper card gains a third role alongside Overhead. Selecting "Send to phone" opens the camera via getUserMedia and `peer.addTrack`s the video track on every paired phone; the phone displays it in the existing `phone-cam-section` since it's "incoming forwarded video from desktop" — the same sink robot cameras already use. Runtime-only state (`_phoneFeedLocalId` in phone-helpers.js), not persisted across reloads.

**Latent.** `phone-cam-section` displays one stream at a time (`v.srcObject = e.streams[0]`, last-wins). When both a robot camera and the laptop-cam are routed to the same phone simultaneously, whichever fires `peer.onTrack` last wins; there is no UI on the phone to switch back. The existing `available-sources` / `subscribe-source` picker handles this per-robot but is not yet generalized across owner types. Acceptable for the single-source case the prototype is built around; if multi-source coexistence becomes the steady-state demo, generalize the picker (own-id namespace = `"robot:<id>" | "local:<deviceId>"`, single global active per phone) before adding more source kinds.

---

# Forks in the road — alternatives evaluated, with revisit triggers

Adjacent technical paths declined, with the specific change in project direction that would trigger a revisit. (Distinct from `field.md`, which audits adjacent work.)

## Espressif KVS WebRTC SDK for ESP32

**Evaluated:** May 2026. Espressif's first-party WebRTC stack ([awslabs/amazon-kinesis-video-streams-webrtc-sdk-c@beta-reference-esp-port](https://github.com/awslabs/amazon-kinesis-video-streams-webrtc-sdk-c/tree/beta-reference-esp-port), HEAD 119617b7 at evaluation time). Ships an AppRTC-mode example targeting classic ESP32. Active development, monthly sync to upstream awslabs releases, 1.2k stars.

**What it would buy us.** Eliminates three of our four libpeer/esp_peer patches at the chip level: chip is DTLS CLIENT by default (so the fragmented-ClientHello bug is sidestepped without patching), SDP answerer emits `setup:active` directly, MID copied from remote offer, ICE agent silently ignores TCP candidates. The four-patch shape in `firmware/esp32_robot_idf/WEBRTC.md` collapses to one (mbedTLS Kconfig). Cert flow returns to chip-side ECDSA generation (~9 KB flash cost we currently save).

**Why not now.** Signaling is hardwired to HTTPS+WebSocket against AWS KVS or `webrtc.espressif.com`. Swapping in means writing a custom `signaling_client_if` implementation that takes offers/answers off our BLE `SIGNAL` characteristic and feeds the SDK's `kvs_peer_connection_if`. The plug point is documented (`CUSTOM_SIGNALING.md` in their tree), but the work doesn't buy us anything the libpeer patches don't already deliver — our wedge is precisely "BLE-signaled, no internet rendezvous." We'd also inherit a 3 MB factory partition expectation that's marginal on classic ESP32's 4 MB flash.

**Revisit trigger.** If a hosted-mode / internet-rendezvoused operator surface lands on the roadmap (share-a-link demos, remote tele-op, third-party robots controlling our robots), KVS WebRTC SDK is the prebuilt path — switch outright rather than reinvent BLE-on-KVS. The libpeer + four-patch setup made sense for BLE-only; it does not earn its keep against a stack that handles cloud signaling for free.

**Bonus capability worth knowing.** KVS WebRTC Split Mode distributes signaling to ESP32-C6 (light sleep) and streaming to ESP32-P4 (deep sleep until wake-on-signal) — the only battery-powered WebRTC camera architecture in the ecosystem. Irrelevant to mains-powered robots today; remember it if low-power ever becomes a constraint.
