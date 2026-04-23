# Competitors

External systems that compete for the same user decision as Better Robotics — *"how do I pair, control, and give a brain to a small robot from a browser."* Not an encyclopedia; filtered for what would change a decision.

## schematik.io — not in this lane

[schematik.io](https://schematik.io) bills itself as "Cursor for Hardware" — an AI code-generation tool that emits firmware / schematic-adjacent code from natural language for Arduino, ESP32, Raspberry Pi (~$4.6M pre-seed as of scan). It is not a pairing UI, not a control plane, not a dashboard you drive a running robot from. The name similarity is the whole story. It's a *potential input* for authoring firmware like ours, not a competitor to the runtime-control story. No overlap with any of the seven architectural bets below.

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

### MicroBlocks (microblocks.fun)
- **Competes for:** browser IDE to program a BLE/serial-connected microcontroller with blocks.
- **Overlap:** runs in Chrome/Edge via WebSerial + Web Bluetooth, no install; supports micro:bit, XRP, and others ([wiki.microblocks.fun](https://wiki.microblocks.fun/en/xrp_setup)). Live programming model.
- **Divergence:** pushes a VM to the device; programs run on-board. No LLM/VLM, no phone-human handoff, no replay. Single-device focus.
- **Better than us today:** live autocomplete / block editing against running firmware; a real educational community.
- **Decision impact:** closest architectural cousin. Validates "browser-first, no-account, BLE-capable" as a shipped pattern. Has no opinion on browser-as-brain for runtime.

### XRPCode / WPILib XRP (experientialrobotics.org)
- **Competes for:** cheap classroom robot + browser IDE — the tightest hardware-class analog.
- **Overlap:** browser IDE for the XRP (RP2040), Python + Blockly, no install ([WPILib docs](https://docs.wpilib.org/en/stable/docs/xrp-robot/web-ui.html)).
- **Divergence:** WiFi/WebSocket, not BLE-first — robot must be on the same network, which is exactly the classroom pain our BLE-first bet was designed around. Code runs on-robot. No LLM, no replay, no phone handoff.
- **Better than us today:** FRC-backed curriculum, ~$75 hardware, real classroom deployments.
- **Decision impact:** directly validates bet #1 — WiFi-first classroom stories *do* break.

### Viam
- **Competes for:** "platform to run software on a robot you own." Different buyer (software engineer, fleet operator) but same keyword space.
- **Overlap:** browser dashboard, camera streaming, live control ([viam.com](https://www.viam.com/product/platform-overview)). gRPC/WebRTC to a device-resident `viam-server`.
- **Divergence:** cloud-account anchored. `viam-server` fetches config from Viam cloud at startup ([docs.viam.com](https://docs.viam.com/operate/reference/viam-server/)). Not BLE-first; no offline-classroom story. "Cloud infra for hardware" is their thesis; "no server in the critical path" is ours.
- **Better than us today:** data capture/sync, fleet management, funding, UR partnership.
- **Decision impact:** clearest head-on conflict in *philosophy*. Worth naming Viam explicitly as "what we are not" so positioning is unmistakable. If Viam ever ships a BLE-first no-account free tier, the moat gets squeezed — they haven't, and it doesn't look like their direction.

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
- **VEX IQ/V5, Makeblock, ROBOTIS** — proprietary-kit + proprietary-app lane. Doubly unavailable to the "no accounts, no server" thesis.

## Concluding read

**Is schematik.io the best thing out there for this shape of problem?** No, and not because it's beaten — it's in a different category entirely (AI hardware codegen, not browser-paired runtime control). For the actual shape — *pair a robot in a browser tab, control and brain it, no account, no server* — **there is no clean head-on competitor.** The closest cousins split the problem: **MicroBlocks** and **XRPCode** own browser-IDE-to-hardware but deploy code *to* the device and have no LLM/VLM layer; **LEGO SPIKE** and **Sphero EDU** own classroom-web-app experience but are walled gardens with accounts; **Viam** owns "browser dashboard for robot" but hard-anchors to a cloud account; **ESP RainMaker** and **Improv Wi-Fi** own the BLE-provisioning primitive but stop there; **LeRobot** owns the VLA/LLM orchestration layer but has no browser runtime or BLE story. The project sits at the intersection none of them occupy.

**Does anything here say change direction?** No. The closest scare is Viam's "robotics is cloud infra for hardware" — opposite bet, well-funded — but the moat is *exactly* not going that way. The nearest tactical move is to implement the **Improv Wi-Fi** BLE onboarding characteristic alongside ours so anything Improv-aware (ESPHome Dashboard, WLED config, Home Assistant tools) can provision our robots out of the box. Interop win, not a strategy shift.

**What's the moat, given the landscape?**
- **No-account-no-server** is genuinely rare here. Sphero, Viam, Particle, RainMaker all account-anchor. MicroBlocks and esptool-js run accountless but aren't runtime-control planes.
- **Three-plane discipline** (control/data/recovery as independent systemd units, USB-CDC recovery, separate heartbeat service) has no analog in the hobby/classroom stacks — openpilot-caliber discipline in a niche that doesn't usually do it.
- **Browser-as-brain for runtime and user code** (not just authoring) is the one genuinely contrarian bet. Every competitor that does "browser IDE" pushes code to the device; every competitor that does "cloud brain" assumes an account. The combination — LLM-orchestrated runtime in the browser, user scripts also in the browser, Pi as typed-primitive actuator — is the shape no one else is shipping.

Keep the scope lines loud in the README. The market reads "robotics kit" and expects either Sphero (closed, accountful, kid-friendly) or Viam (cloud, engineer-facing, fleet-y). The project is neither. Naming what it *isn't* — "not autonomous, not real-time, not spatially aware, not a code-deploy target, not a remote-shell host" — does more positioning work than any feature comparison could.

## Sources

- [Schematik.io homepage](https://schematik.io)
- [LEGO Education SPIKE — Web Bluetooth + Web Serial (Chrome for Developers)](https://developer.chrome.com/blog/lego-education-spike-web-bluetooth-web-serial)
- [Sphero EDU Web App — Connecting Robots](https://help.sphero.com/sphero-support/connecting-robots-in-the-sphero-edu-web-app)
- [MicroBlocks XRP setup (Web Bluetooth)](https://wiki.microblocks.fun/en/xrp_setup)
- [MicroBlocks in the browser](http://www.microblocks.fun/en/microblocks_in_browser)
- [WPILib XRP Web UI](https://docs.wpilib.org/en/stable/docs/xrp-robot/web-ui.html)
- [Experiential Robotics XRP Code](https://www.experiential.bot/code)
- [Viam Platform Overview](https://www.viam.com/product/platform-overview)
- [viam-server reference](https://docs.viam.com/operate/reference/viam-server/)
- [Improv Wi-Fi homepage](https://www.improv-wifi.com/)
- [ESPHome 2025.10.0 changelog — Improv BLE improvements](https://esphome.io/changelog/2025.10.0/)
- [ESP RainMaker provisioning docs](https://docs.rainmaker.espressif.com/docs/sdk/rainmaker-base-sdk/DeviceManagement/provisioning/)
- [ESP RainMaker homepage](https://rainmaker.espressif.com/)
- [LeRobot v0.5.0 release notes (HF blog, Mar 2026)](https://huggingface.co/blog/lerobot-release-v050)
- [Particle BLE provisioning reference](https://docs.particle.io/reference/device-os/bluetooth-le/)
- [esptool-js (Espressif)](https://github.com/espressif/esptool-js)
- [LOFI Control (Web Bluetooth PWA for micro:bit)](https://cardboard.lofirobot.com/lofi-control-app-info/)
