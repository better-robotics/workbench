// Browser-side ESP32 flasher using esptool-js + Web Serial.
//
// Replaces the local-CLI flow (`make setup` → `idf.py flash` /
// `esptool.py write_flash`). The dashboard fetches the per-board bins it
// publishes for OTA, then esptool-js streams them to the chip over a
// Web Serial port the operator picks from the browser chooser. No
// driver install on macOS/Linux; Windows still needs the usual CP210x
// or CH340 USB-serial driver.
//
// Same browser constraint as the rest of the recovery UI — Chrome /
// Edge with Web Serial. esptool-js is dynamic-imported on first use so
// the ~250 KB module only downloads when actually flashing.
//
// UI host is the caller's problem. flashFirmware takes callbacks
// (onLog for human-facing status, onProgress for the bar, pickBoard
// for the variant choice).

let _esptoolModule = null;

async function ensureEsptoolLoaded() {
  if (_esptoolModule) return _esptoolModule;
  // Pin to an EXACT version — `@0.5` floats across patch releases, and the
  // reset method names drift between them (which is why resetChip stopped
  // trusting library reset methods and drives the reset line itself). 0.5.7
  // is the newest 0.5.x; 0.6.0 exists but isn't adopted (house choice;
  // default = latest). Bump deliberately, re-test a real flash's reboot.
  _esptoolModule = await import("https://cdn.jsdelivr.net/npm/esptool-js@0.5.7/+esm");
  return _esptoolModule;
}

// esptool-js expects "binary strings" (one char per byte) for file data,
// not Uint8Array. Convert via charCode mapping; chunked to avoid stack
// overflow from String.fromCharCode(...arr) on large bins.
function bytesToBinaryString(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

async function fetchBin(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`fetch ${path}: HTTP ${r.status}`);
  return bytesToBinaryString(await r.arrayBuffer());
}

async function fetchJson(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`fetch ${path}: HTTP ${r.status}`);
  return r.json();
}

// Map esptool's chip-name string to the IDF target string firmware reports
// in fw_info.chip. Lets the UI compare chip identity across the two
// surfaces without each side knowing the other's casing.
function chipNameToIdfTarget(chipName) {
  const s = (chipName || "").toLowerCase().replace(/-/g, "");
  if (s.startsWith("esp32c3")) return "esp32c3";
  if (s.startsWith("esp32s3")) return "esp32s3";
  if (s.startsWith("esp32s2")) return "esp32s2";
  if (s.startsWith("esp32")) return "esp32";
  return s;  // fallback — caller treats unknown as "no compatible board"
}

// Buffering terminal — esptool-js writes chip-detect / sync / write
// progress lines through this. The callback `onTrace(line)` is supplied
// by the caller; if it's a plain array push (no DOM work), it doesn't
// stall the main thread or break sync timing. An earlier version
// wrote each byte to log() / DOM directly, which drifted the DTR/RTS↔
// sync window enough that connect attempts timed out.
function makeBufferingTerminal(onTrace) {
  let buf = "";
  return {
    clean: () => {},
    writeLine: (line) => { if (line) onTrace(line); },
    write: (s) => {
      buf += s;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        if (line) onTrace(line);
        buf = buf.slice(nl + 1);
      }
    },
  };
}

