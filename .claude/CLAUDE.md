# Wedge

The **browser-native robotics dev environment** — vibe-code robots in a tab, run them on real hardware over BLE. Pip (any tool-using LLM, with ask-human) is the AI-assist surface inside it. One of multiple authorable surfaces, not the headline.

**Positioning** (survey + sources: `RELATED-WORK.md`): four structural claims — browser-native dev surface (no install), browser-resident model serving (no GPU server), layered safety (firmware floor the planner can't bypass; ask-human as terminal cascade rung), static-site/no-accounts. Viam is the closest framing rhyme — server-resident B2B SaaS; inspiration for table-stakes, not competition.

**Anti-drift guards.** Failure modes to refuse:
- *"Yet another fleet manager"* — server-resident cloud for N robots. Viam's space; ours is one operator running their own.
- *"The LLM does everything autonomously"* — Pip is one surface inside the IDE. User code is co-equal; both are bounded by the same firmware safety floor.

# Control-loop architecture

The "openpilot panda" pattern: safety enforced *below* the intelligent layer, not inside it.

- Firmware caps pulse duration and watchdog auto-stop. LLM-issued motion auto-stops at the end of the pulse window (`LLM_MAX_DURATION_MS` — `protocol/constants.json`, shared with the hub contract); the watchdog cuts persistent commands when the dashboard goes silent. The ultrasonic dist_cm clip stops pure-forward motion at walls regardless of who issued the move. The planner can't bypass these — not even via a malformed tool call.
- Magnitude is *not* capped LLM-side. Joypad and Pip share the same signed-byte range; the time-bound is what bounds a single bad decision. Earlier versions used `LLM_MAX_SPEED = 70` as an extra "reduced envelope for the planner" rung, but the duration cap already bounds the wrong-direction excursion, and the cap was making Pip-driven motion artificially slow vs joypad without buying meaningful safety.
- LLM-issued motion is pulse-bounded (`duration_ms` mandatory; firmware auto-stops). Persistent speed is reserved for human joystick control where there's a 20Hz+ decision loop.
- `ask_human_via_phone` is the terminal rung of the decision cascade — the planner asks to be overridden rather than waits for the operator to step in.

# Model discipline

Different model shapes are good at different jobs — distinct primitives, not interchangeable "AI". Past planner-layer attempts to paper over capability gaps with prompt-engineering have bitten us.

- **Closed-vocab reflex detector** (`mediapipe.js`): milliseconds-fast COCO detector. Powers the per-robot Reflex card (`watcher.js`) and user-code `robot.watchFor` / `robot.detections`. Fire-once-and-disable shape — same terminal-rung pattern as `ask_human`. For backend-vision-capable Pip turns, `view_robot_frame` passes the raw frame straight to the planner — no caption step.
- **Tool-using LLM via API** (`claude.js`): seconds-latency, multi-turn, tool-calling. Strong at goal decomposition, weak at closed-loop visual servo (2–5 s round-trip). Currently Claude; any tool-using LLM with the same tool surface fits here.
- **Unproven / experimental**: YOLO26n closed-vocab detector (`yolo26.js`, opt-in via `/detector yolo26`). See `.claude/exploration.md` → "Wired but unproven." Keep out of user docs until validated. Grounding DINO and overhead ArUco localization were removed — rationale + revisit triggers in `.claude/exploration.md` → "Forks in the road."

# Transport channels

Pattern: control = BLE, observe = wifi/discover, recover = USB.

Channel semantics are shared with the classroom hub: the BLE↔MQTT mapping
(MOTOR↔pwm incl. the ±100-percent vs ±255-duty scale, LED+RGB↔set_led,
TELEMETRY↔sys, the 4000 ms drive cap) is canonical in `sprocket-robotics/hub`
CONTRACT.md § "The BLE transport (workbench)" — keep it in sync when a mapped
payload changes here.

- **BLE** — control plane. Low latency, proximity-authenticated, lossy. Anything that sets motor speed, toggles an LED, commits state.
- **Typed ops over BLE** — structured verbs on a single characteristic (`get-log`, `get-config`, `restart-service`, `wifi-scan`, `wifi-join`). Each verb is a deliberate, reviewable decision instead of a real-shell transport.
- **WebRTC** — *Phone ↔ desktop* only: signaled over the hub broker's `pair/#` topics (`pair/broker-signal.js` + `broker-lobby.js`; hub CONTRACT.md § pair) — same-LAN only, no internet rendezvous, no ICE servers (host/mDNS candidates). Accepted losses with the broker migration: cross-network pairing (operator's phone on LTE) *and* pairing from the https deploy (github.io — a https page can't open the broker's plain ws; the pair UI explains and points at the LAN-served IDE via `pairTransportBlocked()`). The pair QR carries roomId + pubkey + hub host. Pair-ceremony authenticated (ECDSA P-256 pubkey + signed pair-request — `pair/peer-key.js`). Carries camera frames, ask-human responses, robot-command relays. (There is no robot↔desktop WebRTC: the ESP32 has no signal char — its camera is HTTP MJPEG `:81/stream` — and Pi robots were retired to the hub.)
- **Wifi-presence** — an ESP32 shows up when BLE-paired (its wifi-status notify carries the LAN IP). No internet rendezvous for robot presence.
- **USB serial** — recovery plane. Last-resort console over the ESP32's USB-UART bridge, driven from the dashboard over Web Serial (`recovery/console.js`). Bounded by physical access.

