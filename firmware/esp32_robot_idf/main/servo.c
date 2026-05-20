#include "servo.h"

#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs.h"

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

// Rest position auto-save. Wherever the slider lands becomes the boot
// angle next power-cycle. Debounce protects flash: drag freely, the
// chip only commits NVS once the slider has been idle for this long.
#define REST_SAVE_DEBOUNCE_MS  1500

// 50Hz · 16384 ticks = 819200 ticks/sec → 0.8192 ticks/µs. Use integer
// math: (us * SERVO_PERIOD_TICKS * SERVO_FREQ_HZ) / 1e6 keeps everything
// in u32 land.
static uint32_t us_to_duty(uint32_t us) {
    return (us * SERVO_PERIOD_TICKS * SERVO_FREQ_HZ) / 1000000U;
}

static uint32_t angle_to_duty(uint8_t angle) {
    uint32_t us = SERVO_MIN_US + ((uint32_t)angle * (SERVO_MAX_US - SERVO_MIN_US)) / 180U;
    return us_to_duty(us);
}

static int s_pin = -1;
static bool s_attached = false;
static uint8_t s_angle = 90;   // mid-travel default until NVS or BLE write overrides
static esp_timer_handle_t s_save_timer;
static uint8_t s_last_saved = 90;   // skip redundant NVS commits

static void save_rest_to_nvs(void *arg) {
    if (s_angle == s_last_saved) return;
    nvs_handle_t h;
    if (nvs_open("servo", NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(TAG, "nvs_open failed; rest position not persisted");
        return;
    }
    if (nvs_set_u8(h, "rest", s_angle) == ESP_OK && nvs_commit(h) == ESP_OK) {
        s_last_saved = s_angle;
        ESP_LOGI(TAG, "rest angle saved: %u°", (unsigned)s_angle);
    }
    nvs_close(h);
}

void servo_init(int pin) {
    s_pin = pin;
    if (!pin_valid(pin)) {
        ESP_LOGI(TAG, "pin -1, cap disabled");
        return;
    }
    // Load persisted rest position before LEDC init so the servo's first
    // commanded duty is the user's saved angle, not a flash of mid-travel.
    nvs_handle_t h;
    if (nvs_open("servo", NVS_READONLY, &h) == ESP_OK) {
        uint8_t saved = 0;
        if (nvs_get_u8(h, "rest", &saved) == ESP_OK) {
            if (saved > 180) saved = 180;
            s_angle = saved;
            s_last_saved = saved;
        }
        nvs_close(h);
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
        .duty = angle_to_duty(s_angle),
        .hpoint = 0,
    };
    if (ledc_channel_config(&ch) != ESP_OK) {
        ESP_LOGE(TAG, "ledc_channel_config failed on GPIO %d", pin);
        return;
    }
    s_attached = true;
    esp_timer_create_args_t sargs = { .callback = save_rest_to_nvs, .name = "servo_save" };
    esp_timer_create(&sargs, &s_save_timer);
    ESP_LOGI(TAG, "ready on GPIO %d (50Hz, 0–180°), rest=%u°", pin, (unsigned)s_angle);
}

void servo_apply(uint8_t angle) {
    if (angle > 180) angle = 180;
    s_angle = angle;
    if (!s_attached) { gatt_svr_notify_servo(); return; }
    ledc_set_duty(SERVO_MODE, SERVO_CHANNEL, angle_to_duty(angle));
    ledc_update_duty(SERVO_MODE, SERVO_CHANNEL);
    // Debounced persist: restart the timer on every write so flash only
    // commits after the slider has been still for REST_SAVE_DEBOUNCE_MS.
    if (s_save_timer) {
        esp_timer_stop(s_save_timer);
        esp_timer_start_once(s_save_timer, (uint64_t)REST_SAVE_DEBOUNCE_MS * 1000);
    }
    gatt_svr_notify_servo();
}

uint8_t servo_angle(void) { return s_angle; }
bool servo_enabled(void) { return s_attached; }
