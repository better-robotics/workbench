import { $ } from "./dom.js";
import { joinPairingRoom } from "./pairing.js";
import { attachJoypad } from "./joypad.js";
import { getMyPubkeyB64 } from "./signal-sdk/v1/peer-key.js";
import { makeTrustStore } from "./trust.js";
import {
  setupServiceWorker, wireInstallMenuItem, wireCheckUpdatesMenuItem,
  wireHardRefresh, wireDiagnosticsMenuItem, setReportIssueLink, readSwVersion,
} from "./app-menu.js";
import { wireTiltDrive, stopTilt } from "./mobile-tilt-drive.js";
import {
  showReconnect, hideReconnect, wireReconnect, cameraUnavailableReason,
} from "./mobile-qr-scan.js";
import { startNearbyDiscovery, deviceLabel } from "./mobile-nearby-discovery.js";
import { mountPipFace, unmountPipFace, applyPipEvent } from "./mobile-pip-face.js";
const _trust = makeTrustStore("better-robotics:trust:v1");

let _peer = null;
let _pending = false;
let _joypad = null;

function setStatus(state, text) {
  const dot = $("phone-status-dot");
  dot.className = `dot${state ? ` ${state}` : ""}`;
  $("phone-status-text").textContent = text;
}

// Wire (must match onPhoneMessage in phones.js):
//   phone→desktop  { type:"robot-command",        id, capability, args }
//   desktop→phone  { type:"robot-command-result", id, ok, data?|error? }
// Correlation id round-trips so racing commands resolve the right promise.
const _pendingCommands = new Map();  // id → { resolve, timeout }
function sendRobotCommand(capability, args = {}, timeoutMs = 5000) {
  if (!_peer) return Promise.resolve({ ok: false, error: "not paired" });
  const id = (crypto.randomUUID && crypto.randomUUID())
    || `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (!_pendingCommands.has(id)) return;
      _pendingCommands.delete(id);
      resolve({ ok: false, error: "timed out" });
    }, timeoutMs);
    _pendingCommands.set(id, { resolve, timeout });
    _peer.send({ type: "robot-command", id, capability, args });
  });
}

function showCommandStatus(text, kind) {
  const el = $("phone-command-status");
  if (!el) return;
  el.textContent = text;
  el.className = "phone-command-status" + (kind ? " " + kind : "");
  el.hidden = false;
  clearTimeout(showCommandStatus._t);
  showCommandStatus._t = setTimeout(() => { el.hidden = true; }, 3000);
}

function wireStopButton() {
  const btn = $("phone-stop-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const r = await sendRobotCommand("stop");
    btn.disabled = false;
    if (r.ok) showCommandStatus(`Stopped${r.data?.robot ? ` · ${r.data.robot}` : ""}`, "ok");
    else showCommandStatus(r.error || "Failed", "alert");
  });
}


// Shared phone-side dialog for ask-human and camera-share-request.
// One dialog on screen at a time; a second showPhoneAskDialog call
// replaces the first (the prior's pending response resolves through
// the server-side timeout). `options` is either:
//   - array of strings → tappable answer buttons (each calls onRespond
//     with its label, once)
//   - array of {label, onClick} → custom click handler (e.g. for the
//     camera-share Share button that needs to run async work)
// `freeText` enables the text input fallback when no options exist.
function showPhoneAskDialog({ question, imageDataUrl, options, freeText, skipValue, onRespond }) {
  const dialog = $("phone-ask-dialog");
  const img = $("phone-ask-image");
  const q = $("phone-ask-question");
  const optsEl = $("phone-ask-options");
  const free = $("phone-ask-free");
  const freeInput = $("phone-ask-free-input");
  let responded = false;
  const close = () => { if (!responded) { responded = true; dialog.close(); } };
  const respond = (answer) => {
    if (responded) return;
    responded = true;
    onRespond(answer);
    dialog.close();
  };

  if (imageDataUrl) { img.src = imageDataUrl; img.hidden = false; }
  else { img.hidden = true; img.src = ""; }
  q.textContent = question || "";

  optsEl.innerHTML = "";
  const hasOptions = Array.isArray(options) && options.length > 0;
  if (hasOptions) {
    for (const opt of options) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ask-option sm";
      if (typeof opt === "string") {
        b.textContent = opt;
        b.addEventListener("click", () => respond(opt), { once: true });
      } else {
        b.textContent = opt.label;
        b.addEventListener("click", () => opt.onClick({ respond, close }), { once: true });
      }
      optsEl.appendChild(b);
    }
  }

  if (freeText && !hasOptions) {
    free.hidden = false;
    freeInput.value = "";
    free.onsubmit = (e) => {
      e.preventDefault();
      const v = freeInput.value.trim();
      if (v) respond(v);
    };
  } else {
    free.hidden = true;
  }

  $("phone-ask-skip").onclick = () => respond(skipValue);
  if (!dialog.open) dialog.showModal();
  // Autofocus the free input so the soft keyboard pops up on mobile.
  if (!free.hidden) setTimeout(() => freeInput.focus(), 50);
}

function showAsk(msg) {
  showPhoneAskDialog({
    question: msg.question,
    imageDataUrl: msg.imageDataUrl,
    options: msg.options,
    freeText: true,
    skipValue: null,
    onRespond: (answer) => _peer?.send({ type: "ask-reply", askId: msg.askId, answer }),
  });
}

// Browsers won't let getUserMedia() run without a user gesture in
// this tab; the Share button click below IS that gesture. The handler
// reports back so the desktop's startHelperCamera tool resolves
// instead of dead-ending on a string error.
function showCameraShareRequest(msg) {
  const send = (result, error) => _peer?.send({
    type: "camera-share-result", requestId: msg.requestId, result, error,
  });
  showPhoneAskDialog({
    question: "Pip wants to use this phone's camera. Share it?",
    skipValue: "denied",
    onRespond: (answer) => send(answer ?? "denied"),
    options: [
      {
        label: _shareStream ? "Already sharing" : "Share camera",
        onClick: async ({ respond, close }) => {
          // Desktop sometimes asks before its onTrack handler has
          // registered the stream we already sent — short-circuit.
          if (_shareStream) { respond("shared"); return; }
          try {
            const res = await toggleShareCamera();
            if (res?.ok) respond("shared");
            else { send("error", res?.error || "getUserMedia returned no stream"); close(); }
          } catch (err) {
            send("error", err.message || String(err)); close();
          }
        },
      },
      { label: "Not now", onClick: ({ respond }) => respond("denied") },
    ],
  });
}

// Pairing layer fires onTrack per track; both video tracks of one stream
// share the same MediaStream so streams[0] is safe.
function onPeerTrack(e) {
  const v = $("phone-cam");
  const section = $("phone-cam-section");
  const stream = e.streams?.[0];
  if (!stream) return;
  if (v.srcObject !== stream) v.srcObject = stream;
  section.hidden = false;
  // When the remote ends the track (laptop user clicked Stop), hide the
  // section so the phone doesn't show a frozen last frame as if it were live.
  for (const t of stream.getTracks()) {
    t.addEventListener("ended", () => {
      // If all tracks are ended, hide. Other tracks may still be live.
      if (stream.getTracks().every(t2 => t2.readyState === "ended")) {
        section.hidden = true;
        v.srcObject = null;
      }
    });
  }
}

// robotId -> { sources, active }. Camera tile's tap handler renders a
// picker over this; updated when desktop notifies (track changes, attached
// camera mount/unmount).
const _availableSources = new Map();

// "Tap to switch source" only when there's more than one source for any
// robot (else the picker would lie about its job). aria state tracks
// the same condition — screen reader users hear "Camera" (passive
// description) when there's nothing to pick, "Pick camera source"
// (button affordance) when there is.
function updateCameraPickerHint() {
  const overlay = $("phone-cam-overlay");
  const tap = $("phone-cam-tap");
  const hasChoice = [..._availableSources.values()].some(s => (s.sources?.length || 0) > 1);
  if (overlay) overlay.hidden = !hasChoice;
  if (tap) {
    tap.setAttribute("aria-label", hasChoice ? "Pick camera source" : "Camera");
    tap.setAttribute("aria-disabled", hasChoice ? "false" : "true");
  }
}

function renderCameraPicker() {
  const wrap = $("phone-cam-picker");
  if (!wrap) return;
  // Each row is "<robot> · <source-label>" with a check on the active.
  // Tap sends subscribe-source for that robotId + sourceId.
  const rows = [];
  for (const [robotId, info] of _availableSources) {
    for (const s of info.sources || []) {
      const active = (info.active || s.kind) === s.id || info.active === s.id;
      rows.push({ robotId, source: s, active });
    }
  }
  if (!rows.length) { wrap.hidden = true; return; }
  wrap.innerHTML = rows.map(r => {
    const tag = r.source.fwType ? `<span class="type-badge type-${r.source.fwType}">${r.source.fwType === "esp32" ? "ESP32" : r.source.fwType.toUpperCase()}</span>` : "";
    return `<button class="phone-cam-pick-row${r.active ? " active" : ""}" type="button"
              data-robot-id="${r.robotId}" data-source-id="${r.source.id}">
              ${tag}<span>${r.source.label}</span>${r.active ? "<span class='phone-cam-pick-check'>✓</span>" : ""}
            </button>`;
  }).join("");
  wrap.hidden = false;
  wrap.querySelectorAll(".phone-cam-pick-row").forEach(btn => {
    btn.addEventListener("click", () => {
      const robotId = btn.dataset.robotId;
      const sourceId = btn.dataset.sourceId;
      try { _peer?.send?.({ type: "subscribe-source", robotId, sourceId }); } catch {}
      // Optimistic local update — the real authority is the next
      // available-sources message from desktop confirming the active.
      const info = _availableSources.get(robotId);
      if (info) { info.active = sourceId; _availableSources.set(robotId, info); }
      wrap.hidden = true;
      renderCameraPicker();  // refresh check marks for next open
    });
  });
}

function onPeerMessage(msg) {
  if (msg.type === "ask") { showAsk(msg); return; }
  if (msg.type === "request-camera-share") { showCameraShareRequest(msg); return; }
  if (msg.type === "screen-mode") { applyScreenMode(msg.mode, msg.robotLabel); return; }
  if (msg.type === "pip-event") { applyPipEvent(msg.event, msg); return; }
  if (msg.type === "available-sources") {
    _availableSources.set(msg.robotId, {
      sources: msg.sources || [], active: msg.active || null,
    });
    updateCameraPickerHint();
    return;
  }
  if (msg.type === "robot-command-result") {
    const pending = _pendingCommands.get(msg.id);
    if (!pending) return;  // late reply after timeout — drop silently
    clearTimeout(pending.timeout);
    _pendingCommands.delete(msg.id);
    pending.resolve({ ok: !!msg.ok, data: msg.data, error: msg.error });
    return;
  }
  if (msg.type === "target-info") {
    // Hide drive surface + panic stop when there's no robot to control.
    const driveSection = $("phone-drive");
    const cmdSection = $("phone-command");
    const targetEl = $("phone-drive-target");
    if (msg.target?.name) {
      driveSection.hidden = false;
      if (cmdSection) cmdSection.hidden = false;
      targetEl.textContent = `Driving: ${msg.target.name}`;
    } else {
      driveSection.hidden = true;
      if (cmdSection) cmdSection.hidden = true;
      targetEl.textContent = "No robot connected";
      _joypad?.reset();
    }
  }
}

// Phone-on-robot screen modes (set by the desktop via setPhoneScreenMode
// when the operator mounts a phone via attachPhoneCameraTo):
//   "operator-cam" — fullscreen incoming video (the operator's face if
//     a local cam's "Send to phone" role is on; black otherwise).
//   "pip-face"     — fullscreen SVG eyes that animate per pip-event.
//   "default"      — normal operator companion UI.
// In all attached modes the sticky Stop button stays visible (semi-
// transparent) so anyone in the room can still halt the robot. Desktop
// owns the choice; the phone has no local override. Reset on peer.
// onClose so a disconnect leaves the user with normal UI to reconnect.
let _currentScreenMode = "default";
function applyScreenMode(mode, robotLabel) {
  const body = document.body;
  // Same-mode re-emit (reconnect path): keep the mounted face's timer
  // chain alive instead of tearing down + remounting.
  if (mode === _currentScreenMode) {
    body.dataset.attachedTo = robotLabel || "";
    return;
  }
  body.classList.remove("phone-mounted", "phone-attached", "phone-face");
  delete body.dataset.attachedTo;
  unmountPipFace();
  const face = $("pip-face");
  if (face) face.hidden = true;
  if (mode === "operator-cam") {
    body.classList.add("phone-mounted", "phone-attached");
    body.dataset.attachedTo = robotLabel || "";
  } else if (mode === "pip-face") {
    body.classList.add("phone-mounted", "phone-face");
    body.dataset.attachedTo = robotLabel || "";
    if (face) {
      face.hidden = false;
      mountPipFace(face);
    }
  }
  _currentScreenMode = mode === "operator-cam" || mode === "pip-face" ? mode : "default";
}

function wireJoypad() {
  const pad = $("phone-joypad");
  const knob = pad?.querySelector(".joypad-knob");
  if (!pad || !knob) return;
  _joypad = attachJoypad(pad, knob, {
    onDrive: (l, r) => _peer?.send({ type: "drive", l, r }),
    onStop:  ()     => _peer?.send({ type: "drive", l: 0, r: 0 }),
  });
}


// Phone backgrounded (tab switch, screen lock, app switcher): emit a stop so
// the robot doesn't keep driving while the user can't see it, and kill any
// outgoing camera share (battery + privacy — don't keep streaming video
// the user can't see).
function wireBackgroundStop() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      _joypad?.reset();
      stopTilt();
      _peer?.send({ type: "drive", l: 0, r: 0 });
      _stopSharing();
    }
  });
}

// ── Phone-camera-as-helper ────────────────────────────────────────
//
// Toggle the phone's camera into the paired WebRTC connection as an
// outgoing media stream. Desktop picks it up via peer.onTrack and
// registers it in its helpers list (phone-helpers.js). Pairing layer handles
// renegotiation on addTrack — `negotiationneeded` fires, Peer
// re-offers, desktop answers, track lands on the other side.
//
// Front is default — it's the quick-share / "show me what I'm pointing at"
// idiom most users reach for. Back is the robot-mount idiom and is one tap
// away. "Back" resolves to the widest available rear lens (see
// openCameraStream below) — for every use case the phone serves, wider
// FOV beats the main sensor. While sharing, the segmented control
// live-switches via sender.replaceTrack so the desktop sees the same
// track slot — no renegotiation, no helper-card churn.
let _shareStream = null;
let _shareSenders = [];
let _shareFacing = "user";  // "user" (front) | "environment" (back)
let _shareSwitching = false;

// Find the widest available back lens by label. Returns null when
// labels are blank (permission not yet granted) or no ultra-wide is
// exposed (older iPhones, most Android phones). iOS post-17 labels look
// like "Back Ultra Wide Camera"; the 0.5 fallback catches third-party
// browser labelings.
async function findWidestBackLens() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const backs = devs.filter(d => d.kind === "videoinput" && d.label && /back/i.test(d.label));
    return backs.find(d => /ultra\s*wide|0\.5/i.test(d.label)) || null;
  } catch { return null; }
}

// Pick the widest available back lens when the user wants "Back". For
// every use case the phone serves here — mounted on the rover for FPV,
// hand-held showing Pip context, or just a quick view forwarded to the
// desktop — wider FOV beats the main sensor's narrower framing.
//
// Two paths:
//   Fast — labels already populated (permission granted in this session
//   or prior, since Safari/Chrome both persist origin permission). Pick
//   the ultra-wide deviceId up front, one getUserMedia call, no main-
//   lens flicker.
//   Slow — first-time permission or no ultra-wide visible. Open with
//   facingMode to surface the prompt and populate labels, then upgrade
//   if a wider lens is now available.
//
// Front (`user`) bypasses this — phones rarely expose multiple front
// lenses, and iOS may misbehave with deviceId selection on the front.
async function openCameraStream(facing) {
  if (facing !== "environment") {
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing } },
      audio: false,
    });
  }
  const preferred = await findWidestBackLens();
  if (preferred) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: preferred.deviceId } },
        audio: false,
      });
    } catch { /* stale deviceId or revoked permission — fall through */ }
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" } },
    audio: false,
  });
  const widest = await findWidestBackLens();
  if (!widest) return stream;
  const current = stream.getVideoTracks()[0]?.getSettings?.()?.deviceId;
  if (current === widest.deviceId) return stream;
  let upgraded;
  try {
    upgraded = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: widest.deviceId } },
      audio: false,
    });
  } catch { return stream; }
  stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
  return upgraded;
}

async function toggleShareCamera() {
  if (_shareStream) { _stopSharing(); return { ok: true, stopped: true }; }
  if (!navigator.mediaDevices?.getUserMedia) {
    const reason = cameraUnavailableReason();
    showCommandStatus(reason, "alert");
    return { ok: false, error: reason };
  }
  let stream;
  try {
    stream = await openCameraStream(_shareFacing);
  } catch (err) {
    showCommandStatus(`Camera unavailable: ${err.message || err}`, "alert");
    return { ok: false, error: err.message || String(err) };
  }
  _shareStream = stream;
  for (const t of stream.getVideoTracks()) {
    const sender = _peer?.addTrack?.(t, stream);
    if (sender) _shareSenders.push(sender);
    t.addEventListener("ended", () => _stopSharing());
  }
  const preview = $("phone-share-preview");
  if (preview) {
    preview.srcObject = stream;
    preview.hidden = false;
    preview.play?.().catch(() => {});
  }
  const btn = $("phone-share-btn");
  if (btn) { btn.textContent = "Stop sharing"; btn.classList.add("on"); }
  // Front/Back segmented is a live "flip camera" action — only meaningful
  // while a stream is running. Hidden by default; revealed here.
  const seg = $("phone-share-mode");
  if (seg) seg.hidden = false;
  return { ok: true };
}

// Swap the camera underneath the existing RTCRtpSender so the desktop
// sees no track change — just a different image. Only called while
// sharing (the segmented control is hidden otherwise), so the not-
// sharing branch is just a defensive bail.
//
// Mutation discipline: `_shareFacing` and the segmented buttons stay
// on the previous value until replaceTrack resolves. Otherwise a
// failed switch leaves the UI claiming a camera the desktop isn't
// actually receiving. Failures stop the just-opened stream and leave
// the existing share untouched.
function stopTracks(stream) {
  if (!stream) return;
  for (const t of stream.getTracks()) { try { t.stop(); } catch {} }
}

async function switchShareFacing(nextFacing) {
  if (nextFacing !== "user" && nextFacing !== "environment") return;
  if (_shareSwitching) return;
  if (!_shareStream) return;
  if (_shareFacing === nextFacing) return;

  _shareSwitching = true;
  let newStream = null;
  try {
    try {
      newStream = await openCameraStream(nextFacing);
    } catch (err) {
      showCommandStatus(`Camera unavailable: ${err.message || err}`, "alert");
      return;
    }
    // Sharing may have been stopped (user tapped Stop, peer closed,
    // tab backgrounded) during the getUserMedia await. Discard the new
    // stream and bail — _stopSharing already cleaned up.
    if (!_shareStream) { stopTracks(newStream); return; }
    const newTrack = newStream.getVideoTracks()[0];
    const sender = _shareSenders[0];
    if (!newTrack || !sender?.replaceTrack) {
      showCommandStatus("Switch failed: sender unavailable", "alert");
      stopTracks(newStream);
      return;
    }
    try {
      await sender.replaceTrack(newTrack);
    } catch (err) {
      showCommandStatus(`Switch failed: ${err.message || err}`, "alert");
      stopTracks(newStream);
      return;
    }
    // Sharing may have been stopped during the replaceTrack await too.
    // The track is now live on the sender but _stopSharing already
    // emptied _shareSenders, so stop the new stream and leave the
    // dead-sender path to clean itself up on next addTrack.
    if (!_shareStream) { stopTracks(newStream); return; }
    // Success — stop old tracks, swap stream + preview, commit UI state.
    stopTracks(_shareStream);
    _shareStream = new MediaStream([newTrack]);
    newTrack.addEventListener("ended", () => _stopSharing());
    _shareFacing = nextFacing;
    updateShareFacingButtons();
    const preview = $("phone-share-preview");
    if (preview) {
      preview.srcObject = _shareStream;
      preview.play?.().catch(() => {});
    }
  } finally {
    _shareSwitching = false;
  }
}

function updateShareFacingButtons() {
  const front = $("phone-share-mode-front");
  const back = $("phone-share-mode-back");
  if (front) front.setAttribute("aria-pressed", _shareFacing === "user" ? "true" : "false");
  if (back) back.setAttribute("aria-pressed", _shareFacing === "environment" ? "true" : "false");
}

function _stopSharing() {
  if (!_shareStream) return;
  for (const sender of _shareSenders) {
    try { _peer?.removeTrack?.(sender); } catch {}
  }
  _shareSenders = [];
  for (const t of _shareStream.getTracks()) { try { t.stop(); } catch {} }
  _shareStream = null;
  const preview = $("phone-share-preview");
  if (preview) { preview.srcObject = null; preview.hidden = true; }
  const btn = $("phone-share-btn");
  if (btn) { btn.textContent = "Share camera"; btn.classList.remove("on"); }
  // Segmented Front/Back has nothing to act on without a live stream.
  // Reset facing to the default so the next Share tap starts fresh.
  const seg = $("phone-share-mode");
  if (seg) seg.hidden = true;
  _shareFacing = "user";
  updateShareFacingButtons();
}

function wireShareCamera() {
  const section = $("phone-share");
  const btn = $("phone-share-btn");
  if (!section || !btn) return;
  section.hidden = false;
  btn.addEventListener("click", toggleShareCamera);
  for (const id of ["phone-share-mode-front", "phone-share-mode-back"]) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener("click", () => switchShareFacing(el.dataset.facing));
  }
  updateShareFacingButtons();
}

// Reconnect / QR-scan surface. Shown when there's no pair code, or after
// a connection failure. Lets the user re-pair without bouncing back to the
// desktop. Uses jsQR (loaded from CDN in phone.html) — BarcodeDetector
// isn't on iOS Safari yet, and jsQR works everywhere.

function wireCameraPicker() {
  const tap = $("phone-cam-tap");
  if (!tap) return;
  tap.addEventListener("click", () => {
    // Only show the picker when there's more than one source — single-
    // source case has nothing to pick from. updateCameraPickerHint
    // already hides the "Tap to switch source" overlay, but guard here too.
    const hasChoice = [..._availableSources.values()].some(s => (s.sources?.length || 0) > 1);
    if (!hasChoice) return;
    const wrap = $("phone-cam-picker");
    if (!wrap) return;
    if (!wrap.hidden) { wrap.hidden = true; return; }
    renderCameraPicker();
  });
  // Outside-click dismiss for the picker — matches dialog/menu patterns.
  document.addEventListener("click", (e) => {
    const wrap = $("phone-cam-picker");
    if (!wrap || wrap.hidden) return;
    if (wrap.contains(e.target) || tap.contains(e.target)) return;
    wrap.hidden = true;
  });
}

function wireAppMenu() {
  const btn = $("app-menu-btn");
  const menu = $("app-menu");
  if (!btn || !menu) return;
  // Popover positioning differs per page (phone is bottom-up, dashboard
  // anchors top-left), so this part stays per-surface. Everything below
  // — version label, install/check-updates/hard-refresh + cross-link
  // close-handlers — flows through app-menu.js.
  btn.addEventListener("click", (e) => {
    if (menu.matches(":popover-open")) { menu.hidePopover(); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.left = `${Math.max(8, rect.left)}px`;
    menu.style.right = "auto";
    menu.showPopover?.();
  });
  document.addEventListener("click", (e) => {
    if (!menu.matches(":popover-open")) return;
    if (e.target.closest("#app-menu")) return;
    if (e.target.closest("#app-menu-btn")) return;
    menu.hidePopover();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.matches(":popover-open")) menu.hidePopover();
  });
  readSwVersion().then(version => {
    $("app-menu-version").textContent = version;
    const reportLink = $("menu-report-issue");
    if (reportLink) setReportIssueLink(reportLink, version);
  });
  wireInstallMenuItem({
    btnId: "menu-install",
    iosPopoverId: "install-ios-popover",
    onClick: () => menu.hidePopover(),
  });
  wireCheckUpdatesMenuItem({ btnId: "menu-check-updates" });
  wireDiagnosticsMenuItem({ onBeforeOpen: () => menu.hidePopover() });
  wireHardRefresh({ onBeforeOpen: () => menu.hidePopover() });
  $("menu-dashboard")?.addEventListener("click", () => menu.hidePopover());
}


async function init() {
  wireReconnect();
  wireCameraPicker();
  wireAppMenu();
  const match = location.hash.match(/^#pair=(.+)$/);
  if (!match) {
    setStatus("error", "Not paired");
    showReconnect("");
    startNearbyDiscovery();
    return;
  }
  // Hash format is now `pair=<roomId>(&pk=<pubkey>)?`. The pk is the
  // in-person trust binding: scanning a QR with pk = consenting that
  // this pubkey belongs to the device that printed the QR. Stored
  // before WebRTC even starts so the trust holds even if pair fails.
  const params = new URLSearchParams(match[1]);
  const roomId = (match[1].split("&")[0]) || "";
  const remotePk = params.get("pk");
  if (remotePk) {
    // Label is unknown until the data channel exchanges it. "Computer"
    // is a placeholder; the pair-keys handshake replaces it with what
    // the desktop calls itself ("Mac", "Windows", …).
    _trust.trust(remotePk, "Computer");
  }
  try {
    setStatus("connecting", "");
    _peer = await joinPairingRoom(roomId, {});
    setStatus("connected", "");
    hideReconnect();
    // Send the desktop our pubkey + label so it can trust us on future
    // discovery without re-scanning. Sent as soon as the channel is up.
    try {
      const myPk = await getMyPubkeyB64();
      _peer.send({ type: "pair-keys", pubkey: myPk, label: deviceLabel() });
    } catch {}
    _peer.onMessage((msg) => {
      // Desktop may send its own pubkey + label as part of pair-keys —
      // upgrade the trust entry from the placeholder label to the real
      // one (and re-trust the pubkey if the QR didn't carry pk for some
      // reason, e.g. a legacy QR from before signed mode).
      if (msg && msg.type === "pair-keys" && msg.pubkey) {
        _trust.trust(msg.pubkey, msg.label || "Computer");
        return;
      }
      onPeerMessage(msg);
    });
    _peer.onTrack(onPeerTrack);
    // Transient state: pairing.js handles ICE restart internally; just
    // mirror the visible status. Terminal states render text; transient
    // states ride the dot.
    _peer.onStatus((status) => {
      if (status === "connected") setStatus("connected", "");
      else if (status === "reconnecting") setStatus("connecting", "");
      else if (status === "failed") setStatus("error", "Disconnected");
    });
    _peer.onClose(() => {
      setStatus("error", "Disconnected");
      $("phone-cam-section").hidden = true;
      _stopSharing();
      $("phone-share").hidden = true;
      // Exit attached-mode on disconnect so the user lands on normal UI
      // to reconnect from. Desktop will re-send "attached" on reconnect
      // if this phone was mounted (see phones.js phone-connect path).
      applyScreenMode("default");
      showReconnect("Lost the desktop. Scan a fresh QR to reconnect.");
      startNearbyDiscovery();
    });
    wireJoypad();
    wireTiltDrive({
      getPeer: () => _peer,
      resetJoypad: () => _joypad?.reset(),
    });
    wireStopButton();
    wireBackgroundStop();
    wireShareCamera();
  } catch (err) {
    setStatus("error", "Failed");
    showReconnect(`Pair failed — ${err.message || err}. Try a fresh QR from the desktop.`);
    startNearbyDiscovery();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Register SW so phone.html is installable + works offline after first
// visit. No banner on the phone surface — a new SW just installs and
// waits, the user triggers application via the menu's "Check for
// updates" (handled in app-menu.js's auto-apply latch).
setupServiceWorker();
