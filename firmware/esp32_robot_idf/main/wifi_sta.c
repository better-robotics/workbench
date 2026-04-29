#include "wifi_sta.h"

#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "nvs.h"

static const char *TAG = "wifi_sta";

static bool s_has_ip = false;

bool wifi_sta_has_ip(void) { return s_has_ip; }

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        // Mirrors Arduino-side setAutoReconnect(true) — without this the
        // firmware sits silently when an AP power-cycles or roams a client.
        s_has_ip = false;
        ESP_LOGW(TAG, "disconnected, retrying");
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *ev = (ip_event_got_ip_t *)data;
        s_has_ip = true;
        ESP_LOGI(TAG, "got ip " IPSTR, IP2STR(&ev->ip_info.ip));
    }
}

static bool load_creds(char *ssid, size_t ssid_len, char *pass, size_t pass_len) {
    nvs_handle_t h;
    if (nvs_open("wifi", NVS_READONLY, &h) != ESP_OK) return false;
    size_t sl = ssid_len, pl = pass_len;
    bool ok = nvs_get_str(h, "ssid", ssid, &sl) == ESP_OK
           && nvs_get_str(h, "pass", pass, &pl) == ESP_OK
           && sl > 0;
    nvs_close(h);
    return ok;
}

void wifi_sta_init(const char *hostname) {
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_t *sta_netif = esp_netif_create_default_wifi_sta();
    esp_netif_set_hostname(sta_netif, hostname);

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    // Persistent storage off — the .ino dropped two NVS writes per begin
    // for the same reason on a heap-tight boot.
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi_event, NULL, NULL));

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));

    char ssid[33] = {0}, pass[65] = {0};
    if (load_creds(ssid, sizeof(ssid), pass, sizeof(pass))) {
        wifi_config_t wc = {0};
        strlcpy((char *)wc.sta.ssid, ssid, sizeof(wc.sta.ssid));
        strlcpy((char *)wc.sta.password, pass, sizeof(wc.sta.password));
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
        ESP_LOGI(TAG, "joining saved network ssid=%s", ssid);
    } else {
        ESP_LOGI(TAG, "no saved creds — STA up, idle");
    }

    ESP_ERROR_CHECK(esp_wifi_start());
    // setSleep(false) equivalent — keep radio awake during BLE windows.
    esp_wifi_set_ps(WIFI_PS_NONE);
    // Drop legacy 802.11b — same airtime/retransmit reasoning as the .ino.
    esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);
}
