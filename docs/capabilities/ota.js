// Routes ESP32 firmware updates over BLE-stream (~30 s for 1.6 MB, works
// anywhere — ESP32 has no WebRTC signal char).
import {
  OTA_DATA_CHAR_UUID, OTA_STATUS_CHAR_UUID,
  decodeJson,
} from "../ble/ble.js";
import { OTA_OP_ABORT, OP_BEGIN, OP_CHUNK, OP_COMMIT } from "../protocol-constants.js";
import { freshUrl, escapeHtml, fetchWithTimeout } from "../dom.js";
import { logFor, log } from "../log.js";
import { state } from "../state.js";

import { renderEntry } from "./runtime/render-bus.js";

// Patch existing OTA section in place; avoids full innerHTML rewrite on
// every progress tick (which would destroy hovered elements and flicker).
// Falls back to full re-render if the section isn't in the DOM yet.
//
// Two progress signals: entry.otaSent (per-chunk, accurate) and
// entry.otaStatus.n (firmware notify, throttled every 32 KB / 250 ms).
// Math.max — sent leads during active uploads; firmware wins on
// post-refresh reconnect when sent is back to 0. Label upgrades to
// "committing" client-side once we've sent everything but firmware hasn't
// notified "done" yet, so the bar doesn't sit at "100% receiving" during
// the install round-trip.
function patchOtaSection(entry) {
  const section = entry.node?.querySelector(".ota-section");
  if (!section) { renderEntry(entry); return; }
  const { st, n: confirmed = 0, total = 0, err, heap } = entry.otaStatus || {};
  const sent = entry.otaSent || 0;
  const display = Math.max(sent, confirmed);
  const pct = total ? Math.round(100 * display / total) : 0;
  const looksDone = total && sent >= total;
  const label = looksDone && (st === "receiving" || !st) ? "committing" : (st || "idle");
  // heap surfaces ESP32 free-heap during OTA — diagnostic for the
  // 98%-commit-failed pattern (heap pressure during sustained BLE RX).
  const heapStr = heap != null ? ` · ${Math.round(heap / 1024)} KB heap` : "";
  const meta = section.querySelector(".meta");
  if (meta) meta.textContent = err ? `${st} — ${err}${heapStr}` : total ? `${label} · ${pct}%${heapStr}` : `${label}${heapStr}`;
  const progress = section.querySelector(".ota-progress");
  if (progress && total) { progress.value = display; progress.max = total; }
  // Mirror into the active-ops chip on the identity row so the top-level
  // "OTA receiving N%" stays in sync. Without this the chip stayed
  // frozen at 0% (only renderEntry rebuilds chips; the upload path
  // patches the section, not the chip).
  const chip = entry.node?.querySelector('.op-chip[data-op="ota"]');
  if (chip) chip.textContent = total ? `OTA ${label} ${pct}%` : `OTA ${label}`;
}

// macOS putting the display to sleep throttles the BLE write loop enough to
// stall a 10-minute stream; hold a wake lock for the duration of the OTA.
let wakeLock = null;
async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); }
  catch { wakeLock = null; }
}
async function releaseWakeLock() {
  if (wakeLock) { try { await wakeLock.release(); } catch {} wakeLock = null; }
}

// Coalesce per-chunk patchOtaSection calls to one paint per frame. A 1.6 MB
// OTA fires ~9000 chunks; without throttling that's ~9000 querySelector +
// DOM-write tuples for an animation that the screen can't show faster than
// ~60 fps anyway. RAF caps us at ~60 paints/sec naturally and drops the rest.
let _otaPendingPatch = false;
function patchOtaSectionThrottled(entry) {
  if (_otaPendingPatch) return;
  _otaPendingPatch = true;
  requestAnimationFrame(() => {
    _otaPendingPatch = false;
    patchOtaSection(entry);
  });
}

async function streamOtaBytes(entry, bytes) {
  const ch = entry.otaDataChar;
  // All chunks WithResponse. Each chunk's ATT_WRITE_RSP flows behind the
  // chip's onWrite callback returning, so back-pressure is implicit.
  // WithoutResponse breaks bootstrap: pre-flow-control firmware can't
  // signal back-pressure, and Chrome's macOS BLE stack throws "GATT
  // operation failed" under sustained blast.
  //
  // CHUNK 244 fits the negotiated ATT MTU (CONFIG_BT_NIMBLE_ATT_PREFERRED_MTU
  // = 256 → max payload 253; frame is chunk + 1-byte opcode).
  entry.otaSent = 0;
  patchOtaSection(entry);
  try { await ch.writeValueWithResponse(new Uint8Array([OTA_OP_ABORT])); } catch {}
  const begin = new Uint8Array(5);
  begin[0] = OP_BEGIN;
  new DataView(begin.buffer).setUint32(1, bytes.length, false);
  await ch.writeValueWithResponse(begin);
  const CHUNK = 244;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    const frame = new Uint8Array(slice.length + 1);
    frame[0] = OP_CHUNK;
    frame.set(slice, 1);
    await ch.writeValueWithResponse(frame);
    entry.otaSent = i + slice.length;
    patchOtaSectionThrottled(entry);
  }
  await ch.writeValueWithResponse(new Uint8Array([OP_COMMIT]));
  entry.otaSent = bytes.length;
  patchOtaSection(entry);
}

