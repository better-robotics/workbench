// Pip's physical-presence channel — drives the RGB LED + servo on each
// connected robot to reflect agent state. Lifecycle-driven (assistant.js
// hooks turn.start / appendStepPill / finishStepPill / turn.end);
// Pip itself isn't exposed a tool here. Predictability over expressiveness
// — an LED that always reports what's actually happening is a trust
// mechanism, not a decoration.
//
// State vocabulary, deliberately small:
//   idle     — no turn active. LED off, servo at rest.
//   thinking — LLM call in flight, no tool yet. Amber breathe (3 s period).
//   working  — tool call executing. Amber solid.
//   asking   — ask_human tool open. Amber rapid pulse + servo turns to
//              ENGAGED (the only mechanical cue in the vocabulary, reserved
//              for "I genuinely need you").
//   done     — turn just finished. Brief white flash, auto-fades to idle
//              after DONE_DURATION ms.

import { state } from "./state.js";
import { SERVICE_UUID, RGB_CHAR_UUID, SERVO_CHAR_UUID } from "./ble.js";

// Anthropic-leaning palette: amber + white, no rainbow. Calibrated by eye
// on the Yahboom BST-03 — pure amber there reads as a deliberate orange-
// yellow rather than alarm-orange.
const AMBER = { r: 255, g: 120, b: 0 };
const WHITE = { r: 200, g: 200, b: 200 };
const OFF   = { r: 0,   g: 0,   b: 0 };

// 74° is firmware's servo rest position (servo_init); keep in lock-step.
const SERVO_REST = 74;
const SERVO_ENGAGED = 90;

const BREATHE_PERIOD_MS = 3000;
const PULSE_PERIOD_MS   = 500;
const DONE_DURATION_MS  = 800;

// RGB animates at rAF rate (~60 Hz); throttle BLE writes to ~30 Hz so
// the GATT queue doesn't back up and surface as visible jitter. The RGB
// and SERVO chars only declare F_WRITE (with response) in firmware
// gatt_svr.c — Chrome rejects writeValueWithoutResponse on a char that
// doesn't advertise WRITE_WITHOUT_RESPONSE, so we use with-response here.
// Per-write ATT round-trip is ~10–15 ms over BLE 5, well inside the
// throttle window.
const MIN_WRITE_INTERVAL_MS = 30;

let currentState = "idle";
let stateEnteredAt = 0;
let rafHandle = null;

// Pip-tool override. Set when Pip's set_rgb tool fires; agent-light pauses
// its RGB painting for the rest of the turn so the breath animation doesn't
// stomp the color Pip chose. Cleared on the next turn boundary.
let pipRgbOverride = false;
export function notePipRgbOverride() { pipRgbOverride = true; }

// Per-device char-handle cache. rebuilt lazily; cleared on write failure
// so a reconnect doesn't strand the LED on a stale handle.
const deviceCache = new Map();

export function setAgentState(next) {
  if (currentState === next) return;
  const prev = currentState;
  currentState = next;
  stateEnteredAt = performance.now();
  // A fresh turn (idle/done → thinking) revokes Pip's RGB override —
  // each turn starts with agent-light back in control.
  if ((prev === "idle" || prev === "done") && next === "thinking") {
    pipRgbOverride = false;
    // Cached "what we last wrote" goes stale across an override — clear
    // so the first animation tick of the new turn actually writes.
    for (const c of deviceCache.values()) c.lastRgb = null;
  }
  applyServoForState(next, prev);
  ensureAnimating();
}

function connectedRobots() {
  return [...state.devices.values()].filter(e => e.status === "connected");
}

function applyServoForState(s, prev) {
  // Only the asking transitions move the servo. Other state changes leave
  // it alone, so Pip's set_servo writes survive a tool-call boundary.
  if (s === "asking") {
    for (const entry of connectedRobots()) writeServo(entry, SERVO_ENGAGED);
  } else if (prev === "asking") {
    for (const entry of connectedRobots()) writeServo(entry, SERVO_REST);
  }
}