// Flash flow split into two stages so the caller can pop a board picker
// between chip detection and write:
//
//   1. loader.main()          → detects chip; pickBoard resolves variant
//   2. fetch manifest + write → uses manifest's per-target flash offsets
//
// Callbacks the caller supplies:
//   onLog(text)                  — user-facing status line (one short message)
//   onProgress(fileIndex, pct)   — progress bar update during writeFlash
//   pickBoard({chip, chipName})  — returns variant id ("aithinker_cam"
//                                  etc.) or null to cancel
//
// Returns { board, chip } on success, null on cancel.
export async function flashFirmware(port, { onLog = () => {}, onProgress = () => {}, onTrace = () => {}, pickBoard }) {
  if (!pickBoard) throw new Error("flashFirmware: pickBoard callback required");

  const { ESPLoader, Transport } = await ensureEsptoolLoaded();

  // Match esp-web-tools' configuration exactly — same Transport tracing
  // flag, same baud through sync and flash. Bumping to 921600 for flash
  // saves time but isn't worth it if it ever destabilizes sync; revisit
  // once the install path is confirmed reliable across hardware.
  const transport = new Transport(port, true);
  const loader = new ESPLoader({
    transport,
    baudrate: 115200,
    romBaudrate: 115200,
    enableTracing: false,
    debugLogging: false,
    terminal: makeBufferingTerminal(onTrace),
  });

  // Reboot the chip into the just-written app. We do NOT rely on
  // esptool-js's own reset methods: their names drift across 0.5.x patches
  // (the old code guessed loader.after / loader.hardReset / transport.
  // hardReset), and worse, a library call that returned *without throwing*
  // was counted as success and skipped the real reset — leaving the chip in
  // the ROM stub loader until a manual power-cycle. That was the bug: it hit
  // every board, because a no-op "success" suppressed the reliable path.
  //
  // Instead drive the reset line directly — the same RTS→EN pulse esptool.py
  // does over the identical wire. It works for every board we ship: classic
  // ESP32 (CP2102 / CH340 / FT232 auto-reset) AND the C3 SuperMini's native
  // USB-Serial-JTAG both map RTS to EN. port.setSignals works while the
  // transport streams are still locked. No chip-family branch needed:
  // reset-to-run is an EN pulse on all of them.
  async function resetChip() {
    const attempt = async (label, fn) => {
      try { await fn(); onTrace(`reset: ${label} ok`); return true; }
      catch (e) { onTrace(`reset: ${label} failed (${e?.message || e})`); return false; }
    };

    // Pulse EN low→high with IO0 (DTR) held high so the chip boots the app,
    // not download mode. On the C3 this reset re-enumerates USB, so the
    // deassert below may throw on a vanished port — harmless, the reboot has
    // already fired (the peripheral releases EN high on re-enumeration).
    await attempt("EN pulse (reset to app)", async () => {
      await port.setSignals({ requestToSend: true, dataTerminalReady: false });
      await new Promise((r) => setTimeout(r, 150));
      await port.setSignals({ requestToSend: false, dataTerminalReady: false });
    });

    // Leave both signals deasserted so a lingering asserted DTR can't hold
    // IO0 low and drop the chip into download mode on its next boot.
    await attempt("port.setSignals RTS=0 DTR=0 (final)", () =>
      port.setSignals({ requestToSend: false, dataTerminalReady: false }));

    // Release the transport reader/writer locks (esptool-js v0.5 also closes
    // the port here). Without this, port.close() in installEsp32's finally
    // silently fails and Chrome keeps the serial-port indicator on.
    if (typeof transport.disconnect === "function")
      await attempt("transport.disconnect()", () => transport.disconnect());
  }

  // main() syncs with the bootloader (asserts EN+GPIO0, reads chip
  // signature, picks ROM stub). Throws if the chip isn't in download
  // mode — most CAM-MB boards have auto-reset wiring so a fresh
  // serial.open() pulse will land here cleanly.
  onLog("Detecting chip…");
  const chipName = await loader.main();
  const chip = chipNameToIdfTarget(chipName);
  onLog(`Detected: ${chipName}`);

  const board = await pickBoard({ chip, chipName });
  if (!board) {
    onLog("Cancelled. Resetting chip…");
    await resetChip();
    return null;
  }

  // Per-board manifest carries the flash offsets — bootloader sits at
  // 0x1000 on esp32 and 0x0 on esp32c3, so a single hardcoded offset
  // table doesn't work. build.sh writes this alongside the bins.
  onLog(`Fetching ${board} bundle…`);
  const manifest = await fetchJson(`firmware/bins/${board}/manifest.json`);
  if (manifest.chip && manifest.chip !== chip) {
    throw new Error(`Bundle is for ${manifest.chip}, connected chip is ${chip}. Flashing would brick the bootloader until USB recovery.`);
  }

  const fileArray = [];
  for (const f of manifest.files) {
    const data = await fetchBin(`firmware/bins/${board}/${f.path}`);
    fileArray.push({ data, address: parseInt(f.offset, 16) });
  }

  onLog("Writing firmware…");
  await loader.writeFlash({
    fileArray,
    flashSize: "keep",
    flashMode: "keep",
    flashFreq: "keep",
    eraseAll: false,
    compress: true,
    reportProgress: (fileIndex, written, total) => {
      const pct = total ? Math.round((written / total) * 100) : 0;
      onProgress(fileIndex, pct, manifest.files.length);
    },
  });

  onLog("Resetting chip…");
  await resetChip();
  return { board, chip };
}
