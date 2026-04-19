// OTA remains hand-written because it bridges Pi bundle-OTA and ESP32
// single-file OTA. Every other capability lives under ./runtime/.
import { ota, setRender as setOtaRender } from "./ota.js";
import { setRuntimeRenderer } from "./runtime/index.js";

export const ALL = [ota];

export function setCapabilityRenderer(fn) {
  setOtaRender(fn);
  setRuntimeRenderer(fn);
}
