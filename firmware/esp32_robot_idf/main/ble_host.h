#pragma once

// Bring up NimBLE host stack and start advertising under `name` with the
// project's SERVICE_UUID. No characteristics yet — Phase 2.C wires those.
// Restarting advertising on disconnect is handled internally so the device
// is rediscoverable after each desktop session ends.
void ble_host_init(const char *name);
