// Capability registry. Adding a new capability means:
//   1. Create capabilities/{name}.js exporting the capability object
//   2. Import it here and add to ALL
//   3. (Optional) Declare matching BLE char + config key on the firmware side
// connect() iterates ALL for probing; renderEntry() iterates for sections +
// wireActions + postRender; makeEntry() composes initEntry() contributions.
// Hand-written capabilities. Each is its own module with bespoke UI and
// behavior. The runtime under ./runtime/ is the target to migrate these
// into — one type at a time. Migrated so far: LED (toggle), motors
// (signed-pair). Still hand-written: wifi, ota, camera, ops.
import { wifi,   setRender as setWifiRender }   from "./wifi.js";
import { ota,    setRender as setOtaRender }    from "./ota.js";
import { camera, setRender as setCameraRender } from "./camera.js";
import { ops,    setRender as setOpsRender }    from "./ops.js";
import { setRuntimeRenderer } from "./runtime/index.js";

export const ALL = [wifi, ota, camera, ops];

export function setCapabilityRenderer(fn) {
  setWifiRender(fn);
  setOtaRender(fn);
  setCameraRender(fn);
  setOpsRender(fn);
  setRuntimeRenderer(fn);
}
