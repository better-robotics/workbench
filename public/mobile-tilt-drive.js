import { $ } from "./dom.js";
import { mix } from "./joypad.js";

// Phone-as-steering-wheel + on-screen throttle pedals. Rolling the phone
// left/right (gamma axis) sets a turn rate; press-and-hold "Forward" or
// "Reverse" applies throttle. Maps to the same {type:"drive", l, r}
// protocol the joypad uses, mixed via differential drive (throttle ±
// turn → left / right motor). 10 Hz send rate (joystick parity).
//
// iOS Safari requires DeviceOrientationEvent.requestPermission() — a
// one-tap user gesture before motion data flows. We surface the prompt
// only when the user opts into Tilt mode (no friction for joypad users).
const TILT_MODE_KEY = "better-robotics:phone-drive-mode";
// Dead-zone covers IMU noise floor (~1°) + typical hand tremor + relaxed
// grip drift (3-6°). Anything inside this band = "go straight" intent —
// the operator gets to keep moving forward without locking their wrist.
const TILT_TURN_DEADZONE_DEG = 8;
const TILT_TURN_SATURATION_DEG = 35;  // ±35° = full turn rate; beyond clips
const TILT_THROTTLE = 60;             // base motor magnitude when a pedal is held (LLM-cap-safe range)
const TILT_SEND_HZ = 10;
// Brief grace period after a pointer-release event before zeroing the
// throttle. iOS Safari can preempt touches during sustained device
// motion (system gestures, capacitive-touch dropouts on hard tilts).
// 80 ms of grace means a quick re-press cancels the stop — common
// mobile-racing-game pattern to filter glitchy releases.
const TILT_RELEASE_GRACE_MS = 80;

let tiltGamma = 0;                   // last orientation event's left-right roll
let tiltBeta = 0;                    // front-back tilt (used in landscape)
let tiltThrottle = 0;                // -1, 0, +1 from pedal state
let tiltSendTimer = null;
let tiltSendLastZero = false;
let tiltOrientationOn = false;
let tiltMotionPermission = "unknown"; // "granted" | "denied" | "unknown"

// Injected by wireTiltDrive — peer handle changes after pairing, so we
// keep it as a getter rather than a captured value.
let getPeer = () => null;
let resetJoypad = () => {};

// Returns the user's "left-right tilt to steer" reading in degrees,
// normalized so positive = turn right regardless of how the phone is
// physically oriented. The DeviceOrientationEvent axes (alpha/beta/gamma)
// are tied to the device frame, not the screen frame, so we re-map based
// on screen.orientation.angle:
//   0   (portrait primary): gamma → screen left-right
//   180 (portrait inverted): -gamma
//   90  (landscape primary, home button on left): beta → screen left-right
//   270 (landscape secondary, home button on right): -beta
function steerAxisDeg() {
  const angle = ((screen.orientation?.angle ?? 0) % 360 + 360) % 360;
  if (angle === 90)  return tiltBeta;
  if (angle === 270) return -tiltBeta;
  if (angle === 180) return -tiltGamma;
  return tiltGamma;
}

function isLandscape() {
  const angle = ((screen.orientation?.angle ?? 0) % 360 + 360) % 360;
  return angle === 90 || angle === 270;
}

function tiltMix() {
  // Steering axis is in [-90, 90] roughly; positive = right tilt.
  // dead-zone + clip then normalize to the shared mix() convention
  // (which handles operator-perspective sign flip on reverse).
  let g = steerAxisDeg();
  if (Math.abs(g) < TILT_TURN_DEADZONE_DEG) g = 0;
  if (g >  TILT_TURN_SATURATION_DEG) g =  TILT_TURN_SATURATION_DEG;
  if (g < -TILT_TURN_SATURATION_DEG) g = -TILT_TURN_SATURATION_DEG;
  const turnPct = g / TILT_TURN_SATURATION_DEG;        // -1..+1
  // 70% turn ratio = comfortable turn radius without pivot-in-place.
  const [l, r] = mix(tiltThrottle * TILT_THROTTLE, turnPct * TILT_THROTTLE * 0.7);
  return { l, r };
}

