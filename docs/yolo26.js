// YOLO26n closed-vocab detector backend. Fetches the ~10MB COCO ONNX from
// HuggingFace (onnx-community/yolo26n-ONNX) on first use, runs via
// onnxruntime-web's WebGPU EP with WASM fallback. Output shape matches
// mediapipe.js: [{ label, score, bbox: { x, y, w, h, cx, cy } }] with
// normalized [0,1] coords.

import { drawFrameToCanvas } from "./camera-frame.js";
import { COCO_80 } from "./detectors.js";

// Bundled minified build embeds the WASM bytes inline — no separate
// wasm-path config needed. WebGPU EP is registered; falls back to WASM
// when the browser lacks navigator.gpu (Safari pre-26, older Chrome).
const ORT_URL   = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.bundle.min.mjs";
const MODEL_URL = "https://huggingface.co/onnx-community/yolo26n-ONNX/resolve/main/onnx/model.onnx";

const INPUT_SIZE = 640;
const DEFAULT_THRESHOLD = 0.25;
const NMS_IOU_THRESHOLD = 0.45;
const MAX_DETECTIONS = 100;
const DEFAULT_INTERVAL_MS = 100;

let _session = null;
let _sessionPromise = null;
let _ort = null;
let _failed = false;

export function isFailed() { return _failed; }

async function ensureSession() {
  if (_failed) return null;
  if (_session) return _session;
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = (async () => {
    try {
      _ort = await import(ORT_URL);
      _session = await _ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ["webgpu", "wasm"],
        graphOptimizationLevel: "all",
      });
      return _session;
    } catch (err) {
      _failed = true;
      console.warn("[yolo26] init failed:", err && err.message || err);
      return null;
    }
  })().catch((err) => {
    _failed = true;
    console.warn("[yolo26] init threw:", err && err.message || err);
    return null;
  });
  return _sessionPromise;
}

// Letterbox the source canvas into a 640x640 RGB plane, gray (114) pad.
// Returns CHW float32 buffer + the geometry needed to un-letterbox the
// bboxes back to original-frame normalized coords.
function preprocess(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const scale = INPUT_SIZE / Math.max(w, h);
  const newW = Math.round(w * scale);
  const newH = Math.round(h * scale);
  const padX = (INPUT_SIZE - newW) / 2;
  const padY = (INPUT_SIZE - newH) / 2;

  const lb = document.createElement("canvas");
  lb.width = INPUT_SIZE;
  lb.height = INPUT_SIZE;
  const ctx = lb.getContext("2d");
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(canvas, padX, padY, newW, newH);
  const img = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;

  const out = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < plane; i++) {
    const j = i * 4;
    out[i]             = img[j]     / 255;
    out[i + plane]     = img[j + 1] / 255;
    out[i + 2 * plane] = img[j + 2] / 255;
  }
  return { data: out, scale, padX, padY, origW: w, origH: h };
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const aArea = (a.x2 - a.x1) * (a.y2 - a.y1);
  const bArea = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (aArea + bArea - inter);
}

