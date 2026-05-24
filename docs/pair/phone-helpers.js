import { $, escapeHtml } from "../dom.js";
import { listPhones, setPhonesChangeHandler, notifyRobotStreamChange, requestPhoneCameraShare, setPhoneFeedStream } from "./phones.js";
import { emit as busEmit, TOPICS } from "../event-bus.js";
import { state } from "../state.js";
import { settings, saveSettings } from "../settings.js";
import { setOverheadSource, clearOverheadSource } from "../perception/aruco.js";

// Permanent print-marker affordance, rendered whenever a helper is the
// active overhead source. Single source of truth (no duplication into
// the status pill on persistent empty — the hint already covers it).
const MARKERS_HINT = `<div class="helper-markers-hint">Markers · print <a href="assets/aruco_markers_0.pdf" target="_blank" rel="noopener">Sheet 1</a> · <a href="assets/aruco_markers_1.pdf" target="_blank" rel="noopener">Sheet 2</a> · tape one flat on each robot.</div>`;

// Phone cameras can be MOUNTED on a robot (phone-as-eye: strap the phone
// to the rover for a second camera). Mounted streams route to
// robot.attachedCameraStream; the helper card shows the routing instead
// of local preview. Session-scoped (phones already are).

let _renderRobot = () => {};
export function setHelpersRobotRenderer(fn) { _renderRobot = fn; }

// phones.js pushes here via setPhoneStream when peer.onTrack fires.
// phoneId (= pairing roomId) → { stream, trackSettings, startedAt }.
const _phoneStreams = new Map();

// Phone-camera → robot routing. phoneId → robotId. Populated by the
// "Mount camera" picker; cleared on detach or full disconnect.
const _phoneAttachments = new Map();

let _videoEls = new Map();  // helperId → <video> element (live video)

// Local videoinputs (laptop webcam, USB cams). enumerateDevices() returns
// stable deviceIds; labels only resolve after the user grants getUserMedia
// permission, so first paint is "Camera 1", "Camera 2" until activated.
// stream is null until designated a role — we don't open every camera
// just to list it. devicechange triggers re-enumeration.
// deviceId → { deviceId, label, stream | null, trackSettings | null }
const _localCameras = new Map();

// Runtime-only marker for the "send to paired phones" role. Not
// persisted — pushing a webcam to phones is an in-session intent, and
// auto-resuming a camera-light to "on" across reloads would be
// surprising. Mutually exclusive with overhead on the same cam, and
// global-singleton across cams (only one feed at a time).
let _phoneFeedLocalId = null;

export function initHelpers() {
  setPhonesChangeHandler(() => render());
  (async () => {
    await enumerateLocalCameras();
    await maybeAutoResumeLocalOverhead();
  })();
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => enumerateLocalCameras());
  }
  wireDelegation();
  render();
}

// Persisted "this camera is overhead" survives reloads, but the
// MediaStream doesn't — getUserMedia has to be called again. Auto-resume
// the stream IF the browser still considers camera permission granted
// (no surprise prompts). On any failure, clear the stale designation so
// the UI doesn't lie about state.
async function maybeAutoResumeLocalOverhead() {
  const deviceId = settings.arucoOverheadLocalId;
  if (!deviceId || !_localCameras.has(deviceId)) {
    if (deviceId) { settings.arucoOverheadLocalId = null; saveSettings(); render(); }
    return;
  }
  let granted = false;
  try {
    if (navigator.permissions?.query) {
      const perm = await navigator.permissions.query({ name: "camera" });
      granted = perm.state === "granted";
    }
  } catch { /* Permissions API not supported; bail rather than prompting */ }
  if (!granted) {
    settings.arucoOverheadLocalId = null;
    saveSettings();
    render();
    return;
  }
  await setLocalCameraRole(deviceId, "overhead", { silent: true });
}

// Strip the hardware-id suffix that browsers append to camera labels —
// "MacBook Pro Camera (0000:0001)" → "MacBook Pro Camera". The suffix is
// useful for disambiguation if you have two identical cameras; collapse
// it otherwise. (Identical-name collisions are rare and we'll handle
// them when we see one.)
function cleanCameraLabel(raw, fallbackIdx) {
  if (!raw) return `Camera ${fallbackIdx}`;
  return raw.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "").trim() || raw;
}