export async function updateFirmware(id) {
  const entry = state.devices.get(id);
  if (!entry || !entry.otaDataChar) {
    log("Update not supported by this firmware");
    return;
  }

  // ESP32 single-binary OTA — fw-info carries the bin's URL.
  const fetchUrl = entry.fwInfo?.url;
  if (!fetchUrl) {
    logFor(entry, "no firmware source (fw-info missing url)");
    return;
  }
  logFor(entry, `fetching ${fetchUrl}…`);
  let bytes;
  try {
    // 60s — firmware bundle can be a few MB on slow connections.
    const resp = await fetchWithTimeout(freshUrl(fetchUrl), { cache: "no-cache" }, 60000);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    bytes = new Uint8Array(await resp.arrayBuffer());
  } catch (err) {
    logFor(entry, `fetch failed: ${err.message}`);
    return;
  }
  await acquireWakeLock();
  try {
    // ESP32 has no WebRTC signal char — BLE-stream is the only transport.
    logFor(entry, `OTA streaming over BLE (~30s for ~1.6 MB)…`);
    try {
      await streamOtaBytes(entry, bytes);
      logFor(entry, "OTA commit sent — click Reconnect when the robot's back");
    } catch (err) {
      logFor(entry, `OTA failed: ${err.message}`);
    }
  } finally {
    await releaseWakeLock();
  }
}

export async function updateFromFile(id) {
  const entry = state.devices.get(id);
  if (!entry || !entry.otaDataChar) {
    log("Update not supported by this firmware");
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".py,.bin";
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Local file — always BLE-stream. data:/blob: URLs aren't reachable from the ESP32.
    logFor(entry, `OTA streaming ${file.name} (${bytes.length} B)…`);
    await acquireWakeLock();
    try {
      await streamOtaBytes(entry, bytes);
      logFor(entry, "OTA commit sent — click Reconnect when the robot's back");
    } catch (err) {
      logFor(entry, `OTA failed: ${err.message}`);
    } finally {
      await releaseWakeLock();
    }
  });
  input.click();
}

export const ota = {
  name: "ota",
  schema: { type: "bundle-ota" },
  initEntry: () => ({
    otaDataChar: null, otaStatusChar: null,
    otaStatus: { st: "idle" }, fwInfo: null,
  }),

  async probe(entry, service) {
    try {
      entry.otaDataChar   = await service.getCharacteristic(OTA_DATA_CHAR_UUID);
      entry.otaStatusChar = await service.getCharacteristic(OTA_STATUS_CHAR_UUID);
      // fw-info is read once in app.js connect() before any capability probe.
      const initial = decodeJson(await entry.otaStatusChar.readValue()) || { st: "idle" };
      entry.otaStatus = initial;
      // Orphaned-state cleanup: if the firmware reports an in-progress upload
      // (receiving / committing) but this dashboard session didn't initiate
      // one, that's a tombstone from a previous session that got interrupted
      // (refresh during OTA, BLE drop mid-stream, etc.). Send the abort
      // opcode so the firmware drops its half-buffer and the next intentional
      // OTA starts clean — and the user doesn't see a misleading "receiving
      // 1%" frozen on the card forever.
      if (initial.st === "receiving" || initial.st === "committing") {
        try {
          await entry.otaDataChar.writeValueWithResponse(new Uint8Array([OTA_OP_ABORT]));
          entry.otaStatus = { st: "idle" };
          logFor(entry, `cleared orphaned OTA state (was ${initial.st} ${initial.n || 0}/${initial.total || 0} B)`);
        } catch { /* if write fails, fall back to displaying the orphaned state — still better than freezing */ }
      }
      await entry.otaStatusChar.startNotifications();
      entry.otaStatusChar.addEventListener("characteristicvaluechanged", (e) => {
        const prevSt = entry.otaStatus?.st || "idle";
        entry.otaStatus = decodeJson(e.target.value) || { st: "idle" };
        const { st, err: errMsg } = entry.otaStatus;
        // Log only terminal transitions (error / done / back-to-idle) — every
        // percent-tick would spam the log pane.
        if (errMsg) logFor(entry, `OTA ${st} — ${errMsg}`);
        else if (st === "done" || st === "idle") logFor(entry, `OTA ${st}`);
        // Section appears/disappears on the idle↔active boundary, so a full
        // re-render is needed there. Progress within the same active window
        // patches the existing DOM so hovered elements don't flicker.
        const wasActive = prevSt !== "idle";
        const nowActive = st !== "idle";
        if (wasActive !== nowActive) renderEntry(entry);
        else if (nowActive) patchOtaSection(entry);
      });
    } catch {
      entry.otaDataChar = null;
    }
  },

  cleanup(entry) {
    entry.otaDataChar = entry.otaStatusChar = null;
    entry.fwInfo = null;
  },

  // OTA controls live in the ⋯ menu; the section only appears while an update
  // is actually in flight so the card shows progress without claiming permanent
  // screen real estate.
  renderSection(entry) {
    const s = entry?.otaStatus;
    if (!s || s.st === "idle") return "";
    const { st, n = 0, total = 0, err, heap } = s;
    const pct = total ? Math.round(100 * n / total) : 0;
    const heapStr = heap != null ? ` · ${Math.round(heap / 1024)} KB heap` : "";
    const stateLine = err
      ? `${escapeHtml(st)} — ${escapeHtml(err)}${heapStr}`
      : total ? `${escapeHtml(st)} · ${pct}%${heapStr}`
      : `${escapeHtml(st)}${heapStr}`;
    // `.ota-section` marker lets the progress handler patch this in place
    // instead of rebuilding the whole card's innerHTML on every OTA notify.
    return `
      <div class="robot-controls ota-section">
        <div class="row">
          <div><div class="label">Firmware</div><div class="meta" aria-live="polite">${stateLine}</div></div>
        </div>
        ${total ? `<progress class="ota-progress" value="${n}" max="${total}"></progress>` : ""}
      </div>
    `;
  },
  wireActions() {},
};
