#include <stdio.h>

#include "esp_log.h"
#include "esp_mac.h"
#include "nvs_flash.h"

#include "ble_host.h"
#include "mdns_advertise.h"
#include "wifi_sta.h"

static const char *TAG = "esp32_robot";

// Init order tracks the .ino's allocation rationale (CLAUDE.md
// "connection-first init"): NVS → WiFi → BLE → mDNS. Camera + the rest
// of the capability surface come in 2.C; WebRTC peer in 2.D.
//
// On classic ESP32-CAM, BLE+WiFi+camera compete for ~250 KB DRAM. The
// .ino's ordering put camera first to give it the freshest heap; the IDF
// rebuild keeps that for 2.C. For 2.B (no camera yet) the order is just
// connectivity.

void app_main(void) {
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // Stable per-chip suffix — low 16 bits of the WiFi MAC. Same shape as
    // the .ino so paired robots in localStorage keep matching after the
    // cutover. BLE name uses the uppercase BR-XXXX form; the mDNS /
    // hostname form lowercases for `<name>.local` lookups.
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    char ble_name[16];
    char hostname[32];
    snprintf(ble_name, sizeof(ble_name), "BR-%02X%02X", mac[4], mac[5]);
    snprintf(hostname, sizeof(hostname), "br-%02x%02x", mac[4], mac[5]);
    ESP_LOGI(TAG, "robot id: ble=%s host=%s", ble_name, hostname);

    wifi_sta_init(hostname);
    ble_host_init(ble_name);
    mdns_advertise_init(hostname);
}
