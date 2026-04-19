// Type → runtime-constructor map, keyed by fw-info.caps entry `type`.
import { makeToggleCap,             setRender as setToggleRender     } from "./toggle.js";
import { makeSignedPairCap,         setRender as setSignedPairRender } from "./signed-pair.js";
import { makeCommandCap,            setRender as setCommandRender    } from "./command.js";
import { makeWifiScanCap,           setRender as setWifiScanRender   } from "./wifi-scan.js";
import { makeWebrtcInstallableCap,  setRender as setWebrtcRender     } from "./webrtc-installable.js";

export const RUNTIMES = {
  "toggle":              makeToggleCap,
  "signed-pair":         makeSignedPairCap,
  "command":             makeCommandCap,
  "wifi-scan":           makeWifiScanCap,
  "webrtc-installable":  makeWebrtcInstallableCap,
};

export function setRuntimeRenderer(fn) {
  setToggleRender(fn);
  setSignedPairRender(fn);
  setCommandRender(fn);
  setWifiScanRender(fn);
  setWebrtcRender(fn);
}