function updateIndicator() {
  const fill = $("phone-tilt-fill");
  const neutral = $("phone-tilt-neutral");
  const read = $("phone-tilt-readout");
  if (!fill) return;
  const steer = steerAxisDeg();
  const pct = Math.max(-1, Math.min(1, steer / TILT_TURN_SATURATION_DEG));
  // Center the bar at 50%; fill from center outward toward the tilt direction.
  const left = pct < 0 ? `${50 + pct * 50}%` : "50%";
  const width = `${Math.abs(pct) * 50}%`;
  fill.style.left = left;
  fill.style.width = width;
  // Neutral zone width tracks the dead-zone / saturation ratio so the
  // visual matches the actual "go straight" band whenever the constants
  // change. Set once per render — cheap.
  if (neutral) {
    const neutralPct = (TILT_TURN_DEADZONE_DEG / TILT_TURN_SATURATION_DEG) * 50;
    neutral.style.width = `${neutralPct * 2}%`;
  }
  if (read) {
    if (Math.abs(steer) < TILT_TURN_DEADZONE_DEG) {
      read.textContent = tiltThrottle === 0 ? "Roll phone L/R to steer" : "Going straight";
    } else {
      read.textContent = `${steer > 0 ? "→ Right" : "← Left"} ${Math.round(Math.abs(steer))}°`;
    }
  }
}

function sendTick() {
  const peer = getPeer();
  if (!peer) return;
  const { l, r } = tiltMix();
  // Skip the send when both motors would be zero AND we already sent zero
  // last tick — common case (phone flat, no pedal). Saves bandwidth.
  if (l === 0 && r === 0 && tiltSendLastZero) return;
  try { peer.send({ type: "drive", l, r }); } catch {}
  tiltSendLastZero = (l === 0 && r === 0);
}

function orientationHandler(e) {
  // gamma: left-right roll. beta: front-back tilt. We need both because
  // the steering axis depends on whether the phone is in portrait or
  // landscape (handled by steerAxisDeg).
  if (typeof e.gamma === "number") tiltGamma = e.gamma;
  if (typeof e.beta  === "number") tiltBeta  = e.beta;
  updateIndicator();
}

// Apply / remove the .landscape modifier on the tilt-drive container so
// CSS can reflow the pedals to bottom corners (controller-grip pattern)
// when the phone rotates. Hides the steering input when in portrait
// + tilt mode, with a hint to rotate.
function applyOrientation() {
  const wrap = $("phone-drive-tilt-wrap");
  const hint = $("phone-tilt-orient-hint");
  if (!wrap) return;
  const land = isLandscape();
  wrap.classList.toggle("landscape", land);
  if (hint) hint.hidden = land;
  updateIndicator();
}

async function requestMotionPermission() {
  // iOS 13+ Safari: explicit user-gesture-bound permission request. Other
  // browsers: addEventListener works without the prompt. Treat the legacy
  // path as already-granted.
  const Klass = window.DeviceOrientationEvent;
  if (Klass && typeof Klass.requestPermission === "function") {
    try {
      const result = await Klass.requestPermission();
      tiltMotionPermission = result;
      return result === "granted";
    } catch { tiltMotionPermission = "denied"; return false; }
  }
  tiltMotionPermission = "granted";
  return true;
}

function startOrientation() {
  if (tiltOrientationOn) return;
  window.addEventListener("deviceorientation", orientationHandler, { passive: true });
  tiltOrientationOn = true;
}

function stopOrientation() {
  if (!tiltOrientationOn) return;
  window.removeEventListener("deviceorientation", orientationHandler);
  tiltOrientationOn = false;
  tiltGamma = 0;
  updateIndicator();
}

function setDriveMode(mode) {
  const isTilt = mode === "tilt";
  $("phone-drive-joypad-wrap").hidden = isTilt;
  $("phone-drive-tilt-wrap").hidden = !isTilt;
  $("phone-drive-mode-joypad").setAttribute("aria-pressed", String(!isTilt));
  $("phone-drive-mode-tilt").setAttribute("aria-pressed", String(isTilt));
  try { localStorage.setItem(TILT_MODE_KEY, mode); } catch {}
  if (isTilt) {
    // iOS: show the permission button when we don't have permission yet.
    // The button has a real user-gesture; addEventListener inside an
    // arbitrary toggle wouldn't satisfy iOS's gesture requirement.
    const Klass = window.DeviceOrientationEvent;
    const needsPrompt = Klass && typeof Klass.requestPermission === "function"
                       && tiltMotionPermission !== "granted";
    $("phone-tilt-permission").hidden = !needsPrompt;
    if (!needsPrompt) startOrientation();
    applyOrientation();
    // Joystick-mode is no longer the throttle source — kill any in-flight
    // joypad drive so swapping doesn't strand a non-zero throttle.
    resetJoypad();
    try { getPeer()?.send({ type: "drive", l: 0, r: 0 }); } catch {}
  } else {
    stopOrientation();
    tiltThrottle = 0;
    if (tiltSendTimer) { clearInterval(tiltSendTimer); tiltSendTimer = null; }
  }
}

