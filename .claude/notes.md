# Notes

Operator-private notes — decisions, competitive analysis, feature design rationale. Encrypted at rest via git-crypt.

---

# Competitors

Systems competing for the same user decision — *"how do I write code for a small robot from a browser tab without installing anything."* Filtered for what would change a decision.

## schematik.io — not in this lane

[schematik.io](https://schematik.io) bills itself as "Cursor for Hardware": AI code-generation emitting firmware/schematic-adjacent code from natural language for Arduino, ESP32, Raspberry Pi (~$4.6M pre-seed). Not a pairing UI, not a control plane, not a dashboard. A *potential input* for authoring firmware like ours, not a competitor to the runtime-control story.

## The real candidates

### LEGO SPIKE web app (spike.legoeducation.com)
- **Competes for:** the classroom decision — "which kit lets students code from a Chromebook with no install."
- **Overlap:** Web Bluetooth + WebSerial in Chrome, no native app ([Chrome for Developers](https://developer.chrome.com/blog/lego-education-spike-web-bluetooth-web-serial)). Programs upload to hub, hub executes.
- **Divergence:** code runs *on the hub*, not the browser. Closed hardware, closed firmware, no user-owned OTA.
- **Better than us today:** mature curriculum, institutional purchase channel.
- **Decision impact:** confirms BLE-first-via-browser as mainstream, not contrarian. Does not threaten browser-as-brain — they deploy to hub; we deliberately don't.

### Sphero EDU web app
- **Competes for:** same classroom decision as LEGO.
- **Overlap:** Web Bluetooth pairing of BOLT+/BOLT/Mini/RVR ([help.sphero.com](https://help.sphero.com/sphero-support/connecting-robots-in-the-sphero-edu-web-app)).
- **Divergence:** Sphero account required, their robots only. No user-owned firmware, no recovery plane, no LLM surface.
- **Better than us today:** polished UI, k-12 marketplace presence, iOS native fallback.
- **Decision impact:** reinforces the "no account" moat — account-gating is exactly the friction this project refuses.

### Makeblock (mBlock + mBot family)
- **Competes for:** same K-12 classroom decision — at the largest scale claim of any vendor in this list (200k+ schools).
- **Overlap:** mBlock 5 web at [ide.mblock.cc](https://ide.mblock.cc/) runs in Chrome/Edge, connects to mBot/CyberPi/Codey Rocky over Web Bluetooth + WebSerial without a helper app ([Makeblock support](https://support.makeblock.com/hc/en-us/articles/19412317319191-Introduction-to-Direct-Connection-of-mBlock-5-on-the-web)). Block + Python.
- **Divergence:** account-required walled garden. Programs run on closed proprietary firmware. Hardware lock-in to Makeblock kits. No LLM, no recovery plane.
- **Better than us today:** scale (200k schools), educator curriculum, hardware breadth (CyberPi has its own screen + sensors), Chinese-market depth, multi-platform (PC/mobile/web).
- **Decision impact:** confirms Web-Bluetooth-from-browser is the dominant K-12 STEAM pattern, not contrarian. Reinforces the "no account, no proprietary kit" wedge: every major K-12 vendor (LEGO, Sphero, Makeblock) is account-gated and kit-locked. The combination "browser-paired AND user-owned hardware AND no account" remains unoccupied.

### MicroBlocks (microblocks.fun)
- **Competes for:** browser IDE to program a BLE/serial-connected microcontroller with blocks.
- **Overlap:** runs in Chrome/Edge via WebSerial + Web Bluetooth, no install; supports micro:bit, XRP, and others ([wiki.microblocks.fun](https://wiki.microblocks.fun/en/xrp_setup)). Live programming model.
- **Divergence:** pushes a VM to the device; programs run on-board. No LLM, no phone-human handoff. Single-device focus.
- **Better than us today:** live autocomplete / block editing against running firmware; a real educational community.
- **Decision impact:** closest architectural cousin. Validates "browser-first, no-account, BLE-capable" as a shipped pattern. Has no opinion on browser-as-brain for runtime.

### XRPCode / WPILib XRP (experientialrobotics.org)
- **Competes for:** cheap classroom robot + browser IDE — the tightest hardware-class analog.
- **Overlap:** browser IDE for the XRP (RP2040), Python + Blockly, no install ([WPILib docs](https://docs.wpilib.org/en/stable/docs/xrp-robot/web-ui.html)).
- **Divergence:** WiFi/WebSocket, not BLE-first — robot must be on the same network, which is exactly the classroom pain our BLE-first bet was designed around. Code runs on-robot. No LLM, no phone handoff.
- **Better than us today:** FRC-backed curriculum, ~$75 hardware, real classroom deployments.
- **Decision impact:** directly validates bet #1 — WiFi-first classroom stories *do* break.

### Viam
- **Competes for:** *closest framing rhyme.* Tagline "build robots like you build software" — same dev-environment-shape pitch, different audience and distribution model.
- **Overlap:** browser dashboard, camera streaming, live control ([viam.com](https://www.viam.com/product/platform-overview)). gRPC/WebRTC to a device-resident `viam-server`. Modular components, multi-language SDKs.
- **Divergence:** server-resident B2B cloud SaaS. `viam-server` fetches config from Viam cloud at startup ([docs.viam.com](https://docs.viam.com/operate/reference/viam-server/)). Different buyer (software engineer at an industrial outfit, fleet operator), different distribution shape (account-anchored cloud product vs. static-site, no-backend).
- **Better than us today:** data capture/sync, fleet management, funding, UR partnership.
- **Decision impact:** **inspiration, not competition.** Same transport stack we ship; treats the same problem space at industrial scale. Watching their feature surface tells us what becomes table-stakes for "robotics dev environment." Our distribution shape (browser-only, no backend, MIT) is the moat — they can ship features in 18 months; restructuring their cloud-product distribution model to match would be a different company.

### Freedom Robotics
- **Competes for:** browser-based teleop and remote operation of fielded robots.
- **Overlap:** WebRTC video + control via browser; SDK/agent runs on the robot ([freedomrobotics.com](https://www.freedomrobotics.com/)).
- **Divergence:** server-resident B2B cloud SaaS, TURN-relay-anchored teleop, account + fleet model. No standalone deploy, no offline mode, no LLM/scripting surface.
- **Better than us today:** production teleop UX for industrial deployments, observability tooling, customer base in delivery + service robotics.
- **Decision impact:** same audience-shape conflict as Viam — enterprise/industrial vs. consumer/education/hobbyist. Worth tracking for transport / observability conventions; not a wedge threat.

### Improv Wi-Fi (open standard)
- **Competes for:** the onboarding moment — "how does a fresh device join Wi-Fi."
- **Overlap:** open standard for BLE-based Wi-Fi onboarding from a browser, Chrome/Edge ([improv-wifi.com](https://www.improv-wifi.com/)). Shipped across WLED, Tasmota, ESPHome.
- **Divergence:** explicitly scoped to Wi-Fi onboarding only — *"not the goal to offer a way for devices to share data or control."* Hands off to a device-hosted URL after provisioning.
- **Better than us today:** it's a *standard*, with network-effect adoption we don't have.
- **Decision impact:** **integration candidate, not a threat.** Our BLE onboarding characteristic could optionally speak Improv so any Improv-aware browser tool can provision our robots. See `@improv-wifi/sdk-js` on npm.

### ESP RainMaker
- **Competes for:** "ESP32-based product with BLE provisioning and a dashboard to control it."
- **Overlap:** BLE provisioning for ESP32/S3/C3/C6 ([docs.rainmaker.espressif.com](https://docs.rainmaker.espressif.com/docs/sdk/rainmaker-base-sdk/DeviceManagement/provisioning/)).
- **Divergence:** cloud-account-anchored by design — user↔node mapping during provisioning, AWS Cognito underneath. Mobile-app first. No browser-first story, no LLM.
- **Better than us today:** Espressif-backed, production-scale cloud infra.
- **Decision impact:** confirms that in the ESP32 ecosystem, the dominant BLE-provisioning story still assumes cloud + account + phone app. The "browser tab, no account, no server" stance remains differentiated.

### LeRobot (Hugging Face)
- **Competes for:** open-source stack to put an LLM/VLA brain on a robot.
- **Overlap:** LLM/VLA orchestration for hobby+research robots; v0.5 added Pi0-FAST, Real-Time Chunking, EnvHub ([HF blog](https://huggingface.co/blog/lerobot-release-v050), March 2026).
- **Divergence:** Python stack, GPU-assumed, imitation/RL-focused. No BLE story, no browser runtime, no classroom onboarding. Arms + manipulation, not browser-paired hobby robots.
- **Better than us today:** actual VLA models, datasets, research community.
- **Decision impact:** adjacent, not competitive — the "not real-time, not spatially aware, decision loop is seconds" scope line keeps us in a different lane. Potential future integration: `scripts.js` calling LeRobot policies client-side via transformers.js.

## Out of scope (one-liners)

- **Wokwi** — browser simulator, not a real-device pairing UI.
- **esptool-js / ESP Web Tools** — WebSerial flashers. Dependencies of the neighborhood, not competitors; we already rely on the same Web Serial API for recovery.
- **MakeCode micro:bit** — mature web IDE for micro:bit; overlaps MicroBlocks, adds little new signal.
- **Particle Device OS** — BLE provisioning exists but mobile-SDK oriented, commercial product flow, account-anchored. Same shape as RainMaker.
- **ROS 2 MoveIt, Dora-rs, industrial / arm stacks** — different buyer, different latency bracket, no browser pairing story. "Not real-time, not spatially aware" rules the lane out.
- **VEX IQ/V5, ROBOTIS** — proprietary-kit + proprietary-app lane. Doubly unavailable to the "no accounts, no server" thesis.

## Concluding read

**Clean head-on competitor for the actual shape — *write code for a robot in a browser tab, no install, AI assist optional, no backend*?** No. Closest cousins split the problem: **MicroBlocks** and **XRPCode** own browser-IDE-to-hardware but deploy code *to* the device and have no in-browser AI layer; **LEGO SPIKE**, **Sphero EDU**, **Makeblock mBlock** own classroom-web-app experience but are walled gardens with accounts and proprietary kits; **Viam** and **Freedom Robotics** are framing rhymes (server-resident dev environments) anchored to industrial cloud, accounts, fleet ops; **ESP RainMaker** and **Improv Wi-Fi** own BLE-provisioning but stop there; **LeRobot** owns VLA/LLM orchestration but has no browser runtime or BLE story.

**Anything say change direction?** No. Nearest tactical move: implement **Improv Wi-Fi** BLE onboarding alongside ours so Improv-aware tools (ESPHome Dashboard, WLED config, Home Assistant) can provision our robots. Interop win, not a strategy shift.

**Moat, ranked by erosion runway (slowest first):**
- **Browser-native dev surface.** Every "robotics platform" worth naming requires *some* install — `viam-server`, ESP-IDF, gpiozero on Pi, Arduino IDE. Static-site, no-backend distribution is structurally hard to copy without restructuring a whole company's product surface.
- **Browser-resident model serving.** Open-vocab detector, ArUco fiducial pose — all client-side. Viam, Freedom Robotics, LeRobot all assume server-side or per-device GPU.
- **Layered safety.** Firmware-bounded motors the IDE-level planner can't bypass. Ask-human as terminal cascade rung. Standard in driving (openpilot-panda), rare in hobby/classroom.
- **No backend, no accounts.** Static-site deployable, MIT-licensed. Sphero, Viam, Particle, RainMaker, Freedom — all account-anchor.

Keep the scope lines loud in the README. Market reads "robotics platform" and expects Sphero or Viam. Naming what it *isn't* — *not a teleop dashboard, not a fleet manager, not "AI does everything autonomously," not real-time, not spatially aware* — does more positioning work than any feature comparison.

## Sources

- [Schematik.io homepage](https://schematik.io)
- [LEGO Education SPIKE — Web Bluetooth + Web Serial (Chrome for Developers)](https://developer.chrome.com/blog/lego-education-spike-web-bluetooth-web-serial)
- [Sphero EDU Web App — Connecting Robots](https://help.sphero.com/sphero-support/connecting-robots-in-the-sphero-edu-web-app)
- [mBlock 5 web IDE](https://ide.mblock.cc/)
- [Makeblock support — direct browser connection](https://support.makeblock.com/hc/en-us/articles/19412317319191-Introduction-to-Direct-Connection-of-mBlock-5-on-the-web)
- [MicroBlocks XRP setup (Web Bluetooth)](https://wiki.microblocks.fun/en/xrp_setup)
- [MicroBlocks in the browser](http://www.microblocks.fun/en/microblocks_in_browser)
- [WPILib XRP Web UI](https://docs.wpilib.org/en/stable/docs/xrp-robot/web-ui.html)
- [Experiential Robotics XRP Code](https://www.experiential.bot/code)
- [Viam Platform Overview](https://www.viam.com/product/platform-overview)
- [viam-server reference](https://docs.viam.com/operate/reference/viam-server/)
- [Freedom Robotics homepage](https://www.freedomrobotics.com/)
- [Improv Wi-Fi homepage](https://www.improv-wifi.com/)
- [ESPHome 2025.10.0 changelog — Improv BLE improvements](https://esphome.io/changelog/2025.10.0/)
- [ESP RainMaker provisioning docs](https://docs.rainmaker.espressif.com/docs/sdk/rainmaker-base-sdk/DeviceManagement/provisioning/)
- [ESP RainMaker homepage](https://rainmaker.espressif.com/)
- [LeRobot v0.5.0 release notes (HF blog, Mar 2026)](https://huggingface.co/blog/lerobot-release-v050)
- [Particle BLE provisioning reference](https://docs.particle.io/reference/device-os/bluetooth-le/)
- [esptool-js (Espressif)](https://github.com/espressif/esptool-js)
- [LOFI Control (Web Bluetooth PWA for micro:bit)](https://cardboard.lofirobot.com/lofi-control-app-info/)

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

Shipping a scheduled pipeline before the state-aware layer exists pays pipeline maintenance for output state-aware messaging would dominate on relevance anyway.

## When would an external feed earn its way in?

When the state-aware layer saturates — Pip has mined what the browser knows and the ceiling becomes *"Pip doesn't know about the new ESP32-S3 cam module that would unblock the perception loop."* Then:

1. GitHub Action on the `pulse` pattern — public-API-only, no-auth, committing JSON to `docs/feed/`. Sources: Reddit `.json`, HN Algolia, GitHub trending by topic, Hackaday/Adafruit/Sparkfun RSS, ArXiv. **Not X**: free tier died.
2. Feed is a **secondary input to the same filter** reading project state. Filter stays in the browser; the Action is dumb by design.
3. Observations referencing external content still clear *"and here's why it matters for your current work."*

State-aware layer first, let it saturate, then add the corpus.

---

# Wired but unproven — pending real-world validation

Loads at runtime but not confirmed end-to-end against hardware. Kept out of `README.md`, `DEV.md`, and the GitHub repo About. Promote into user docs only after a real run confirms the path.

## Overhead ArUco localization (`docs/aruco.js`)

**What's wired.**
- Headless detection service — no UI panel. Helper-card "Camera role" select on each paired phone offers `Operator / Overhead localization / Mount on <robot>`. Choosing Overhead sets `settings.arucoOverheadPhoneId` (persisted) and points the detection loop at that phone's existing preview tile in the helpers card. No second video element, no second decoder.
- SVG overlay paints detected markers directly on the helper's preview (`patchArucoOverlay`-style — same shape as the deleted phone-on-robot tracker, retargeted at the helpers tile).
- Detection via `js-aruco2` from jsDelivr (`cv.js` + `aruco.js` + `posit1.js`), dictionary `ARUCO_4X4_50`. Printable marker sheets in `docs/assets/aruco_markers_0.pdf` and `_1.pdf`. Pose via `POS.Posit` using `settings.arucoMarkerSizeMm` + focal-length heuristic (`max(w,h) * 0.85`) — no calibration file.
- Marker → robot binding: prefers explicit `entry.arucoMarkerId` (persisted in localStorage; set via `window.bindArucoMarker(robotId, markerId)`). Falls back to positional `entries[m.id]` only when NO entry has claimed that id. Hits write `entry.arucoPosition = { x, y, headingDeg, markerSizeMm, updatedAt }`.

**What hasn't been confirmed.**
- Focal-length heuristic accuracy against a real ruler ("perfect" to "off by 30%" both plausible without ground truth).
- ARUCO_4X4_50 detection reliability on a phone-camera feed via WebRTC (compression, autofocus hunting, rolling-shutter under motion).
- Multi-robot orchestration end-to-end: two robots, two markers, two bindings, both `arucoPosition`s update on the same scan, motion planner consumes both without drift. Wedge demo for the primitive.

**To validate.** Print sheet 0 + sheet 1, tape marker 0 on Pi-01 and marker 1 on Pi-02. Pair a phone, share its camera, set role to "Overhead localization." Bind explicitly: `window.bindArucoMarker("<pi-01-id>", 0)` and `window.bindArucoMarker("<pi-02-id>", 1)`. Confirm both robots' `arucoPosition` update simultaneously on each detection, metric XY within ~20 mm of tape-measured ground truth at ~50 cm camera height. If it holds, promote: line in `README.md` perception section, bullet in `DEV.md` "When to reach for what."

**Why bother.** Sub-pixel deterministic pose for a tagged object is the only roadmap primitive that closes the visual-servo loop without a depth sensor — and the substrate for the multi-robot-orchestration direction in `.claude/CLAUDE.md`. Drives `entry.arucoPosition` which the motion controller consumes as ground truth (subject to its staleness gate — `aruco.js` does NOT clear stale entries when a robot leaves frame; consumer's job).

## Grounding DINO open-vocab detector — deleted (May 2026)

Lived in `docs/grounding.js` as the open-vocab fallback when MediaPipe COCO's 80 classes couldn't cover a target. Disabled after real-world false positives (medium-confidence "stop sign.[SEP]" matches against a robot-vacuum dock — BERT separator token leaking through the post-processor). Deleted entirely once Claude vision via `view_robot_frame` was confirmed to fill the same role with scene reasoning the bbox-only detector couldn't do.

**Why deleting rather than fixing.** The role this module filled — "give Pip a way to localize 'the yellow can' or 'the book on the bag'" — is now served by the planner itself. Pip sends a frame to Claude, Claude reads the scene, plans the next action. No bbox needed when the planner can reason. Re-arming the closed-vocab variant would duplicate the role with worse semantics (no scene context, false-positive history) AND keep a 151 MB model download in the asset graph.

**What to revisit if it comes back.** A future need for sub-second open-vocab bboxes at the rate the LLM can't serve (Claude vision is ~1–2 s round-trip; bbox-rate use cases want ~100 ms). At that point: re-evaluate Grounding DINO 1.5, owlv2, or YOLO-World — but only after a use case earns it. Reactive open-vocab is not on the wedge today.

## YOLO26n closed-vocab detector (`docs/yolo26.js`)

Faster sibling for reactive-tier use cases (visual servo, gamepad-overlay tracking). Wired behind `/detector yolo26` with the registry in `docs/detectors.js`; MediaPipe stays the default. ONNX runtime via WebGPU EP with WASM fallback, ~10 MB COCO model fetched from HuggingFace on first use.

**What hasn't been confirmed.** End-to-end accuracy vs MediaPipe EfficientDet-Lite0 on the same scenes, WebGPU EP stability across the Chrome/Edge versions students will run, first-fetch UX on classroom WiFi (10 MB ONNX + onnxruntime-web bytes). Promote to default — or remove from the registry — only after a side-by-side run. Out of `README.md` and `DEV.md` until then.

---

# Forks in the road — alternatives evaluated, with revisit triggers

Paths we looked at and chose not to take, with the specific change in project direction that would make us revisit. Distinct from competitors (which compete for the same user decision) — these are *adjacent technical paths* we declined.

## Espressif KVS WebRTC SDK for ESP32

**Evaluated:** May 2026. Espressif's first-party WebRTC stack ([awslabs/amazon-kinesis-video-streams-webrtc-sdk-c@beta-reference-esp-port](https://github.com/awslabs/amazon-kinesis-video-streams-webrtc-sdk-c/tree/beta-reference-esp-port), HEAD 119617b7 at evaluation time). Ships an AppRTC-mode example targeting classic ESP32. Active development, monthly sync to upstream awslabs releases, 1.2k stars.

**What it would buy us.** Eliminates three of our four libpeer/esp_peer patches at the chip level: chip is DTLS CLIENT by default (so the fragmented-ClientHello bug is sidestepped without patching), SDP answerer emits `setup:active` directly, MID copied from remote offer, ICE agent silently ignores TCP candidates. The four-patch shape in `CLAUDE.md`'s WebRTC section collapses to one (mbedTLS Kconfig). Cert flow returns to chip-side ECDSA generation (~9 KB flash cost we currently save).

**Why not now.** Signaling is hardwired to HTTPS+WebSocket against AWS KVS or `webrtc.espressif.com`. Swapping in means writing a custom `signaling_client_if` implementation that takes offers/answers off our BLE `SIGNAL` characteristic and feeds the SDK's `kvs_peer_connection_if`. The plug point is documented (`CUSTOM_SIGNALING.md` in their tree), but the work doesn't buy us anything the libpeer patches don't already deliver — our wedge is precisely "BLE-signaled, no internet rendezvous." We'd also inherit a 3 MB factory partition expectation that's marginal on classic ESP32's 4 MB flash.

**Revisit trigger.** If a hosted-mode / internet-rendezvoused operator surface lands on the roadmap (share-a-link demos, remote tele-op, third-party robots controlling our robots), KVS WebRTC SDK is the prebuilt path. **Do not reinvent BLE-on-KVS at that point — switch outright.** The libpeer + four-patch setup made sense for BLE-only; it does not earn its keep against a stack that handles cloud signaling for free.

**Bonus capability worth knowing.** KVS WebRTC Split Mode distributes signaling to ESP32-C6 (light sleep) and streaming to ESP32-P4 (deep sleep until wake-on-signal) — the only battery-powered WebRTC camera architecture in the ecosystem. Irrelevant to mains-powered robots today; remember it if low-power ever becomes a constraint.
