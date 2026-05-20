#pragma once

#include <stdbool.h>
#include <stdint.h>

// SG90-class hobby servo on a single signal pin. 50 Hz PWM, 500–2500 µs
// pulse width maps to 0–180°. pin = -1 disables the cap.
//
// No watchdog: hobby servos hold the last commanded position under
// silence (the H-bridge motor watchdog exists because PWM-driven motors
// run away on stuck-throttle, not because the actuator can't hold a
// safe default — servos already do that).
void servo_init(int pin);
void servo_apply(uint8_t angle);   // clamped to [0, 180]
uint8_t servo_angle(void);
bool servo_enabled(void);
