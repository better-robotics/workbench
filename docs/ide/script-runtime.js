// The user-code execution surface, lifted verbatim out of the old scripts
// dialog so the IDE view changes where code lives, never how it runs. In
// scope inside a script: robot, robots, phones, pip, sleep, log, speak —
// same names, same clamps (pulseMotors's pulse-duration floor), same
// firmware safety floor. See USER-CODE.md and .claude/CLAUDE.md →
// Control-loop architecture.
import { state } from "../state.js";
import { setToggleValue } from "../capabilities/runtime/toggle.js";
import { pulseMotors } from "../capabilities/runtime/signed-pair.js";
import { sendCommand } from "../capabilities/runtime/command.js";
import { waitOpsResponse } from "../ops-response.js";
import { captureFrameDataUrl } from "../perception/camera-frame.js";
import { detectOnce as detDetectOnce, startDetection as detStartDetection } from "../perception/detectors.js";
import { listPhones, askHuman } from "../pair/phones.js";
import { ask as claudeAsk } from "../pip/claude.js";
import { speak as voiceSpeak } from "../voice.js";

// pip.ask(prompt, opts?) — routes through whichever Pip backend /model
// picked. Throws on any backend failure so scripts catch one error path.
const pip = {
  async ask(prompt, opts = {}) {
    const text = await claudeAsk(String(prompt), {
      system: opts.system,
      maxTokens: opts.maxTokens ?? 300,
    });
    if (text === null) throw new Error("pip.ask: backend unreachable (check Settings → Pip backend)");
    return text;
  },
};

// Per-robot wrapper. Pass-throughs to the same capability surface the
// dashboard UI drives, so safety/clamp behavior is identical.
function makeRobotApi(entry) {
  return {
    id: entry.id,
    name: entry.name,
    get connected() { return entry.status === "connected"; },
    get capabilities() { return (entry.capSchema || []).map(c => c.name); },
    entry,

    async move({ left = 0, right = 0, durationMs = 400 } = {}) {
      return pulseMotors(entry.id, left, right, durationMs);
    },

    async led(on) {
      if (!entry.ledChar) throw new Error(`${entry.name}: no LED capability`);
      await setToggleValue(entry, "led", on);
    },

    async op(name, args = {}, opts = {}) {
      const sent = await sendCommand(entry, "ops", { op: name, args });
      if (!sent) throw new Error(`${entry.name}: ops write failed (not connected?)`);
      if (opts.await === false) return { ok: true };
      return waitOpsResponse(name, entry.id, opts.timeoutMs);
    },

    frame(maxDim = 320) { return captureFrameDataUrl(entry, maxDim); },

    async detections(opts = {}) {
      const dets = await detDetectOnce(entry, opts);
      if (dets === null) throw new Error(`${entry.name}: detection unavailable (check the camera is streaming and the detector loaded — see console)`);
      return dets;
    },

    watchFor(classes, opts = {}) {
      const list = Array.isArray(classes) ? classes : [classes];
      return detStartDetection(entry, { ...opts, classes: list }).promise;
    },
  };
}

function makePhoneApi(phone) {
  return {
    id: phone.id,
    label: phone.label,
    async ask(opts = {}) {
      const { answer } = await askHuman(phone.id, opts);
      return answer;
    },
  };
}

function connectedRobots() {
  return [...state.devices.values()]
    .filter(e => e.status === "connected")
    .map(makeRobotApi);
}

// Execute a user script body. `onLog(line)` receives each log(...) line and
// the final return value (prefixed "→ "); `onError(msg)` receives a thrown
// error's message. Returns a promise that resolves when the script settles.
export async function runUserScript(body, { onLog, onError } = {}) {
  const log = (...args) => onLog?.(args.map(a =>
    typeof a === "string" ? a : JSON.stringify(a)
  ).join(" "));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const speak = voiceSpeak;
  const robots = connectedRobots();
  const robot = robots[0] || null;
  const phones = listPhones().map(makePhoneApi);
  try {
    // AsyncFunction so top-level `await` works in the user's script.
    const fn = new (Object.getPrototypeOf(async function () {}).constructor)(
      "robot", "robots", "phones", "pip", "sleep", "log", "speak", body
    );
    const ret = await fn(robot, robots, phones, pip, sleep, log, speak);
    if (ret !== undefined) onLog?.(`→ ${typeof ret === "string" ? ret : JSON.stringify(ret)}`);
  } catch (err) {
    onError?.(err.message || String(err));
  }
}

