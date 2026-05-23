# User code

## The `robot` API

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

// Capture a current camera frame as a data URL (camera card must be running).
const dataUrl = robot.frame(320);

// Phone in the loop — paired phone via the WebRTC pair layer.
const dir = await phones[0].ask({
  question: "Which way?",
  options: ["Forward", "Back", "Stop"],
});

// Tool-using LLM in the loop — same bridge Pip uses (claude.js).
// Costs the user's API quota per call. Throws on bridge failure.
const move = await pip.ask("Scene: chair ahead. Reply: forward, left, right, stop.", {
  system: "Reply with EXACTLY ONE token.",
  maxTokens: 8,
});
```

In scope inside a script: `robot`, `robots`, `phones`, `pip`, `sleep(ms)`, `log(...)`, `speak(text)`. The Scripts dialog ships templates; pick one from the dropdown to load it.

The `pip` namespace is deliberately thin: today just `pip.ask(prompt, opts?)`, returning the LLM's text response. It's the seam between "user wrote the orchestration" and "the LLM decided this step" — same shape Pip uses internally, exposed so the two surfaces aren't siloed.

## Safety floor

Firmware enforces motor watchdog + pulse duration cap + ultrasonic dist_cm forward-clip regardless of who issued the writes. User code, Pip, joypad — all see the same limits.

`robot.move()` calls `pulseMotors`, carrying the same 50–2000 ms duration cap the LLM is bound by. Magnitude is the signed-byte range, no LLM-specific clamp. Dashboard-side clamps are advisory; firmware enforcement is binding.

## Deployment model

User code lives in the browser, not on the robot. No upload-to-Pi, no GH Actions push, no `scp`-from-the-dashboard.

If a robot ever needs to run behavior with the dashboard disconnected for minutes+ (outside the wedge today — see `.claude/CLAUDE.md → Anti-drift guards`), the path forward is the existing OTA pipeline: drop user code into a `/home/robot/user/` slot via BLE OTA, have `pi_robot.py` import it via a typed plugin API. No new sync server needed.
