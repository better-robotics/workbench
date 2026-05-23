// Schema: { name: "rgb", char: "…da7", type: "rgb", pins: {r,g,b} }
// 3-byte payload [R, G, B] (0..255 per channel), atomic write.
// Native <input type="color"> picker — one tap to a full HSL/swatch
// panel on desktop and the system color wheel on mobile. Same drop-
// intermediate-value pattern as the level slider: the picker fires many
// "input" events while the user drags through the gradient; keep only
// the latest pending color and flush after the in-flight BLE write
// resolves so we don't pile up "GATT operation already in progress".

import { UUIDS_BY_CAP } from "../../ble.js";
import { capSection } from "./cap-section.js";
import { coalescedWrite } from "./coalesced-write.js";
import { renderEntry } from "./render-bus.js";

function toHex(r, g, b) {
  const h = (n) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
function fromHex(hex) {
  // Tolerant parse: accepts "#rrggbb" or "rrggbb". Anything else → black.
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export async function setRgbValue(entry, hex) {
  await coalescedWrite(entry, "rgb", fromHex(hex), ([r, g, b]) => Uint8Array.of(r, g, b));
}

export function makeRgbCap(schema) {
  const { name } = schema;
  const char = schema.char || UUIDS_BY_CAP[name];
  const action = `rgb-${name}`;
  const label = name.length <= 3 ? name.toUpperCase()
    : name[0].toUpperCase() + name.slice(1);

  return {
    name,
    schema,
    initEntry: () => ({
      rgbChar: null,
      rgbValue: [0, 0, 0],
      rgbSending: false,
      rgbPending: null,
    }),

    async probe(entry, service) {
      try {
        const c = await service.getCharacteristic(char);
        entry.rgbChar = c;
        const v = await c.readValue();
        entry.rgbValue = [v.getUint8(0), v.getUint8(1), v.getUint8(2)];
        await c.startNotifications();
        c.addEventListener("characteristicvaluechanged", (e) => {
          const dv = e.target.value;
          entry.rgbValue = [dv.getUint8(0), dv.getUint8(1), dv.getUint8(2)];
          // Same surgical-patch pattern as the level slider — full re-
          // render would steal focus + close the color picker mid-drag.
          const sec = entry.node?.querySelector(`.cap-section[data-cap-name="${name}"]`);
          if (sec) {
            const hex = toHex(...entry.rgbValue);
            const stateEl = sec.querySelector(".cap-state");
            if (stateEl) stateEl.textContent = hex;
            const picker = sec.querySelector(`input[data-action="${action}"]`);
            if (picker && document.activeElement !== picker) picker.value = hex;
          } else {
            renderEntry(entry);
          }
        });
      } catch {
        entry.rgbChar = null;
      }
    },

    cleanup(entry) {
      entry.rgbChar = null;
      entry.rgbSending = false;
      entry.rgbPending = null;
    },

    renderSection(entry) {
      if (entry.status !== "connected" || !entry.rgbChar) return "";
      const hex = toHex(...(entry.rgbValue || [0, 0, 0]));
      return capSection({
        name,
        label,
        state: hex,
        action: `<input type="color" class="rgb-picker" data-action="${action}" value="${hex}">`,
        transport: "ble",
      });
    },

    wireActions(entry, node) {
      const picker = node.querySelector(`input[data-action="${action}"]`);
      if (!picker) return;
      picker.addEventListener("input", () => setRgbValue(entry, picker.value));
    },
  };
}