// Called by mobile.js's background-stop handler so a backgrounded phone
// doesn't drive into a wall while the user can't see the robot.
export function stopTilt() {
  if (tiltThrottle !== 0) {
    tiltThrottle = 0;
    if (tiltSendTimer) { clearInterval(tiltSendTimer); tiltSendTimer = null; }
  }
}

export function wireTiltDrive(deps) {
  getPeer = deps.getPeer;
  resetJoypad = deps.resetJoypad;
  // Mode toggle: persist choice + swap UI.
  $("phone-drive-mode-joypad")?.addEventListener("click", () => setDriveMode("joypad"));
  $("phone-drive-mode-tilt")?.addEventListener("click", () => setDriveMode("tilt"));
  // Orientation change → re-apply class + hint. The browser fires both
  // orientationchange (legacy) and screen.orientation.change (modern);
  // listen to whichever surfaces first.
  const onOrient = () => applyOrientation();
  if (screen.orientation?.addEventListener) {
    screen.orientation.addEventListener("change", onOrient);
  } else {
    window.addEventListener("orientationchange", onOrient);
  }
  // Permission prompt — explicit gesture handler so iOS approves.
  $("phone-tilt-permission")?.addEventListener("click", async () => {
    const ok = await requestMotionPermission();
    $("phone-tilt-permission").hidden = ok;
    if (ok) startOrientation();
  });
  // Pedals — pointer events so it works for both touch and mouse-on-tablet.
  // Throttle on press, zero on release. The interval driver runs only
  // while a pedal is held to keep the bandwidth profile flat.
  const startSend = () => {
    if (tiltSendTimer) return;
    tiltSendTimer = setInterval(sendTick, 1000 / TILT_SEND_HZ);
  };
  const stopSend = () => {
    if (tiltSendTimer) { clearInterval(tiltSendTimer); tiltSendTimer = null; }
    try { getPeer()?.send({ type: "drive", l: 0, r: 0 }); } catch {}
  };
  // Pending grace timer per pedal. A pointer-release event schedules a
  // delayed stop; if the user re-presses (real intent: hold continuous)
  // before the timer fires, we cancel it. Filters capacitive-touch
  // dropouts during hard tilts that would otherwise spuriously stop.
  const pendingStop = new Map();
  const cancelPending = (dir) => {
    const t = pendingStop.get(dir);
    if (t) { clearTimeout(t); pendingStop.delete(dir); }
  };
  const wirePedal = (id, dir) => {
    const btn = $(id);
    if (!btn) return;
    let activePid = null;
    const onWinUp = (e) => {
      if (activePid != null && e.pointerId !== activePid) return;
      activePid = null;
      window.removeEventListener("pointerup", onWinUp);
      window.removeEventListener("pointercancel", onWinUp);
      // Grace-period stop: a quick re-press cancels it. If genuinely
      // released, the timer fires and zeroes the throttle.
      cancelPending(dir);
      pendingStop.set(dir, setTimeout(() => {
        pendingStop.delete(dir);
        if (tiltThrottle === dir) { tiltThrottle = 0; stopSend(); }
      }, TILT_RELEASE_GRACE_MS));
    };
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      // Cancel any in-flight grace-stop from a previous release —
      // user re-pressed before the grace window expired, so they
      // were never really off the pedal.
      cancelPending(dir);
      activePid = e.pointerId;
      try { btn.setPointerCapture(e.pointerId); } catch {}
      tiltThrottle = dir;
      startSend();
      // Window-level release listeners. iOS Safari can preempt the
      // pointer with a system gesture during heavy device motion;
      // listening on window catches the release even when the
      // button-level capture is lost mid-drive.
      window.addEventListener("pointerup", onWinUp);
      window.addEventListener("pointercancel", onWinUp);
    });
    // Intentionally NOT listening to pointerleave on the button —
    // pointer capture handles drift, and the window-level pointerup
    // catches the actual release reliably.
  };
  wirePedal("phone-tilt-forward", +1);
  wirePedal("phone-tilt-reverse", -1);
  // Restore last-used drive mode (defaults to joypad).
  let saved = "joypad";
  try { saved = localStorage.getItem(TILT_MODE_KEY) || "joypad"; } catch {}
  setDriveMode(saved);
}
