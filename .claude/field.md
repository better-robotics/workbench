# Field

Adjacent work that defines what positioning BetterRobotics can claim. Frame: "what's already claimed in the surrounding field," not "who do we beat." Filtered for what would change a decision.

## schematik.io — not in this lane

[schematik.io](https://schematik.io) bills itself as "Cursor for Hardware": AI code-generation emitting firmware/schematic-adjacent code from natural language for Arduino, ESP32, Raspberry Pi (~$4.6M pre-seed). Not a pairing UI, not a control plane, not a dashboard. A *potential input* for authoring firmware like ours, not a parallel to the runtime-control story.

## The real candidates

### LEGO SPIKE web app (spike.legoeducation.com)
- **Claims:** the classroom decision — "which kit lets students code from a Chromebook with no install."
- **Overlap:** Web Bluetooth + WebSerial in Chrome, no native app ([Chrome for Developers](https://developer.chrome.com/blog/lego-education-spike-web-bluetooth-web-serial)). Programs upload to hub, hub executes.
- **Divergence:** code runs *on the hub*, not the browser. Closed hardware, closed firmware, no user-owned OTA.
- **Ships today that we don't:** mature curriculum, institutional purchase channel.
- **Decision impact:** confirms BLE-first-via-browser as mainstream, not contrarian. Does not threaten browser-as-brain — they deploy to hub; we deliberately don't.

### Sphero EDU web app
- **Claims:** same classroom decision as LEGO.
- **Overlap:** Web Bluetooth pairing of BOLT+/BOLT/Mini/RVR ([help.sphero.com](https://help.sphero.com/sphero-support/connecting-robots-in-the-sphero-edu-web-app)).
- **Divergence:** Sphero account required, their robots only. No user-owned firmware, no recovery plane, no LLM surface.
- **Ships today that we don't:** polished UI, k-12 marketplace presence, iOS native fallback.
- **Decision impact:** reinforces the "no account" moat — account-gating is exactly the friction this project refuses.

### Makeblock (mBlock + mBot family)
- **Claims:** same K-12 classroom decision — at the largest scale claim of any vendor in this list (200k+ schools).
- **Overlap:** mBlock 5 web at [ide.mblock.cc](https://ide.mblock.cc/) runs in Chrome/Edge, connects to mBot/CyberPi/Codey Rocky over Web Bluetooth + WebSerial without a helper app ([Makeblock support](https://support.makeblock.com/hc/en-us/articles/19412317319191-Introduction-to-Direct-Connection-of-mBlock-5-on-the-web)). Block + Python.
- **Divergence:** account-required walled garden. Programs run on closed proprietary firmware. Hardware lock-in to Makeblock kits. No LLM, no recovery plane.
- **Ships today that we don't:** scale (200k schools), educator curriculum, hardware breadth (CyberPi has its own screen + sensors), Chinese-market depth, multi-platform (PC/mobile/web).
- **Decision impact:** confirms Web-Bluetooth-from-browser is the dominant K-12 STEAM pattern, not contrarian. Reinforces the "no account, no proprietary kit" wedge: every major K-12 vendor (LEGO, Sphero, Makeblock) is account-gated and kit-locked. The combination "browser-paired AND user-owned hardware AND no account" remains unoccupied.

### MicroBlocks (microblocks.fun)
- **Claims:** browser IDE to program a BLE/serial-connected microcontroller with blocks.
- **Overlap:** runs in Chrome/Edge via WebSerial + Web Bluetooth, no install; supports micro:bit, XRP, and others ([wiki.microblocks.fun](https://wiki.microblocks.fun/en/xrp_setup)). Live programming model.
- **Divergence:** pushes a VM to the device; programs run on-board. No LLM, no phone-human handoff. Single-device focus.
- **Ships today that we don't:** live autocomplete / block editing against running firmware; a real educational community.
- **Decision impact:** closest architectural cousin. Validates "browser-first, no-account, BLE-capable" as a shipped pattern. Has no opinion on browser-as-brain for runtime.

### XRPCode / WPILib XRP (experientialrobotics.org)
- **Claims:** cheap classroom robot + browser IDE — the tightest hardware-class analog.
- **Overlap:** browser IDE for the XRP (RP2040), Python + Blockly, no install ([WPILib docs](https://docs.wpilib.org/en/stable/docs/xrp-robot/web-ui.html)).
- **Divergence:** WiFi/WebSocket, not BLE-first — robot must be on the same network, which is exactly the classroom pain our BLE-first bet was designed around. Code runs on-robot. No LLM, no phone handoff.
- **Ships today that we don't:** FRC-backed curriculum, ~$75 hardware, real classroom deployments.
- **Decision impact:** directly validates bet #1 — WiFi-first classroom stories *do* break.

### Viam
- **Claims:** *closest framing rhyme.* Tagline "build robots like you build software" — same dev-environment-shape pitch, different audience and distribution model.
- **Overlap:** browser dashboard, camera streaming, live control ([viam.com](https://www.viam.com/product/platform-overview)). gRPC/WebRTC to a device-resident `viam-server`. Modular components, multi-language SDKs.
- **Divergence:** server-resident B2B cloud SaaS. `viam-server` fetches config from Viam cloud at startup ([docs.viam.com](https://docs.viam.com/operate/reference/viam-server/)). Different buyer (software engineer at an industrial outfit, fleet operator), different distribution shape (account-anchored cloud product vs. static-site, no-backend).
- **Ships today that we don't:** data capture/sync, fleet management, funding, UR partnership.
- **Decision impact:** **inspiration, not competition.** Same transport stack we ship; treats the same problem space at industrial scale. Watching their feature surface tells us what becomes table-stakes for "robotics dev environment." Our distribution shape (browser-only, no backend, MIT) is the moat — they can ship features in 18 months; restructuring their cloud-product distribution model to match would be a different company.

### Freedom Robotics
- **Claims:** browser-based teleop and remote operation of fielded robots.
- **Overlap:** WebRTC video + control via browser; SDK/agent runs on the robot ([freedomrobotics.com](https://www.freedomrobotics.com/)).
- **Divergence:** server-resident B2B cloud SaaS, TURN-relay-anchored teleop, account + fleet model. No standalone deploy, no offline mode, no LLM/scripting surface.
- **Ships today that we don't:** production teleop UX for industrial deployments, observability tooling, customer base in delivery + service robotics.
- **Decision impact:** same audience-shape conflict as Viam — enterprise/industrial vs. consumer/education/hobbyist. Worth tracking for transport / observability conventions; not a wedge threat.

### Improv Wi-Fi (open standard)
- **Claims:** the onboarding moment — "how does a fresh device join Wi-Fi."
- **Overlap:** open standard for BLE-based Wi-Fi onboarding from a browser, Chrome/Edge ([improv-wifi.com](https://www.improv-wifi.com/)). Shipped across WLED, Tasmota, ESPHome.
- **Divergence:** explicitly scoped to Wi-Fi onboarding only — *"not the goal to offer a way for devices to share data or control."* Hands off to a device-hosted URL after provisioning.
- **Ships today that we don't:** it's a *standard*, with network-effect adoption we don't have.
- **Decision impact:** **integration candidate, not a threat.** Our BLE onboarding characteristic could optionally speak Improv so any Improv-aware browser tool can provision our robots. See `@improv-wifi/sdk-js` on npm.

### ESP RainMaker
- **Claims:** "ESP32-based product with BLE provisioning and a dashboard to control it."
- **Overlap:** BLE provisioning for ESP32/S3/C3/C6 ([docs.rainmaker.espressif.com](https://docs.rainmaker.espressif.com/docs/sdk/rainmaker-base-sdk/DeviceManagement/provisioning/)).
- **Divergence:** cloud-account-anchored by design — user↔node mapping during provisioning, AWS Cognito underneath. Mobile-app first. No browser-first story, no LLM.
- **Ships today that we don't:** Espressif-backed, production-scale cloud infra.
- **Decision impact:** confirms that in the ESP32 ecosystem, the dominant BLE-provisioning story still assumes cloud + account + phone app. The "browser tab, no account, no server" stance remains differentiated.

### LeRobot (Hugging Face)
- **Claims:** open-source stack to put an LLM/VLA brain on a robot.
- **Overlap:** LLM/VLA orchestration for hobby+research robots; v0.5 added Pi0-FAST, Real-Time Chunking, EnvHub ([HF blog](https://huggingface.co/blog/lerobot-release-v050), March 2026).
- **Divergence:** Python stack, GPU-assumed, imitation/RL-focused. No BLE story, no browser runtime, no classroom onboarding. Arms + manipulation, not browser-paired hobby robots.
- **Ships today that we don't:** actual VLA models, datasets, research community.
- **Decision impact:** adjacent, not parallel — the "not real-time, not spatially aware, decision loop is seconds" scope line keeps us in a different lane. Potential future integration: `scripts.js` calling LeRobot policies client-side via transformers.js.

## Out of scope (one-liners)

- **Wokwi** — browser simulator, not a real-device pairing UI.
- **esptool-js / ESP Web Tools** — WebSerial flashers. Shared substrate, not parallel work; we already rely on the same Web Serial API for recovery.
- **MakeCode micro:bit** — mature web IDE for micro:bit; overlaps MicroBlocks, adds little new signal.
- **Particle Device OS** — BLE provisioning exists but mobile-SDK oriented, commercial product flow, account-anchored. Same shape as RainMaker.
- **ROS 2 MoveIt, Dora-rs, industrial / arm stacks** — different buyer, different latency bracket, no browser pairing story. "Not real-time, not spatially aware" rules the lane out.
- **VEX IQ/V5, ROBOTIS** — proprietary-kit + proprietary-app lane. Doubly unavailable to the "no accounts, no server" thesis.

## Concluding read

**Anyone claiming the same shape — *write code for a robot in a browser tab, no install, AI assist optional, no backend*?** No. The field divides cleanly: **MicroBlocks** and **XRPCode** claim browser-IDE-to-hardware but deploy code *to* the device and have no in-browser AI layer; **LEGO SPIKE**, **Sphero EDU**, **Makeblock mBlock** claim classroom-web-app experience but are walled gardens with accounts and proprietary kits; **Viam** and **Freedom Robotics** are framing rhymes (server-resident dev environments) anchored to industrial cloud, accounts, fleet ops; **ESP RainMaker** and **Improv Wi-Fi** claim BLE-provisioning but stop there; **LeRobot** claims VLA/LLM orchestration but has no browser runtime or BLE story.

**Anything say change direction?** No. Nearest tactical move: implement **Improv Wi-Fi** BLE onboarding alongside ours so Improv-aware tools (ESPHome Dashboard, WLED config, Home Assistant) can provision our robots. Interop win, not a strategy shift.

**Positioning, ranked by durability (slowest to erode first):**
- **Browser-native dev surface.** Every "robotics platform" worth naming requires *some* install — `viam-server`, ESP-IDF, gpiozero on Pi, Arduino IDE. Static-site, no-backend distribution is structurally hard to copy without restructuring a whole company's product surface.
- **Browser-resident model serving.** Open-vocab detector, ArUco fiducial pose — all client-side. Viam, Freedom Robotics, LeRobot all assume server-side or per-device GPU.
- **Layered safety.** Firmware-bounded motors the IDE-level planner can't bypass. Ask-human as terminal cascade rung. Standard in driving (openpilot-panda), rare in hobby/classroom.
- **No backend, no accounts.** Static-site deployable, MIT-licensed. Sphero, Viam, Particle, RainMaker, Freedom — all account-anchor.

Scope lines stay loud in the README. Market reads "robotics platform" and expects Sphero or Viam. Naming what it *isn't* — *not a teleop dashboard, not a fleet manager, not "AI does everything autonomously," not real-time, not spatially aware* — does more positioning work than any feature comparison.

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
