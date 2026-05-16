#include "encoders.h"

#include "driver/gpio.h"
#include "esp_attr.h"
#include "esp_err.h"
#include "esp_log.h"

static const char *TAG = "encoders";

static volatile uint32_t s_left_ticks  = 0;
static volatile uint32_t s_right_ticks = 0;
static int  s_pin_left  = -1;
static int  s_pin_right = -1;
static bool s_isr_service_installed = false;

// IRAM_ATTR: ISR handlers must live in IRAM so they're callable while
// flash is busy (e.g. during writes to NVS or OTA). Volatile increment
// is racy-but-fine: 32-bit aligned writes are atomic on ESP32, and the
// reader (telemetry tick) only ever sees a fully-written value, never
// a torn one. Worst case under contention: a missed tick at the moment
// of read, which a successive read picks up on the next sample.
static void IRAM_ATTR enc_isr_left(void *arg)  { s_left_ticks++; }
static void IRAM_ATTR enc_isr_right(void *arg) { s_right_ticks++; }

static bool attach(int pin, gpio_isr_t handler) {
    gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << pin,
        .mode = GPIO_MODE_INPUT,
        // pull-up matches the open-collector output common on Hall /
        // optical wheel encoders. Active-HIGH push-pull encoders also
        // work — the transition still fires the ISR. Active-LOW
        // encoders fire on the pulled-down edge.
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_NEGEDGE,
    };
    if (gpio_config(&cfg) != ESP_OK) {
        ESP_LOGE(TAG, "gpio_config failed on GPIO %d", pin);
        return false;
    }
    if (gpio_isr_handler_add(pin, handler, NULL) != ESP_OK) {
        ESP_LOGE(TAG, "isr_handler_add failed on GPIO %d", pin);
        return false;
    }
    return true;
}

void encoders_init(const pin_config_t *cfg) {
    if (!pin_valid(cfg->enc_l) && !pin_valid(cfg->enc_r)) {
        ESP_LOGI(TAG, "pins -1, cap disabled");
        return;
    }
    // gpio_install_isr_service is global per-process; safe to call once
    // here because no other module on this chip uses GPIO ISRs today
    // (motors uses LEDC, snapshot is BLE, camera is DMA). If a future
    // module needs ISRs it should share this service rather than
    // double-installing.
    if (!s_isr_service_installed) {
        esp_err_t err = gpio_install_isr_service(0);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
            ESP_LOGE(TAG, "isr_service install failed (%d)", err);
            return;
        }
        s_isr_service_installed = true;
    }
    if (pin_valid(cfg->enc_l) && attach(cfg->enc_l, enc_isr_left))  s_pin_left  = cfg->enc_l;
    if (pin_valid(cfg->enc_r) && attach(cfg->enc_r, enc_isr_right)) s_pin_right = cfg->enc_r;
    ESP_LOGI(TAG, "ready, L=%d R=%d", s_pin_left, s_pin_right);
}

bool encoders_enabled(void) {
    return s_pin_left >= 0 || s_pin_right >= 0;
}

void encoders_get(uint32_t *left, uint32_t *right) {
    if (left)  *left  = s_left_ticks;
    if (right) *right = s_right_ticks;
}
