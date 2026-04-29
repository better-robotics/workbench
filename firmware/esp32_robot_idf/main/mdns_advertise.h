#pragma once

// Publish `<hostname>._http._tcp.local` on port 81 once WiFi is up.
// Idempotent against early calls — the netif catches up on join.
// The dashboard's wifi-presence probe resolves <hostname>.local from
// localStorage, no internet rendezvous required.
void mdns_advertise_init(const char *hostname);