async function enumerateLocalCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  let cams;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    cams = devs.filter(d => d.kind === "videoinput");
  } catch { return; }
  const seen = new Set();
  let idx = 1;
  for (const d of cams) {
    seen.add(d.deviceId);
    const existing = _localCameras.get(d.deviceId);
    if (existing) {
      if (d.label) existing.label = cleanCameraLabel(d.label, idx);
    } else {
      _localCameras.set(d.deviceId, {
        deviceId: d.deviceId,
        label: cleanCameraLabel(d.label, idx),
        stream: null,
        trackSettings: null,
      });
    }
    idx += 1;
  }
  for (const id of [..._localCameras.keys()]) {
    if (seen.has(id)) continue;
    const cam = _localCameras.get(id);
    if (cam.stream) cam.stream.getTracks().forEach(t => t.stop());
    _localCameras.delete(id);
    if (settings.arucoOverheadLocalId === id) {
      settings.arucoOverheadLocalId = null;
      saveSettings();
    }
    if (_phoneFeedLocalId === id) {
      _phoneFeedLocalId = null;
      setPhoneFeedStream(null);
    }
  }
  render();
}

// Called from app.js after robot connect/disconnect so the mount picker
// reflects current robots.
export function renderHelpers() { render(); }

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
    routeAttachedStream(phoneId, stream);
  } else {
    _phoneStreams.delete(phoneId);
    _videoEls.delete(`phone:${phoneId}`);
    // Phone stopped sharing or disconnected — clear routing too. If it
    // re-shares while still paired, it lands back in the helper card;
    // re-mount is a fresh user choice.
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
  render();
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
//
// Mount and overhead are mutually exclusive — attaching auto-clears any
// overhead designation on this phone. The previous single-dropdown shape
// enforced this on the role-setter; now that attach lives in a different
// surface, the invariant is enforced here so every caller (UI, future
// Pip tool calls) gets consistent state.
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
    if (settings.arucoOverheadPhoneId === phoneId) {
      settings.arucoOverheadPhoneId = null;
      saveSettings();
    }
    _phoneAttachments.set(phoneId, robotId);
    const ps = _phoneStreams.get(phoneId);
    if (ps?.stream) routeAttachedStream(phoneId, ps.stream);
    const robot = state.devices.get(robotId);
    busEmit(TOPICS.PHONE_ATTACHED, { phoneId, robotId, robotLabel: robot?.name || null });
  }
  render();
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
    return captureFromVideoEl(helperId, _phoneStreams.has(phoneId));
  }
  return { error: `unknown helper: ${helperId}` };
}

// The videoEl is looked up from _videoEls (populated in wire() after
// render); isLive guards against stale video elements left over from a
// just-ended stream.
function captureFromVideoEl(helperId, isLive, maxDim = 640, quality = 0.8) {
  const v = _videoEls.get(helperId);
  if (!v || !isLive) {
    return { error: `${helperId}: no live stream — start the camera first` };
  }
  let w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) return { error: `${helperId}: frame not ready yet` };
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

function render() {
  const list = $("helpers-list");
  if (!list) return;
  // Local cameras are gated behind "user has something to localize" — a
  // first-time visitor with no robots paired shouldn't be confronted with
  // a "Camera role" picker for their MacBook camera before they know what
  // any of this means. Once a robot or phone is in play, the local cam
  // becomes context-relevant and shows up. Always show if one is already
  // active (don't strand the user in a session they've already started).
  const hasContext = state.devices.size > 0 || listPhones().length > 0;
  const localActive = [..._localCameras.values()].some(c => c.stream)
    || !!settings.arucoOverheadLocalId;
  const showLocalCams = hasContext || localActive;
  const cards = [
    ...listPhones().map(renderPhoneCard),
    ...(showLocalCams ? [..._localCameras.values()].map(renderLocalCameraCard) : []),
  ];
  list.innerHTML = cards.join("");
  wire();
}

function statusClass(p) {
  if (p.status === "connected") return "status-connected";
  if (p.status === "reconnecting" || p.status === "starting") return "status-connecting";
  if (p.status === "error") return "status-error";
  return "";
}

