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


// Wire: see askHuman() in phones.js. One ask on screen at a time; a second
// replaces the first, prior resolves as skipped when its server-side timer
// fires.
function showAsk(msg) {
  const dialog = $("phone-ask-dialog");
  const img = $("phone-ask-image");
  const q = $("phone-ask-question");
  const optsEl = $("phone-ask-options");
  const free = $("phone-ask-free");
  const freeInput = $("phone-ask-free-input");

  if (msg.imageDataUrl) { img.src = msg.imageDataUrl; img.hidden = false; }
  else { img.hidden = true; img.src = ""; }
  q.textContent = msg.question || "";

  const respond = (answer) => {
    _peer?.send({ type: "ask-reply", askId: msg.askId, answer });
    dialog.close();
  };

  optsEl.innerHTML = "";
  if (Array.isArray(msg.options) && msg.options.length > 0) {
    free.hidden = true;
    for (const opt of msg.options) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ask-option sm";
      b.textContent = String(opt);
      b.addEventListener("click", () => respond(String(opt)), { once: true });
      optsEl.appendChild(b);
    }
  } else {
    free.hidden = false;
    freeInput.value = "";
    free.onsubmit = (e) => {
      e.preventDefault();
      const v = freeInput.value.trim();
      if (v) respond(v);
    };
  }

  $("phone-ask-skip").onclick = () => respond(null);
  if (!dialog.open) dialog.showModal();
  // Autofocus the free input when there are no tappable options, so the
  // keyboard pops up immediately on mobile.
  if (free.hidden === false) setTimeout(() => freeInput.focus(), 50);
}

// Desktop relayed a "please share your camera" prompt over the data
// channel. Browsers won't let getUserMedia() run without a user gesture
// in this tab; the Share button click below IS that gesture, so
// toggleShareCamera() called synchronously from the handler can call
// getUserMedia successfully. The handler awaits the share flow and
// reports back so the desktop's startHelperCamera tool can resolve
// instead of dead-ending on a string error.
//
// Reuses the phone-ask-dialog DOM rather than introducing a parallel
// modal — same Share / Not now affordance shape as askHuman.
function showCameraShareRequest(msg) {
  const dialog = $("phone-ask-dialog");
  const img = $("phone-ask-image");
  const q = $("phone-ask-question");
  const optsEl = $("phone-ask-options");
  const free = $("phone-ask-free");
  let responded = false;

  img.hidden = true; img.src = "";
  q.textContent = "Pip wants to use this phone's camera. Share it?";
  free.hidden = true;
  optsEl.innerHTML = "";

  const respond = (result, error) => {
    if (responded) return;
    responded = true;
    _peer?.send({ type: "camera-share-result", requestId: msg.requestId, result, error });
    dialog.close();
  };

  const shareBtn = document.createElement("button");
  shareBtn.type = "button";
  shareBtn.className = "ask-option sm";
  shareBtn.textContent = _shareStream ? "Already sharing" : "Share camera";
  shareBtn.addEventListener("click", async () => {
    // Already-sharing fast path — desktop sometimes asks before its
    // onTrack handler has registered the stream we already sent.
    if (_shareStream) { respond("shared"); return; }
    // toggleShareCamera() awaits getUserMedia internally; the user
    // gesture from this click propagates through the first await per
    // the user-activation spec, so the permission dialog (if any) is
    // allowed to show. The {ok, error} return surfaces the real
    // permission / device error to the desktop instead of collapsing
    // every failure to "user dismissed".
    try {
      const res = await toggleShareCamera();
      if (res?.ok) respond("shared");
      else respond("error", res?.error || "getUserMedia returned no stream");
    } catch (err) {
      respond("error", err.message || String(err));
    }
  }, { once: true });
  optsEl.appendChild(shareBtn);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ask-option sm";
  cancelBtn.textContent = "Not now";
  cancelBtn.addEventListener("click", () => respond("denied"), { once: true });
  optsEl.appendChild(cancelBtn);

  $("phone-ask-skip").onclick = () => respond("denied");
  if (!dialog.open) dialog.showModal();
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
// robot (else the picker would lie about its job).
function updateCameraPickerHint() {
  const overlay = $("phone-cam-overlay");
  if (!overlay) return;
  const hasChoice = [..._availableSources.values()].some(s => (s.sources?.length || 0) > 1);
  overlay.hidden = !hasChoice;
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
// away. While sharing, the segmented control live-switches via
// sender.replaceTrack so the desktop sees the same track slot — no
// renegotiation, no helper-card churn.
let _shareStream = null;
let _shareSenders = [];
let _shareFacing = "user";  // "user" (front) | "environment" (back)
let _shareSwitching = false;

async function openCameraStream(facing) {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing } },
    audio: false,
  });
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
  if (btn) { btn.textContent = "Stop sharing this device's camera"; btn.classList.add("on"); }
  return { ok: true };
}

// While sharing, swap the camera underneath the existing RTCRtpSender so
// the desktop sees no track change — just a different image. When not
// sharing, just remember the choice for the next Share tap.
//
// Mutation discipline: on the sharing path, `_shareFacing` and the
// segmented buttons stay on the previous value until replaceTrack
// resolves. Otherwise a failed switch leaves the UI claiming a camera
// the desktop isn't actually receiving. Failures stop the just-opened
// stream and leave the existing share untouched.
function stopTracks(stream) {
  if (!stream) return;
  for (const t of stream.getTracks()) { try { t.stop(); } catch {} }
}

async function switchShareFacing(nextFacing) {
  if (nextFacing !== "user" && nextFacing !== "environment") return;
  if (_shareSwitching) return;
  if (_shareFacing === nextFacing && _shareStream) return;

  // Not sharing: safe to mutate immediately — there's no live stream
  // whose state we could lie about. Next Share tap honors the choice.
  if (!_shareStream) {
    _shareFacing = nextFacing;
    updateShareFacingButtons();
    return;
  }

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
  if (btn) { btn.textContent = "+ Share this device's camera"; btn.classList.remove("on"); }
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
