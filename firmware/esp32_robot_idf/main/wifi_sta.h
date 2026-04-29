#pragma once

#include <stdbool.h>

// Bring up WiFi STA. Sets hostname, attaches a reconnect handler, and
// kicks off a join attempt with whatever creds live in the "wifi" NVS
// namespace. No-op if no creds saved — caller can drive a join later.
//
// `hostname` and `chip_suffix` come from the chip MAC. `chip_suffix` is
// the lowercase 4-hex used for `<hostname>.local` consistency with the
// dashboard's wifi-presence probe.
void wifi_sta_init(const char *hostname);

// True once we've seen STA_GOT_IP at least once. The /ota and presence
// paths gate on this so they don't fire before LWIP has an address.
bool wifi_sta_has_ip(void);
