# Wedge

The **browser-native robotics dev environment** — vibe-code robots in a tab, run them on real hardware over BLE. Pip (any tool-using LLM, with ask-human) is the AI-assist surface inside it. One of multiple authorable surfaces, not the headline.

**Adjacent platforms.** Viam ("build robots like you build software" — modular components, multi-language SDKs, fleet management) is the closest framing rhyme. Viam and Freedom Robotics are server-resident B2B cloud SaaS — same transport stack, different audience and distribution shape. Inspiration for table-stakes, not competition.

**What's defensible.** Browser is the dev surface — no install, no SDK download. Browser-resident model serving — perception, detection, fiducial pose all client-side, no GPU server, no inference bill. Layered safety — firmware-bounded motors that the IDE-level planner (user code or Pip) can't bypass; ask-human is the terminal cascade rung (openpilot-panda pattern). Static-site deployable — no backend, no accounts, no data leaving the browser.

**Directions worth pursuing:**
- **Capability schema** — JSON manifest + chip handler + auto-rendered card. The IDE's plugin system; lets a user or Pip ship a new hardware capability without touching dashboard code.
- **Multi-robot orchestration.** Two robots in the same room, scripts or Pip planning across them, no central server.

**Anti-drift guards.** Failure modes to refuse:
- *"Yet another teleop dashboard"* — joystick-shaped UI for human pilots. The wedge is planning-shaped.
- *"Yet another fleet manager"* — server-resident cloud for N robots. Viam's space; ours is one operator running their own.
- *"The LLM does everything autonomously"* — Pip is one surface inside the IDE. User code is co-equal; both are bounded by the same firmware safety floor.

# Developer reference

`DEV.md` at the repo root is the canonical list of URL flags, `window.*` handles, IndexedDB stores, and common debug paths.

# Project layout

- `docs/` is a symlink to `public/`. GitHub Pages serves `docs/`; the site content lives in `public/`. Repo-level docs (HARDWARE.md, SMOKE.md, etc.) live at the root or inside subsystems.
- `public/` is flat by design — file count is manageable, naming prefixes carry the subsystem boundary. Promote a subsystem to its own folder (like `capabilities/`) once it passes ~5 files whose internals shouldn't leak outside.

# Subsystem map

- **Pair layer** — `pairing.js`, `phones.js`, `mobile.js` + `phone.html`. Desktop ↔ phone WebRTC.
- **Perception + detection** — `camera-frame.js`, `mediapipe.js` (closed-vocab COCO reflex, powers `watcher.js`), `aruco.js` (overhead ArUco → `entry.arucoPosition`, wired but unproven). Open-vocab queries route through `view_robot_frame` → Claude vision — no in-browser open-vocab model needed.
- **Pip / assistant** — `assistant.js`, `claude.js`, `pip-tools.js`.
- **Robot ops** — `ble.js`, `ops-response.js`, `capabilities/`.
- **Robot lifecycle** — `prepare.js`, `recovery.js`, `pinout.js`.
- **User code** — `scripts.js`. Mirrors the BLE capability surface; persisted in localStorage. See `USER-CODE.md`.
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

# Model discipline

Different model shapes are good at different jobs — distinct primitives, not interchangeable "AI". Past planner-layer attempts to paper over capability gaps with prompt-engineering have bitten us.

**Detectors and perception:**

- **Closed-vocab reflex detector** (`mediapipe.js`, EfficientDet-Lite0 via MediaPipe Tasks API): 80 COCO classes, ~10–30 ms on GPU. Powers the per-robot Reflex card (`watcher.js`) and user-code `robot.watchFor` / `robot.detections`. Fire-once-and-disable shape — same terminal-rung pattern as `ask_human`. For backend-vision-capable Pip turns, `view_robot_frame` passes the raw frame straight to the planner — no caption step.

