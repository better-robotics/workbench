#pragma once

#include "esp_http_server.h"

// HTTP server on port 81 — presence + OTA upload during the migration.
//   GET  /health → JSON probe target for the dashboard's wifi-presence path
//   POST /ota    → firmware bin upload (PNA preflight on OPTIONS)
//
// MJPEG /stream lands in 2.C.4 with the camera; http_server_handle()
// returns the server so camera_init can register the additional URI.
void http_server_init(const char *robot_name);
httpd_handle_t http_server_handle(void);
