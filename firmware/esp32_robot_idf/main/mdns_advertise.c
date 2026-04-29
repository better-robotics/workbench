#include "mdns_advertise.h"

#include "esp_log.h"
#include "mdns.h"

static const char *TAG = "mdns";

void mdns_advertise_init(const char *hostname) {
    ESP_ERROR_CHECK(mdns_init());
    ESP_ERROR_CHECK(mdns_hostname_set(hostname));
    // Match the .ino: HTTP server on port 81 (MJPEG + /health + /ota).
    ESP_ERROR_CHECK(mdns_service_add(NULL, "_http", "_tcp", 81, NULL, 0));
    ESP_LOGI(TAG, "%s.local advertised on :81", hostname);
}
