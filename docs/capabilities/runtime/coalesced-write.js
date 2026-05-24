// Drop-intermediate-values BLE writer shared by level / rgb /
// signed-pair caps. Web Bluetooth refuses overlapping GATT writes,
// so a stream of dashboard updates (slider drag, joypad poll) needs
// to coalesce: only the most-recently-set value survives, prior
// pending writes are discarded. Three caps had near-identical
// implementations; this is the one.
//
// State per cap lives on the entry: `${capName}Pending` (last value
// queued; null when idle) and `${capName}Sending` (re-entry guard).
// `encode(value)` returns the Uint8Array payload to ship.

import { logFor } from "../../log.js";

export async function coalescedWrite(entry, capName, value, encode) {
  const ch = entry[`${capName}Char`];
  if (!ch) return;
  entry[`${capName}Pending`] = value;
  if (entry[`${capName}Sending`]) return;
  entry[`${capName}Sending`] = true;
  try {
    while (entry[`${capName}Pending`] != null) {
      const next = entry[`${capName}Pending`];
      entry[`${capName}Pending`] = null;
      try {
        await ch.writeValueWithResponse(encode(next));
      } catch (err) {
        logFor(entry, `${capName} write failed: ${err.message}`);
        break;
      }
    }
  } finally {
    entry[`${capName}Sending`] = false;
  }
}
