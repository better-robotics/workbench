#include "servo.h"

#include "driver/ledc.h"
#include "esp_log.h"

#include "gatt_svr.h"
#include "pin_config.h"

static const char *TAG = "servo";

// Own LEDC timer + channel — motors/flash share timer 0 at 1 kHz / 8-bit,
// which is wrong for servos (need 50 Hz / ~14-bit for sub-µs pulse-width
// resolution). Timer 1 + channel 5 keep us out of their way.
#define SERVO_TIMER       LEDC_TIMER_1
#define SERVO_CHANNEL     LEDC_CHANNEL_5
#define SERVO_MODE        LEDC_LOW_SPEED_MODE
#define SERVO_FREQ_HZ     50
#define SERVO_RES_BITS    LEDC_TIMER_14_BIT   // 16384 ticks / 20ms ≈ 1.22µs/tick

// Period = 20 ms = 1/50 Hz. With 14-bit res, period = 16384 ticks.
// Standard SG90 pulse-width range: 500µs (0°) to 2500µs (180°). Some
// SG90 clones bottom out at 1000µs; 500 is safer than risking a buzz
// at the low end on stock SG90s.
#define SERVO_PERIOD_TICKS   16384
#define SERVO_MIN_US         500
#define SERVO_MAX_US         2500
// 50Hz · 16384 ticks = 819200 ticks/sec → 0.8192 ticks/µs. Use integer
// math: (us * SERVO_PERIOD_TICKS * SERVO_FREQ_HZ) / 1e6 keeps everything
// in u32 land.
static uint32_t us_to_duty(uint32_t us) {
    return (us * SERVO_PERIOD_TICKS * SERVO_FREQ_HZ) / 1000000U;
}

static int s_pin = -1;
static bool s_attached = false;
static uint8_t s_angle = 90;   // mid-travel default; matches typical servo rest pose

void servo_init(int pin) {
    s_pin = pin;
    if (!pin_valid(pin)) {
        ESP_LOGI(TAG, "pin -1, cap disabled");
        return;
    }
    ledc_timer_config_t tcfg = {
        .speed_mode = SERVO_MODE,
        .timer_num = SERVO_TIMER,
        .duty_resolution = SERVO_RES_BITS,
        .freq_hz = SERVO_FREQ_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    if (ledc_timer_config(&tcfg) != ESP_OK) {
        ESP_LOGE(TAG, "ledc_timer_config failed");
        return;
    }
    ledc_channel_config_t ch = {
        .gpio_num = pin,
        .speed_mode = SERVO_MODE,
        .channel = SERVO_CHANNEL,
        .timer_sel = SERVO_TIMER,
        .duty = us_to_duty(SERVO_MIN_US + (SERVO_MAX_US - SERVO_MIN_US) / 2),
        .hpoint = 0,
    };
    if (ledc_channel_config(&ch) != ESP_OK) {
        ESP_LOGE(TAG, "ledc_channel_config failed on GPIO %d", pin);
        return;
    }
    s_attached = true;
    ESP_LOGI(TAG, "ready on GPIO %d (50Hz, 0–180°)", pin);
}

void servo_apply(uint8_t angle) {
    if (angle > 180) angle = 180;
    s_angle = angle;
    if (!s_attached) { gatt_svr_notify_servo(); return; }
    uint32_t us = SERVO_MIN_US + ((uint32_t)angle * (SERVO_MAX_US - SERVO_MIN_US)) / 180U;
    uint32_t duty = us_to_duty(us);
    ledc_set_duty(SERVO_MODE, SERVO_CHANNEL, duty);
    ledc_update_duty(SERVO_MODE, SERVO_CHANNEL);
    gatt_svr_notify_servo();
}

uint8_t servo_angle(void) { return s_angle; }
bool servo_enabled(void) { return s_attached; }
