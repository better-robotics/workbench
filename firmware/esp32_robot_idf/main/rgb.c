#include "rgb.h"

#include "sdkconfig.h"
#include "driver/ledc.h"
#include "esp_log.h"

#include "gatt_svr.h"
#include "pin_config.h"

static const char *TAG = "rgb";

// Channel budget by chip:
//   Classic ESP32 — 8 LS channels (0–3 motors, 4 flash, 5 servo) and 8
//     HS channels totally unused. Put RGB on HS_0/1/2 so the cap is
//     orthogonal to everything else on the LS side.
//   ESP32-C3     — 6 LEDC channels total (no HS mode). 0–3 motors + 5
//     servo leave just channel 4. Not enough for 3 colors; cap stays
//     disabled and rgb_enabled() returns false even when pins are
//     assigned (firmware never claims the channels).
#if CONFIG_IDF_TARGET_ESP32
#  define RGB_AVAILABLE   1
#  define RGB_MODE        LEDC_HIGH_SPEED_MODE
#  define RGB_TIMER       LEDC_TIMER_0
#else
#  define RGB_AVAILABLE   0
#endif

// 1 kHz, 8-bit — same conventions as motors/flash; no perceptible
// flicker, duty 0..255 maps 1:1 onto the BLE payload bytes.
#define RGB_FREQ_HZ   1000
#define RGB_RES_BITS  LEDC_TIMER_8_BIT

#if RGB_AVAILABLE
static const ledc_channel_t s_chan[3] = {
    LEDC_CHANNEL_0, LEDC_CHANNEL_1, LEDC_CHANNEL_2,
};
#endif

static int s_pin[3] = { -1, -1, -1 };
static bool s_attached = false;
static uint8_t s_rgb[3] = { 0, 0, 0 };

void rgb_init(int pin_r, int pin_g, int pin_b) {
    s_pin[0] = pin_r;
    s_pin[1] = pin_g;
    s_pin[2] = pin_b;
    if (!pin_valid(pin_r) || !pin_valid(pin_g) || !pin_valid(pin_b)) {
        ESP_LOGI(TAG, "pins incomplete (r=%d g=%d b=%d), cap disabled",
                 pin_r, pin_g, pin_b);
        return;
    }
#if !RGB_AVAILABLE
    ESP_LOGW(TAG, "no free LEDC channels on this chip — cap disabled");
    return;
#else
    ledc_timer_config_t tcfg = {
        .speed_mode = RGB_MODE,
        .timer_num = RGB_TIMER,
        .duty_resolution = RGB_RES_BITS,
        .freq_hz = RGB_FREQ_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    if (ledc_timer_config(&tcfg) != ESP_OK) {
        ESP_LOGE(TAG, "ledc_timer_config failed");
        return;
    }
    for (int i = 0; i < 3; i++) {
        ledc_channel_config_t ch = {
            .gpio_num = s_pin[i],
            .speed_mode = RGB_MODE,
            .channel = s_chan[i],
            .timer_sel = RGB_TIMER,
            .duty = 0,
            .hpoint = 0,
        };
        if (ledc_channel_config(&ch) != ESP_OK) {
            ESP_LOGE(TAG, "ledc_channel_config failed on GPIO %d", s_pin[i]);
            return;
        }
    }
    s_attached = true;
    ESP_LOGI(TAG, "ready on GPIOs r=%d g=%d b=%d", pin_r, pin_g, pin_b);
#endif
}

void rgb_apply(uint8_t r, uint8_t g, uint8_t b) {
    s_rgb[0] = r;
    s_rgb[1] = g;
    s_rgb[2] = b;
#if RGB_AVAILABLE
    if (s_attached) {
        ledc_set_duty(RGB_MODE, s_chan[0], r);
        ledc_set_duty(RGB_MODE, s_chan[1], g);
        ledc_set_duty(RGB_MODE, s_chan[2], b);
        ledc_update_duty(RGB_MODE, s_chan[0]);
        ledc_update_duty(RGB_MODE, s_chan[1]);
        ledc_update_duty(RGB_MODE, s_chan[2]);
    }
#endif
    gatt_svr_notify_rgb();
}

void rgb_get(uint8_t *r, uint8_t *g, uint8_t *b) {
    *r = s_rgb[0]; *g = s_rgb[1]; *b = s_rgb[2];
}

bool rgb_enabled(void) { return s_attached; }
