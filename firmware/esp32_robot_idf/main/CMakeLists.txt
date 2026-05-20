# Component sources — keep flat for now; promote subsystems to subdirs as
# they grow past ~3 files (mirrors the public/ subsystem-promotion rule).
#
# uuids.h is generated from protocol/uuids.json by tools/gen-uuids.py.
# Firmware version comes from esp_app_get_description()->version, which
# IDF derives from `git describe --always` at build time.

# Camera, WebRTC, and snapshot are gated on the active board:
#   - esp32-camera component is conditionally required on BR_HAS_CAMERA.
#     It doesn't compile for esp32c3 (no DVP peripheral); leaving the dep
#     in for non-camera builds fails component resolution.
#   - espressif__esp_peer (vendored libpeer) is conditionally required on
#     BR_WEBRTC_ESP_PEER. libpeer's dtls_srtp.c uses mbedTLS DTLS-SRTP
#     symbols that only exist when BR_WEBRTC_ESP_PEER=y selects them, so
#     keeping the dep unconditional fails at compile time on no-WebRTC
#     builds. (Earlier comment claimed --gc-sections would handle it —
#     true for link time, irrelevant at compile time.)
#   - camera.c / snapshot.c / http_stream.c have #else stubs that take
#     over when BR_HAS_CAMERA=n, so they stay in SRCS unconditionally.
#   - webrtc_peer.c #ifdef's out to an empty TU when WebRTC is off, so it
#     stays in SRCS unconditionally too.

set(BR_SRCS
    "app_main.c"
    "wifi_sta.c"
    "ble_host.c"
    "gatt_svr.c"
    "pin_config.c"
    "led.c"
    "flash.c"
    "motors.c"
    "encoders.c"
    "servo.c"
    "rgb.c"
    "ota.c"
    "camera.c"
    "snapshot.c"
    "restart_util.c"
    "fw_info.c"
    "telemetry.c"
    "webrtc_peer.c"
    "http_stream.c"
)

set(BR_REQS
    # Connectivity
    nvs_flash
    esp_wifi
    esp_event
    esp_netif
    # BLE — NimBLE matches the Arduino-side stack
    bt
    # OTA
    app_update
    esp_https_ota
    # HTTP MJPEG streamer (port 81/stream) — comparison path for WebRTC
    esp_http_server
    # Capabilities
    driver
    esp_timer
    # JSON parsing (cJSON via ESP-IDF's json component)
    json
)

if(CONFIG_BR_HAS_CAMERA)
    list(APPEND BR_REQS esp32-camera)
endif()

# esp_peer PRIV_REQUIRES is driven by the BR_WANT_ESP_PEER env var that
# build.sh exports — same source-of-truth as the EXCLUDE_COMPONENTS in
# the project-root CMakeLists. `if(CONFIG_BR_WEBRTC_ESP_PEER)` was
# unreliable here during component-registration phase in the multi-
# overlay setup; the env var avoids the timing question entirely.
if(DEFINED ENV{BR_WANT_ESP_PEER} AND "$ENV{BR_WANT_ESP_PEER}" STREQUAL "1")
    list(APPEND BR_REQS espressif__esp_peer)
endif()

idf_component_register(
    SRCS ${BR_SRCS}
    INCLUDE_DIRS "."
    PRIV_REQUIRES ${BR_REQS}
)
