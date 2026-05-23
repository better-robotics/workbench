// OTA remains hand-written because it bridges Pi bundle-OTA and ESP32
// single-file OTA. Every other capability lives under ./runtime/. Both
// share the runtime render-bus so one setter wires the whole graph.
import { ota } from "./ota.js";
import { setRuntimeRenderer } from "./runtime/index.js";

export const ALL = [ota];

export function setCapabilityRenderer(fn) {
  setRuntimeRenderer(fn);
}
