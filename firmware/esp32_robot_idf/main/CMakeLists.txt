# Component sources — keep flat for now; promote subsystems to subdirs as
# they grow past ~3 files (mirrors the public/ subsystem-promotion rule).

idf_component_register(
    SRCS
        "app_main.c"
    INCLUDE_DIRS
        "."
    PRIV_REQUIRES
        # Connectivity
        nvs_flash
        esp_wifi
        esp_event
        esp_netif
        mdns
        # BLE — NimBLE matches the Arduino-side stack
        bt
        # Camera (managed component esp32-camera)
        esp32-camera
        # WebRTC (managed component libpeer)
        libpeer
        # OTA
        app_update
        esp_https_ota
        # HTTP (existing :81 server: MJPEG, /ota, /health)
        esp_http_server
)
