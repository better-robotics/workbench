# User code lives in the browser, not on the robot

No way to upload arbitrary user code to a Pi or ESP32. No GH Actions push, no sync server, no `scp`-from-the-dashboard, no "drop a `.py` into this folder."

## What we do instead

User code runs in the browser alongside the dashboard, with a `robot` API that calls the robot's typed BLE capabilities. Scripts panel is the IDE; localStorage is the file system; BLE is the runtime link.

```js
// Multi-robot is a forEach.
for (const r of robots) {
  await r.led(true);
  await r.move({ left: 30, right: 30, durationMs: 400 });
  await sleep(500);
  await r.led(false);
}

// Typed ops with responses — same channel Pip uses.
const cfg = await robot.op("get-config");
const log = await robot.op("get-log", { lines: 50, unit: "pi-robot" });

// Fire-and-forget for ops where the robot drops BLE mid-call.
await robot.op("reboot", {}, { await: false });

// Vision in the loop — same in-browser VLM Pip uses (perception.js).
// Camera must be streaming on this robot first.
const scene = await robot.scene("Is the path ahead clear?");

// Phone in the loop — paired phone via the WebRTC pair layer.
const dir = await phones[0].ask({
  question: "Which way?",
  options: ["Forward", "Back", "Stop"],
});

// Claude in the loop — same bridge Pip uses (claude.js). Costs the user's
// API quota per call. Throws on bridge failure.
const move = await pip.ask("Scene: chair ahead. Reply: forward, left, right, stop.", {
  system: "Reply with EXACTLY ONE token.",
  maxTokens: 8,
});
```

In scope inside a script: `robot`, `robots`, `phones`, `pip`, `sleep(ms)`, `log(...)`, `speak(text)`. The Scripts dialog ships templates demonstrating the shapes; pick one from the dropdown to load it.

The `pip` namespace is deliberately thin: today just `pip.ask(prompt, opts?)`, returning Claude's text. It's the seam between "user wrote the orchestration" and "Claude decided this step" — same shape Pip uses internally, exposed to user scripts so the two worlds aren't siloed.

## Why this is the right shape

The architecture already says where the brain lives. Pip runs in the browser and drives the robot via typed BLE calls. User code is the same shape with a human writing the orchestration instead of a model generating it. Splitting them across browser and Pi would be inconsistent for no reason.

What you get for free:

- **Zero deployment.** Edit, click Run. No flash, no OTA wait, no SSH.
- **Zero new infrastructure.** No CI, no server, no signing, no sync. Keeps the README's "no servers, no broker, no cloud in the critical path" intact.
- **Zero new trust boundary.** Dashboard is already paired to the robot via TOFU. Browser code is already trusted to the same level.
- **Multi-robot is a `forEach`.** No per-robot deploy step.
- **Iteration is instant.** Same edit-reload loop as the rest of the dashboard.

## The safety argument

Standard reflex for "user code on device": code signing, sandboxing, restricted shell, signed OTA, review pipeline. Each costs real engineering, because *the device is now executing foreign code* and the threat surface is "everything you can run."

Browser-side user code doesn't have that surface. The robot only sees typed BLE writes, and firmware's safety floor (motor watchdog, pulse magnitude/duration caps) applies to those writes regardless of who issued them.

Same panda doctrine that governs Pip:
> Safety below the planner. Firmware-side limits are the hard floor. Pip and user code cannot bypass them, not even with a malformed or malicious tool call. (.claude/CLAUDE.md → Control-loop architecture)

User code is just another planner. The hard floor doesn't care which planner is driving. `robot.move()` calls `pulseMotors`, carrying the same ±40 magnitude / 50–2000 ms duration caps the LLM is bound by, and firmware enforces those caps regardless of dashboard-side clamps.

## When would Pi-side user code be the right answer?

Only if a robot needs to run useful behavior with the dashboard disconnected for minutes+. That sits outside the wedge (`.claude/CLAUDE.md → Wedge` and `Anti-drift guards`), so it's not a current need.

If it becomes one, **reuse the existing OTA pipeline** (drop user code into a `/home/robot/user/` slot via BLE OTA; have `pi_robot.py` import it via a typed plugin API) rather than invent GH Actions integration or a sync server.
