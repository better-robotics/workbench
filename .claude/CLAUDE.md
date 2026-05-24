# Wedge

The **browser-native robotics dev environment** — vibe-code robots in a tab, run them on real hardware over BLE. Pip (any tool-using LLM, with ask-human) is the AI-assist surface inside it. One of multiple authorable surfaces, not the headline.

**Adjacent platforms.** Viam ("build robots like you build software" — modular components, multi-language SDKs, fleet management) is the closest framing rhyme. Viam and Freedom Robotics are server-resident B2B cloud SaaS — same transport stack, different audience and distribution shape. Inspiration for table-stakes, not competition.

**What's defensible.** Browser is the dev surface — no install, no SDK download. Browser-resident model serving — perception, detection, fiducial pose all client-side, no GPU server, no inference bill. Layered safety — firmware-bounded motors that the IDE-level planner (user code or Pip) can't bypass; ask-human is the terminal cascade rung (openpilot-panda pattern). Static-site deployable — no backend, no accounts, no data leaving the browser.

**Anti-drift guards.** Failure modes to refuse:
- *"Yet another fleet manager"* — server-resident cloud for N robots. Viam's space; ours is one operator running their own.
- *"The LLM does everything autonomously"* — Pip is one surface inside the IDE. User code is co-equal; both are bounded by the same firmware safety floor.

# Control-loop architecture

The "openpilot panda" pattern: safety enforced *below* the intelligent layer, not inside it.

- Firmware caps pulse duration and watchdog auto-stop. LLM-issued motion auto-stops at the end of the pulse window (4s on Pi, same on ESP32); the watchdog cuts persistent commands when the dashboard goes silent. The ultrasonic dist_cm clip stops pure-forward motion at walls regardless of who issued the move. The planner can't bypass these — not even via a malformed tool call.
- Magnitude is *not* capped LLM-side. Joypad and Pip share the same signed-byte range; the time-bound is what bounds a single bad decision. Earlier versions used `LLM_MAX_SPEED = 70` as an extra "reduced envelope for the planner" rung, but the duration cap already bounds the wrong-direction excursion, and the cap was making Pip-driven motion artificially slow vs joypad without buying meaningful safety.
- LLM-issued motion is pulse-bounded (`duration_ms` mandatory; firmware auto-stops). Persistent speed is reserved for human joystick control where there's a 20Hz+ decision loop.
- `ask_human_via_phone` is the terminal rung of the decision cascade — the planner asks to be overridden rather than waits for the operator to step in.

# Model discipline

Different model shapes are good at different jobs — distinct primitives, not interchangeable "AI". Past planner-layer attempts to paper over capability gaps with prompt-engineering have bitten us.

- **Closed-vocab reflex detector** (`mediapipe.js`, EfficientDet-Lite0 via MediaPipe Tasks API): 80 COCO classes, ~10–30 ms on GPU. Powers the per-robot Reflex card (`watcher.js`) and user-code `robot.watchFor` / `robot.detections`. Fire-once-and-disable shape — same terminal-rung pattern as `ask_human`. For backend-vision-capable Pip turns, `view_robot_frame` passes the raw frame straight to the planner — no caption step.
- **Tool-using LLM via API** (`claude.js`): seconds-latency, multi-turn, tool-calling. Strong at goal decomposition, weak at closed-loop visual servo (2–5 s round-trip). Currently Claude; any tool-using LLM with the same tool surface fits here.
- **Unproven / experimental**: Overhead ArUco localization (`aruco.js`), YOLO26n closed-vocab detector (`yolo26.js`, opt-in via `/detector yolo26`). See `.claude/exploration.md` → "Wired but unproven." Keep out of user docs until validated. Grounding DINO was deleted once Claude vision via `view_robot_frame` absorbed the open-vocab role with scene reasoning the bbox-only detector couldn't do.

# Transport channels

Pattern: control = BLE, observe = wifi/discover, recover = USB.

- **BLE** — control plane. Low latency, proximity-authenticated, lossy. Anything that sets motor speed, toggles an LED, commits state.
- **Typed ops over BLE** — structured verbs on a single characteristic (`get-log`, `get-config`, `restart-service`, `wifi-scan`, `wifi-join`). Each verb is a deliberate, reviewable decision instead of a real-shell transport.
- **WebRTC** — two distinct flows.
  - *Phone ↔ desktop*: signaled via `wss://signal.neevs.io` (cross-network — operator may not be physically near the phone). Pair-ceremony authenticated (Ed25519 pubkey + signed pair-request). Carries camera frames, ask-human responses, robot-command relays.
  - *Robot ↔ desktop* (Pi or ESP32): signaled over the BLE `SIGNAL` characteristic — no internet rendezvous, no Mixed-Content/PNA gate. BLE pair = signal = auth. Carries OTA bundles, log tail, PTY shell (Pi), and camera video. See `firmware/esp32_robot_idf/WEBRTC.md` for the ESP32-side patches.