function ensureAnimating() {
  if (rafHandle != null) return;
  rafHandle = requestAnimationFrame(tick);
}

function tick(now) {
  rafHandle = null;
  const target = targetRgb(currentState, now);
  for (const entry of connectedRobots()) writeRgbThrottled(entry, target);

  if (currentState === "done" && now - stateEnteredAt >= DONE_DURATION_MS) {
    setAgentState("idle");
    return;
  }
  // Static states (idle, working) get one write and unwind the loop.
  // Re-entering a dynamic state re-arms via setAgentState → ensureAnimating.
  if (currentState === "thinking" || currentState === "asking" || currentState === "done") {
    rafHandle = requestAnimationFrame(tick);
  }
}

function targetRgb(s, now) {
  const t = now - stateEnteredAt;
  switch (s) {
    case "working":  return scale(AMBER, 0.9);
    case "thinking": return scale(AMBER, 0.2 + 0.8 * breathe(t / BREATHE_PERIOD_MS));
    case "asking":   return scale(AMBER, 0.3 + 0.7 * pulse(t / PULSE_PERIOD_MS));
    case "done":     return WHITE;
    case "idle":
    default:         return OFF;
  }
}

// Smooth, gentle 0..1. cos-based so the cycle starts at 0 and is
// symmetric around the midpoint.
function breathe(cycles) { return 0.5 - 0.5 * Math.cos(2 * Math.PI * cycles); }

// Sharper than breathe — biased to spend more time near the extremes
// so the "asking" rhythm reads as deliberate-but-urgent, not random.
function pulse(cycles) { return Math.abs(Math.sin(Math.PI * cycles)); }

function scale(c, k) {
  return { r: Math.round(c.r * k), g: Math.round(c.g * k), b: Math.round(c.b * k) };
}
function rgbEqual(a, b) { return a.r === b.r && a.g === b.g && a.b === b.b; }

async function writeRgbThrottled(entry, rgb) {
  if (pipRgbOverride) return;
  const cache = ensureCache(entry.id);
  const now = performance.now();
  if (cache.lastRgb && rgbEqual(cache.lastRgb, rgb)) return;
  if (now - cache.lastWriteTs < MIN_WRITE_INTERVAL_MS) return;
  cache.lastWriteTs = now;
  cache.lastRgb = rgb;
  try {
    const ch = await ensureChar(entry, "rgb");
    if (!ch) return;
    await ch.writeValueWithResponse(new Uint8Array([rgb.r, rgb.g, rgb.b]));
  } catch {
    // Disconnect, missing cap, GATT teardown — LED is best-effort. Clear
    // both the char handle and the last-rgb so a reconnect re-resolves
    // and re-writes instead of skipping on cached equality.
    cache.rgbChar = null;
    cache.lastRgb = null;
  }
}

async function writeServo(entry, angle) {
  const cache = ensureCache(entry.id);
  if (cache.lastServo === angle) return;
  cache.lastServo = angle;
  try {
    const ch = await ensureChar(entry, "servo");
    if (!ch) return;
    await ch.writeValueWithResponse(new Uint8Array([angle]));
  } catch {
    cache.servoChar = null;
    cache.lastServo = null;
  }
}

function ensureCache(id) {
  let c = deviceCache.get(id);
  if (!c) {
    c = { rgbChar: null, servoChar: null, lastWriteTs: 0, lastRgb: null, lastServo: null };
    deviceCache.set(id, c);
  }
  return c;
}

async function ensureChar(entry, kind) {
  const caps = entry.fwInfo?.caps;
  if (!caps?.some(c => c.name === kind)) return null;
  const cache = ensureCache(entry.id);
  const key = `${kind}Char`;
  if (cache[key]) return cache[key];
  if (!entry.device?.gatt?.connected) return null;
  const svc = await entry.device.gatt.getPrimaryService(SERVICE_UUID);
  const uuid = kind === "rgb" ? RGB_CHAR_UUID : SERVO_CHAR_UUID;
  cache[key] = await svc.getCharacteristic(uuid);
  return cache[key];
}
