// Pip's physical-presence channel — drives the RGB LED + servo on each
// connected robot to reflect agent state. Lifecycle-driven (assistant.js
// hooks turn.start / appendStepPill / finishStepPill / turn.end);
// Pip itself has set_rgb / set_servo tools for intentional cues.
// Predictability over expressiveness — an LED that always reports what's
// actually happening is a trust mechanism, not a decoration.
//
// State vocabulary, deliberately small:
//   idle     — no turn active. LED off, servo at rest.
//   thinking — LLM call in flight, no tool yet. Slow ~1Hz amber blink.
//   working  — tool call executing. Amber solid (one write at entry).
//   asking   — ask_human tool open. Fast ~4Hz amber pulse + servo turns
//              to ENGAGED. Only mechanical cue in the vocabulary, reserved
//              for "I genuinely need you."
//   done     — turn just finished. White flash, auto-fades to idle after
//              DONE_DURATION_MS.
//
// Writes are EVENT-DRIVEN, not continuous: state transitions trigger
// timer setup; the timer ticks at the rhythm appropriate to the state
// (1–4 Hz, not 30 Hz). A typical turn produces ~10–30 BLE writes total,
// bounded and well below the GATT queue's saturation threshold. We route
// through setRgbValue / setLevelValue so the in-flight-coalescing path
// from the dashboard's manual color picker is the only write path —
// no parallel BLE-touching code to keep in sync.

import { state } from "./state.js";
import { setRgbValue } from "./capabilities/runtime/rgb.js";
import { setLevelValue } from "./capabilities/runtime/level.js";

// Anthropic-leaning palette: amber + white, no rainbow. AMBER_DIM at
// ~40% intensity reads as "ambient on" at 1 m without competing with
// the dashboard.
const COLOR_OFF        = "#000000";
const COLOR_AMBER_DIM  = "#663000";
const COLOR_AMBER_FULL = "#ff7800";
const COLOR_WHITE      = "#c8c8c8";

// 74° is firmware's servo rest position (servo_init); keep in lock-step.
const SERVO_REST    = 74;
const SERVO_ENGAGED = 90;

const THINKING_BLINK_MS = 500;   // 1 Hz
const ASKING_PULSE_MS   = 125;   // 4 Hz
const DONE_DURATION_MS  = 800;

let currentState = "idle";
let activeTimer = null;
// Pip-tool override. Set when Pip's set_rgb tool fires; agent-light
// stops painting for the rest of the turn so the color Pip chose
// survives across tool-call boundaries. Cleared on next turn boundary.
let pipRgbOverride = false;

export function notePipRgbOverride() {
  pipRgbOverride = true;
  cancelTimer();
}

export function setAgentState(next) {
  if (currentState === next) return;
  const prev = currentState;
  currentState = next;

  // A fresh turn (idle/done → thinking) revokes Pip's RGB override —
  // each turn starts with agent-light back in control.
  if ((prev === "idle" || prev === "done") && next === "thinking") {
    pipRgbOverride = false;
  }

  cancelTimer();
  applyServoForTransition(prev, next);
  applyRgbForState(next);
}

function cancelTimer() {
  if (activeTimer != null) {
    clearInterval(activeTimer);
    clearTimeout(activeTimer);
    activeTimer = null;
  }
}

function applyServoForTransition(prev, next) {
  // Only the asking transitions move the servo. Other state changes
  // leave it alone, so Pip's set_servo writes survive a tool-call boundary.
  if (next === "asking") writeServo(SERVO_ENGAGED);
  else if (prev === "asking") writeServo(SERVO_REST);
}

function applyRgbForState(s) {
  if (pipRgbOverride) return;
  switch (s) {
    case "idle": {
      writeRgb(COLOR_OFF);
      break;
    }
    case "thinking": {
      // Slow blink — dim amber to off and back. Reads as "I'm here,
      // working on it" at a human-perceptible rhythm without burning
      // the radio.
      let on = true;
      writeRgb(COLOR_AMBER_DIM);
      activeTimer = setInterval(() => {
        on = !on;
        writeRgb(on ? COLOR_AMBER_DIM : COLOR_OFF);
      }, THINKING_BLINK_MS);
      break;
    }
    case "working": {
      writeRgb(COLOR_AMBER_FULL);
      break;
    }
    case "asking": {
      // Fast pulse for attention. ask_human blocks the planner, so this
      // only runs while waiting on the user — by design.
      let on = true;
      writeRgb(COLOR_AMBER_FULL);
      activeTimer = setInterval(() => {
        on = !on;
        writeRgb(on ? COLOR_AMBER_FULL : COLOR_OFF);
      }, ASKING_PULSE_MS);
      break;
    }
    case "done": {
      writeRgb(COLOR_WHITE);
      activeTimer = setTimeout(() => {
        activeTimer = null;
        setAgentState("idle");
      }, DONE_DURATION_MS);
      break;
    }
  }
}

function connectedRobots() {
  return [...state.devices.values()].filter(e => e.status === "connected");
}

function writeRgb(hex) {
  for (const entry of connectedRobots()) {
    if (entry.rgbChar) setRgbValue(entry, hex).catch(() => {});
  }
}

function writeServo(angle) {
  for (const entry of connectedRobots()) {
    if (entry.servoChar) setLevelValue(entry, "servo", angle).catch(() => {});
  }
}
