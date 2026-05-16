#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "pin_config.h"

// Single-OUT wheel-speed encoders. Each side is a GPIO input with a
// pull-up + edge-triggered ISR that bumps a monotonic tick counter.
// Cumulative counts surface through telemetry; the dashboard derives
// speed/distance from successive deltas. No new BLE characteristic.
//
// Pin pressure note: the ESP32-CAM exposes only ~8 user-assignable
// GPIOs, most of which are SD- or PSRAM-shared. Encoders default to
// disabled (-1) — the dashboard pin map is the place where the user
// picks free pins for their specific board variant.
void encoders_init(const pin_config_t *cfg);
bool encoders_enabled(void);

// Atomic 32-bit reads (ESP32 word-aligned). Pass NULL for either side
// you don't care about.
void encoders_get(uint32_t *left, uint32_t *right);
