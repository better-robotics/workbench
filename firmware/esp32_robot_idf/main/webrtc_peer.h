#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// WebRTC peer — answerer for the dashboard, exposes ota + video data
// channels. Two signaling transports:
//
//  1. BLE-signaling (Phase 2.F.1, preferred): dashboard writes the offer
//     to SIGNAL_CHAR_UUID as a chunked envelope; firmware reassembles,
//     hands to libpeer, and notifies the answer back over the same char.
//     ICE then runs P2P over LAN — no internet rendezvous.
//
//  2. wss://signal.neevs.io fallback: connected at boot, drives offers
//     into the same handle_offer path. Kept for cross-network access
//     and as a backstop while BLE-signaling is rolled out.
//
// Wire format on the SIGNAL char (both directions):
//   0x01 [u16 BE total]   begin
//   0x02 [bytes]          chunk
//   0x03                  commit
//   0xFF [utf8]           error (notify-only, robot → dashboard)
void webrtc_peer_init(const char *robot_name);

// Called by gatt_svr from the SIGNAL_CHAR_UUID write access callback.
// Reassembles chunked offer SDP and queues it for the rtc loop task.
// `from_conn` is the writer's BLE conn handle — the answer notify
// routes back to that same central so a second concurrently-connected
// browser doesn't intercept it (Phase 2.F.2 multi-conn world).
void webrtc_peer_handle_ble_signal_write(uint16_t from_conn, const uint8_t *buf, size_t len);

// True when a video stream is actively flowing. Telemetry uses this to
// pause its 10s notify cadence — every BLE notify during streaming
// competes with WiFi for radio time and induces "wifi:m f null" coex
// drops. Read-only side; cleared by stop_video_streaming or peer state
// transitions.
bool webrtc_peer_video_active(void);
