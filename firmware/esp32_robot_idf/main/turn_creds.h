#pragma once

#include <stdbool.h>

// Spawns a background task that waits for WiFi GOT_IP, fetches Cloudflare
// TURN credentials from proxy.neevs.io/cloudflare/turn, and caches them.
// Re-fetches if the cached creds expire (24h default TTL). Call once at
// boot after wifi_sta_init.
void turn_creds_init(void);

// Returns NULL until the first successful fetch completes (or after the
// cache expires). webrtc_peer reads these into its IceServer entries; on
// NULL, it falls back to STUN-only and the chip works on LAN-friendly
// networks but not on apartment-WiFi-shaped ones.
const char *turn_creds_username(void);
const char *turn_creds_credential(void);
