# Wedge

This project is the **browser-native robotics dev environment** — vibe-code robots in a tab, run them on real hardware over BLE, fork the repo to deploy your own. Pip (any tool-using LLM, with replay and ask-human) is the AI-assist surface inside it. One of multiple authorable surfaces, not the headline.

**Adjacent platforms.** Viam ("build robots like you build software" — modular components, multi-language SDKs, fleet management) is the closest framing rhyme. Both Viam and Freedom Robotics are server-resident B2B cloud SaaS — same transport stack you ship, different audience and distribution shape. Industrial cloud vs. consumer/education/hobbyist fork-and-run. Treat as inspiration for table-stakes, not competition.

**What's defensible here that they don't have.** Browser is the dev surface — write JS in a tab, no install, no SDK download. Browser-resident model serving — perception, detection, fiducial pose all run client-side, no GPU server, no inference bill. Layered safety — firmware-bounded motors that the IDE-level planner (user code or Pip) can't bypass; ask-human is the terminal cascade rung (openpilot-panda pattern). Fork-and-run — GitHub-Pages deployable, no backend, no accounts, no data leaving the browser.

**Directions worth pursuing** (when there's a session to dedicate to each):
- **Capability schema** — JSON manifest + chip handler + auto-rendered card. The IDE's plugin system; lets a user or Pip ship a new hardware capability without touching dashboard code.
- **Opt-in replay → dataset → improvement loop.** Replay is local-only today. Aggregating opted-in sessions builds the only consumer-robot interaction dataset that exists.
- **Multi-robot orchestration.** Two robots in the same room, scripts or Pip planning across them, no central server. A research demo nobody else can show.

**Anti-drift guards.** Three failure modes to refuse:
- *"Yet another teleop dashboard"* — joystick-shaped UI for human pilots. The wedge is planning-shaped.
- *"Yet another fleet manager"* — server-resident cloud for N robots. Viam's space; ours is one operator forking their own platform.
- *"The LLM does everything autonomously"* — Pip is one surface inside the IDE. User code is co-equal; both are bounded by the same firmware safety floor.

# Developer reference

`DEV.md` at the repo root is the canonical list of URL flags, `window.*` handles, IndexedDB stores, and common debug paths.

# Project layout

- `docs/` is a symlink to `public/`. GitHub Pages serves `docs/`; the site content lives in `public/`. Repo-level docs (HARDWARE.md, SMOKE.md, etc.) live at the root or inside subsystems.
- `public/` is flat by design — file count is manageable, naming prefixes carry the subsystem boundary. Promote a subsystem to its own folder (like `capabilities/`) once it passes ~5 files whose internals shouldn't leak outside.

# Subsystem map

- **Pair layer** — `pairing.js`, `phones.js` (paired-phones management on desktop), `mobile.js` + `phone.html` (phone-side UI). Desktop ↔ phone WebRTC.
- **Perception + detection** — `perception.js` (VLM), `grounding.js` (open-vocab detector), `aruco.js` (overhead ArUco localization → `entry.arucoPosition`). Camera-frame capture, scene prompts, structured outputs. Overhead aruco is wired but unproven against real hardware — see "Wired but unproven" in `.claude/notes.md`.
- **Pip / assistant** — `assistant.js`, `claude.js`, `local-llm.js`, `pip-tools.js`, `replay.js`. Tool-using LLM integration (Claude or local fallback), tool schemas, executor, replay logging.
- **Robot ops** — `ble.js`, `ops-response.js`, `capabilities/`. BLE protocol, ops channel, per-cap cards + runtime.
- **Robot lifecycle** — `prepare.js`, `recovery.js`, `pinout.js`. SD prep, USB recovery, pinout editor.
- **User code** — `scripts.js`. Browser-resident IDE for user-authored robot code. Mirrors the BLE capability surface; persisted in localStorage. See `USER-CODE.md`.
- **App shell** — `app.js`, `dom.js`, `state.js`, `settings.js`, `log.js`, `auth.js`, `passwords.js`, `index.html`, `styles.css`, `icons.svg`.

# Smoke testing

Two layers, kept cheap:

- `make smoke` — pure-function tests via `node --test tests/*.test.js`. Anything in `format.js` (and future pure helpers) earns a row in `tests/format.test.js`. Runs in <1 s.
- `SMOKE.md` — manual checklist for architectural promises (lifecycle, render patterns, capability behavior, Pip flow, recovery).

Pattern for new pure helpers: extract from `app.js` / cap runtime into `format.js`, import where used, add a test.

`make install-hooks` wires `.githooks/` as `core.hooksPath`. Pre-commit runs `make smoke`, the gen-uuids drift check (when `protocol/uuids.json` is staged), and the sw.js VERSION stamp (when `public/*` excluding firmware bins / sw.js is staged — folds the stamp into the user's commit so the dashboard "Reload to update" banner fires on the right commit instead of a CI follow-up). Bypassable with `--no-verify`; CI is the binding layer.

# Comment discipline

Default to no comments — every line is context cost in an AI-edited codebase.

Keep when the comment carries WHY: hidden constraints, kernel/API gotchas, workarounds for past bugs, cross-file invariants ("must match `firmware/pi_robot/pi_robot.py`"), schema/wire-format examples. Cut when it restates WHAT: module preambles, narration, section banners, labels above obvious code.

# Abstractions earn upstream consumers

Before adding a logical layer, registry, wrapper, or routing decision, audit who outside its home module will use it. If only one module touches it, it's internal — bar for keeping it is high. The merge layer (item F) shipped with no consumers above the dashboard; deletion (R1) was clean precisely because nothing else depended on it. The cost of an unused abstraction isn't only the lines it adds — it's the explanatory comments, the cross-cutting params plumbed through siblings, and the bug-shaped negative space (the joypad-no-op was a child of the abstraction, not a coincidence). Audit before adding, not before deleting.

# Dialog vs menu dismiss

- **Menus + popovers** (robot-menu, avatar-menu, help popovers, Pip's `<div popover>`): outside-click + Escape dismiss.
- **Dialogs**: × button or Escape only. Outside-click would nuke session state (recovery terminal, SD prep) for a tiny convenience win.

# Control-loop architecture

The "openpilot panda" pattern: safety enforced *below* the intelligent layer, not inside it.

- Firmware caps motor speed, pulse duration, and watchdog auto-stop. The LLM planner can't bypass them — not even via a malformed tool call.
- LLM-issued motion is pulse-bounded (`duration_ms` mandatory; firmware auto-stops). Persistent speed is reserved for human joystick control where there's a 20Hz+ decision loop.
- `ask_human_via_phone` is the terminal rung of the decision cascade — the planner asks to be overridden rather than waits for the operator to step in.
- Pip has a silent local-LFM fallback when the primary backend returns null AND `settings.pipLocalInstalled` is true. A null Pip reply means BOTH paths returned null.

# Model discipline

Different model shapes are good at different jobs — distinct primitives, not interchangeable "AI". Past planner-layer attempts to paper over capability gaps with prompt-engineering have bitten us.

**Detectors and perception (present-tense backends):**

- **Open-vocab detector** (`grounding.js`, Grounding DINO tiny): "find the red cup" works on a text prompt, no retraining. ~150–300 ms on CPU. Default detector today.
- **VLM** (`perception.js`, LFM2.5-VL-450M): semantic + open-vocab spatial. Caption + structured-JSON bbox prompting. ~1.5 s — planner-tier, not reactive. Single-pulse motion based on VLM text is fine for a toy; chaining without a deterministic primitive re-asserting between pulses drifts.

**Unproven / experimental:** Overhead ArUco localization (`aruco.js`, wired but unvalidated end-to-end) and YOLO26n closed-vocab detector (not built). Full record + validation criteria in `.claude/notes.md` under "Wired but unproven." Keep both out of user docs until validated.

**Planners — the IDE's AI-assist surface (Pip):**

- **Tool-using LLM via API** (`claude.js`): seconds-latency, multi-turn, tool-calling. Strong at goal decomposition, weak at closed-loop visual servo (2–5 s round-trip). Currently Claude; any tool-using LLM with the same tool surface fits here.
- **Local LFM2.5** (`local-llm.js`): offline / API-outage fallback. 512-token output ceiling, retries needed. Pip falls through silently when the primary backend returns null AND `settings.pipLocalInstalled` is true.

# Transport channels

Each transport has a distinct job:

- **BLE** — control plane. Low latency, proximity-authenticated, lossy. Anything that sets motor speed, toggles an LED, commits state.
- **Typed ops over BLE** — structured verbs on a single characteristic (`get-log`, `get-config`, `restart-service`, `wifi-scan`, `wifi-join`). Each verb is a deliberate, reviewable decision instead of a real-shell transport.
- **WebRTC** — two distinct flows.
  - *Phone ↔ desktop*: signaled via `wss://signal.neevs.io` (cross-network — operator may not be physically near the phone). Pair-ceremony authenticated (Ed25519 pubkey + signed pair-request). Carries camera frames, ask-human responses, robot-command relays.
  - *Robot ↔ desktop* (Pi or ESP32): signaled over the BLE `SIGNAL` characteristic — no internet rendezvous, no Mixed-Content/PNA gate. ESP32 handles signaling in-firmware; Pi forwards the offer to a local aiortc daemon (`pi_robot_rtc.py`) over a Unix socket and chunks the answer back via BLE notify. BLE pair = signal = auth. Carries OTA bundles, log tail, PTY shell (Pi), and camera video (BLE-signaled `camera-signal` char on Pi).
- **Wifi-presence** — Pi exposes `<name>.local:81/health` (pi_robot_health.py); dashboard probes it for the "on wifi" badge + service-crash detection. ESP32 retired its HTTP server in Phase 2.H — its presence shows up only when BLE-paired (wifi-status notify). No internet rendezvous for robot presence (signal.neevs.io stays for cross-network phone-pair only).
- **USB-CDC** — recovery plane. Last-resort serial console, runs as its own systemd unit so a `pi-robot.service` crash doesn't take recovery with it. Bounded by physical access.

Pattern: control = BLE, observe = wifi/discover, recover = USB.

# ESP32 WebRTC: chip is the DTLS client, not the server

Classic ESP32 streams WebRTC video to current Chrome via four coordinated
patches that don't independently make sense — anyone debugging this stack
needs to see them as one shape:

1. **DTLS role: chip is CLIENT** (forced in `dtls_srtp_init` regardless of
   what libpeer's binary blob passes). libpeer always passes ROLE_SERVER,
   but mbedTLS's `ssl_parse_client_hello` can't reassemble Chrome's ~1413-
   byte fragmented ClientHello — bails immediately with `FEATURE_UNAVAILABLE`.
   As CLIENT, chip sends the (small, never-fragmented) ClientHello and
   Chrome handles whatever it receives. Chrome 124+ enforces this strictly.
2. **Self-signed cert is ECDSA P-256**, not RSA. WebRTC standardized on
   ECDSA; current Chrome rejects RSA in DTLS-SRTP.
3. **Answer SDP rewrite**: `setup:passive` → `setup:active`. libpeer's
   binary always emits passive; we override to match the actual on-wire
   role.
4. **mbedTLS Kconfig** must enable the WebRTC cipher set explicitly
   (DTLS_SRTP, ECDHE_ECDSA, ECDH_C, ECDSA_C, SECP256R1, GCM_C, SHA1_C,
   CIPHER_MODE_CTR, HKDF_C, X509_CREATE_C). IDF defaults are tuned for
   HTTPS-client and lack what DTLS-SRTP needs.
5. **PSRAM-default malloc** with `RESERVE_INTERNAL=32768` — mbedTLS context
   + libpeer SCTP/SRTP buffers go to PSRAM so the camera DMA's 32 KB
   contiguous internal block is always available mid-session.

Removing any one of these reverts the chip to "DTLS handshake never
completes" or "camera_acquire fails after WebRTC opens." The full set is
documented in firmware/esp32_robot_idf/components/espressif__esp_peer/src/
dtls_srtp.c and sdkconfig.defaults.esp32.

**Opt-in via `CONFIG_BR_WEBRTC_ESP_PEER`** (main/Kconfig.projbuild, default
y). Set =n to drop all WebRTC code — `select` chain removes the WebRTC-only
mbedTLS bits, all call sites in webrtc_peer / app_main / gatt_svr / telemetry
guard out with `#ifdef`, and the linker's `--gc-sections` strips libpeer.a
from the image (~215 KB smaller binary). Useful for forks that only need
HTTP MJPEG video. esp_peer always *registers* as a component (Kconfig values
aren't visible to IDF's component-registration phase), but produces no live
references when off, so the linker drops it.

# Connection-first init

Connection infrastructure (BLE, WiFi, USB-CDC) initializes before capability infrastructure (camera, perception, motors). When constrained resources force a tradeoff, connection wins. A robot whose BLE stays up with no camera is observable and actionable; the reverse is a brick.

ESP32 example: NimBLE host init and `wifi_sta_init` run early in `app_main()` so radio drivers pre-allocate their buffers in fresh internal heap. Camera comes after; if it can't fit its 32 KB DMA buffer in what's left, it fails loudly via `camera_init_error()` and `fw_info` hides the cap so the dashboard adapts.

# Replay

Every Pip tool call is persisted to IndexedDB so a session can be re-run offline against a new model (comma.ai's replay-your-drive pattern, scoped to our tool surface). Image data URLs from `ask_human_via_phone` stay in the record so reconstruction is faithful.

Wire-up via `replay.wrapExecutor()` in `pip-tools.js`. Surface in `DEV.md`.
