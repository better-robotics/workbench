// Motor calibration wizard — pulses each driver in turn, asks the user
// what they observed, derives the three orientation flips (swap channels,
// invert motor A, invert motor B), and writes them to pi-robot.conf. The
// pulses go through a "raw" ops verb that bypasses the firmware's
// orientation transform, so the user is observing motor-A vs motor-B in
// their physical wiring — exactly what we need to discover.
//
// Renders inside the pinout dialog body (same modal); on done we either
// re-render the pinout editor or close the dialog after a successful save.
import { $ } from "./dom.js";
import { sendCommand } from "./capabilities/runtime/command.js";
import { uploadFile } from "./capabilities/ota.js";
import { logFor } from "./log.js";

// Map a per-step user answer (one of five buttons) to the bits that the
// answer implies for that motor.
//
// Step 1 pulses motor A forward. The user reports which wheel turned and
// in what direction:
//   "left-fwd"  → A drives the LEFT wheel correctly. No swap. No invert_a.
//   "left-bwd"  → A drives the LEFT wheel reversed. No swap. invert_a=true.
//   "right-fwd" → A drives the RIGHT wheel correctly. swap=true. No invert_a.
//   "right-bwd" → A drives the RIGHT wheel reversed. swap=true. invert_a=true.
// Step 2 (motor B) reports the OTHER wheel; we use its sign to set invert_b
// and cross-check swap.
const CHOICES = [
  { id: "left-fwd",  label: "Left wheel — forward" },
  { id: "left-bwd",  label: "Left wheel — backward" },
  { id: "right-fwd", label: "Right wheel — forward" },
  { id: "right-bwd", label: "Right wheel — backward" },
  { id: "nothing",   label: "Nothing / not sure (retry)" },
];

function deriveOrientation(a, b) {
  // a, b ∈ {"left-fwd","left-bwd","right-fwd","right-bwd"} — "nothing"
  // never reaches here, the wizard re-asks.
  const aSide = a.startsWith("left") ? "left" : "right";
  const bSide = b.startsWith("left") ? "left" : "right";
  const consistent = aSide !== bSide;
  // swap=true means: dashboard's L (operator's left wheel) should drive
  // motor B instead of motor A. We need that when motor A is wired to the
  // right wheel — i.e. step 1 reported a "right-*" choice.
  const swap = aSide === "right";
  const invert_a = a.endsWith("bwd");
  const invert_b = b.endsWith("bwd");
  return { swap, invert_a, invert_b, consistent };
}

// Returns true if the pulse command actually reached the chip. The wizard
// uses this to show a clear message instead of leaving the button dead
// when the firmware predates the OPS char.
async function pulseRaw(entry, motor) {
  if (!entry?.opsChar) {
    logFor(entry, "calibration: this firmware doesn't expose the ops channel — re-flash to use the wizard, or swap the forward/backward pin numbers manually");
    return false;
  }
  // Speed 100 matches WASD — calibration's job is "spin enough that the
  // user sees which wheel turned." Lower magnitudes (we tried 30) get
  // clamped through audible PWM whine without breaking static friction on
  // typical gearmotors. Duration stays at 300 ms, firmware still bounds it.
  return await sendCommand(entry, "ops", {
    op: "motors-pulse-raw",
    args: { motor, direction: "forward", duration_ms: 300, speed: 100 },
  });
}

