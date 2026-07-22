#include "telemetry.h"

#include <stdio.h>

#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "soc/soc_caps.h"

#if SOC_TEMP_SENSOR_SUPPORTED
#include "driver/temperature_sensor.h"
#endif

#include "host/ble_hs.h"

#include "ble_host.h"
#include "encoders.h"
#include "gatt_svr.h"

static const char *TAG = "telemetry";

#define TELEMETRY_BUF_SIZE   512
#define INTERVAL_US          (10ULL * 1000 * 1000)

static char s_buf[TELEMETRY_BUF_SIZE] = "{}";
static esp_timer_handle_t s_timer;
#if SOC_TEMP_SENSOR_SUPPORTED
static temperature_sensor_handle_t s_tsens = NULL;  // NULL if install failed / unsupported
#endif

const char *telemetry_json(void) { return s_buf; }

static const char *reset_reason_label(esp_reset_reason_t r) {
    switch (r) {
        case ESP_RST_POWERON:   return "poweron";
        case ESP_RST_EXT:       return "ext";
        case ESP_RST_SW:        return "sw";
        case ESP_RST_PANIC:     return "panic";
        case ESP_RST_INT_WDT:   return "int-wdt";
        case ESP_RST_TASK_WDT:  return "task-wdt";
        case ESP_RST_WDT:       return "wdt";
        case ESP_RST_DEEPSLEEP: return "deepsleep";
        case ESP_RST_BROWNOUT:  return "brownout";
        case ESP_RST_SDIO:      return "sdio";
        default:                return "unknown";
    }
}

static void on_tick(void *arg) {
    char ip[16] = {0};
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif) {
        esp_netif_ip_info_t info;
        if (esp_netif_get_ip_info(netif, &info) == ESP_OK && info.ip.addr != 0) {
            snprintf(ip, sizeof(ip), IPSTR, IP2STR(&info.ip));
        }
    }
    // free_heap_internal / min_free_heap_internal split out internal SRAM
    // from the SPIRAM-augmented total. The camera's 32 KB DMA buffer
    // allocates from internal heap only; if the chip shows 4 MB free
    // overall but internal-min has hit ~20 KB, camera_acquire() fails
    // and the total number is misleading.
    int o = snprintf(s_buf, TELEMETRY_BUF_SIZE,
        "{\"uptime_ms\":%llu,\"free_heap\":%u,\"min_free_heap\":%u,"
        "\"free_heap_internal\":%u,\"min_free_heap_internal\":%u,"
        "\"free_psram\":%u,\"reset_reason\":\"%s\",\"sha\":\"%s\"",
        esp_timer_get_time() / 1000ULL,
        (unsigned)esp_get_free_heap_size(),
        (unsigned)esp_get_minimum_free_heap_size(),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
        reset_reason_label(esp_reset_reason()),
        esp_app_get_description()->version);
    if (ip[0]) o += snprintf(s_buf + o, TELEMETRY_BUF_SIZE - o, ",\"ip\":\"%s\"", ip);
    // RSSI of the currently-bonded central. Dashboard's primary-row chip
    // surfaces a "Weak signal" warning when this dips below -75 dBm.
    uint16_t conn = ble_host_active_conn();
    int8_t rssi;
    if (conn != BLE_HS_CONN_HANDLE_NONE && ble_gap_conn_rssi(conn, &rssi) == 0) {
        o += snprintf(s_buf + o, TELEMETRY_BUF_SIZE - o, ",\"rssi_dbm\":%d", (int)rssi);
    }
    if (encoders_enabled()) {
        uint32_t l, r;
        encoders_get(&l, &r);
        o += snprintf(s_buf + o, TELEMETRY_BUF_SIZE - o,
            ",\"enc_l\":%u,\"enc_r\":%u", (unsigned)l, (unsigned)r);
    }
#if SOC_TEMP_SENSOR_SUPPORTED
    if (s_tsens) {
        float tc = 0;
        if (temperature_sensor_get_celsius(s_tsens, &tc) == ESP_OK) {
            o += snprintf(s_buf + o, TELEMETRY_BUF_SIZE - o, ",\"temp_c\":%.1f", tc);
        }
    }
#endif
    o += snprintf(s_buf + o, TELEMETRY_BUF_SIZE - o,
        ",\"tasks\":%u", (unsigned)uxTaskGetNumberOfTasks());
    snprintf(s_buf + o, TELEMETRY_BUF_SIZE - o, "}");
    gatt_svr_notify_telemetry();
}

void telemetry_init(void) {
#if SOC_TEMP_SENSOR_SUPPORTED
    // Internal chip temperature sensor (S3/C3/etc.; classic ESP32 has none the
    // driver supports). Best-effort — s_tsens stays NULL and temp is omitted
    // if install fails.
    temperature_sensor_config_t tcfg = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 110);
    if (temperature_sensor_install(&tcfg, &s_tsens) == ESP_OK) {
        temperature_sensor_enable(s_tsens);
    } else {
        s_tsens = NULL;
    }
#endif
    esp_timer_create_args_t a = { .callback = on_tick, .name = "telemetry" };
    if (esp_timer_create(&a, &s_timer) != ESP_OK) {
        ESP_LOGE(TAG, "timer create failed");
        return;
    }
    on_tick(NULL);  // populate the initial value so first BLE read isn't "{}".
    esp_timer_start_periodic(s_timer, INTERVAL_US);
}
