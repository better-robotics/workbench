import { listPhones, notifyRobotStreamChange, requestPhoneCameraShare } from "./phones.js";
import { emit as busEmit, TOPICS } from "../event-bus.js";
import { state } from "../state.js";

// Headless engine for "use a paired phone's camera as a robot sensor" — no
// persistent UI section. Two jobs:
//   1. Mount a phone's camera onto a robot as a second eye (attachPhoneCameraTo,
//      called from the robot card's ⋯ menu). The mounted video renders on the
//      robot card itself (app.js's attachedCameraHtml), not here.
//   2. Let Pip grab a frame from any paired phone's camera on demand
//      (list_helpers / take_helper_snapshot / start_helper_camera /
//      stop_helper_camera Pip tools), even when that phone isn't mounted on
//      any robot. That needs a live <video> to decode into — see
//      _ensureDecodeEl below — but it's never shown to the user.
//
// A "Helpers" card list used to live here (phone + local-webcam preview
// tiles, camera-role pickers). Removed 2026-07: the capability above never
// needed it — mount and Pip's tools are both driven headlessly — and it was
// the only thing keeping a permanently-visible section on screen for a
// feature nobody was choosing roles on day to day.

let _renderRobot = () => {};
export function setHelpersRobotRenderer(fn) { _renderRobot = fn; }

// phones.js pushes here via setPhoneStream when peer.onTrack fires.
// phoneId (= pairing roomId) → { stream, trackSettings, startedAt }.
const _phoneStreams = new Map();

// Phone-camera → robot routing. phoneId → robotId. Populated by the
// "Mount camera" picker; cleared on detach or full disconnect.
const _phoneAttachments = new Map();

// Off-screen decode buffer per live phone stream — phoneId → <video>.
// Not attached to any visible layout; exists purely so takeHelperSnapshot
// has a frame to draw from. Kept at real (if tiny) dimensions and
// opacity:0 rather than display:none — some browsers stop decoding
// frames on display:none video elements.
const _decodeEls = new Map();

function ensureDecodeEl(phoneId, stream) {
  let v = _decodeEls.get(phoneId);
  if (!v) {
    v = document.createElement("video");
    v.autoplay = true;
    v.playsInline = true;
    v.muted = true;
    v.style.cssText = "position:fixed; left:-9999px; top:0; width:2px; height:2px; opacity:0; pointer-events:none;";
    document.body.appendChild(v);
    _decodeEls.set(phoneId, v);
  }
  if (v.srcObject !== stream) v.srcObject = stream;
  return v;
}

function dropDecodeEl(phoneId) {
  const v = _decodeEls.get(phoneId);
  if (!v) return;
  v.srcObject = null;
  v.remove();
  _decodeEls.delete(phoneId);
}

export function listHelpers() {
  const out = [];
  for (const p of listPhones()) {
    const ps = _phoneStreams.get(p.id);
    out.push({
      id: `phone:${p.id}`, kind: "phone", label: p.label || "Phone",
      status: p.status, connectedAt: p.connectedAt,
      live: !!ps,
      resolution: ps?.trackSettings
        ? { width: ps.trackSettings.width, height: ps.trackSettings.height }
        : null,
    });
  }
  return out;
}

// Wire in from phones.js: peer.onTrack → setPhoneStream(phoneId, stream).
// Null stream clears the entry (phone stopped sharing or disconnected).
export function setPhoneStream(phoneId, stream) {
  if (stream) {
    const track = stream.getVideoTracks()[0];
    _phoneStreams.set(phoneId, {
      stream,
      startedAt: Date.now(),
      trackSettings: track ? track.getSettings() : null,
    });
    ensureDecodeEl(phoneId, stream);
    routeAttachedStream(phoneId, stream);
  } else {
    _phoneStreams.delete(phoneId);
    dropDecodeEl(phoneId);
    // Phone stopped sharing or disconnected — clear routing too. If it
    // re-shares while still paired, mounting it again is a fresh user choice.
    const attachedTo = _phoneAttachments.get(phoneId);
    if (attachedTo) {
      _phoneAttachments.delete(phoneId);
      const robot = state.devices.get(attachedTo);
      if (robot && robot.attachedFromPhoneId === phoneId) {
        robot.attachedCameraStream = null;
        robot.attachedFromPhoneId = null;
        _renderRobot(robot);
        // Tell other phones the robot's "view" just changed (the
        // attached camera went away). They drop the forwarded track.
        notifyRobotStreamChange(robot);
      }
    }
  }
}

