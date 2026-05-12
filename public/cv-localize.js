// Overhead camera localization via ARUCO_4X4_50 marker detection.
//
// Uses the same js-aruco2 library as aruco.js but with the 4×4 dictionary,
// which matches the DICT_4X4_50 PDFs from the object-tracking project.
// Separate detector instance — no conflict with the per-robot ARUCO tracker.
//
// Phase 1: pixel-space position + heading only. Metric pose (cm/mm via
// known marker size + camera calibration) is Phase 2.

const CDN = "https://cdn.jsdelivr.net/gh/damianofalcioni/js-aruco2@master/src";
const SCRIPTS = ["cv.js", "aruco.js"];
const DICTIONARY = "ARUCO_4X4_50";

let _detector = null;
let _detectorPromise = null;
let _stream = null;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-aruco-src="${url}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = url;
    s.dataset.arucoSrc = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`failed to load ${url}`));
    document.head.appendChild(s);
  });
}

async function ensureDetector() {
  if (_detector) return _detector;
  if (_detectorPromise) return _detectorPromise;
  _detectorPromise = (async () => {
    for (const f of SCRIPTS) await loadScript(`${CDN}/${f}`);
    if (!window.AR?.Detector) throw new Error("AR.Detector not available after script load");
    _detector = new window.AR.Detector({ dictionaryName: DICTIONARY });
    return _detector;
  })();
  try { return await _detectorPromise; }
  catch (err) { _detectorPromise = null; throw err; }
}

async function enumerateCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs
    .filter(d => d.kind === "videoinput")
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

function drawOverlay(canvasEl, markers) {
  const ctx = canvasEl.getContext("2d");
  const minDim = Math.min(canvasEl.width, canvasEl.height);
  const arrowLen = minDim * 0.07;
  const fontSize = Math.max(12, Math.round(minDim * 0.03));
  for (const m of markers) {
    const c = m.corners;
    ctx.strokeStyle = "#00e87a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = "#ff4466";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(m.cx, m.cy);
    ctx.lineTo(m.cx + Math.cos(m.headingRad) * arrowLen, m.cy + Math.sin(m.headingRad) * arrowLen);
    ctx.stroke();
    ctx.fillStyle = "#ff4466";
    ctx.beginPath();
    ctx.arc(m.cx, m.cy, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = "#00e87a";
    ctx.fillText(`id ${m.id}`, m.cx + 6, m.cy - 6);
  }
}

export async function initCvLocalize() {
  const panel    = document.getElementById("cv-localize-panel");
  if (!panel) return;

  const videoEl   = document.getElementById("cv-video");
  const canvasEl  = document.getElementById("cv-canvas");
  const selectEl  = document.getElementById("cv-camera-select");
  const refreshBtn = document.getElementById("cv-refresh-btn");
  const startBtn  = document.getElementById("cv-start-btn");
  const stopBtn   = document.getElementById("cv-stop-btn");
  const scanBtn   = document.getElementById("cv-scan-btn");
  const statusEl  = document.getElementById("cv-status");
  const resultsEl = document.getElementById("cv-results");

  function setStatus(msg) { statusEl.textContent = msg; }

  async function populateSelect() {
    const cameras = await enumerateCameras();
    if (cameras.length === 0) {
      selectEl.innerHTML = `<option value="">No cameras found</option>`;
      startBtn.disabled = true;
      return;
    }
    const current = selectEl.value;
    selectEl.innerHTML = cameras
      .map(c => `<option value="${c.id}"${c.id === current ? " selected" : ""}>${c.label}</option>`)
      .join("");
    startBtn.disabled = false;
  }

  function setRunning(on) {
    videoEl.hidden = !on;
    startBtn.hidden = on;
    stopBtn.hidden = !on;
    scanBtn.disabled = !on;
    selectEl.disabled = on;
    refreshBtn.disabled = on;
    if (!on) {
      canvasEl.hidden = true;
      resultsEl.innerHTML = "";
    }
  }

  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    await populateSelect();
    refreshBtn.disabled = false;
  });

  startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    setStatus("Starting camera…");
    try {
      const deviceId = selectEl.value;
      const constraints = { video: deviceId ? { deviceId: { exact: deviceId } } : true };
      _stream = await navigator.mediaDevices.getUserMedia(constraints);
      videoEl.srcObject = _stream;
      await new Promise(res => { videoEl.onloadedmetadata = res; });
      videoEl.play();
      await populateSelect();
      setRunning(true);
      setStatus("Camera ready · click Scan");
    } catch (err) {
      startBtn.disabled = false;
      setStatus(`Camera error: ${err.message}`);
    }
  });

  stopBtn.addEventListener("click", () => {
    if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
    videoEl.srcObject = null;
    setRunning(false);
    setStatus("Camera stopped · select a camera and click Start");
  });

  scanBtn.addEventListener("click", async () => {
    scanBtn.disabled = true;
    setStatus("Scanning…");
    try {
      const detector = await ensureDetector();
      const w = videoEl.videoWidth;
      const h = videoEl.videoHeight;
      if (!w || !h) throw new Error("no video frame — camera not ready");

      canvasEl.width = w;
      canvasEl.height = h;
      const ctx = canvasEl.getContext("2d");
      ctx.drawImage(videoEl, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);

      const raw = detector.detect(imageData);
      const markers = raw.map(m => {
        const c = m.corners;
        const cx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4;
        const cy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4;
        const headingRad = Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x);
        return { id: m.id, cx, cy, headingRad, corners: c };
      });

      drawOverlay(canvasEl, markers);
      canvasEl.hidden = false;

      if (markers.length === 0) {
        resultsEl.innerHTML = `<div class="hint cv-no-markers">No markers detected · try repositioning the camera or improving lighting</div>`;
      } else {
        resultsEl.innerHTML = markers.map(m => {
          const deg = Math.round(m.headingRad * 180 / Math.PI);
          return `<div class="cv-result-row">
            <span class="cv-marker-id">id ${m.id}</span>
            <span class="meta">(${Math.round(m.cx)}, ${Math.round(m.cy)}) px</span>
            <span class="meta">${deg >= 0 ? "+" : ""}${deg}°</span>
          </div>`;
        }).join("");
      }

      const t = new Date().toLocaleTimeString();
      setStatus(`${markers.length} marker${markers.length === 1 ? "" : "s"} · ${t}`);
    } catch (err) {
      setStatus(`Scan failed: ${err.message}`);
    } finally {
      scanBtn.disabled = false;
    }
  });

  await populateSelect();
  setStatus("Select a camera and click Start.");
}