function renderPhoneCard(p) {
  const cls = statusClass(p);
  // Drop transient text — the row's status-* class tints already. Words
  // earn their place only when terminal (error) or unknown (raw status).
  const statusText = p.status === "error"
    ? "Offline"
    : (p.status === "connected" || p.status === "reconnecting")
      ? ""
      : escapeHtml(p.status);
  const ps = _phoneStreams.get(p.id);
  const live = !!ps;
  const helperId = `phone:${p.id}`;
  const attachedTo = _phoneAttachments.get(p.id) || null;
  const attachedRobot = attachedTo ? state.devices.get(attachedTo) : null;
  const isOverhead = live && settings.arucoOverheadPhoneId === p.id;
  const res = ps?.trackSettings ? `${ps.trackSettings.width || "?"}×${ps.trackSettings.height || "?"}` : "";
  const meta = isOverhead
    ? `Overhead localization · ${res}`
    : attachedRobot
      ? `Camera mounted on ${escapeHtml(attachedRobot.name)}`
      : live
        ? `Sharing camera · ${res}`
        : escapeHtml(`id ${p.id.slice(0, 8)}…`);

  // "Camera role" picker — operator / overhead are mutually exclusive
  // (a phone's camera does one job at a time). Hidden when the camera is
  // mounted on a robot: that attachment is robot-centric and lives on the
  // robot card (see attachPhoneCameraTo callers in app.js). The mounted
  // status surfaces in the meta line above.
  const currentRole = isOverhead ? "overhead" : "operator";
  const rolePicker = (live && !attachedRobot) ? `
    <label class="phone-mount">
      <span class="meta-prose">Camera role</span>
      <select data-action="phone-role" data-phone-id="${escapeHtml(p.id)}">
        <option value="operator" ${currentRole === "operator" ? "selected" : ""}>Operator (hand-held)</option>
        <option value="overhead" ${currentRole === "overhead" ? "selected" : ""}>Overhead localization</option>
      </select>
    </label>
  ` : "";

  // Attached mode has one option (operator-cam) now that pip-face is
  // extracted to its own repo; no picker needed.
  const picker = rolePicker;

  // Preview tile lives here whenever the stream isn't mounted on a robot.
  // When overhead is designated, an SVG overlay paints detected markers
  // on the same tile — no second video element, no duplicate decode.
  const body = (live && !attachedTo) ? `
    ${isOverhead ? MARKERS_HINT : ""}
    <div class="helper-preview">
      <video class="helper-video" data-helper-video="${escapeHtml(helperId)}" autoplay playsinline muted></video>
      ${isOverhead ? `<svg class="aruco-overlay" data-aruco-overlay-id="${escapeHtml(helperId)}"></svg>` : ""}
    </div>
    ${isOverhead ? `<div class="meta aruco-status" data-aruco-status-id="${escapeHtml(helperId)}">Loading detector…</div>` : ""}
  ` : "";
  return `
    <section class="card robot helper ${cls}" data-helper-id="${escapeHtml(helperId)}">
      <div class="row">
        <div class="robot-identity">
          <div class="label-btn">
            ${escapeHtml(p.label || "Phone")}
            <span class="type-badge">PHONE</span>
          </div>
          ${statusText ? `<div class="status">${statusText}</div>` : ""}
        </div>
      </div>
      <div class="robot-secondary">
        <div class="robot-meta">${meta}</div>
      </div>
      ${picker}
      ${body ? `<div class="robot-body">${body}</div>` : ""}
    </section>
  `;
}