function routeAttachedStream(phoneId, stream) {
  const robotId = _phoneAttachments.get(phoneId);
  if (!robotId) return;
  const robot = state.devices.get(robotId);
  if (!robot) return;
  robot.attachedCameraStream = stream;
  robot.attachedFromPhoneId = phoneId;
  _renderRobot(robot);
  // Forward the now-attached stream to all OTHER paired phones so they
  // see what this robot is currently using as its eye. syncRobotMedia
  // skips the source phone (no echo).
  notifyRobotStreamChange(robot);
}

// Mount a phone's camera onto robot. Called from the robot card's ⋯ menu.
// Idempotent. Detaches from any previous robot first. Empty/null robotId
// detaches.
export function attachPhoneCameraTo(phoneId, robotId) {
  const prev = _phoneAttachments.get(phoneId) || null;
  if (prev === robotId) return;
  if (prev) {
    const prevRobot = state.devices.get(prev);
    if (prevRobot && prevRobot.attachedFromPhoneId === phoneId) {
      prevRobot.attachedCameraStream = null;
      prevRobot.attachedFromPhoneId = null;
      _renderRobot(prevRobot);
    }
  }
  if (!robotId) {
    _phoneAttachments.delete(phoneId);
    busEmit(TOPICS.PHONE_DETACHED, { phoneId });
  } else {
    _phoneAttachments.set(phoneId, robotId);
    const ps = _phoneStreams.get(phoneId);
    if (ps?.stream) routeAttachedStream(phoneId, ps.stream);
    const robot = state.devices.get(robotId);
    busEmit(TOPICS.PHONE_ATTACHED, { phoneId, robotId, robotLabel: robot?.name || null });
  }
}

export function getPhoneAttachment(phoneId) {
  return _phoneAttachments.get(phoneId) || null;
}

export async function startHelperCamera(helperId) {
  if (helperId.startsWith("phone:")) {
    // Browsers gate getUserMedia() behind a user gesture in the phone's
    // own browser tab — desktop can't toggle it remotely. We relay a
    // share request over the data channel; the phone shows a one-tap
    // prompt where the user's tap on Share IS the gesture. This call
    // awaits the phone's reply (or 60s timeout). See
    // requestPhoneCameraShare in phones.js + showCameraShareRequest in
    // mobile.js for the wire shape.
    const phoneId = helperId.slice("phone:".length);
    if (_phoneStreams.has(phoneId)) return { ok: true, already: true };
    try {
      return await requestPhoneCameraShare(phoneId);
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }
  return { ok: false, error: `unknown helper: ${helperId}` };
}

export async function stopHelperCamera(helperId) {
  if (helperId.startsWith("phone:")) {
    // Same gesture-scope constraint as start, in reverse. We could relay
    // a stop-prompt but the inconvenience is much lower than the start
    // case (the camera-running indicator is visible on the phone), so
    // leaving this as a guidance message for now.
    return { ok: false, error: "tap Stop sharing on the phone to end the stream" };
  }
  return { ok: false, error: `unknown helper: ${helperId}` };
}

export function takeHelperSnapshot(helperId) {
  if (helperId.startsWith("phone:")) {
    const phoneId = helperId.slice("phone:".length);
    return captureFromVideoEl(phoneId, _phoneStreams.has(phoneId));
  }
  return { error: `unknown helper: ${helperId}` };
}

// isLive guards against a stale decode element left over from a just-ended
// stream (dropDecodeEl removes it, but a snapshot could race the teardown).
function captureFromVideoEl(phoneId, isLive, maxDim = 640, quality = 0.8) {
  const v = _decodeEls.get(phoneId);
  if (!v || !isLive) {
    return { error: `phone:${phoneId}: no live stream — start the camera first` };
  }
  let w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) return { error: `phone:${phoneId}: frame not ready yet` };
  if (Math.max(w, h) > maxDim) {
    const s = maxDim / Math.max(w, h);
    w = Math.round(w * s); h = Math.round(h * s);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  try {
    canvas.getContext("2d").drawImage(v, 0, 0, w, h);
    return { imageDataUrl: canvas.toDataURL("image/jpeg", quality), width: w, height: h };
  } catch (err) {
    return { error: `frame capture failed: ${err?.message || err}` };
  }
}
