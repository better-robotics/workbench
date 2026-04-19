// Generic typed-characteristic runtime for `signed-pair` capabilities.
// Two signed int8 values (left, right) in a declared range. Motors are the
// canonical instance; any future 2-axis input with a symmetric ± range
// (differential-drive, pan/tilt, stereo gain) uses this same runtime.
//
// Expected schema shape:
//   { name: "motors", char: "…d99", type: "signed-pair",
//     range: [-100, 100], unit?: "pct", labels?: {left: "L", right: "R"} }
//
// State lives on entry as `<name>Char`, `<name>Left`, `<name>Right`,
// `<name>Sending`, `<name>Pending`. Write path is drop-intermediate-values
// (latest-intent-wins) because sliders fire faster than BLE can process.
import { escapeHtml } from "../../dom.js";
import { log, logFor } from "../../log.js";
import { state } from "../../state.js";

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

// Generic per-cap-name writer. Voice, gamepad, and future LLM tool calls
// all route through this. clamp-on-write means callers don't have to care
// about the declared range.
export async function setPairValue(entry, capName, left, right) {
  const ch = entry[`${capName}Char`];
  if (!ch) return;
  const range = entry.capSchema?.find(s => s.name === capName)?.range || [-100, 100];
  const [mn, mx] = range;
  const clamp = (v) => Math.max(mn, Math.min(mx, Math.round(Number(v) || 0)));
  entry[`${capName}Pending`] = [clamp(left), clamp(right)];
  if (entry[`${capName}Sending`]) return;
  entry[`${capName}Sending`] = true;
  try {
    while (entry[`${capName}Pending`]) {
      const [l, r] = entry[`${capName}Pending`];
      entry[`${capName}Pending`] = null;
      try {
        await ch.writeValueWithResponse(Uint8Array.of(l & 0xff, r & 0xff));
      } catch (err) {
        logFor(entry, `${capName} write failed: ${err.message}`);
        break;
      }
    }
  } finally {
    entry[`${capName}Sending`] = false;
  }
}

export function makeSignedPairCap(schema) {
  const { name, char } = schema;
  const range = schema.range || [-100, 100];
  const labels = schema.labels || { left: "L", right: "R" };
  const charField = `${name}Char`;
  const leftField = `${name}Left`;
  const rightField = `${name}Right`;
  const actionLeft = `${name}-left`;
  const actionRight = `${name}-right`;
  const actionStop = `${name}-stop`;
  const label = name.length <= 3 ? name.toUpperCase()
    : name[0].toUpperCase() + name.slice(1);

  return {
    name,
    schema,
    initEntry: () => ({
      [charField]: null,
      [leftField]: 0, [rightField]: 0,
      [`${name}Sending`]: false, [`${name}Pending`]: null,
    }),

    async probe(entry, service) {
      try {
        entry[charField] = await service.getCharacteristic(char);
        const cur = await entry[charField].readValue();
        entry[leftField] = cur.getInt8(0);
        entry[rightField] = cur.getInt8(1);
        await entry[charField].startNotifications();
        entry[charField].addEventListener("characteristicvaluechanged", (e) => {
          const l = e.target.value.getInt8(0);
          const r = e.target.value.getInt8(1);
          if (l !== entry[leftField] || r !== entry[rightField]) {
            // Log the watchdog-cut transition specifically — it's the
            // safety behavior operators most want visible.
            if (l === 0 && r === 0 && (entry[leftField] || entry[rightField])) {
              log(`${name} stopped (watchdog)`, entry.name);
            }
            entry[leftField] = l;
            entry[rightField] = r;
            renderEntry(entry);
          }
        });
      } catch {
        entry[charField] = null;
      }
    },

    cleanup(entry) {
      entry[charField] = null;
      entry[leftField] = entry[rightField] = 0;
    },

    renderSection(entry) {
      if (entry.status !== "connected" || !entry[charField]) return "";
      return `
        <div class="robot-controls row">
          <div>
            <div class="label">${escapeHtml(label)}</div>
            <div class="meta">${escapeHtml(labels.left)}: ${entry[leftField]} · ${escapeHtml(labels.right)}: ${entry[rightField]}</div>
          </div>
          <button class="secondary sm" data-action="${actionStop}">Stop</button>
        </div>
        <div class="motor-sliders">
          <label>${escapeHtml(labels.left)} <input type="range" min="${range[0]}" max="${range[1]}" value="${entry[leftField]}" data-action="${actionLeft}"></label>
          <label>${escapeHtml(labels.right)} <input type="range" min="${range[0]}" max="${range[1]}" value="${entry[rightField]}" data-action="${actionRight}"></label>
        </div>
      `;
    },

    wireActions(entry, node) {
      const l = node.querySelector(`[data-action="${actionLeft}"]`);
      const r = node.querySelector(`[data-action="${actionRight}"]`);
      const stop = node.querySelector(`[data-action="${actionStop}"]`);
      if (l && r) {
        const onInput = () => setPairValue(entry, name, l.value, r.value);
        l.addEventListener("input", onInput);
        r.addEventListener("input", onInput);
      }
      if (stop) {
        stop.addEventListener("click", () => {
          if (l) l.value = 0;
          if (r) r.value = 0;
          setPairValue(entry, name, 0, 0);
        });
      }
    },
  };
}

// Per-id convenience — matches the old sendMotors(id, l, r) shape that
// gamepad.js calls. Kept so input drivers don't need to resolve entries
// themselves.
export async function sendPairById(id, capName, left, right) {
  const entry = state.devices.get(id);
  if (entry) await setPairValue(entry, capName, left, right);
}
