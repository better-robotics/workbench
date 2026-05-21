// Camera-frame helpers — pixel capture from <img class="robot-camera">
// (ESP32 HTTP MJPEG with firmware CORS), <canvas class="robot-camera">
// (ESP32 WebRTC via WebCodecs decode), or <video data-camera-id> (Pi
// WebRTC), plus the attached-phone variant (data-attached-camera-id).

function findPrimaryCameraElement(entry) {
  const node = entry.node;
  if (!node) return null;
  return node.querySelector("img.robot-camera:not([data-attached-camera-id])")
      || node.querySelector("canvas.robot-camera:not([data-attached-camera-id])")
      || node.querySelector("video[data-camera-id]:not([data-attached-camera-id])")
      || node.querySelector("video:not([data-attached-camera-id])");
}

function findAttachedCameraElement(entry) {
  const node = entry.node;
  if (!node) return null;
  return node.querySelector(`video[data-attached-camera-id="${entry.id}"]`);
}

export function listCameraSources(entry) {
  const out = [];
  const primary = findPrimaryCameraElement(entry);
  if (primary) out.push({ label: "primary", element: primary });
  const attached = findAttachedCameraElement(entry);
  if (attached) out.push({ label: "phone", element: attached });
  return out;
}

// Frame as data URL — used by ask_human to send the robot's view to a
// paired phone. Smaller default maxDim keeps JPEG under typical WebRTC
// data-channel budgets (~60KB).
export function captureFrameDataUrl(entry, maxDim = 320, quality = 0.75) {
  const canvas = drawFrameToCanvas(entry, maxDim);
  if (!canvas) return null;
  try { return canvas.toDataURL("image/jpeg", quality); }
  catch { return null; }
}

export function drawFrameToCanvas(entry, maxDim, source = null) {
  const el = source || findPrimaryCameraElement(entry);
  if (!el) return null;
  const isCanvas = el instanceof HTMLCanvasElement;
  let w = el.naturalWidth || el.videoWidth || (isCanvas ? el.width : 0);
  let h = el.naturalHeight || el.videoHeight || (isCanvas ? el.height : 0);
  if (!w || !h) return null;
  if (Math.max(w, h) > maxDim) {
    const s = maxDim / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  // The card preview's "Flip 180°" toggle is a CSS transform on the <video>;
  // drawImage reads raw pixels and ignores it, so Pip / mediapipe would
  // see un-flipped frames. Re-apply the rotation at capture time so every
  // downstream consumer sees the same orientation the operator sees.
  // Only for the robot's own camera, not phone-attached helpers — those
  // carry their own orientation independent of the chassis mount.
  const isAttachedPhone = el.hasAttribute?.("data-attached-camera-id");
  const flip = !!entry.cameraFlip && !isAttachedPhone;
  try {
    const ctx = canvas.getContext("2d");
    if (flip) {
      ctx.translate(w, h);
      ctx.rotate(Math.PI);
    }
    ctx.drawImage(el, 0, 0, w, h);
    return canvas;
  } catch {
    // Tainted canvas → firmware didn't serve CORS + the <img> is missing
    // crossOrigin="anonymous". Surface null; caller logs once.
    return null;
  }
}