- **Wifi-presence** — Pi exposes `<name>.local:81/health`; dashboard probes it for the "on wifi" badge + service-crash detection. ESP32 presence shows up only when BLE-paired (wifi-status notify). No internet rendezvous for robot presence.
- **USB-CDC** — recovery plane. Last-resort serial console, runs as its own systemd unit so a `pi-robot.service` crash doesn't take recovery with it. Bounded by physical access.

# Connection-first init

Connection infrastructure (BLE, WiFi, USB-CDC) initializes before capability infrastructure (camera, perception, motors). A robot whose BLE stays up with no camera is observable and actionable; the reverse is a brick. ESP32 example: NimBLE host init and `wifi_sta_init` run early in `app_main()` so radio drivers pre-allocate their buffers in fresh internal heap. Camera comes after; if it can't fit its 32 KB DMA buffer in what's left, it fails loudly and `fw_info` hides the cap so the dashboard adapts.

# Project layout

`docs/` is the GitHub Pages publish root — static ES modules live there directly. Repo-level docs (HARDWARE.md, SMOKE.md, etc.) live at the root or inside subsystems, not in `docs/`.

- **Root holds primitives, subsystems hold vocabularies.** `docs/` root is for (a) HTML entry points, (b) app-shell singletons (`app.js`, `state.js`, `dom.js`, `event-bus.js`, `log.js`, `settings.js`), (c) cross-cutting primitives imported by ≥3 subsystems (`format.js`, `error-capture.js`). Everything else presumed to belong in a subsystem folder.
- **Promotion trigger: vocabulary closure.** Files belong in their own folder when they (1) share a naming prefix, (2) change together for the same reason, (3) expose ≤2 symbols outward. A 3-file sealed vocabulary (`pinout-*`) is more ready than a 6-file loose collection (`mobile-*`). When a prefix collects files that change for *different* reasons, split — don't folder.

# Comment discipline

Every line is context cost in an AI-edited codebase. Comments earn their place when they carry WHY: hidden constraints, kernel/API gotchas, workarounds for past bugs, cross-file invariants ("must match `firmware/pi_robot/pi_robot.py`"), schema/wire-format examples. Restatement (module preambles, narration, section banners, labels above obvious code) is the cut.

# Abstractions earn upstream consumers

Before adding a logical layer, registry, wrapper, or routing decision, audit who outside its home module will use it. If only one module touches it, it's internal. The cost of an unused abstraction isn't only the lines it adds — it's the explanatory comments, the cross-cutting params plumbed through siblings, and the bug-shaped negative space (a one-shot helper turns into a parameter on every sibling, then the sibling that forgot to use it ships a regression). Audit before adding, not before deleting.

# Dialog vs menu dismiss

- **Menus + popovers** (robot-menu, avatar-menu, help popovers, Pip's `<div popover>`): outside-click + Escape dismiss.
- **Dialogs**: × button or Escape only. Outside-click would nuke session state (recovery terminal, SD prep) for a tiny convenience win.

# References

- `DEV.md` — URL flags, `window.*` handles, IndexedDB stores, common debug paths.
- `SMOKE.md` — manual checklist for architectural promises.
- `USER-CODE.md` — surface that `scripts.js` exposes to user-authored code.
- `HARDWARE.md` — wiring, board-specific knobs.
- `.claude/direction.md` — what we're committing to close for the course pilot.
- `.claude/exploration.md` — open architectural directions, design rationale, wired-but-unproven inventory, forks evaluated.
- `.claude/field.md` — positioning analysis vs adjacent work.
- `firmware/esp32_robot_idf/WEBRTC.md` — the four coordinated DTLS/SDP patches.
- `firmware/pi_robot/SYSTEMD.md` — preconditions-belong-in-the-script pattern.
- `make smoke` — pure-function tests (<1 s); `make install-hooks` wires pre-commit (`make smoke` + gen-uuids drift + sw.js VERSION stamp), bypassable with `--no-verify`, CI is the binding layer.
