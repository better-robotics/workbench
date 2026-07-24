#include <stdio.h>

#include "esp_log.h"
#include "esp_mac.h"
#include "nvs_flash.h"

#include "ble_host.h"
#include "camera.h"
#include "encoders.h"
#include "flash.h"
#include "fs_svc.h"
#include "fw_info.h"
#include "http_stream.h"
#include "led.h"
#include "motors.h"
#include "ota.h"
#include "pyvm.h"
#include "rgb.h"
#include "servo.h"
#include "ws2812.h"
#include "pin_config.h"
#include "telemetry.h"
#include "wifi_sta.h"

static const char *TAG = "esp32_robot";

// Connection-first init (CLAUDE.md), but on classic ESP32-CAM the camera
// must allocate its 32 KB DMA buffer in fresh internal heap (PSRAM isn't
// DMA-coherent on this chip). Allocation order:
//
//   1. NVS              (per-key persistence for pin / wifi / cam)
//   2. pin_config       (load runtime overrides)
//   3. Camera           (esp32-camera; fights for DRAM first, fails
//                        loudly if PSRAM is missing — fw-info hides
//                        the cap so the dashboard adapts)
//   4. LED / Flash / Motors
//   5. NimBLE host      (BLE before WiFi — controller pool fits while
//                        heap is mostly fresh; reverse order panics)
//   6. OTA              (no radio; just esp_partition lookup)
//   7. WiFi STA         (whatever's left — comes up with fewer RX
//                        buffers if needed)

void app_main(void) {
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    pin_config_t pins;
    pin_config_load(&pins);

    // Stable per-chip id — the low 16 bits of the WiFi MAC as 4 hex digits,
    // the fleet-wide `robot-<id>` convention (sprocket-robotics/hub CONTRACT.md
    // § names). Identity must not change across reflashes or paired robots in
    // localStorage break. Both the BLE name and the mDNS hostname carry it,
    // lowercase, so a workbench robot reads the same on the dashboard and on
    // the hub broker.
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    char ble_name[16];
    char hostname[32];
    snprintf(ble_name, sizeof(ble_name), "robot-%02x%02x", mac[4], mac[5]);
    snprintf(hostname, sizeof(hostname), "robot-%02x%02x", mac[4], mac[5]);
    ESP_LOGI(TAG, "robot id: ble=%s host=%s", ble_name, hostname);

    camera_probe();

    led_init(pins.led);
    flash_init(pins.flash);
    motors_init(&pins);
    encoders_init(&pins);
    servo_init(pins.servo);
    rgb_init(pins.rgb_r, pins.rgb_g, pins.rgb_b);
    ws2812_init(pins.ws2812);   // onboard addressable RGB (S3-CAM); no-op elsewhere
    // Storage: flash-only mount, no radio. Before fw_info so the "fs" cap
    // is advertised only when the partition actually mounted (boot probe).
    fs_svc_init();
    // Python VM (PSRAM boards): allocate the GC heap after PSRAM is up, before
    // fw_info so the "python" cap reflects whether the VM actually came up.
    pyvm_init();

    // fw-info reflects the cap surface; built once after caps are up.
    // Changes (camera profile, pin config) reboot, so a fresh boot
    // rebuilds it.
    fw_info_init(&pins);

    ble_host_init(ble_name);
    ota_init();
    telemetry_init();
    wifi_sta_init(hostname);
    // HTTP MJPEG (port 81) — the only camera video transport.
    http_stream_init();
}
