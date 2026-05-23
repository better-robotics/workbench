// Hand-tracking + closed-set gesture recognition via MediaPipe Tasks API.
// Strict superset of Hand Landmarker (same 21 landmarks, two-stage palm
// detector + landmark regressor) plus 8 built-in gesture classes from
// the canned classifier head. ~12 ms GPU + ~8 ms for the gesture head.
// One shared instance, same shape as mediapipe.js — keeps the perception
// surface uniform and avoids each demo wiring up its own model bootstrap.
//
// Tracking note: in VIDEO running mode the recognizer skips palm
// detection on most frames by reusing the prior landmark bbox, so the
// per-tick cost stays close to landmark inference alone.
//
// Output shape (single hand for now — num_hands=1 by default; bump if a
// multi-hand demo earns it):
//   { gesture: "Open_Palm" | ..., score, landmarks, palmCentroid: {cx,cy},
//     bboxArea }
// or null on failure / no hand visible.

import { drawFrameToCanvas } from "./camera-frame.js";

const TASKS_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision";
const WASM_URL  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task";
const MAX_DIM = 640;

let _recognizer = null;
let _recognizerPromise = null;
let _recognizerFailed = false;

export function isGesturesFailed() { return _recognizerFailed; }

// Same GPU-then-CPU cascade as mediapipe.js — some drivers refuse shader
// compile and we want to fall through instead of disabling perception.
const INIT_ATTEMPTS = [
  { delegate: "GPU" },
  { delegate: "CPU" },
];

async function ensureRecognizer() {
  if (_recognizerFailed) return null;
  if (_recognizer) return _recognizer;
  if (_recognizerPromise) return _recognizerPromise;
  _recognizerPromise = (async () => {
    const { GestureRecognizer, FilesetResolver } = await import(TASKS_URL);
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    const errors = [];
    for (const attempt of INIT_ATTEMPTS) {
      try {
        _recognizer = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: attempt.delegate },
          runningMode: "VIDEO",
          numHands: 1,
        });
        return _recognizer;
      } catch (err) {
        errors.push(`${attempt.delegate}: ${err && err.message || err}`);
      }
    }
    _recognizerFailed = true;
    console.warn("[gestures] init failed across delegates:", errors.join(" | "));
    return null;
  })().catch((err) => {
    _recognizerFailed = true;
    console.warn("[gestures] init threw:", err && err.message || err);
    return null;
  });
  return _recognizerPromise;
}

// Palm centroid (mean of all 21 landmarks) is the right tracking anchor
// per the MentorPi reference + GestureBot review: the wrist (idx 0) sits
// at the bottom of the bbox and biases the robot to aim "below" the hand;
// the index fingertip is the right pick only when pointing direction
// matters. Mean is also naturally jitter-smoother than any single point.
function palmCentroid(landmarks) {
  if (!landmarks?.length) return { cx: 0.5, cy: 0.5 };
  let sx = 0, sy = 0;
  for (const p of landmarks) { sx += p.x; sy += p.y; }
  return { cx: sx / landmarks.length, cy: sy / landmarks.length };
}

function landmarksBboxArea(landmarks) {
  if (!landmarks?.length) return 0;
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.max(0, (maxX - minX) * (maxY - minY));
}

export async function detectGestureOnce(entry, { source = null } = {}) {
  if (_recognizerFailed) return null;
  const canvas = drawFrameToCanvas(entry, MAX_DIM, source);
  if (!canvas) return null;
  const rec = await ensureRecognizer();
  if (!rec) return null;
  let raw;
  try {
    raw = rec.recognizeForVideo(canvas, performance.now());
  } catch (err) {
    // A mid-session inference failure kills the recognizer for the rest
    // of the session — same policy as mediapipe.js.
    _recognizerFailed = true;
    _recognizer = null;
    _recognizerPromise = null;
    console.warn("[gestures] inference failed, disabling recognizer for the session:", err && err.message || err);
    return null;
  }
  const lm = raw?.landmarks?.[0];
  if (!lm) return null;
  const cat = raw?.gestures?.[0]?.[0];
  return {
    // "None" is the recognizer's no-confident-gesture label — surface it
    // verbatim so callers can distinguish "hand seen but no gesture" from
    // "no hand at all" (the null return above).
    gesture: cat?.categoryName || "None",
    score: cat?.score || 0,
    landmarks: lm,
    palmCentroid: palmCentroid(lm),
    bboxArea: landmarksBboxArea(lm),
  };
}

// Built-in gesture classes (Google AI Edge Gesture Recognizer). Exposed
// so callers (watcher UI hints, tool descriptions) can show the user
// which gestures actually do anything. Skip Thumb_Down for command
// mapping — measured 70.7% accuracy in real robot benchmarks vs >90%
// for the others; it gets confused with similar poses.
export const GESTURE_CLASSES = [
  "Open_Palm", "Closed_Fist", "Pointing_Up", "Thumb_Up",
  "Thumb_Down", "Victory", "ILoveYou", "None",
];
