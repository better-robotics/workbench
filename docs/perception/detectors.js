// Closed-vocab detector registry. Routes detectOnce / startDetection to
// the active backend, lazy-imports the backend module on first use so the
// inactive one's bytes (mediapipe ~150KB + 4MB tflite model, yolo26 ~10MB
// onnx) never hit the wire. Switch backends via setActiveDetector or the
// `/detector` slash; the setting persists in localStorage.

import { settings, saveSettings } from "../settings.js";

// COCO 80 — the closed vocabulary both shipped backends detect. Single
// source of truth (was duplicated in watcher.js); other modules read it
// through getActiveVocabulary() so tool schemas + UI stay aligned with
// whichever backend is live.
export const COCO_80 = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
  "truck", "boat", "traffic light", "fire hydrant", "stop sign",
  "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
  "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag",
  "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
  "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
  "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana",
  "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza",
  "donut", "cake", "chair", "couch", "potted plant", "bed", "dining table",
  "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone",
  "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock",
  "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
];

// Registered backends. `load` returns a Promise<module>; the module must
// export detectOnce, startDetection, isFailed with the same signatures as
// mediapipe.js. `vocabulary` is the synchronous class list (or null for
// backends whose vocab is loaded async — yoloe will be that case).
const REGISTRY = {
  mediapipe: {
    label: "MediaPipe EfficientDet-Lite0 · COCO 80",
    vocabulary: COCO_80,
    load: () => import("./mediapipe.js"),
  },
  yolo26: {
    label: "YOLO26n · COCO 80 (onnxruntime-web + WebGPU)",
    vocabulary: COCO_80,
    load: () => import("./yolo26.js"),
  },
};

const DEFAULT_NAME = "mediapipe";

let _activeName = REGISTRY[settings.pipDetector] ? settings.pipDetector : DEFAULT_NAME;
let _activeModule = null;
let _activePromise = null;

async function ensureLoaded() {
  if (_activeModule) return _activeModule;
  if (_activePromise) return _activePromise;
  const name = _activeName;
  _activePromise = REGISTRY[name].load().then(mod => {
    // Guard against a switch happening mid-import — if the user toggled
    // away before this module finished loading, drop it on the floor and
    // let the next ensureLoaded() pick up the new backend.
    if (_activeName !== name) {
      _activePromise = null;
      return ensureLoaded();
    }
    _activeModule = mod;
    return mod;
  }).catch(err => {
    // Module fetch failed (CDN blocked, 404, offline). Resolve to null
    // and drop the cached rejection so a later call can retry — without
    // this, a transient network blip would brick the active backend
    // until page reload.
    console.warn(`[detectors] failed to load ${name}:`, err && err.message || err);
    _activePromise = null;
    return null;
  });
  return _activePromise;
}

export function getActiveDetectorName() { return _activeName; }

export function getAvailableDetectors() {
  return Object.keys(REGISTRY).map(name => ({ name, label: REGISTRY[name].label }));
}

export function getActiveVocabulary() {
  return REGISTRY[_activeName]?.vocabulary || null;
}

export function setActiveDetector(name) {
  if (!REGISTRY[name]) throw new Error(`unknown detector: ${name}`);
  if (name === _activeName) return;
  _activeName = name;
  _activeModule = null;
  _activePromise = null;
  settings.pipDetector = name;
  try { saveSettings(); } catch {}
}

export async function detectOnce(entry, opts) {
  const mod = await ensureLoaded();
  if (!mod) return null;
  return mod.detectOnce(entry, opts);
}

// Sync wrapper around the backend's startDetection so callers retain the
// { promise, stop } shape and stop() works even before the backend's
// dynamic import resolves. Without this, an immediate stop() between
// startDetection() and the import landing would leak the eventual loop.
export function startDetection(entry, opts) {
  let stopped = false;
  let realStop = null;
  let resolveResult;
  const promise = new Promise((r) => { resolveResult = r; });
  ensureLoaded().then((mod) => {
    if (stopped || !mod) { resolveResult(null); return; }
    try {
      const { promise: p, stop } = mod.startDetection(entry, opts);
      realStop = stop;
      // Resolve to null on inner-promise rejection so the caller's await
      // unblocks instead of hanging on an unhandled rejection.
      p.then((v) => resolveResult(v), () => resolveResult(null));
    } catch {
      resolveResult(null);
    }
  });
  return {
    promise,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (realStop) realStop();
      else resolveResult(null);
    },
  };
}

// Sync — returns false until the backend has loaded AND reported failure.
// Pre-load this is effectively "no failure observed yet," which matches
// the old isMediapipeFailed() semantics (the boolean only flips after a
// real init attempt fails).
export function isDetectorFailed() {
  if (!_activeModule) return false;
  return _activeModule.isFailed?.() ?? false;
}