// Seed files for "New from template". Each demonstrates a slice of the
// architecture (multi-robot, vision, phone-coupled, typed ops). Names are
// filenames now — the IDE writes them as .js files.
export const TEMPLATES = [
  {
    id: "hello",
    name: "hello.js",
    label: "Hello — basic moves + ops",
    body: `// \`robots\` is every connected robot, \`robot\` is the first.
// \`sleep(ms)\`, \`log(...)\`, \`speak(text)\` available. \`phones\` lists paired
// phones. See USER-CODE.md.

if (!robot) {
  log("No robots connected. Pair one and click Connect first.");
  return;
}

log(\`\${robot.name} caps: \${robot.capabilities.join(", ") || "(none)"}\`);

// Read-back ops return data:
const cfg = await robot.op("get-config");
log("config:", cfg.text?.slice(0, 200) || "(empty)");

// Pulse-bounded motion (firmware-clamped to 50–2000 ms duration):
await robot.move({ left: 60, right: 60, durationMs: 400 });
await sleep(500);
await robot.move({ left: -60, right: -60, durationMs: 400 });
log("done");
`,
  },
  {
    id: "disco",
    name: "disco.js",
    label: "Disco — multi-robot LED + spin",
    body: `// All connected robots: alternate LED on/off and spin briefly.
// What's special: this is one browser orchestrating N robots over BLE
// in parallel — the architecture's defining trick.

if (robots.length === 0) { log("Pair at least one robot."); return; }

for (let i = 0; i < 6; i++) {
  await Promise.all(robots.map(async (r, idx) => {
    try { await r.led(i % 2 === idx % 2); } catch {}
    await r.move({ left: 30, right: -30, durationMs: 300 });
  }));
  await sleep(150);
}

await Promise.all(robots.map(r => r.led(false).catch(() => {})));
log("done");
`,
  },
  {
    id: "square",
    name: "square.js",
    label: "Square dance — patterned drive",
    body: `// Drive a rough square. The 2000ms pulse cap that pulseMotors
// enforces is the LLM-grade safety floor — same cap Pip is bound by.
// Tune the durations for your robot's actual turn rate.

if (!robot) { log("Pair a robot first."); return; }

for (let side = 0; side < 4; side++) {
  log(\`side \${side + 1} / 4\`);
  await robot.move({ left: 35, right: 35,  durationMs: 800 });   // forward
  await sleep(400);
  await robot.move({ left: 35, right: -35, durationMs: 380 });   // turn ~90°
  await sleep(400);
}
log("done — adjust durations if it doesn't close up");
`,
  },
  {
    id: "phone-joystick",
    name: "phone-joystick.js",
    label: "Phone joystick — paired phone drives",
    body: `// Phone in the loop: pop a question on the paired phone, drive based
// on the answer. Demonstrates the WebRTC phone pair layer + ask_human
// primitive — same one Pip uses to defer decisions upward.
// Pair a phone first via the Phone QR in the avatar menu.

if (!robot) { log("Pair a robot first."); return; }
if (phones.length === 0) { log("No paired phone — pair one via the Phone QR."); return; }

const phone = phones[0];
const CMDS = {
  Forward: { left: 30,  right: 30 },
  Back:    { left: -30, right: -30 },
  Left:    { left: -25, right: 25 },
  Right:   { left: 25,  right: -25 },
};

for (let step = 0; step < 6; step++) {
  const dir = await phone.ask({
    question: \`Step \${step + 1}/6 — which way?\`,
    options: ["Forward", "Back", "Left", "Right", "Stop"],
    timeoutMs: 30000,
  });
  log(\`phone said: \${dir ?? "(no answer)"}\`);
  if (!dir || dir === "Stop") break;
  if (CMDS[dir]) await robot.move({ ...CMDS[dir], durationMs: 400 });
}
log("done");
`,
  },
  {
    id: "stop-sign",
    name: "stop-sign.js",
    label: "Stop sign — reflex vision",
    body: `// Closed-vocab reflex detector (MediaPipe COCO, ~10–30ms/frame on GPU).
// Drive forward in short pulses; halt the cruise the moment a stop sign
// shows up in the robot's camera. \`watchFor\` runs in parallel with the
// drive loop so the script linearizes around the next sighting.

if (!robot) { log("Pair a robot first."); return; }

let seen = null;
robot.watchFor("stop sign", { timeoutMs: 30000 }).then(d => { seen = d; });

for (let i = 0; i < 60 && !seen; i++) {
  await robot.move({ left: 30, right: 30, durationMs: 300 });
  await sleep(50);
}

if (seen) {
  log(\`stop sign detected (\${(seen.score * 100 | 0)}%) at cx=\${seen.bbox.cx.toFixed(2)}\`);
  speak("stop sign");
} else {
  log("timeout — no stop sign seen in 30 s");
}
`,
  },
  {
    id: "fleet-status",
    name: "fleet-status.js",
    label: "Fleet status — typed ops across robots",
    body: `// Multi-robot health check. Pulls config + recent log lines from every
// connected robot in parallel via the typed ops channel. Demonstrates
// the request/response form of robot.op() at fleet scale.

if (robots.length === 0) { log("Pair at least one robot."); return; }

await Promise.all(robots.map(async (r) => {
  try {
    const cfg = await r.op("get-config");
    const cfgObj = (() => { try { return JSON.parse(cfg.text || "{}"); } catch { return {}; } })();
    const caps = Object.entries(cfgObj)
      .filter(([k, v]) => k.endsWith("_enabled") && v)
      .map(([k]) => k.replace("_enabled", ""))
      .join(", ") || "(none enabled)";
    log(\`\${r.name}  caps: \${caps}\`);
  } catch (err) {
    log(\`\${r.name}: \${err.message}\`);
  }
}));
log("done");
`,
  },
];
