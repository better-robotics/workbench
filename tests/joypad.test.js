// Tests for the differential-mix function in docs/joypad.js.
// Regression coverage for the "throttle flickering across zero produces
// non-deterministic turn direction" bug — small Y-noise on the pad center
// combined with the sign-flip-on-reverse made pure-left/right turns
// inconsistent (sometimes correct direction, sometimes opposite).

import { test } from "node:test";
import assert from "node:assert";
import { mix } from "../docs/joypad.js";

test("mix: pure forward → both wheels equal positive", () => {
  const [l, r] = mix(80, 0);
  assert.equal(l, 80);
  assert.equal(r, 80);
});

test("mix: pure reverse → both wheels equal negative", () => {
  const [l, r] = mix(-80, 0);
  assert.equal(l, -80);
  assert.equal(r, -80);
});

test("mix: pure-left stick (turn=-100, throttle=0) spins left", () => {
  // L motor backward, R motor forward → robot rotates CCW (left).
  const [l, r] = mix(0, -100);
  assert.equal(l, -100);
  assert.equal(r, 100);
});

test("mix: pure-right stick (turn=+100, throttle=0) spins right", () => {
  const [l, r] = mix(0, 100);
  assert.equal(l, 100);
  assert.equal(r, -100);
});

test("mix: tiny positive throttle noise during pure-left does NOT flip", () => {
  // Pre-deadband, throttle=+5 + turn=-100 produced L=-95, R=+105→100 (left).
  // Post-deadband, throttle snaps to 0 → L=-100, R=+100. Direction preserved.
  const [l, r] = mix(5, -100);
  assert.equal(l, -100);
  assert.equal(r, 100);
});

test("mix: tiny negative throttle noise during pure-left does NOT flip", () => {
  // The bug: throttle=-5 + turn=-100 with the sign-flip → turn becomes +100,
  // L = -5 + 100 = 95, R = -5 - 100 = -105 → -100. Robot spins RIGHT despite
  // operator pushing left. Deadband zeroes throttle and skips the flip.
  const [l, r] = mix(-5, -100);
  assert.equal(l, -100);
  assert.equal(r, 100);
});

test("mix: tiny negative throttle noise during pure-right does NOT flip", () => {
  const [l, r] = mix(-5, 100);
  assert.equal(l, 100);
  assert.equal(r, -100);
});

test("mix: genuine reverse still flips turn (operator-perspective)", () => {
  // Stick pushed bottom-right (throttle=-50, turn=+50): without flip the
  // robot's front would swing LEFT, disorienting. With flip, the front
  // swings to operator's right as expected.
  // throttle=-50 ⇒ |throttle| > deadband ⇒ flip ⇒ turn=-50
  // L = -50 + -50 = -100,  R = -50 - -50 = 0
  const [l, r] = mix(-50, 50);
  assert.equal(l, -100);
  assert.equal(r, 0);
});

test("mix: genuine reverse-left flips correctly", () => {
  // throttle=-50, turn=-50 ⇒ flip ⇒ turn=+50
  // L = -50 + 50 = 0,  R = -50 - 50 = -100
  const [l, r] = mix(-50, -50);
  assert.equal(l, 0);
  assert.equal(r, -100);
});

test("mix: deadband boundary — inside zeroed, outside flips", () => {
  // Just below the 10% deadband — throttle snaps to 0, no flip.
  const [lA, rA] = mix(-9, -100);
  assert.equal(lA, -100);
  assert.equal(rA, 100);
  // At exactly the deadband threshold, flip kicks in (genuine reverse).
  // throttle=-10 ⇒ turn=+100 ⇒ L = -10+100 = 90, R = -10-100 = -110 → -100
  const [lB, rB] = mix(-10, -100);
  assert.equal(lB, 90);
  assert.equal(rB, -100);
});

test("mix: clamps overflow back to ±100", () => {
  const [l, r] = mix(100, 100);
  assert.equal(l, 100);   // 100 + 100 = 200, clamped
  assert.equal(r, 0);     // 100 - 100 = 0
});

test("mix: rounds fractional inputs", () => {
  const [l, r] = mix(40.4, 19.6);
  assert.equal(l, 60);
  assert.equal(r, 21);
});
