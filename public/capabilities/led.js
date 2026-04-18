// LED capability. One-byte characteristic: write 0/1 to toggle, notify on
// change. Absent from services that weren't built with an LED wired — the
// probe's try/catch is the contract, no capability flag is exchanged.
import { LED_CHAR_UUID } from "../ble.js";
import { logFor } from "../log.js";
import { state } from "../state.js";

export async function toggleLed(id) {
  const entry = state.devices.get(id);
  if (!entry || !entry.ledChar) return;
  const next = !entry.ledOn;
  try {
    await entry.ledChar.writeValueWithResponse(Uint8Array.of(next ? 1 : 0));
    entry.ledOn = next;
    renderEntry(entry);
  } catch (err) {
    logFor(entry, `LED write failed: ${err.message}`);
  }
}

// renderEntry is injected by render.js at init. Capabilities don't import
// render to keep the dependency tree acyclic.
let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

export const led = {
  name: "led",
  // Expected schema in fw-info.caps — lets the browser verify the robot
  // exposes what this module knows how to drive.
  schema: { type: "toggle" },
  initEntry: () => ({ ledChar: null, ledOn: false }),

  async probe(entry, service) {
    try {
      const ch = await service.getCharacteristic(LED_CHAR_UUID);
      entry.ledChar = ch;
      const value = await ch.readValue();
      entry.ledOn = value.getUint8(0) !== 0;
      await ch.startNotifications();
      ch.addEventListener("characteristicvaluechanged", (e) => {
        entry.ledOn = e.target.value.getUint8(0) !== 0;
        renderEntry(entry);
        logFor(entry, `LED → ${entry.ledOn ? "on" : "off"}`);
      });
    } catch {
      entry.ledChar = null;
    }
  },

  cleanup(entry) { entry.ledChar = null; },

  renderSection(entry) {
    if (entry.status !== "connected" || !entry.ledChar) return "";
    const onOff = entry.ledOn ? "on" : "off";
    const verb  = entry.ledOn ? "Turn off" : "Turn on";
    return `
      <div class="robot-controls row">
        <div>
          <div class="label">LED</div>
          <div class="meta">${onOff}</div>
        </div>
        <button class="secondary sm" data-action="toggle-led">${verb}</button>
      </div>
    `;
  },

  wireActions(entry, node) {
    const btn = node.querySelector('[data-action="toggle-led"]');
    if (btn) btn.addEventListener("click", () => toggleLed(entry.id));
  },
};