# Connection-first init

Connection infrastructure (BLE, WiFi, USB-CDC) initializes before capability infrastructure (camera, perception, motors). A robot whose BLE stays up with no camera is observable and actionable; the reverse is a brick. ESP32 example: NimBLE host init and `wifi_sta_init` run early in `app_main()` so radio drivers pre-allocate their buffers in fresh internal heap. Camera comes after; if it can't fit its 32 KB DMA buffer in what's left, it fails loudly and `fw_info` hides the cap so the dashboard adapts.

# Project layout

`docs/` is the GitHub Pages publish root — static ES modules live there directly. Repo-level docs (HARDWARE.md, SMOKE.md, etc.) live at the root or inside subsystems, not in `docs/`.

- **Root holds primitives, subsystems hold vocabularies.** `docs/` root is for (a) HTML entry points, (b) app-shell singletons (`app.js`, `state.js`, `dom.js`, `event-bus.js`, `log.js`, `settings.js`), (c) cross-cutting primitives with fan-out beyond a single subsystem — `format.js` (app.js + pip/), `error-capture.js` (loaded via `<script src>` from both HTML entry points, before any subsystem's module graph exists to import into). Everything else presumed to belong in a subsystem folder.
- **Promotion trigger: vocabulary closure.** Files belong in their own folder when they (1) share a naming prefix, (2) change together for the same reason, (3) expose ≤2 symbols outward. A 3-file sealed vocabulary (`pinout-*`) is more ready than a 6-file loose collection (`mobile-*`). When a prefix collects files that change for *different* reasons, split — don't folder.

# Comment discipline

Every line is context cost in an AI-edited codebase. Comments earn their place when they carry WHY: hidden constraints, kernel/API gotchas, workarounds for past bugs, cross-file invariants ("must match `firmware/esp32_robot_idf/main/app_main.c`"), schema/wire-format examples. Restatement (module preambles, narration, section banners, labels above obvious code) is the cut.

# Abstractions earn upstream consumers

Before adding a logical layer, registry, wrapper, or routing decision, audit who outside its home module will use it. If only one module touches it, it's internal. The cost of an unused abstraction isn't only the lines it adds — it's the explanatory comments, the cross-cutting params plumbed through siblings, and the bug-shaped negative space (a one-shot helper turns into a parameter on every sibling, then the sibling that forgot to use it ships a regression). Audit before adding, not before deleting.

# Dialog vs menu dismiss

- **Menus + popovers** (robot-menu, avatar-menu, help popovers, Pip's `<div popover>`): outside-click + Escape dismiss.
- **Dialogs**: × button or Escape only. Outside-click would nuke session state (recovery terminal, SD prep) for a tiny convenience win.

# References

- `DEV.md` — URL flags, `window.*` handles, IndexedDB stores, common debug paths.
- `SMOKE.md` — manual checklist for architectural promises.
- `USER-CODE.md` — the on-robot Python surface (issue #47): the IDE authors Python, ships it to `/fs`, the robot's embedded MicroPython VM (`firmware/.../main/pyvm.c`) runs it. `ide/python-api.js` drives Monaco completions; `ide/script-runner.js` + `ide/script-output.js` handle ship/run/stream.
- `HARDWARE.md` — wiring, board-specific knobs.
- Pinned tracker (issue #45) — live pilot state: ranked gaps, watch-list. Rationale stays in `.claude/exploration.md`.
- `.claude/exploration.md` — open architectural directions, design rationale, wired-but-unproven inventory, forks evaluated.
- `RELATED-WORK.md` — survey of adjacent work, written for an outside reader.
- `make smoke` — pure-function tests (<1 s); `make install-hooks` wires pre-commit (`make smoke` + gen-uuids/gen-constants drift + sw.js VERSION stamp), bypassable with `--no-verify`, CI is the binding layer. `protocol/constants.json` (`tools/gen-constants.py`) is the uuids.json pattern applied to numeric cross-firmware constants (safety timeouts, BLE chunk sizes) — edit the JSON, not the generated `protocol_constants.h`/`docs/protocol-constants.js`.
