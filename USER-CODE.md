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
const log = await robot.op("get-log", { lines: 50 });

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

In scope inside a script: `robot`, `robots`, `phones`, `pip`, `sleep(ms)`, `log(...)`, `speak(text)`. The IDE view (Scripts) has full IntelliSense for this surface — typing `robot.` offers the API with hover docs — and ships the templates as "New from template" seed files.

## Where files live

Scripts live in one of two places, shown side by side in the IDE's file tree:

- **On the robot** — when a robot with the file service is connected, its files appear under "On <robot>". They're stored in a LittleFS partition in the robot's flash, so they survive a reboot and roam with the hardware. Save streams the file over BLE with a length + CRC32 check; a file only lands if it arrives intact.
- **Local drafts** — files kept in this browser under "Local". The offline path: no robot needed, but they stay on this machine.

Per-robot limits: 32 KB per file, 64 files. Over a limit, the save surfaces a plain-language error, not a silent failure.

The `pip` namespace is thin: `pip.ask(prompt, opts?)` returns the LLM's text response. It's the seam between "user wrote the orchestration" and "the LLM decided this step" — same shape Pip uses internally, exposed so the two surfaces aren't siloed.

## Safety floor

Firmware enforces motor watchdog + pulse duration cap + ultrasonic dist_cm forward-clip regardless of who issued the writes. User code, Pip, joypad — all see the same limits.

`robot.move()` calls `pulseMotors`, carrying the same 50–2000 ms duration cap the LLM is bound by. Magnitude is the signed-byte range, no LLM-specific clamp. Dashboard clamps are advisory; firmware is binding.

## Deployment model

User code lives in the browser, not on the robot. No upload-to-device, no GH Actions push, no `scp`.

If a robot needs to run behavior with the dashboard disconnected for minutes+ (outside the wedge today — see `.claude/CLAUDE.md → Anti-drift guards`), the path forward is the existing OTA pipeline: stream user code onto the firmware via BLE OTA and have it load through a typed plugin API. No new sync server needed.