// Local cameras have a smaller role surface than phones — they can't mount
// on a robot via WebRTC, and "operator" doesn't apply. Picker carries
// Overhead localization and Send to phone; the unselected placeholder
// *is* the inactive state (no spurious "Idle" role).
function renderLocalCameraCard(c) {
  const helperId = `local:${c.deviceId}`;
  const live = !!c.stream;
  const isOverhead = settings.arucoOverheadLocalId === c.deviceId;
  const isPhoneFeed = _phoneFeedLocalId === c.deviceId;
  const res = c.trackSettings ? `${c.trackSettings.width || "?"}×${c.trackSettings.height || "?"}` : "";
  // Mirror the phone card's "live AND designated" check — without it, the
  // dropdown reads "Overhead localization" after a reload (setting persists)
  // even though the stream is dead, which is dishonest UX.
  const isActive = (isOverhead || isPhoneFeed) && live;
  const meta = isActive
    ? `${isOverhead ? "Overhead localization" : "Sent to phone"} · ${res}`
    : "";
  const currentRole = isOverhead ? "overhead" : isPhoneFeed ? "phone-feed" : "";
  const picker = `
    <label class="phone-mount ${isActive ? "" : "is-placeholder"}">
      <span class="meta-prose">Camera role</span>
      <select data-action="local-role" data-local-id="${escapeHtml(c.deviceId)}">
        <option value="" ${currentRole === "" ? "selected" : ""}>Choose role…</option>
        <option value="overhead" ${currentRole === "overhead" ? "selected" : ""}>Overhead localization</option>
        <option value="phone-feed" ${currentRole === "phone-feed" ? "selected" : ""}>Send to phone</option>
      </select>
    </label>
  `;
  const body = live && isOverhead ? `
    ${MARKERS_HINT}
    <div class="helper-preview">
      <video class="helper-video" data-helper-video="${escapeHtml(helperId)}" autoplay playsinline muted></video>
      <svg class="aruco-overlay" data-aruco-overlay-id="${escapeHtml(helperId)}"></svg>
    </div>
    <div class="meta aruco-status" data-aruco-status-id="${escapeHtml(helperId)}">Loading detector…</div>
  ` : live && isPhoneFeed ? `
    <div class="helper-preview">
      <video class="helper-video" data-helper-video="${escapeHtml(helperId)}" autoplay playsinline muted></video>
    </div>
  ` : "";
  return `
    <section class="card robot helper" data-helper-id="${escapeHtml(helperId)}">
      <div class="row">
        <div class="robot-identity">
          <div class="label-btn">
            ${escapeHtml(c.label || "Camera")}
            <span class="type-badge">LOCAL</span>
          </div>
        </div>
      </div>
      ${meta ? `<div class="robot-secondary"><div class="robot-meta">${meta}</div></div>` : ""}
      ${picker}
      ${body ? `<div class="robot-body">${body}</div>` : ""}
    </section>
  `;
}

// Stops any other-camera designation in flight (local or phone), since
// overhead is exclusive across the whole helpers list — there's only one
// overhead at a time.
function clearOtherOverhead(except) {
  if (settings.arucoOverheadPhoneId && except !== `phone:${settings.arucoOverheadPhoneId}`) {
    settings.arucoOverheadPhoneId = null;
  }
  if (settings.arucoOverheadLocalId && except !== `local:${settings.arucoOverheadLocalId}`) {
    const other = _localCameras.get(settings.arucoOverheadLocalId);
    if (other?.stream) {
      other.stream.getTracks().forEach(t => t.stop());
      other.stream = null;
      other.trackSettings = null;
    }
    settings.arucoOverheadLocalId = null;
  }
}

// What is this phone's camera doing — operator (default) or overhead.
// Mount-on-robot is exclusive with both and set via attachPhoneCameraTo
// (called from the robot card's menu, not here). The picker is hidden
// whenever the phone is already mounted, so this setter only sees
// operator/overhead transitions.
function setPhoneRole(phoneId, role) {
  if (role === "overhead") {
    clearOtherOverhead(`phone:${phoneId}`);
    settings.arucoOverheadPhoneId = phoneId;
  } else {
    if (settings.arucoOverheadPhoneId === phoneId) settings.arucoOverheadPhoneId = null;
  }
  saveSettings();
  render();
}

// Tracks which deviceId the user CURRENTLY intends for overhead while a
// getUserMedia call is in flight. If they switch away (to Idle, or to a
// different camera) before the stream resolves, the resolved stream is
// dropped rather than applied — otherwise the orphan stream keeps running
// and the camera light stays on.
let _pendingLocalOverhead = null;

