import { $ } from "../dom.js";

let _scanStream = null;
let _scanRaf = 0;
let _scanCanvas = null;

export function showReconnect(message) {
  $("phone-reconnect").hidden = false;
  $("phone-reconnect-message").textContent = message || "";
  $("phone-cam-section").hidden = true;
}
export function hideReconnect() {
  stopQrScan();
  $("phone-reconnect").hidden = true;
  $("phone-scanner").hidden = true;
}

function showScanError(text) {
  const el = $("phone-scanner-fallback");
  el.textContent = text;
  el.hidden = false;
}
function clearScanError() {
  $("phone-scanner-fallback").hidden = true;
}

// navigator.mediaDevices is undefined in any insecure context — accessing
// phone.html over http://<ip>/<mac>.local instead of https:// is the most
// common trip. Surface that reason instead of the raw TypeError.
export function cameraUnavailableReason() {
  return window.isSecureContext
    ? "Camera isn't available in this browser."
    : "Camera needs HTTPS. Open this page over https:// (or use the GitHub Pages URL).";
}

async function startQrScan() {
  if (typeof window.jsQR !== "function") {
    showScanError("QR decoder didn't load. Reload the page or check your network.");
    return;
  }
  clearScanError();
  if (!navigator.mediaDevices?.getUserMedia) {
    showScanError(cameraUnavailableReason());
    return;
  }
  try {
    _scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch (err) {
    showScanError(`Couldn't open camera: ${err.message || err}.`);
    return;
  }
  $("phone-scanner").hidden = false;
  $("phone-scan-btn").hidden = true;
  const v = $("phone-scanner-video");
  v.srcObject = _scanStream;
  // Required on iOS Safari: video must play before videoWidth is non-zero.
  // Inline + muted attrs in the HTML cover the autoplay policy.
  await v.play().catch(() => {});

  _scanCanvas = _scanCanvas || document.createElement("canvas");
  const ctx = _scanCanvas.getContext("2d", { willReadFrequently: true });

  const tick = () => {
    if (!_scanStream) return;
    if (v.readyState >= v.HAVE_ENOUGH_DATA && v.videoWidth > 0) {
      // Downscale to ~480 on the long edge — jsQR is O(pixels), full HD
      // tanks fps on older phones, and 480 is plenty for a QR.
      const scale = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.round(v.videoWidth * scale);
      const h = Math.round(v.videoHeight * scale);
      if (_scanCanvas.width !== w) _scanCanvas.width = w;
      if (_scanCanvas.height !== h) _scanCanvas.height = h;
      ctx.drawImage(v, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const result = window.jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
      if (result?.data) {
        stopQrScan();
        // Same-origin pair URL → navigate. Cross-origin → user picked the
        // wrong QR; surface a hint rather than bouncing them out.
        try {
          const target = new URL(result.data, location.href);
          if (target.origin === location.origin && target.hash.startsWith("#pair=")) {
            // location.replace() does NOT reload when the new URL only
            // differs by fragment — it fires hashchange and keeps the JS
            // state, so init()/joinPairingRoom never see the new roomId.
            // Force a reload so the page restarts with the fresh hash.
            // Same pattern the nearby-pair button uses.
            location.replace(target.toString());
            location.reload();
            return;
          }
          showScanError(`That QR points to ${target.host}, not this dashboard.`);
        } catch {
          showScanError("That QR isn't a pair link.");
        }
        return;
      }
    }
    _scanRaf = requestAnimationFrame(tick);
  };
  tick();
}

function stopQrScan() {
  if (_scanRaf) { cancelAnimationFrame(_scanRaf); _scanRaf = 0; }
  if (_scanStream) {
    for (const t of _scanStream.getTracks()) { try { t.stop(); } catch {} }
    _scanStream = null;
  }
  const v = $("phone-scanner-video");
  if (v) v.srcObject = null;
  $("phone-scanner").hidden = true;
  $("phone-scan-btn").hidden = false;
}

export function wireReconnect() {
  $("phone-scan-btn")?.addEventListener("click", startQrScan);
  $("phone-scanner-cancel")?.addEventListener("click", stopQrScan);
}
