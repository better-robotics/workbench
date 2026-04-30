#include "mdns_advertise.h"

#include "esp_log.h"
#include "mdns.h"

static const char *TAG = "mdns";

void mdns_advertise_init(const char *hostname) {
    ESP_ERROR_CHECK(mdns_init());
    ESP_ERROR_CHECK(mdns_hostname_set(hostname));
    // Phase 2.H: HTTP server retired. mDNS still publishes the hostname
    // so dashboards can resolve `<name>.local` — useful as a "this robot
    // is on this LAN" hint and as a STUN-less host candidate for
    // WebRTC ICE. No service record advertised; the chip exposes nothing
    // on TCP anymore.
    ESP_LOGI(TAG, "%s.local advertised (no service)", hostname);
}
