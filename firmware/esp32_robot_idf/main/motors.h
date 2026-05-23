#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "pin_config.h"

// L298N H-bridge driver. PWM rides the IN pins (ENA/ENB jumpered ON).
// Each motor has two direction pins (named `forward` / `backward` in
// the dashboard schema, matching gpiozero's Motor() on the Pi side):
// forward = fwd-pin PWM, bwd-pin LOW; backward = fwd-pin LOW, bwd-pin PWM.
// signedSpeed range is [-100, 100]; magnitude > 100 clamps to 100.
//
// Safety rungs (watchdog + pulse match firmware/pi_robot/pi_robot.py;
// the stall rung is ESP32-only — Pi has no encoder path yet):
//   - Watchdog: any non-zero apply arms a 500ms one-shot. Re-armed on
//     each apply; fires if the operator stops sending updates (BLE drop,
//     dashboard tab closed, etc.).
//   - Pulse:    LLM tool calls go through motors_pulse() with a bounded
//     duration (LLM_MAX_DURATION_MS). One-shot timer auto-stops at the
//     end; a newer apply (joystick, newer pulse) wins via pulse_id check
//     inside the timer fire. Magnitude is unbounded beyond signed-byte —
//     duration + watchdog + dist_cm clip are the safety floor.
//   - Stall:    when encoders are wired, a commanded side that hasn't
//     ticked inside ~200ms is jammed. Auto-stop both sides before the
//     H-bridge cooks. No-op when encoders aren't configured.
void motors_init(const pin_config_t *cfg);

// Persistent apply (joystick). Speed in [-100, 100]. Applies the
// orientation transform (swap motors, invert each side) loaded at init
// from NVS — same shape as the Pi side's motors_orientation.
void motors_apply(int8_t left, int8_t right);

// Time-bounded pulse (LLM safety). Speed clamped, dur clamped. Goes
// through motors_apply, so orientation transform applies.
void motors_pulse(int8_t left, int8_t right, uint16_t dur_ms);

// Calibration: drive ONE motor (0=A=left-physical, 1=B=right-physical)
// for dur_ms, bypassing the orientation transform. The dashboard
// wizard uses this to discover which physical wheel motor-A drives
// and in what direction — derives swap/invert_a/invert_b from the
// answers. Speed clamped, dur clamped; auto-stops at the deadline.
void motors_pulse_raw(int motor_idx, int8_t signed_speed, uint16_t dur_ms);

// Persist orientation to NVS and schedule a restart. swap=true means
// the dashboard's "left" wheel is wired to motor B's pins.
void motors_set_orientation(bool swap, bool invert_a, bool invert_b);

void motors_get(int8_t *left, int8_t *right);
bool motors_enabled(void);

// True when motors are running in PWM-on-enable mode (ENA/ENB wired to
// MCU pins, IN1..IN4 as digital direction outputs). False for PWM-on-
// direction mode where the IN pins carry PWM. Used by rgb_init on C3
// to know whether channels 2/3 are free to claim.
bool motors_pwm_on_enable(void);
