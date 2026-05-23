import { $ } from "../dom.js";
import { state } from "../state.js";
import { openPi, resetPi } from "./pinout-pi.js";
import { openEsp32, resetEsp32 } from "./pinout-esp32.js";

let _initialized = false;
function initOnce() {
  if (_initialized) return;
  _initialized = true;
  $("pinout-close").addEventListener("click", () => $("pinout-modal").close());
  // Close handler fires for any reason the dialog closes (×, Escape,
  // .close()) — reset both paths since either could have opened it.
  $("pinout-modal").addEventListener("close", () => {
    resetPi();
    resetEsp32();
  });
}

export function openPinoutDialog(id) {
  initOnce();
  const entry = state.devices.get(id);
  if (!entry) return;
  $("pinout-title").textContent = `Pinout — ${entry.name}`;
  if (entry.fwType === "esp32") {
    openEsp32(entry);
  } else {
    openPi(entry);
  }
  $("pinout-modal").showModal();
}