**Unproven / experimental:** Overhead ArUco localization (`aruco.js`), YOLO26n closed-vocab detector (`yolo26.js`, opt-in via `/detector yolo26` — wired, not the default, no field-validation run logged). See `.claude/notes.md` "Wired but unproven." Keep out of user docs until validated. (Grounding DINO was previously the open-vocab fallback; deleted once Claude vision via `view_robot_frame` absorbed that role with scene reasoning the bbox-only detector couldn't do.)

**Planners (Pip):**

- **Tool-using LLM via API** (`claude.js`): seconds-latency, multi-turn, tool-calling. Strong at goal decomposition, weak at closed-loop visual servo (2–5 s round-trip). Currently Claude; any tool-using LLM with the same tool surface fits here.

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
2. **DTLS cert is dashboard-supplied**, ECDSA P-256. The browser generates
   the keypair (WebCrypto) and self-signs an X.509 cert (@peculiar/x509),
   then pushes both PEMs over the SIGNAL char (opcodes 0x07/0x08/0x09) BEFORE
   the offer. Chip's `dtls_srtp_init` refuses to open WebRTC if nothing was
   supplied — chip-gen path was removed for ~9 KB flash saved (linker gc on
   mbedtls x509write_crt_* + ecp_gen_key). WebRTC standardized on ECDSA;
   current Chrome rejects RSA in DTLS-SRTP, so the dashboard cert is built
   ECDSA-only too.
3. **All chip-quirk SDP rewriting lives in the dashboard** (webrtc-robot.js).
   The browser pre-strips TCP candidates from the offer (chip is UDP-only),
   pins offer MID to "0" so libpeer's hardcoded "0" in the answer matches,
   and flips `setup:passive`→`setup:active` on the incoming answer (libpeer
   always emits passive even though chip is actually CLIENT). Used to be
   three string-walking functions in webrtc_peer.c (`filter_sdp_for_chip`,
   `capture_offer_mid`, `rewrite_answer_mid`); centralizing made the chip
   an SDP-agnostic byte pipe.
4. **mbedTLS Kconfig** must enable the WebRTC cipher set explicitly
   (DTLS_SRTP, ECDHE_ECDSA, ECDH_C, ECDSA_C, SECP256R1, GCM_C, SHA1_C,
   HKDF_C). IDF defaults are tuned for HTTPS-client and lack what DTLS-SRTP
   needs. X509_CREATE_C: not needed on v5 (dashboard does the cert
   creation, chip only parses); v6 path of esp_peer re-enables it for
   upstream cert helpers even though our flow stays dashboard-side.
5. **PSRAM-default malloc** with `RESERVE_INTERNAL=32768` — mbedTLS context
   + libpeer SCTP/SRTP buffers go to PSRAM so the camera DMA's 32 KB
   contiguous internal block is always available mid-session.

Removing any one of these reverts the chip to "DTLS handshake never
completes" or "camera_acquire fails after WebRTC opens." Firmware-side
constraints (DTLS role, mbedTLS Kconfig, PSRAM malloc) are documented in
firmware/esp32_robot_idf/components/espressif__esp_peer/src/dtls_srtp.c
and sdkconfig.defaults.esp32; dashboard-side constraints (cert push, SDP
rewriting) in public/webrtc-cert.js and public/webrtc-robot.js.

**Sunset path.** mbedTLS PR #10623 (3.6 backport of the fragmented DTLS-
ClientHello reassembly fix, first released in 3.6.6 / 4.1.0, March 2026)
collapses Patch 1 and the half of Patch 3 that exists because of it.
ESP-IDF v5.5.4 (current pin) ships 3.6.5, v6.0.1 ships 4.0.0 — both
pre-fix. espressif/esp-idf release/v5.5 (now on 3.6.6-idf) and
release/v6.0 (now on 4.1.0-idf) have the fix on their HEAD branches; the
next tagged release in either line is the trigger.

Prefer v6.0.x. components/espressif__esp_peer/src/dtls_srtp_v6.c is
pre-staged (CMake selects it on `IDF_VERSION_MAJOR >= 6`) and already
encodes the post-sunset shape: role honored from cfg (no CLIENT
override), HelloVerifyRequest cookies enabled, PSA crypto path. The
cleanup on a v6.0.2 bump collapses to "delete the v5 dtls_srtp.c sibling
and the IDF major-version CMake selector" rather than reverting patches
in-place. The rest of the firmware migrates clean — NimBLE / WiFi /
esp_netif / esp_http_server / LEDC / GPIO / NVS / esp_timer call sites
all survive v6.0; exposure is `-Werror` flip + gnu23 default surfacing
latent warnings.

v5.5.5 is the fallback if v6.0.2 is slow. On v5.5.5, the manual cleanup
is: revert chip-as-CLIENT in dtls_srtp.c (lines 75 and 161), restore
HelloVerifyRequest cookies (line 95). In either case, drop the
`setup:passive`→`setup:active` flip from public/webrtc-robot.js. Patches
2 (dashboard ECDSA cert), 4 (mbedTLS Kconfig) and 5 (PSRAM malloc) stay
— those are WebRTC-spec or chip-shape, not mbedTLS-bug workarounds.

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

# Unit preconditions belong in the script, not in `Condition*`

`ConditionPathExists=`, `ConditionFileNotEmpty=`, etc. evaluate **once** at unit-start time and silently skip the unit when false — no retry, no log noise the operator can search for, no recovery without manual `systemctl start`. When the prerequisite is racy (asynchronous kernel-driver probes, hotplug events, network reachability, anything not synchronously guaranteed by an `After=` ordering), a missed check turns the unit invisibly inert until the next reboot, and even that may race the same way.

Pattern instead: drop the `Condition*` and wait inside the `ExecStart` script with a bounded poll loop. The script makes the timeout legible (logs a clear failure on exhaustion), the unit gets to use `Restart=on-failure` for self-healing, and a future contributor can read the wait-condition next to the work it gates. The `usb-gadget.service` → `usb-gadget-setup.sh` pair is the reference shape: 10 s poll for `/sys/class/udc` to populate, clean exit-1 with a message if dwc2 never publishes.

If the precondition really is synchronous and unambiguous (a config file the user wrote, the existence of a hardware feature already enumerated at boot), `Condition*` is fine. The line is "does this become true asynchronously after the unit's `After=` ordering?" — if yes, wait in the script.

