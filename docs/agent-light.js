// Pip's physical-presence channel — drives the RGB LED + servo on each
// connected robot to reflect agent state. Lifecycle-driven (assistant.js
// hooks turn.start / appendStepPill / finishStepPill / turn.end);
// Pip itself has set_rgb / set_servo tools for intentional cues.
//
// Envelope shapes are grounded in Baraka, Paiva & Veloso (CMU 2015),
// "Expressive Lights for Revealing Mobile Service Robot State":
//   - Hard square-wave blinks read as fault/alarm. Avoid for in-progress
//     states.
//   - Triangular fade ("Siren" envelope) at ~2 s period reads as
//     "deliberate, in progress." Used here for `thinking`.
//   - Asymmetric attack-decay ("Push" envelope, ~300 ms attack /
//     1.5 s total) reads as attention-demanding without alarm. Used here
//     for `asking`, paired with the servo gaze cue.
//
// Writes go through setRgbValue / setLevelValue — those already coalesce
// in-flight writes (rgbPending / rgbSending), so our 5 Hz tick rate
// won't pile up the GATT queue. Total per turn is ~10–30 BLE writes.
//
// State vocabulary, deliberately small:
//   idle     — off, servo at rest.
//   thinking — triangular fade between off and PEAK_AMBER, 2 s period.
//   working  — PEAK_AMBER solid (one write at entry).
//   asking   — "Push" envelope on PEAK_AMBER + servo at ENGAGED.
//   done     — PEAK_WHITE, linear fade to off over 600 ms → idle.

import { state } from "./state.js";
import { setRgbValue } from "./capabilities/runtime/rgb.js";
import { setLevelValue } from "./capabilities/runtime/level.js";

// Peak colors at full saturation. The Yahboom BST-03 is physically dim
// (indicator-class, not illumination); keeping peaks at max preserves
// the contrast budget. Gamma-correcting toward CIE 1931 would compress
// mid-range and reduce drama — the opposite of what we want here.
const PEAK_AMBER = { r: 255, g: 170, b: 0 };
const PEAK_WHITE = { r: 255, g: 255, b: 255 };
const OFF        = { r: 0,   g: 0,   b: 0   };

// 74° = firmware servo rest; ENGAGED is "looking forward / asking."
const SERVO_REST    = 74;
const SERVO_ENGAGED = 90;

// 5 Hz tick. Smooth enough for visible fades (10 samples per 2 s cycle);
// well within ~30 ms ATT round-trip × in-flight coalescing budget.
const TICK_MS = 200;

const THINKING_PERIOD_MS = 2000;  // "Siren" full cycle
const ASKING_ATTACK_MS   = 300;   // "Push" fast rise
const ASKING_TOTAL_MS    = 1500;  // "Push" total cycle
const DONE_FADE_MS       = 600;

let currentState = "idle";
let stateEnteredAt = 0;
let activeTimer = null;
let pipRgbOverride = false;

export function notePipRgbOverride() {
  pipRgbOverride = true;
  cancelTimer();
}

export function setAgentState(next) {
  if (currentState === next) return;
  const prev = currentState;
  currentState = next;
  stateEnteredAt = performance.now();

  // Fresh turn (idle/done → thinking) revokes Pip's RGB override —
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
  if (next === "asking") writeServo(SERVO_ENGAGED);
  else if (prev === "asking") writeServo(SERVO_REST);
}

function applyRgbForState(s) {
  if (pipRgbOverride) return;
  switch (s) {
    case "idle":
      writeRgb(OFF);
      break;
    case "thinking":
      writeRgb(siren(0));
      activeTimer = setInterval(() => writeRgb(siren(elapsed())), TICK_MS);
      break;
    case "working":
      writeRgb(PEAK_AMBER);
      break;
    case "asking":
      writeRgb(push(0));
      activeTimer = setInterval(() => writeRgb(push(elapsed())), TICK_MS);
      break;
    case "done":
      writeRgb(PEAK_WHITE);
      activeTimer = setInterval(() => {
        const t = elapsed();
        if (t >= DONE_FADE_MS) { setAgentState("idle"); return; }
        writeRgb(scale(PEAK_WHITE, 1 - t / DONE_FADE_MS));
      }, TICK_MS);
      break;
  }
}

function elapsed() { return performance.now() - stateEnteredAt; }

// "Siren" envelope: smooth 0 → peak → 0 triangular wave.
function siren(t) {
  const phase = (t % THINKING_PERIOD_MS) / THINKING_PERIOD_MS;
  const k = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  return scale(PEAK_AMBER, k);
}

// "Push" envelope: fast linear rise to peak (ASKING_ATTACK_MS), then
// slow linear decay back to 0 across the remainder. Asymmetric — reads
// as a heartbeat / urgent-but-deliberate rhythm.
function push(t) {
  const phase = t % ASKING_TOTAL_MS;
  const k = phase < ASKING_ATTACK_MS
    ? phase / ASKING_ATTACK_MS
    : 1 - (phase - ASKING_ATTACK_MS) / (ASKING_TOTAL_MS - ASKING_ATTACK_MS);
  return scale(PEAK_AMBER, k);
}

function scale(c, k) {
  return {
    r: Math.round(c.r * k),
    g: Math.round(c.g * k),
    b: Math.round(c.b * k),
  };
}

function rgbToHex(c) {
  const h = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function connectedRobots() {
  return [...state.devices.values()].filter(e => e.status === "connected");
}

function writeRgb(c) {
  for (const entry of connectedRobots()) {
    if (entry.rgbChar) setRgbValue(entry, rgbToHex(c)).catch(() => {});
  }
}

function writeServo(angle) {
  for (const entry of connectedRobots()) {
    if (entry.servoChar) setLevelValue(entry, "servo", angle).catch(() => {});
  }
}
