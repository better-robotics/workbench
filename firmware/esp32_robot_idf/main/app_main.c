/**
 * esp32_robot — ESP-IDF entry point.
 *
 * Migration scaffold; init order placeholders only. Each subsystem moves
 * over from firmware/esp32_robot/esp32_robot.ino in its own commit. Until
 * the migration completes, the Arduino .ino stays the shipping firmware.
 *
 * Init order (matches CLAUDE.md "connection-first init"):
 *   1. NVS                (Preferences-equivalent for pin config, fw version)
 *   2. WiFi STA           (top of setup so DMA buffers pre-allocate in
 *                          fresh internal heap; camera fights for what's
 *                          left and fails loudly via camera_err if PSRAM
 *                          is missing or constrained)
 *   3. NimBLE             (control plane; comes up before motors/LED so a
 *                          dead camera leaves the robot still drivable)
 *   4. Motors / LED / Flash  (capability surface — gated on pin config)
 *   5. Camera             (esp32-camera; reports camera_err in fw-info if
 *                          init fails so dashboard hides the cap)
 *   6. HTTP server :81    (MJPEG + /health + /ota — kept for compatibility
 *                          with existing dashboard probes during migration)
 *   7. WebRTC peer        (libpeer; signaling via wss://signal.neevs.io/
 *                          esp32-rtc-<robotId>/ws — symmetric with the Pi
 *                          side's pi-rtc-<robotId> rooms)
 */

#include "esp_log.h"
#include "nvs_flash.h"

static const char *TAG = "esp32_robot";

void app_main(void) {
    ESP_LOGI(TAG, "esp32_robot ESP-IDF migration scaffold — see README.md");

    // NVS first — Preferences-equivalent. Pin config + fw stamp + WiFi
    // credentials all persist here.
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // TODO migrate from .ino:
    //   wifi_init_sta();             // ~lines 200-340 of .ino
    //   ble_server_start();          // NimBLE service + characteristics
    //   pinconfig_load();            // Preferences → motor/LED/flash pins
    //   motors_init();
    //   led_init(); flash_init();
    //   camera_init();               // initCamera() in .ino, ~line 355
    //   http_server_start();         // :81 MJPEG + /ota + /health
    //   webrtc_peer_start();         // libpeer — NEW in this migration
}
