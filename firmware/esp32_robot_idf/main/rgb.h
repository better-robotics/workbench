#pragma once

#include <stdbool.h>
#include <stdint.h>

// Common-cathode RGB LED triple driven via 3 PWM channels (one per
// color, 0..255 duty). Cap is enabled only when ALL three pins are
// wired and the chip has free LEDC channels (classic ESP32 only — C3's
// 6-channel LEDC is exhausted after motors+servo).
//
// Yahboom BST-03 wiring: R/G/B → MCU GPIOs, GND → MCU GND. On-board
// resistors limit current; drive the LEDs directly from the GPIOs.
void rgb_init(int pin_r, int pin_g, int pin_b);
void rgb_apply(uint8_t r, uint8_t g, uint8_t b);
void rgb_get(uint8_t *r, uint8_t *g, uint8_t *b);
bool rgb_enabled(void);
