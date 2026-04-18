// Capability registry. Adding a new capability means:
//   1. Create capabilities/{name}.js exporting the capability object
//   2. Import it here and add to ALL
//   3. (Optional) Declare matching BLE char + config key on the firmware side
// connect() iterates ALL for probing; renderEntry() iterates for sections;
// makeEntry() composes initEntry() contributions.
//
// Motors, WiFi, OTA, Camera, Gamepad, Voice are still inline in app.js for
// now — next refactor pass migrates them onto this pattern. LED is the
// reference implementation.
import { led, setRender as setLedRender } from "./led.js";

export const ALL = [led];

export function setCapabilityRenderer(fn) {
  setLedRender(fn);
}