// Class-aware NMS. YOLO26 is trained NMS-free (one box per object via
// loss design), but real exports still emit near-duplicates at training-
// distribution-edge anchors — the IoU pass costs ~1ms on ~10 surviving
// boxes and avoids dashboard-side double-fires.
function nms(boxes, iouThreshold) {
  const sorted = boxes.slice().sort((a, b) => b.score - a.score);
  const keep = [];
  for (const cand of sorted) {
    let suppressed = false;
    for (const kept of keep) {
      if (kept.classId === cand.classId && iou(kept, cand) > iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) keep.push(cand);
    if (keep.length >= MAX_DETECTIONS) break;
  }
  return keep;
}

// YOLO output head layout: (1, 4 + numClasses, numAnchors), channel-first.
// First 4 channels are bbox (cx, cy, w, h) in input pixel space (0..640).
// Remaining channels are per-class scores already in [0,1].
function decode(output, numClasses, threshold) {
  const numAnchors = output.length / (4 + numClasses);
  const boxes = [];
  for (let i = 0; i < numAnchors; i++) {
    let maxScore = 0;
    let maxClass = -1;
    for (let c = 0; c < numClasses; c++) {
      const s = output[(4 + c) * numAnchors + i];
      if (s > maxScore) { maxScore = s; maxClass = c; }
    }
    if (maxScore < threshold) continue;
    const cx = output[i];
    const cy = output[numAnchors + i];
    const w  = output[2 * numAnchors + i];
    const h  = output[3 * numAnchors + i];
    boxes.push({
      x1: cx - w / 2,
      y1: cy - h / 2,
      x2: cx + w / 2,
      y2: cy + h / 2,
      score: maxScore,
      classId: maxClass,
    });
  }
  return boxes;
}

// Map input-space bbox back to the original frame's normalized coords.
// Mirrors the unletterbox step in any Ultralytics inference pipeline.
function unletterbox(box, pre) {
  const x1 = (box.x1 - pre.padX) / pre.scale;
  const y1 = (box.y1 - pre.padY) / pre.scale;
  const x2 = (box.x2 - pre.padX) / pre.scale;
  const y2 = (box.y2 - pre.padY) / pre.scale;
  const cx1 = Math.max(0, Math.min(pre.origW, x1));
  const cy1 = Math.max(0, Math.min(pre.origH, y1));
  const cx2 = Math.max(0, Math.min(pre.origW, x2));
  const cy2 = Math.max(0, Math.min(pre.origH, y2));
  const xN = cx1 / pre.origW;
  const yN = cy1 / pre.origH;
  const wN = (cx2 - cx1) / pre.origW;
  const hN = (cy2 - cy1) / pre.origH;
  return { x: xN, y: yN, w: wN, h: hN, cx: xN + wN / 2, cy: yN + hN / 2 };
}

export async function detectOnce(entry, { classes, source = null, threshold = DEFAULT_THRESHOLD } = {}) {
  if (_failed) return null;
  const canvas = drawFrameToCanvas(entry, INPUT_SIZE, source);
  if (!canvas) return null;
  const session = await ensureSession();
  if (!session) return null;

  let pre, output;
  try {
    pre = preprocess(canvas);
    const tensor = new _ort.Tensor("float32", pre.data, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    const results = await session.run({ [inputName]: tensor });
    output = results[outputName].data;
  } catch (err) {
    // Mid-session inference failure kills the backend for the rest of the
    // session so callers don't loop on a broken pipeline — same fail-fast
    // shape as mediapipe.js.
    _failed = true;
    _session = null;
    _sessionPromise = null;
    console.warn("[yolo26] inference failed, disabling for the session:", err && err.message || err);
    return null;
  }

  const raw = decode(output, COCO_80.length, threshold);
  const filtered = nms(raw, NMS_IOU_THRESHOLD);
  let out = filtered.map(b => ({
    label: COCO_80[b.classId] || "",
    score: b.score,
    bbox: unletterbox(b, pre),
  }));
  if (classes && classes.length) {
    const set = new Set(classes.map(c => String(c).toLowerCase()));
    out = out.filter(d => set.has(d.label.toLowerCase()));
  }
  return out;
}

// Same poll-loop shape + semantics as mediapipe.startDetection — callers
// upstream (watcher.js, pip-tools.js) don't care which backend they hit.
export function startDetection(entry, { classes, source = null, threshold, intervalMs = DEFAULT_INTERVAL_MS, timeoutMs = 0 } = {}) {
  let stopped = false;
  let timer = null;
  let timeoutTimer = null;
  let resolveResult;
  const promise = new Promise((resolve) => { resolveResult = resolve; });
  const finish = (val) => {
    if (stopped) return;
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    resolveResult(val);
  };
  const loop = async () => {
    if (stopped) return;
    const dets = await detectOnce(entry, { classes, source, threshold });
    if (stopped) return;
    if (dets === null) {
      if (_failed) { finish(null); return; }
      timer = setTimeout(loop, intervalMs);
      return;
    }
    if (dets.length > 0) { finish(dets[0]); return; }
    timer = setTimeout(loop, intervalMs);
  };
  if (timeoutMs > 0) timeoutTimer = setTimeout(() => finish(null), timeoutMs);
  loop();
  return { promise, stop: () => finish(null) };
}
