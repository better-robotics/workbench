import { $ } from "../dom.js";
import { state } from "../state.js";
import { openEsp32, resetEsp32 } from "./pinout-esp32.js";

let _initialized = false;
function initOnce() {
  if (_initialized) return;
  _initialized = true;
  $("pinout-close").addEventListener("click", () => $("pinout-modal").close());
  $("pinout-modal").addEventListener("close", () => resetEsp32());
}

export function openPinoutDialog(id) {
  initOnce();
  const entry = state.devices.get(id);
  if (!entry) return;
  $("pinout-title").textContent = `Pinout — ${entry.name}`;
  openEsp32(entry);
  $("pinout-modal").showModal();
}
