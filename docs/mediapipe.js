// Closed-vocab reflex object detection via MediaPipe Tasks API. Powers
// the watcher's halt/speak/notify reactions and approach_until's target-
// centering loop at ~10–30 ms on the GPU path, ~30–80 ms on CPU. Output:
// [{ label, score, bbox: { x, y, w, h, cx, cy } }] with normalized coords.
// Open-vocab queries ("find the orange book on the bag") are handled by
// the planner via view_robot_frame to Claude — no in-browser open-vocab
// model is needed once the LLM is vision-capable.
//
// Model: EfficientDet-Lite0 float16, ~4MB, 80 COCO classes (stop sign,
// person, traffic light, ...). Bump to Lite2 if Lite0's accuracy fails
// for the deployment scene — slower but better small-object recall.

import { drawFrameToCanvas } from "./camera-frame.js";

// Unversioned tracks current 0.10.x — WASM bundle path matches the
// imported JS version.
const TASKS_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision";
const WASM_URL  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/latest/efficientdet_lite0.tflite";
const MAX_DIM = 640;
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_INTERVAL_MS = 100;

let _detector = null;
let _detectorPromise = null;
let _detectorFailed = false;

// Standard backend-interface name consumed by detectors.js — the registry
// proxies through isFailed across all backends.
export function isFailed() { return _detectorFailed; }

// GPU is ~10× faster but some drivers refuse shader compile or silently
// fall back. CPU path is ~30–80ms — still well below detection budget
// for the reflex use case. Fail-fast cascade across delegates.
const INIT_ATTEMPTS = [
  { delegate: "GPU" },
  { delegate: "CPU" },
];

async function ensureDetector() {
  if (_detectorFailed) return null;
  if (_detector) return _detector;
  if (_detectorPromise) return _detectorPromise;
  _detectorPromise = (async () => {
    const { ObjectDetector, FilesetResolver } = await import(TASKS_URL);
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    const errors = [];
    for (const attempt of INIT_ATTEMPTS) {
      try {
        _detector = await ObjectDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: attempt.delegate },
          scoreThreshold: DEFAULT_THRESHOLD,
          maxResults: DEFAULT_MAX_RESULTS,
          runningMode: "VIDEO",
        });
        return _detector;
      } catch (err) {
        errors.push(`${attempt.delegate}: ${err && err.message || err}`);
      }
    }
    _detectorFailed = true;
    console.warn("[mediapipe] init failed across delegates:", errors.join(" | "));
    return null;
  })().catch((err) => {
    _detectorFailed = true;
    console.warn("[mediapipe] init threw:", err && err.message || err);
    return null;
  });
  return _detectorPromise;
}

function toBoxes(raw, w, h) {
  return (raw?.detections || []).map(d => {
    const c = d.categories?.[0] || {};
    const b = d.boundingBox || {};
    const x0 = b.originX / w;
    const y0 = b.originY / h;
    const ww = b.width  / w;
    const hh = b.height / h;
    return {
      label: c.categoryName || "",
      score: c.score || 0,
      bbox: { x: x0, y: y0, w: ww, h: hh, cx: x0 + ww / 2, cy: y0 + hh / 2 },
    };
  });
}

// Single-shot. `classes` whitelist applied post-detection (the model
// always scores all 80 COCO classes; filtering is a free operation).
export async function detectOnce(entry, { classes, source = null, threshold } = {}) {
  if (_detectorFailed) return null;
  const canvas = drawFrameToCanvas(entry, MAX_DIM, source);
  if (!canvas) return null;
  const det = await ensureDetector();
  if (!det) return null;
  let raw;
  try {
    raw = det.detectForVideo(canvas, performance.now());
  } catch (err) {
    // A mid-session inference failure kills
    // the detector for the rest of the session so callers don't loop on
    // a broken pipeline.
    _detectorFailed = true;
    _detector = null;
    _detectorPromise = null;
    console.warn("[mediapipe] inference failed, disabling detector for the session:", err && err.message || err);
    return null;
  }
  let out = toBoxes(raw, canvas.width, canvas.height);
  if (threshold != null) out = out.filter(d => d.score >= threshold);
  if (classes && classes.length) {
    const set = new Set(classes.map(c => String(c).toLowerCase()));
    out = out.filter(d => set.has(d.label.toLowerCase()));
  }
  return out;
}

// Continuous watcher. Returns { promise, stop }. The promise resolves with
// the first matching detection, or null on timeout / detector-unavailable
// / manual stop(). Designed for `await robot.watchFor(...)` to linearize
// reflex-shaped scripts around the next sighting.
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
      // Distinguish hard failure (detector dead — abandon) from transient
      // null (no frame this tick — camera element missing or 0-sized).
      // Persistent watchers need to ride out brief camera blips.
      if (_detectorFailed) { finish(null); return; }
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
