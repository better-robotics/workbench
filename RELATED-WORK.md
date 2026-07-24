# Related work

An honest survey of the neighbouring field, for anyone deciding whether this
project fits their classroom or bench. Several of the products below are more
mature than this one, and each entry says where.

Every claim links to the vendor's own documentation. If something here is out of
date or unfair, open an issue — misdescribing someone else's work is a bug.

## Classroom kits with browser apps

### LEGO SPIKE (spike.legoeducation.com)

**What it is.** The classroom-kit answer to "let students code from a Chromebook
with no install." Pairs over Web Bluetooth and Web Serial in Chrome, no native
app ([Chrome for Developers](https://developer.chrome.com/blog/lego-education-spike-web-bluetooth-web-serial)).
Programs upload to the hub, which executes them.

**How this differs.** Code runs on the hub there; here it runs in the browser
tab. LEGO's hardware and firmware are closed, with no user-owned OTA.

**Where it's stronger.** A mature curriculum and an institutional purchase
channel — neither of which this project has.

### Sphero EDU

**What it is.** Web Bluetooth pairing for BOLT+/BOLT/Mini/RVR from the browser
([help.sphero.com](https://help.sphero.com/sphero-support/connecting-robots-in-the-sphero-edu-web-app)).

**How this differs.** Sphero EDU requires an account and works with Sphero
robots only. No user-owned firmware and no recovery plane.

**Where it's stronger.** A more polished UI, real K-12 marketplace presence, and
an iOS native fallback.

### Makeblock (mBlock + mBot)

**What it is.** The largest deployment in this list, by the vendor's own count —
200k+ schools. [mBlock 5 on the web](https://ide.mblock.cc/) runs in Chrome and
Edge and connects to mBot/CyberPi/Codey Rocky over Web Bluetooth and Web Serial
with no helper app ([Makeblock support](https://support.makeblock.com/hc/en-us/articles/19412317319191-Introduction-to-Direct-Connection-of-mBlock-5-on-the-web)).
Blocks and Python, like this project.

**How this differs.** Account-required and kit-locked; programs run on closed
proprietary firmware.

**Where it's stronger.** Scale, educator curriculum, hardware breadth (CyberPi
carries its own screen and sensors), and multi-platform reach across PC, mobile
and web.

## Browser IDEs for open hardware

### MicroBlocks (microblocks.fun)

**What it is.** The closest architectural cousin here. A browser IDE that
programs a BLE- or serial-connected microcontroller with blocks, running in
Chrome/Edge with no install, supporting micro:bit, XRP and others
([wiki.microblocks.fun](https://wiki.microblocks.fun/en/xrp_setup)). Live
programming model.

**How this differs.** MicroBlocks pushes a VM to the device and programs run
on-board; here the browser is the runtime. Single-device focus, no phone-to-human
handoff.

**Where it's stronger.** Live autocomplete and block editing against running
firmware, and a real educational community.

### XRPCode / WPILib XRP (experientialrobotics.org)

**What it is.** The tightest hardware-class analog — a cheap classroom robot with
a browser IDE, Python and Blockly, no install
([WPILib docs](https://docs.wpilib.org/en/stable/docs/xrp-robot/web-ui.html)).

**How this differs.** XRP is WiFi/WebSocket rather than BLE-first, so the robot
must be on the same network — the constraint this project's BLE-first approach
was chosen to avoid. Code runs on-robot.

**Where it's stronger.** FRC-backed curriculum, ~$75 hardware, and real classroom
deployments at scale.

## Robotics platforms

### Viam

**What it is.** The closest framing rhyme — "build robots like you build
software." Browser dashboard, camera streaming and live control
([viam.com](https://www.viam.com/product/platform-overview)), speaking gRPC and
WebRTC to a device-resident `viam-server`, with modular components and
multi-language SDKs.

**How this differs.** Viam is a server-resident cloud platform aimed at a
different buyer — a software engineer at an industrial outfit, or a fleet
operator. `viam-server` fetches its config from Viam's cloud at startup
([docs.viam.com](https://docs.viam.com/operate/reference/viam-server/)). This
project is a static site with no backend and no accounts.

**Where it's stronger.** Data capture and sync, fleet management, and the
resources of a funded company. Much of the transport stack here is the same;
Viam is a useful signal for what becomes table stakes.

### Freedom Robotics

**What it is.** Browser-based teleoperation and remote operation of fielded
robots — WebRTC video plus control, with an SDK/agent on the robot
([freedomrobotics.com](https://www.freedomrobotics.com/)).

**How this differs.** Server-resident cloud product with TURN-relay teleop, an
account and fleet model, and no offline mode. This project has no scripting
handoff to a cloud service and works with no internet at all.

**Where it's stronger.** Production teleop UX, observability tooling, and real
customers in delivery and service robotics.

## Provisioning

### Improv Wi-Fi (open standard)

**What it is.** An open standard for BLE-based Wi-Fi onboarding from a browser
([improv-wifi.com](https://www.improv-wifi.com/)), shipped across WLED, Tasmota
and ESPHome.

**How this differs.** Improv is deliberately scoped to Wi-Fi onboarding only —
in its own words, it is *"not the goal to offer a way for devices to share data
or control"* — and hands off to a device-hosted URL afterwards.

**Worth integrating.** This is a complement, not an alternative: the BLE
onboarding characteristic here could also speak Improv, so any Improv-aware
browser tool could provision these robots. See `@improv-wifi/sdk-js`.

### ESP RainMaker

**What it is.** Espressif's own BLE provisioning for ESP32/S3/C3/C6 with a
dashboard to control the result
([docs.rainmaker.espressif.com](https://docs.rainmaker.espressif.com/docs/sdk/rainmaker-base-sdk/DeviceManagement/provisioning/)).

**How this differs.** RainMaker is cloud-account-anchored by design — user-to-node
mapping happens during provisioning, with AWS Cognito underneath — and is
mobile-app first.

**Where it's stronger.** Backed by Espressif, with production-scale cloud
infrastructure.

## Robot brains

### LeRobot (Hugging Face)

**What it is.** An open-source stack for putting an LLM/VLA brain on a robot.
v0.5 added Pi0-FAST, Real-Time Chunking and EnvHub
([HF blog](https://huggingface.co/blog/lerobot-release-v050), March 2026).

**How this differs.** LeRobot is a Python stack that assumes a GPU and focuses on
imitation and RL for arms and manipulation. No BLE story, no browser runtime.
This project's scope line — not real-time, not spatially aware, decision loop
measured in seconds — puts it in a different lane.

**Where it's stronger.** Actual VLA models, datasets, and a research community.

## Also looked at

- **Wokwi** — browser simulator, not a real-device pairing UI.
- **esptool-js / ESP Web Tools** — Web Serial flashers. Shared substrate rather
  than parallel work; the recovery plane here uses the same Web Serial API.
- **MakeCode micro:bit** — mature web IDE for micro:bit; overlaps MicroBlocks.
- **Particle Device OS** — BLE provisioning exists, but mobile-SDK oriented and
  account-anchored, in the same shape as RainMaker.
- **ROS 2 MoveIt, Dora-rs, industrial arm stacks** — different buyer, different
  latency bracket, no browser pairing story.
- **VEX IQ/V5, ROBOTIS** — proprietary kit plus proprietary app.
- **schematik.io** — "Cursor for Hardware," generating firmware-adjacent code
  from natural language. A possible *input* for authoring firmware like this,
  not a control plane or dashboard.

## How this project differs, structurally

These are shape differences rather than feature gaps — they follow from the
architecture, and closing them would mean becoming a different product.

- **Browser-native dev surface.** Every robotics platform worth naming requires
  installing *something* — `viam-server`, ESP-IDF, gpiozero, the Arduino IDE.
  Static-site distribution with no backend is a different shape.
- **Browser-resident model serving.** The detectors run client-side. Viam,
  Freedom Robotics and LeRobot all assume a server or a per-device GPU.
- **Layered safety.** Motor limits are enforced in firmware, below the layer that
  plans motion, so the planner cannot bypass them — not even with a malformed
  tool call. Standard in driving stacks, rare in hobby and classroom ones.
- **No backend, no accounts.** Static-site deployable and MIT-licensed.

Worth being equally clear about what this is **not**: not a teleop dashboard, not
a fleet manager, not autonomous, not real-time, and not spatially aware. If you
need any of those, several products above will serve you better.

## Sources

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
- [Schematik.io homepage](https://schematik.io)