export function beginMotorsCalibration({ entry, editConfig, onCancel, onDone }) {
  const state = { step: "intro", answers: { a: null, b: null }, status: "" };

  const choicesHtml = (side) => `
    <div class="cal-choices">
      ${CHOICES.map(c => `
        <button class="secondary sm" data-side="${side}" data-choice="${c.id}">${c.label}</button>
      `).join("")}
    </div>
  `;

  function render() {
    const stepNum = state.step === "intro" ? 0
      : state.step === "pulse-a" ? 1
      : state.step === "pulse-b" ? 2 : 3;
    const stepper = `
      <div class="cal-progress">
        ${[1, 2, 3].map(n => `<span class="cal-step${n <= stepNum ? " active" : ""}">${n}</span>`).join("")}
      </div>
    `;

    let body;
    if (state.step === "intro") {
      // If opsChar isn't there, the firmware predates the calibration
      // ops verbs. The wizard would click silently. Tell the user up front
      // and point them at the manual workaround (swap forward/backward
      // pin numbers in the pin editor — same effect for the
      // common "wheels spin the wrong way" case).
      const noOps = entry && !entry.opsChar;
      const opsWarn = noOps ? `
        <div class="cal-warn">
          <strong>Calibration unavailable.</strong> This robot's firmware
          doesn't expose the calibration ops channel — re-flash to the
          latest firmware to use the wizard. In the meantime, if your
          wheels spin the wrong way, swap forward ↔ backward pin numbers
          in the editor (e.g., Left forward = 17 + Left backward = 16
          instead of 16/17).
        </div>` : "";
      body = `
        ${opsWarn}
        <p>I'll pulse each motor for a moment so you can see which wheel it drives and in which direction. From your two answers, I'll figure out how your robot is wired — no math, no swapping wires.</p>
        <p class="meta">Make sure the robot is on a surface where the wheels can turn freely.</p>
        <button class="sm" id="cal-start"${noOps ? " disabled" : ""}>Start calibration</button>
      `;
    } else if (state.step === "pulse-a" || state.step === "pulse-b") {
      const side = state.step === "pulse-a" ? "a" : "b";
      const label = side === "a" ? "first" : "second";
      body = `
        <p><strong>Step ${stepNum} of 3</strong> — pulsing the ${label} motor.</p>
        <button class="sm" id="cal-pulse" data-side="${side}">▶ Pulse motor (300 ms forward)</button>
        <p class="meta">What did you see?</p>
        ${choicesHtml(side)}
        ${state.status ? `<p class="meta">${state.status}</p>` : ""}
      `;
    } else if (state.step === "summary") {
      const o = deriveOrientation(state.answers.a, state.answers.b);
      const lines = [];
      if (o.swap) lines.push("Channels are swapped (firmware's motor A drives the right wheel).");
      if (o.invert_a) lines.push("Motor A's polarity is reversed (forward command spun it backward).");
      if (o.invert_b) lines.push("Motor B's polarity is reversed.");
      if (!o.swap && !o.invert_a && !o.invert_b) lines.push("Everything is wired in the canonical way — no flips needed.");
      const warn = o.consistent ? "" : `<p class="cal-warn">Both pulses reported the same wheel. Either one motor is disconnected or you may have mis-clicked — recommend re-running.</p>`;
      body = `
        <p><strong>Step 3 of 3</strong> — confirm and save.</p>
        ${warn}
        <ul class="cal-summary">${lines.map(l => `<li>${l}</li>`).join("")}</ul>
        <p class="meta">Saving writes <code>motors_orientation</code> into <code>pi-robot.conf</code> and restarts the service so the flips take effect.</p>
        <div class="row" style="gap: 8px;">
          <button class="secondary sm" id="cal-redo">Re-run</button>
          <button class="sm" id="cal-save">Save &amp; restart</button>
        </div>
      `;
    } else if (state.step === "saving") {
      body = `<p>Writing config + restarting service…</p>`;
    }

    $("pinout-body").innerHTML = `
      <div class="cal-wizard">
        <h3 style="margin: 0 0 8px;">Motor calibration</h3>
        ${stepper}
        ${body}
        <div class="modal-footer">
          <button class="secondary sm" id="cal-cancel">Cancel</button>
        </div>
      </div>
    `;
    wire();
  }

  function wire() {
    $("cal-cancel")?.addEventListener("click", () => onCancel?.());
    $("cal-start")?.addEventListener("click", () => {
      state.step = "pulse-a"; state.status = ""; render();
    });
    $("cal-pulse")?.addEventListener("click", async (e) => {
      const side = e.currentTarget.dataset.side;
      state.status = "pulsing…";
      render();
      await pulseRaw(entry, side);
      state.status = "Done — pick what you saw.";
      render();
    });
    $("pinout-body").querySelectorAll("[data-choice]").forEach(btn => {
      btn.addEventListener("click", () => {
        const side = btn.dataset.side;
        const choice = btn.dataset.choice;
        if (choice === "nothing") {
          state.status = "Pulse again, then pick.";
          render();
          return;
        }
        state.answers[side] = choice;
        if (side === "a") state.step = "pulse-b";
        else state.step = "summary";
        state.status = "";
        render();
      });
    });
    $("cal-redo")?.addEventListener("click", () => {
      state.answers = { a: null, b: null };
      state.step = "pulse-a";
      render();
    });
    $("cal-save")?.addEventListener("click", () => save());
  }

  async function save() {
    const o = deriveOrientation(state.answers.a, state.answers.b);
    state.step = "saving";
    render();
    // ESP32: persist via BLE ops verb (NVS-backed, firmware reboots itself).
    // Pi: persist via pi-robot.conf upload, restart the service. Same
    // {swap, invert_a, invert_b} shape, different transports.
    if (entry.fwType === "esp32") {
      const ok = await sendCommand(entry, "ops", {
        op: "motors-set-orientation",
        args: { swap: o.swap, invert_a: o.invert_a, invert_b: o.invert_b },
      });
      onDone?.(ok);
      return;
    }
    const merged = {
      ...editConfig,
      motors_orientation: {
        swap: o.swap,
        invert_a: o.invert_a,
        invert_b: o.invert_b,
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(merged, null, 2) + "\n");
    const ok = await uploadFile(entry.id, "pi-robot.conf",
                                "/boot/firmware/pi-robot.conf", bytes,
                                { restart: "pi-robot" });
    onDone?.(ok);
  }

  render();
}