// `silent` suppresses the warn on getUserMedia failure — used for the
// auto-resume path where failure is the expected outcome whenever the
// origin or device set changed since the last session (deviceIds scope
// per-origin, so a Cloudflare-tunnel reload will mismatch).
//
// Roles: "overhead" (decoded by aruco) | "phone-feed" (forwarded to
// paired phones) | anything else = off. One role per cam at a time;
// changing role on the same cam stops and re-acquires the stream.
async function setLocalCameraRole(deviceId, role, { silent = false } = {}) {
  const cam = _localCameras.get(deviceId);
  if (!cam) return;

  // Off branch: drop any role this cam held, stop its stream.
  if (role !== "overhead" && role !== "phone-feed") {
    _pendingLocalOverhead = null;
    if (cam.stream) cam.stream.getTracks().forEach(t => t.stop());
    cam.stream = null;
    cam.trackSettings = null;
    if (settings.arucoOverheadLocalId === deviceId) settings.arucoOverheadLocalId = null;
    if (_phoneFeedLocalId === deviceId) {
      _phoneFeedLocalId = null;
      setPhoneFeedStream(null);
    }
    saveSettings();
    render();
    return;
  }

  // Active role: clear conflicts then acquire. Drop any prior stream on
  // this cam first (covers role transitions on the same deviceId).
  if (cam.stream) {
    cam.stream.getTracks().forEach(t => t.stop());
    cam.stream = null;
    cam.trackSettings = null;
  }
  if (role === "overhead") {
    _pendingLocalOverhead = deviceId;
    clearOtherOverhead(`local:${deviceId}`);
    if (_phoneFeedLocalId === deviceId) {
      _phoneFeedLocalId = null;
      setPhoneFeedStream(null);
    }
  } else {
    _pendingLocalOverhead = null;
    if (settings.arucoOverheadLocalId === deviceId) settings.arucoOverheadLocalId = null;
    if (_phoneFeedLocalId && _phoneFeedLocalId !== deviceId) {
      const other = _localCameras.get(_phoneFeedLocalId);
      if (other?.stream) {
        other.stream.getTracks().forEach(t => t.stop());
        other.stream = null;
        other.trackSettings = null;
      }
      _phoneFeedLocalId = null;
      setPhoneFeedStream(null);
    }
  }

  try {
    // `enumerateDevices()` returns videoinputs with EMPTY deviceId
    // strings until camera permission is granted for the origin. Passing
    // `exact: ""` then throws OverconstrainedError. Skip the constraint
    // until we have a real ID (the long hash form); the resolved track's
    // getSettings().deviceId tells us which camera we actually got.
    const hasRealId = !!deviceId && deviceId.length >= 16;
    const constraints = hasRealId
      ? { video: { deviceId: { exact: deviceId } } }
      : { video: true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (role === "overhead" && _pendingLocalOverhead !== deviceId) {
      // User switched intent mid-await. Stop the just-acquired tracks
      // and bail — the off-branch already cleared state.
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    const track = stream.getVideoTracks()[0];
    const trackSettings = track ? track.getSettings() : null;
    const actualDeviceId = trackSettings?.deviceId || deviceId;
    // If we used {video:true} and the browser picked a different id
    // than our placeholder, migrate the entry to the real id so future
    // sessions can exact-match it.
    let target = cam;
    if (actualDeviceId !== deviceId) {
      _localCameras.delete(deviceId);
      if (!_localCameras.has(actualDeviceId)) {
        _localCameras.set(actualDeviceId, { deviceId: actualDeviceId, label: cam.label, stream: null, trackSettings: null });
      }
      target = _localCameras.get(actualDeviceId);
    }
    target.stream = stream;
    target.trackSettings = trackSettings;
    // OS-level revoke / camera unplug fires `ended` on the track.
    // Reflect that in UI immediately instead of leaving a dead stream
    // dribbling blank frames into the detector / phone feed.
    for (const t of stream.getTracks()) {
      t.addEventListener("ended", () => {
        if (target.stream === stream) setLocalCameraRole(actualDeviceId, "off");
      }, { once: true });
    }
    if (role === "overhead") {
      settings.arucoOverheadLocalId = actualDeviceId;
    } else {
      _phoneFeedLocalId = actualDeviceId;
      setPhoneFeedStream(stream);
    }
    // Permission grant unlocks labels for OTHER cameras too — re-enumerate
    // so the picker shows real names next time it opens.
    enumerateLocalCameras();
  } catch (err) {
    cam.stream = null;
    cam.trackSettings = null;
    if (role === "overhead" && settings.arucoOverheadLocalId === deviceId) settings.arucoOverheadLocalId = null;
    if (role === "phone-feed" && _phoneFeedLocalId === deviceId) {
      _phoneFeedLocalId = null;
      setPhoneFeedStream(null);
    }
    if (!silent) console.warn("[helpers] getUserMedia failed:", err);
  }
  saveSettings();
  render();
}

// Reconcile the active overhead designation (phone OR local) with the
// live DOM. Called after every render so a fresh <video> element
// (innerHTML rebuild) gets wired to the detection loop. setOverheadSource
// is element-identity-cached so repeat calls with the same element are cheap.
function applyOverheadDesignation() {
  let helperId = null;
  if (settings.arucoOverheadPhoneId && _phoneStreams.has(settings.arucoOverheadPhoneId)) {
    helperId = `phone:${settings.arucoOverheadPhoneId}`;
  } else if (settings.arucoOverheadLocalId) {
    const cam = _localCameras.get(settings.arucoOverheadLocalId);
    if (cam?.stream) helperId = `local:${cam.deviceId}`;
  }
  if (!helperId) { clearOverheadSource(); return; }
  const list = $("helpers-list");
  const videoEl = list?.querySelector(`[data-helper-video="${CSS.escape(helperId)}"]`);
  if (!videoEl) { clearOverheadSource(); return; }
  setOverheadSource(videoEl, { onResult: (r) => paintOverhead(helperId, r) });
}

function paintOverhead(helperId, { markers, frameCount, error }) {
  const list = $("helpers-list");
  if (!list) return;
  const svg = list.querySelector(`svg[data-aruco-overlay-id="${CSS.escape(helperId)}"]`);
  const status = list.querySelector(`[data-aruco-status-id="${CSS.escape(helperId)}"]`);
  if (!svg) return;
  if (error) {
    svg.innerHTML = "";
    if (status) { status.textContent = `Detector: ${error}`; status.classList.remove("aruco-locked"); }
    return;
  }
  if (markers.length === 0) {
    svg.innerHTML = "";
    if (status) {
      status.classList.remove("aruco-locked");
      status.textContent = frameCount > 5
        ? "No markers in view"
        : `Scanning · ${frameCount} frame${frameCount === 1 ? "" : "s"} · no marker yet`;
    }
    return;
  }
  const { frameW, frameH } = markers[0];
  svg.setAttribute("viewBox", `0 0 ${frameW} ${frameH}`);
  const pieces = [];
  for (const m of markers) {
    const pts = m.corners.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
    const len = Math.min(frameW, frameH) * 0.08;
    const hx = m.cx + Math.cos(m.headingRad) * len;
    const hy = m.cy + Math.sin(m.headingRad) * len;
    pieces.push(`<polygon points="${pts}" />`);
    pieces.push(`<line x1="${m.cx.toFixed(1)}" y1="${m.cy.toFixed(1)}" x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}" class="heading" />`);
    const label = m.entry ? m.entry.name : `id ${m.id}`;
    pieces.push(`<text x="${m.cx.toFixed(1)}" y="${m.cy.toFixed(1)}" dy="-8">${escapeHtml(label)}</text>`);
  }
  svg.innerHTML = pieces.join("");
  if (status) {
    const bound = markers.filter(m => m.entry).length;
    status.textContent = `Tracking ${markers.length} marker${markers.length === 1 ? "" : "s"} · ${bound} bound · frame ${frameCount}`;
    status.classList.add("aruco-locked");
  }
}

// One delegated change-listener on the helpers list so we don't re-
// attach per-element handlers every time render() rebuilds the
// innerHTML. Wired once from initHelpers; subsequent renders inherit.
function wireDelegation() {
  const list = $("helpers-list");
  if (!list) return;
  list.addEventListener("change", (e) => {
    const sel = e.target.closest("select[data-action]");
    if (!sel) return;
    switch (sel.dataset.action) {
      case "phone-role":
        setPhoneRole(sel.dataset.phoneId, sel.value);
        return;
      case "local-role":
        // Empty value = placeholder = no role active; setter takes "off".
        setLocalCameraRole(sel.dataset.localId, sel.value || "off");
        return;
    }
  });
}

function wire() {
  const list = $("helpers-list");
  if (!list) return;

  // Mount the live MediaStream into the freshly-rendered <video> elements.
  // Has to happen after innerHTML rebuild — srcObject before DOM attach is
  // OK but we re-render on every state change so we re-attach unconditionally.
  for (const [phoneId, entry] of _phoneStreams) {
    const helperId = `phone:${phoneId}`;
    const pv = list.querySelector(`[data-helper-video="${CSS.escape(helperId)}"]`);
    if (pv && entry.stream) {
      if (pv.srcObject !== entry.stream) pv.srcObject = entry.stream;
      _videoEls.set(helperId, pv);
    }
  }
  for (const cam of _localCameras.values()) {
    if (!cam.stream) continue;
    const helperId = `local:${cam.deviceId}`;
    const pv = list.querySelector(`[data-helper-video="${CSS.escape(helperId)}"]`);
    if (pv) {
      if (pv.srcObject !== cam.stream) pv.srcObject = cam.stream;
      _videoEls.set(helperId, pv);
    }
  }
  applyOverheadDesignation();
}
