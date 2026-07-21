#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

// Wire protocol for the BLE ota-data char (opcodes from protocol_constants.h,
// generated from protocol/constants.json):
//   OTA_OP_ABORT                abort
//   OP_BEGIN [size:u32 BE]      begin-stream — reset, expect `size` bytes over BLE
//   OP_CHUNK [payload]          chunk — append to flash
//   OP_COMMIT                   commit — finalize + restart
//
// ota-status (READ + NOTIFY) carries: {"st":...,"n":...,"total":...,"err":...}.

void ota_init(void);
void ota_handle_data_write(const uint8_t *buf, size_t len);
const char *ota_status_json(void);

// HTTP /ota path. Drives the same underlying esp_ota_* state but skips
// the BLE chunk-paced status notifications.
esp_err_t ota_http_begin(size_t total);
esp_err_t ota_http_write(const uint8_t *buf, size_t len);
esp_err_t ota_http_commit(void);
void ota_http_abort(void);
