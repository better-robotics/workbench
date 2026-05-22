import { $, escapeHtml } from "./dom.js";
import { log } from "./log.js";
import { settings } from "./settings.js";
import { state } from "./state.js";
import { ALL as CAPABILITIES, setCapabilityRenderer } from "./capabilities/index.js";
import { setOpen as capSetOpen } from "./capabilities/runtime/cap-section.js";
import {
  setBleRenderers, loadPaired, scanForNew, connect, disconnect, forgetDevice,
} from "./ble-lifecycle.js";
import {
  formatUptime, formatWifi, formatWifiShort, formatResetReason,
  formatRssi, rssiSeverity, tempSeverity,
} from "./format.js";
import { updateFirmware, updateFromFile } from "./capabilities/ota.js";
import { restartService, rebootRobot, enrollKey } from "./capabilities/runtime/command.js";
import { initGamepad } from "./gamepad.js";
import { initMotorsKeyboard } from "./capabilities/runtime/signed-pair.js";
// prepare.js / pinout.js / recovery.js are lazy-loaded on first use (~750 LOC
// combined, none of it needed for first paint). See the dynamic import()
// calls in the DOMContentLoaded wiring below.
import { initAuthUI, fingerprint as dashFingerprint, pubkeySsh, onKeyChange } from "./auth.js";
import { initPasswordsUI } from "./passwords.js";
import { initAssistant } from "./assistant.js";
import { initPhones, listPhones } from "./phones.js";
import {
  initHelpers, setHelpersRobotRenderer,
  attachPhoneCameraTo, getPhoneAttachment,
} from "./phone-helpers.js";
// aruco.js is wired through phone-helpers.js — phone helpers can be designated
// as the overhead camera; detection runs against the helper's existing
// preview tile. No init call here.
import "./aruco.js";
import { watcherCap } from "./watcher.js";
import {
  setupServiceWorker, wireInstallMenuItem, wireCheckUpdatesMenuItem,
  wireHardRefresh, wireDiagnosticsMenuItem, setReportIssueLink, readSwVersion,
} from "./app-menu.js";
import { initRobotPresence } from "./wifi-presence.js";
import { wireLogDialog } from "./log-dialog.js";

setCapabilityRenderer((entry) => renderEntry(entry));
setHelpersRobotRenderer((entry) => renderEntry(entry));
setBleRenderers({ renderEntry, render, patchSecondaryRow, patchRobotStateLine });

// A phone helper's camera mounted on this robot (phone-as-eye). The video
// element is discoverable by camera-frame.js's findCameraElement enumerator
// via [data-attached-camera-id]. srcObject is bound by renderEntry after
// innerHTML rebuild.
function attachedCameraHtml(entry) {
  if (!entry.attachedCameraStream) return "";
  return `
    <div class="cap-section attached-camera">
      <div class="cap-header">
        <div class="label">Phone camera (mounted)</div>
      </div>
      <div class="cap-body">
        <div class="attached-camera-frame">
          <video class="robot-camera" data-attached-camera-id="${escapeHtml(entry.id)}" autoplay playsinline muted></video>
        </div>
      </div>
    </div>
  `;
}

// The primary-row meta line. Kept short — width is precious in the list,
// and detail (IP, mem, temp, RSSI, etc.) lives in the system line inside
// the expanded card body, not here. Only "abnormal reset" stays because
// it's a discoverability signal you want to see without expanding.
function metaText(entry) {
  const connected = entry.status === "connected" || entry.status === "firmware-down";
  if (!connected) return "";
  const t = entry.telemetry;
  const parts = [
    formatWifiShort(entry.wifiStatus),
    formatUptime(t),
    formatResetReason(t?.reset_reason),
  ];
  return parts.filter(Boolean).join(" · ");
}

// The system line — full diagnostic detail (IP, mem, temp, RSSI), shown
// inside the expanded card body. Card-open is the user's implicit "show
// me more" gesture, so this line has all the precise numbers the primary
// row deliberately omits.
function systemLine(entry) {
  const connected = entry.status === "connected" || entry.status === "firmware-down";
  if (!connected) return "";
  const t = entry.telemetry;
  const w = entry.wifiStatus;
  const parts = [];
  if (w?.st === "joined" && w.ip) parts.push(w.ip);
  if (typeof t?.mem_free_mb === "number") parts.push(`${t.mem_free_mb} MB free`);
  else if (typeof t?.free_heap === "number") parts.push(`${Math.floor(t.free_heap / 1024)} KB free`);
  if (typeof t?.temp_c === "number") parts.push(`${t.temp_c.toFixed(1)}°C`);
  const rssi = formatRssi(t?.rssi_dbm);
  if (rssi) parts.push(rssi);
  return parts.join(" · ");
}

// Warning chips for the primary row — only render when something is
// degraded enough that the user should notice at a glance. Empty when
// everything is healthy, so the row stays visually quiet.
function warningChips(entry) {
  const connected = entry.status === "connected" || entry.status === "firmware-down";
  if (!connected) return "";
  const t = entry.telemetry;
  const chips = [];
  const tempSev = tempSeverity(t?.temp_c);
  if (tempSev) chips.push({ sev: tempSev, text: `${t.temp_c.toFixed(1)}°C` });
  const rssiSev = rssiSeverity(t?.rssi_dbm);
  if (rssiSev) chips.push({ sev: rssiSev, text: `${t.rssi_dbm} dBm` });
  // Recovery-plane chips — only Pi advertises these (heartbeat.py keys).
  // "weak" sev (yellow), not "bad" (red): BLE is alive when we're reading
  // this, so a degraded recovery plane is forward-looking ("if this
  // connection drops you may not be able to recover"), not an active
  // failure that justifies a red chip on a working card.
  const hb = entry.heartbeat;
  if (hb?.usb_gadget && hb.usb_gadget !== "active") {
    chips.push({ sev: "weak", text: `USB recovery: ${hb.usb_gadget}` });
  }
  if (hb?.ssh && hb.ssh !== "active") {
    chips.push({ sev: "weak", text: `SSH: ${hb.ssh}` });
  }
  if (!chips.length) return "";
  return `<div class="robot-warnings">${chips.map(c =>
    `<span class="warning-chip warning-${c.sev}">${escapeHtml(c.text)}</span>`,
  ).join("")}</div>`;
}

// Surgical patcher for the secondary row + body telemetry line. Avoids a
// full-card innerHTML rewrite on every 10 s telemetry notify — the
// rewrite destroys/recreates the entire card DOM and reads as a flash.
// Same shape as patchOtaSection, generalized to high-frequency channels.
function patchSecondaryRow(entry) {
  const node = entry.node;
  if (!node) return;
  const meta = node.querySelector(".robot-meta");
  if (meta) {
    const t = metaText(entry);
    meta.textContent = t;
    meta.title = t;
  }
  const sys = node.querySelector(".robot-system");
  if (sys) sys.textContent = systemLine(entry);
  // Warnings replace in place to avoid a flash. innerHTML swap is fine —
  // chip count is tiny, no event listeners attached.
  const warnSlot = node.querySelector(".robot-warnings-slot");
  if (warnSlot) warnSlot.innerHTML = warningChips(entry);
}

// Same idea for robot-status notify (rebooting / installing / ready). Lower
// frequency than telemetry but same flash-on-full-render cost.
function patchRobotStateLine(entry) {
  const node = entry.node;
  if (!node) return;
  const liveStatus = entry.robotStatus;
  const sticky = !liveStatus ? entry.stickyStatus : null;
  const s = liveStatus || sticky;
  let line = node.querySelector(".robot-state");
  if (!s || s.st === "ready") {
    if (line) line.remove();
    return;
  }
  if (!line) {
    line = document.createElement("div");
    line.className = "robot-state";
    // Insert right after the identity row so order matches renderEntry.
    const identityRow = node.querySelector(":scope > .row");
    if (identityRow) identityRow.after(line);
    else node.appendChild(line);
  }
  line.classList.toggle("sticky", !!sticky);
  const prefix = sticky ? "was " : "";
  line.textContent = s.msg ? `${prefix}${s.st} — ${s.msg}` : `${prefix}${s.st}`;
}

// Per-robot expand/collapse preference. Persisted so a user's choice sticks
// across sessions. Absence of a key = fall back to smart default (see
// computeExpanded). Live-busy state (installing, rebooting) always forces
// expanded so progress is visible regardless of preference.
const EXPANSION_KEY = "robot-expansion-v1";
function loadExpansionPrefs() {
  try { return JSON.parse(localStorage.getItem(EXPANSION_KEY) || "{}"); }
  catch { return {}; }
}
function setExpansionPref(id, expanded) {
  const prefs = loadExpansionPrefs();
  prefs[id] = expanded;
  try { localStorage.setItem(EXPANSION_KEY, JSON.stringify(prefs)); } catch {}
}
function computeExpanded(entry) {
  const live = entry.robotStatus;
  if (live && live.st && live.st !== "ready") return true;  // mid-flight work wins
  // Force-expand when a phone helper just got mounted, otherwise the new
  // camera section (and any Pip-readable view of it) lives in a collapsed
  // body the user can't see. Same posture as live-busy: visibility wins.
  if (entry.attachedCameraStream) return true;
  const prefs = loadExpansionPrefs();
  if (entry.id in prefs) return prefs[entry.id];
  return state.devices.size === 1;  // solo robot → expand; crowd → let user pick
}

// Dashboard's own fingerprint. Cached sync so renderEntry can compare
// against fw-info.authorized without awaiting. Refreshed whenever the
// keypair changes (generate / import / regenerate).
let myFingerprint = null;
async function refreshMyFingerprint() {
  myFingerprint = await dashFingerprint();
  for (const e of state.devices.values()) {
    if (e.status === "connected") renderEntry(e);
  }
}
onKeyChange(refreshMyFingerprint);


// QR hint: ?robot=X on the URL means a scan landed us here. Surface a
// one-click Pair CTA when that robot isn't paired yet. Chrome gates
// requestDevice on user activation, so the button click is the activation.
function updateQrHint() {
  const hinted = new URLSearchParams(location.search).get("robot");
  const hint = $("qr-hint");
  if (!hint) return;
  const known = hinted && [...state.devices.values()].some(e => e.name === hinted);
  const show = !!hinted && !known && !!navigator.bluetooth;
  hint.hidden = !show;
  if (show) $("qr-hint-name").textContent = hinted;
}

function render() {
  const list = $("robot-list");
  const empty = $("empty-state");
  const header = $("robots-heading");

  updateQrHint();

  if (state.devices.size === 0) {
    // Robots are the platform; their pair affordances stay visible whether
    // or not the operator has phone helpers. A "Set up a robot" prompt is
    // never wrong — phones are an addition, not a substitute.
    empty.hidden = false;
    header.hidden = true;
    list.innerHTML = "";
    return;
  }
  empty.hidden = true;
  header.hidden = false;

  const ids = new Set(state.devices.keys());
  for (const child of [...list.children]) {
    if (!ids.has(child.dataset.robotId)) child.remove();
  }

  let prev = null;
  for (const entry of state.devices.values()) {
    if (!entry.node) {
      entry.node = document.createElement("section");
      entry.node.className = "card robot";
      entry.node.dataset.robotId = entry.id;
    }
    renderEntry(entry);
    const target = prev ? prev.nextSibling : list.firstChild;
    if (target !== entry.node) {
      if (prev) prev.after(entry.node); else list.prepend(entry.node);
    }
    prev = entry.node;
  }
}

function renderEntry(entry) {
  if (!entry.node) { render(); return; }
  // Preserve focus + value across the innerHTML rebuild for any data-action
  // input/textarea inside this card. Telemetry/ops/motor notifies fire
  // renderEntry frequently; without this, typing in an inline editor would
  // be interrupted on every tick.
  const active = document.activeElement;
  const savedAction = active && entry.node.contains(active) ? active.dataset?.action : null;
  const savedValue = savedAction && "value" in active ? active.value : null;
  const savedStart = savedAction && active.selectionStart != null ? active.selectionStart : null;
  const savedEnd   = savedAction && active.selectionEnd != null ? active.selectionEnd : null;
  const { id, status } = entry;
  const name = entry.name;
  const firmwareDown = status === "firmware-down";
  // GATT IS connected when firmwareDown — only the main service is missing.
  // Treat as connected for button purposes so the user gets Disconnect.
  const connected = status === "connected" || firmwareDown;
  const connecting = status === "connecting";
  const statusText = status === "error"
    ? (/no longer in range|not found/i.test(entry.lastConnectError || "") ? "Out of range" : "Error")
    : firmwareDown ? "Firmware down"
    : "";
  // Card-style status hint via a colored left edge stripe (see
  // .robot.connected etc. in styles.css).
  entry.node.classList.toggle("status-connected",     status === "connected");
  entry.node.classList.toggle("status-connecting",    connecting);
  entry.node.classList.toggle("status-error",         status === "error");
  entry.node.classList.toggle("status-firmware-down", firmwareDown);

  // Canonical capability order across robot types so the eye lands on the same
  // control in the same place on both Pi and ESP32 cards. Unknown names fall
  // to the end in schema order.
  // OTA renders at the top of the body when active — it's a transient
  // operation that demands attention, not a parked control. Other caps
  // keep their canonical order so the eye lands on each in the same
  // place across robots. OTA only emits markup when in flight, so this
  // ordering is a no-op in steady state.
  const CAP_ORDER = { ota: 0, led: 1, motors: 2, wifi: 3, camera: 4, watcher: 4.5, ops: 5 };
  const byOrder = (a, b) => (CAP_ORDER[a.name] ?? 99) - (CAP_ORDER[b.name] ?? 99);
  // Schema is flat (each cap is its own BLE characteristic) but the operator's
  // mental model isn't — Flash and Snapshot are sub-controls of the Camera.
  // Render-tree groups them under their parent so the card mirrors the model
  // instead of the wire shape. Mapping is dashboard-side, no firmware change.
  const PARENT_MAP = { flash: "camera", snapshot: "camera" };
  const allCaps = [];
  for (const c of CAPABILITIES) allCaps.push({ cap: c });
  for (const c of entry.runtimeCaps || []) allCaps.push({ cap: c });
  // Dashboard-side virtual cap — not firmware-published, lives at the
  // intersection of camera (input) and motors (action). renderSection
  // self-gates on camera availability.
  allCaps.push({ cap: watcherCap });
  const childrenOf = new Map();
  const topCaps = [];
  for (const item of allCaps) {
    const parent = PARENT_MAP[item.cap.name];
    if (parent) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(item);
    } else {
      topCaps.push(item);
    }
  }
  const capByOrder = (a, b) => byOrder(a.cap, b.cap);
  const sections = topCaps
    .slice()
    .sort(capByOrder)
    .map(({ cap }) => {
      const kids = (childrenOf.get(cap.name) || []).slice().sort(capByOrder);
      const childHtml = kids.map(k => k.cap.renderSection(entry)).join("");
      return cap.renderSection(entry, { childHtml });
    })
    .join("");
  const liveStatus = entry.robotStatus;
  const sticky = !liveStatus ? entry.stickyStatus : null;
  const stateHtml = (() => {
    const s = liveStatus || sticky;
    if (!s || s.st === "ready") return "";
    const prefix = sticky ? "was " : "";
    const text = s.msg ? `${prefix}${s.st} — ${s.msg}` : `${prefix}${s.st}`;
    return `<div class="robot-state${sticky ? " sticky" : ""}">${escapeHtml(text)}</div>`;
  })();
  // Enroll prompt flattened to match the capability row rhythm (label + state
  // + action) so it doesn't visually break the card's structure.
  const enrollHtml = (() => {
    if (!connected || !entry.opsChar) return "";
    const auth = entry.fwInfo?.authorized;
    if (!Array.isArray(auth) || !myFingerprint || auth.includes(myFingerprint)) return "";
    if (auth.length === 0) {
      return `
        <div class="robot-controls">
          <div class="row">
            <div><div class="label">Enrollment</div><div class="meta">Dashboard not enrolled on this robot.</div></div>
            <button class="secondary sm" data-action="enroll">Enroll</button>
          </div>
        </div>`;
    }
    return `
      <div class="robot-controls">
        <div class="row">
          <div><div class="label">Enrollment</div><div class="meta">Enrolled to another dashboard.</div></div>
        </div>
      </div>`;
  })();
  const typeBadge = entry.fwType
    ? `<span class="type-badge type-${escapeHtml(entry.fwType)}">${
        escapeHtml(entry.fwType === "esp32" ? "ESP32" : entry.fwType.toUpperCase())
      }</span>`
    : "";
  // metaText() composes the slim primary-row meta (WiFi state + uptime,
  // plus any abnormal reset reason). Full diagnostic detail — IP, RAM,
  // temp, RSSI — lives in the system line inside the expanded body.
  // Reused by patchSecondaryRow on the high-frequency telemetry notify
  // path so the display logic stays in one place. Always emit the
  // wrapper (even empty) so the patcher can fill it without a full
  // re-render. CSS :empty hides it.
  const metaJoined = metaText(entry);
  const metaRow = `<div class="robot-meta" title="${escapeHtml(metaJoined)}">${escapeHtml(metaJoined)}</div>`;
  const sysLine = systemLine(entry);
  const sysRow = `<div class="robot-system">${escapeHtml(sysLine)}</div>`;
  const warningsSlot = `<div class="robot-warnings-slot">${warningChips(entry)}</div>`;

  // Active-ops chips: at-a-glance "what's happening right now" without
  // having to expand each capability section.
  const activeOps = [];
  if (status === "connected" || firmwareDown) {
    if (entry.cameraRunning || entry.cameraStream) {
      activeOps.push({ text: "streaming" });
    }
    if ((entry.motorLeft || 0) !== 0 || (entry.motorRight || 0) !== 0) {
      activeOps.push({ text: `motors L:${entry.motorLeft || 0} R:${entry.motorRight || 0}` });
    }
    if ((entry.flashLevel || 0) > 0) activeOps.push({ text: `flash ${entry.flashLevel}%` });
    if (entry.otaStatus?.st && entry.otaStatus.st !== "idle") {
      const oSt = entry.otaStatus.st;
      const total = entry.otaStatus.total || 0;
      const n = entry.otaStatus.n || entry.otaSent || 0;
      const pct = total ? Math.round(100 * n / total) : 0;
      activeOps.push({
        op: "ota",
        text: total ? `OTA ${oSt} ${pct}%` : `OTA ${oSt}`,
      });
    }
    if (entry.snapshotBusy) activeOps.push({ text: "snapshotting…" });
  }
  const opsRow = activeOps.length
    ? `<div class="robot-ops">${activeOps.map(o =>
        `<span class="op-chip"${o.op ? ` data-op="${o.op}"` : ""}>${escapeHtml(o.text)}</span>`,
      ).join("")}</div>`
    : "";
  // Split on the last hyphen so the common "BetterRobot-" prefix dims and the
  // distinguishing suffix ("E9D4") carries the visual weight. Names without a
  // hyphen render plainly.
  const dash = name.lastIndexOf("-");
  const hasSplit = dash > 0 && dash < name.length - 1;
  const nameInner = hasSplit
    ? `<span class="name-prefix">${escapeHtml(name.slice(0, dash + 1))}</span><span class="name-suffix">${escapeHtml(name.slice(dash + 1))}</span>`
    : escapeHtml(name);
  // Wrap so the name span can truncate independently of chevron + badge —
  // otherwise a long name + ESP32 pill overflows into the Disconnect button.
  const nameHtml = `<span class="robot-name" title="${escapeHtml(name)}">${nameInner}</span>`;
  const expanded = computeExpanded(entry);
  entry.node.classList.toggle("expanded", expanded);
  // Capture the live MJPEG <img> or WebRTC-decode <canvas> before innerHTML
  // wipes it. Tearing down the <img> aborts the multipart/x-mixed-replace
  // HTTP response and forces the ESP32 streamTask to detect a client
  // disconnect + accept a fresh connection — costly. Replacing the <canvas>
  // detaches the drawing context mid-decode and forfeits any pixels until
  // the cap's post-render rebind re-acquires it. Transplanting either keeps
  // the stream visually continuous.
  const liveCameraImg = entry.node.querySelector("img.robot-camera[data-cam-id]");
  const liveCameraReady = liveCameraImg?.complete && liveCameraImg.naturalWidth > 0;
  const liveCameraCanvas = entry.node.querySelector("canvas.robot-camera[data-cam-id]");
  entry.node.innerHTML = `
    <div class="row">
      <div class="robot-identity">
        <button class="label-btn" data-action="toggle-expand" aria-expanded="${expanded}">
          <svg class="icon-svg disclosure-chevron" aria-hidden="true"><use href="icons.svg#icon-chevron-down"/></svg>
          ${typeBadge}${nameHtml}
        </button>
        ${statusText ? `<div class="status">${statusText}</div>` : ""}
      </div>
      <div class="robot-actions">
        ${connected
          ? ""
          : `<button class="sm" data-action="connect" ${connecting ? "disabled" : ""}>${
              connecting ? "Connecting…" : "Reconnect"
            }</button>`}
        <button class="icon" data-action="menu" aria-label="More actions"><svg class="icon-svg"><use href="icons.svg#icon-more"/></svg></button>
      </div>
    </div>
    <div class="robot-secondary">
      ${metaRow}
      ${warningsSlot}
      ${opsRow}
    </div>
    ${stateHtml}
    ${firmwareDown ? `
      <div class="firmware-down-banner">
        <div class="label">pi-robot.service: ${escapeHtml(entry.heartbeat?.pi_robot || "down")}</div>
        <div class="meta">Only the heartbeat plane is responding — capabilities (LED, motors, WiFi, OTA) are unavailable until the firmware comes back.</div>
        ${entry.heartbeat?.ip ? `<div class="meta">SSH: <code>ssh robot@${escapeHtml(entry.heartbeat.ip)}</code></div>` : `<div class="meta">No IP — robot isn't on WiFi. Use the USB-C serial console.</div>`}
        <div class="row" style="margin-top:8px;">
          <button class="secondary sm" data-action="open-recovery">Open serial console</button>
        </div>
      </div>
    ` : ""}
    ${expanded && !firmwareDown ? `
      <div class="robot-body">
        ${sysRow}
        ${enrollHtml}
        ${sections}
        ${attachedCameraHtml(entry)}
      </div>
    ` : ""}
  `;
  // Transplant the preserved live MJPEG img if the new render expects the
  // same src — keeps the multipart HTTP response uninterrupted across
  // re-renders. The fresh placeholder src is identical (same robot IP +
  // port), so the user sees no flash and the ESP32 doesn't see a reconnect.
  if (liveCameraReady) {
    const placeholder = entry.node.querySelector(
      `img.robot-camera[data-cam-id="${entry.id}"]`,
    );
    if (placeholder && placeholder.src === liveCameraImg.src) {
      placeholder.parentNode.replaceChild(liveCameraImg, placeholder);
    }
  }
  // Same transplant for the WebRTC-decode canvas. The cap's post-render
  // rebind re-points the decode loop at whichever canvas survives — by
  // transplanting we preserve the already-painted pixels (no black flash)
  // and the captureStream wired into entry.cameraStream.
  if (liveCameraCanvas) {
    const placeholder = entry.node.querySelector(
      `canvas.robot-camera[data-cam-id="${entry.id}"]`,
    );
    if (placeholder) {
      placeholder.parentNode.replaceChild(liveCameraCanvas, placeholder);
    }
  }
  // Bind the attached-camera MediaStream after innerHTML rebuild — srcObject
  // can't survive an innerHTML reset, and querying for the new <video> needs
  // the DOM to exist.
  if (entry.attachedCameraStream) {
    const v = entry.node.querySelector(`video[data-attached-camera-id="${entry.id}"]`);
    if (v) v.srcObject = entry.attachedCameraStream;
  }
  // Per-cap try/catch: one cap's wireActions throwing shouldn't silently
  // break wiring for every cap that comes after it. Surface the error so
  // future regressions are visible instead of mysteriously-not-working.
  const safeCall = (fn, label, cap) => {
    try { fn(); }
    catch (err) { console.warn(`[${label}] ${cap?.name || "?"}: ${err?.message || err}`); }
  };
  for (const cap of CAPABILITIES) safeCall(() => cap.wireActions(entry, entry.node), "wireActions", cap);
  for (const cap of entry.runtimeCaps || []) safeCall(() => cap.wireActions(entry, entry.node), "wireActions", cap);
  safeCall(() => watcherCap.wireActions(entry, entry.node), "wireActions", watcherCap);
  for (const cap of CAPABILITIES) safeCall(() => cap.postRender?.(entry), "postRender", cap);
  for (const cap of entry.runtimeCaps || []) safeCall(() => cap.postRender?.(entry), "postRender", cap);
  // Per-capability disclosure toggles (cap-section.js renders the buttons).
  // Click hides/shows the body without a re-render and persists the choice
  // to localStorage so the user's collapse preferences stick across sessions.
  entry.node.querySelectorAll("[data-cap-toggle]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const capName = btn.dataset.capToggle;
      const sec = btn.closest(".cap-section");
      const body = sec?.querySelector(".cap-body");
      if (!body) return;
      const willOpen = body.hasAttribute("hidden");
      body.toggleAttribute("hidden", !willOpen);
      btn.setAttribute("aria-expanded", String(willOpen));
      capSetOpen(capName, willOpen);
    });
  });
  const connectBtn = entry.node.querySelector('[data-action="connect"]');
  if (connectBtn) connectBtn.addEventListener("click", () => connect(id));
  const disconnectBtn = entry.node.querySelector('[data-action="disconnect"]');
  if (disconnectBtn) disconnectBtn.addEventListener("click", () => disconnect(id));
  const recoveryBtn = entry.node.querySelector('[data-action="open-recovery"]');
  if (recoveryBtn) recoveryBtn.addEventListener("click", () => openConsole("pi"));
  const menuBtn = entry.node.querySelector('[data-action="menu"]');
  if (menuBtn) menuBtn.addEventListener("click", () => openMenu(menuBtn, id));
  const toggleExpand = () => {
    // No-op for cards that have nothing useful to reveal — matches the
    // CSS chevron-hidden bucket in styles.css. Without this gate, the row
    // click handler still toggles (pointer-events:none on .label-btn only
    // suppresses the button itself; the click lands on .row, where the
    // closest("button") guard returns null and toggle would otherwise fire).
    if (entry.status !== "connected" && entry.status !== "connecting") return;
    setExpansionPref(id, !entry.node.classList.contains("expanded"));
    renderEntry(entry);
  };
  // Explicit label-button handles keyboard + screen readers (aria-expanded).
  const expandBtn = entry.node.querySelector('[data-action="toggle-expand"]');
  if (expandBtn) expandBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleExpand(); });
  // Whole row is a generous click target for the same action — except clicks
  // that landed on another button (Pair/Disconnect, overflow menu).
  const row = entry.node.querySelector(".row");
  if (row) row.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    toggleExpand();
  });
  const enrollBtn = entry.node.querySelector('[data-action="enroll"]');
  if (enrollBtn) enrollBtn.addEventListener("click", async () => {
    const pub = await pubkeySsh();
    if (await enrollKey(id, pub) && myFingerprint) {
      // Optimistic: assume the Pi accepted. fw-info is re-published by the
      // firmware after enroll, but we also update locally so the prompt
      // disappears immediately.
      if (!entry.fwInfo) entry.fwInfo = {};
      entry.fwInfo.authorized = [...(entry.fwInfo.authorized || []), myFingerprint];
      renderEntry(entry);
    }
  });

  // Restore focus + selection to the data-action element that had focus
  // before the rebuild, if any. Preserves the user's typing in inline
  // editors across telemetry ticks.
  if (savedAction) {
    const restored = entry.node.querySelector(`[data-action="${savedAction}"]`);
    if (restored) {
      try {
        if (savedValue != null && "value" in restored) restored.value = savedValue;
        restored.focus();
        if (savedStart != null && typeof restored.setSelectionRange === "function") {
          restored.setSelectionRange(savedStart, savedEnd ?? savedStart);
        }
      } catch {}
    }
  }
}

let menuTargetId = null;

function openMenu(triggerBtn, id) {
  const menu = $("robot-menu");
  const isOpen = menu.matches(":popover-open");
  // Toggle off if clicking the same robot's trigger; otherwise switch targets.
  if (isOpen && menuTargetId === id) {
    closeMenu();
    return;
  }
  if (isOpen) menu.hidePopover();  // switching robots — reopen at new position
  menuTargetId = id;
  // Diagnostic metadata (firmware commit SHA) lives here rather than on the
  // card face — only relevant when you're about to act on the robot.
  const entry = state.devices.get(id);
  const header = $("robot-menu-header");
  const version = entry?.fwInfo?.version;
  if (version) {
    header.textContent = `Firmware ${version}`;
    header.hidden = false;
  } else {
    header.hidden = true;
  }
  $("menu-restart").hidden = !entry?.opsChar;
  $("menu-reboot").hidden  = !entry?.opsChar;
  $("menu-log").hidden     = !entry?.opsChar;
  // Shell is Pi-only (no shell on ESP32). pi-robot-rtc.service must be
  // installed; if it's not, the connect button surfaces a clear error.
  $("menu-shell").hidden   = !(entry?.fwType === "pi" && entry?.status === "connected");
  $("menu-pinout").hidden  = !(entry?.status === "connected" && entry?.fwInfo);
  $("menu-update").hidden       = !entry?.otaDataChar;
  $("menu-disconnect").hidden = !(entry?.status === "connected" || entry?.status === "firmware-down");
  // Phone-attach group: one button per connected phone, labelled
  // "Attach <phone> camera" or "Detach <phone> camera" depending on
  // whether that phone is already mounted on THIS robot. Generated each
  // time the menu opens so the list reflects current phone status.
  // Hidden when robot isn't connected or no phones are paired.
  const phoneAttachGroup = $("menu-phone-attach");
  phoneAttachGroup.innerHTML = "";
  const phoneAttachable = entry?.status === "connected";
  if (phoneAttachable) {
    for (const phone of listPhones()) {
      if (phone.status !== "connected") continue;
      const attachedHere = getPhoneAttachment(phone.id) === id;
      const label = phone.label || `Phone ${phone.id.slice(0, 6)}`;
      const btn = document.createElement("button");
      btn.className = "menu-item";
      btn.innerHTML = `<svg class="icon-svg"><use href="icons.svg#icon-camera"/></svg>${
        attachedHere ? `Detach ${escapeHtml(label)} camera` : `Attach ${escapeHtml(label)} camera`
      }`;
      btn.addEventListener("click", () => {
        closeMenu();
        attachPhoneCameraTo(phone.id, attachedHere ? null : id);
      });
      phoneAttachGroup.appendChild(btn);
    }
  }
  phoneAttachGroup.hidden = phoneAttachGroup.children.length === 0;
  const rect = triggerBtn.getBoundingClientRect();
  // Position below-right of trigger, nudging left if it would overflow viewport.
  const menuWidth = 220;
  const left = Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8);
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${Math.max(8, left)}px`;
  if (menu.showPopover) menu.showPopover();
}

function closeMenu() {
  const menu = $("robot-menu");
  if (menu.hidePopover) menu.hidePopover();
  // NOTE: don't clear menuTargetId — handlers read it after closeMenu()
  // returns. openMenu sets it on next open.
}

function robotUrl(name) {
  return `${location.origin}${location.pathname}?robot=${encodeURIComponent(name)}`;
}

function openLabel(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  const url = robotUrl(entry.name);
  $("label-title").textContent = entry.name;
  const labelUrl = $("label-url");
  labelUrl.textContent = url;
  labelUrl.dataset.url = url;
  labelUrl.classList.remove("copied");
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  $("qr-box").innerHTML = qr.createSvgTag({ scalable: true, margin: 0 });
  $("label-modal").showModal();
}

function highlightKnownRobotFromUrl() {
  const hinted = new URLSearchParams(location.search).get("robot");
  if (!hinted) return;
  const entry = [...state.devices.values()].find(e => e.name === hinted);
  if (!entry || !entry.node) return;
  requestAnimationFrame(() => {
    entry.node.classList.add("highlight");
    entry.node.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => entry.node.classList.remove("highlight"), 1500);
  });
}

function setBluetoothAvailable(available) {
  $("bluetooth-off").hidden = !!available;
  const btn = $("scan-btn");
  if (btn) btn.disabled = !available;
  const emptyBtn = $("empty-scan-btn");
  if (emptyBtn) emptyBtn.disabled = !available;
}

// Service worker + update banner. SW lifecycle is intentional: we never
// auto-skip-waiting on background detection — show a banner so the user
// triggers the swap. Explicit "Check for updates" clicks (wired below
// via app-menu.js) auto-apply.
function showSwUpdateBanner(worker) {
  if (document.getElementById("sw-update-banner")) return;  // already shown
  const bar = document.createElement("div");
  bar.id = "sw-update-banner";
  bar.innerHTML = `
    <span>New dashboard version available.</span>
    <button class="sm" id="sw-update-reload">Reload</button>
    <button class="icon" id="sw-update-dismiss" aria-label="Dismiss"><svg class="icon-svg"><use href="icons.svg#icon-x"/></svg></button>
  `;
  document.body.appendChild(bar);
  document.getElementById("sw-update-reload").addEventListener("click", () => {
    worker.postMessage("skip-waiting");
  });
  document.getElementById("sw-update-dismiss").addEventListener("click", () => bar.remove());
}
setupServiceWorker({ onUnsolicitedUpdate: showSwUpdateBanner });

// Console (Pi USB-C + ESP32 USB serial) — unified entry point. Mode is
// remembered across sessions via localStorage; explicit mode argument
// wins (e.g. firmware-down banner opens Pi mode regardless).
async function openConsole(mode) {
  const m = mode || localStorage.getItem("console-mode") || "pi";
  await _setConsoleMode(m);
  if (!$("console-modal").open) $("console-modal").showModal();
}
async function _setConsoleMode(mode) {
  $("console-pi-section").hidden = mode !== "pi";
  $("console-esp-section").hidden = mode !== "esp";
  $("console-mode-pi")?.setAttribute("aria-pressed", String(mode === "pi"));
  $("console-mode-esp")?.setAttribute("aria-pressed", String(mode === "esp"));
  if (mode === "pi") {
    const mod = await import("./recovery.js");
    mod.init();
  } else {
    const mod = await import("./esp-serial.js");
    mod.init();
  }
}

// Recovery menu (BetterRobotics dropdown) — wired FIRST in DOMContentLoaded
// inside try/catch so a failure later in init can never strand the user
// without Hard Refresh. Uses optional chaining on every $() lookup so a
// single missing element doesn't abort the rest of the wiring. Same panda
// principle the firmware applies: the recovery layer enforced *below* the
// failure-prone intelligent layer.
function wireRecoveryMenu() {
  const appMenuBtn = $("app-menu-btn");
  const appMenu = $("app-menu");
  if (!appMenuBtn || !appMenu) return;
  appMenuBtn.addEventListener("click", (e) => {
    if (appMenu.matches(":popover-open")) { appMenu.hidePopover(); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    appMenu.style.top = `${rect.bottom + 6}px`;
    appMenu.style.left = `${Math.max(8, rect.left)}px`;
    appMenu.style.right = "auto";
    if (appMenu.showPopover) appMenu.showPopover();
  });
  document.addEventListener("click", (e) => {
    if (!appMenu.matches(":popover-open")) return;
    if (e.target.closest("#app-menu")) return;
    if (e.target.closest("#app-menu-btn")) return;
    appMenu.hidePopover();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && appMenu.matches(":popover-open")) appMenu.hidePopover();
  });
  $("menu-phone-view")?.addEventListener("click", () => appMenu.hidePopover());
  $("menu-report-issue")?.addEventListener("click", () => appMenu.hidePopover());
  // Version + report-issue link. Read VERSION from sw.js (CI stamps it
  // on every dashboard-asset change). Both the menu display and the
  // report-issue body get the running commit + UA + URL prefilled.
  readSwVersion().then(version => {
    const v = $("app-menu-version"); if (v) v.textContent = version;
    const r = $("menu-report-issue"); if (r) setReportIssueLink(r, version);
  }).catch(() => {});
  wireInstallMenuItem({
    btnId: "menu-install",
    iosPopoverId: "install-ios-popover",
    onClick: () => appMenu.hidePopover(),
  });
  wireCheckUpdatesMenuItem({ btnId: "menu-check-updates" });
  wireDiagnosticsMenuItem({
    getTelemetrySources: () => Array.from(state.devices.values()),
    onBeforeOpen: () => appMenu.hidePopover(),
  });
  wireHardRefresh({ onBeforeOpen: () => appMenu.hidePopover() });
}

// Clean GATT teardown on tab close / refresh / app-switch (mobile PWA).
// Without this, the Pi-side bluez keeps the HCI link in some intermediate
// state until the supervision timeout fires (~5-20s), and a fresh dashboard
// load hits a desynced state where Chrome thinks it's disconnected while
// the Pi still holds the link. Pagehide is fire-and-forget — disconnect()
// returns synchronously and the link-layer teardown completes in the
// ~100ms before the page is killed.
window.addEventListener("pagehide", () => {
  for (const entry of state.devices.values()) {
    if (entry.device?.gatt?.connected) {
      try { entry.device.gatt.disconnect(); } catch {}
    }
  }
});

document.addEventListener("DOMContentLoaded", () => {
  // Wire the recovery menu FIRST and in isolation. Anything throwing in
  // the rest of init can no longer strand the user without Hard Refresh.
  try { wireRecoveryMenu(); } catch (err) { console.error("[recovery-menu]", err); }
  // Browsers without Web Bluetooth (iOS Safari is the common case — a
  // phone user who navigated phone → "Open dashboard view") still need
  // the chrome to work: BetterRobotics menu, PWA install, update check,
  // random profile name. Surface the unsupported banner + disable BLE-only
  // buttons, then let the rest of init run.
  const hasBLE = !!navigator.bluetooth;
  if (!hasBLE) {
    $("unsupported").hidden = false;
    $("scan-btn").disabled = true;
    $("empty-scan-btn").disabled = true;
  } else if (navigator.bluetooth.getAvailability) {
    navigator.bluetooth.getAvailability().then(setBluetoothAvailable);
    navigator.bluetooth.addEventListener("availabilitychanged", (e) => {
      setBluetoothAvailable(e.value);
    });
  }

  $("scan-btn").addEventListener("click", scanForNew);
  $("empty-scan-btn").addEventListener("click", scanForNew);
  $("qr-hint-pair").addEventListener("click", scanForNew);


  // robot-menu is popover="manual" so neither Escape nor outside-click are
  // native — both need explicit listeners at document level.
  document.addEventListener("click", (e) => {
    const menu = $("robot-menu");
    if (!menu.matches(":popover-open")) return;
    if (e.target.closest("#robot-menu")) return;           // click inside the menu
    if (e.target.closest("[data-action='menu']")) return;  // trigger handles its own toggle
    closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("robot-menu").matches(":popover-open")) closeMenu();
  });

  $("menu-label").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (id) openLabel(id);
  });
  $("menu-update").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    const entry = state.devices.get(id);
    if (entry?.otaDataChar) openUpdateDialog(id);
  });
  function openUpdateDialog(id) {
    const entry = state.devices.get(id);
    if (!entry) return;
    const dialog = $("update-fw-dialog");
    const sourceEl = $("update-fw-source");
    const latestBtn = $("update-fw-latest");
    // Mirror the source-resolution logic in updateFirmware: Pi falls back to
    // the default manifest path when fwInfo is partial; ESP32 uses fwInfo.url.
    const bundleUrl = entry.fwInfo?.bundle_url
      || (entry.otaDataChar && !entry.fwInfo?.url ? "firmware/pi_robot/ota-manifest.json" : null);
    const url = bundleUrl || entry.fwInfo?.url;
    if (url) {
      sourceEl.textContent = url;
      sourceEl.hidden = false;
      latestBtn.disabled = false;
    } else {
      sourceEl.textContent = "(no published source — pick a local file instead)";
      sourceEl.hidden = false;
      latestBtn.disabled = true;
    }
    latestBtn.onclick = () => { dialog.close(); updateFirmware(id); };
    $("update-fw-file").onclick = () => { dialog.close(); updateFromFile(id); };
    dialog.showModal();
  }
  $("update-fw-close").addEventListener("click", () => $("update-fw-dialog").close());
  $("update-fw-cancel").addEventListener("click", () => $("update-fw-dialog").close());
  $("menu-restart").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (state.devices.get(id)?.opsChar) restartService(id);
  });
  $("menu-reboot").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (state.devices.get(id)?.opsChar) rebootRobot(id);
  });
  wireLogDialog({ getMenuTargetId: () => menuTargetId, closeMenu });
  $("menu-pinout").addEventListener("click", async () => {
    const id = menuTargetId;
    closeMenu();
    const entry = state.devices.get(id);
    if (!entry || entry.status !== "connected" || !entry.fwInfo) return;
    const mod = await import("./pinout.js");
    mod.openPinoutDialog(id);
  });
  // Shell — lazy-import so xterm.js + WebRTC plumbing only load when the
  // user actually opens a terminal session. Pi-only.
  $("menu-shell").addEventListener("click", async () => {
    const id = menuTargetId;
    closeMenu();
    const entry = state.devices.get(id);
    if (!entry || entry.fwType !== "pi" || entry.status !== "connected") return;
    const mod = await import("./shell.js");
    mod.openShellDialog(id);
  });
  $("menu-console").addEventListener("click", () => {
    $("avatar-menu").hidePopover();
    openConsole();
  });
  for (const id of ["console-mode-pi", "console-mode-esp"]) {
    $(id)?.addEventListener("click", async (e) => {
      const mode = e.currentTarget.dataset.mode;
      localStorage.setItem("console-mode", mode);
      await _setConsoleMode(mode);
    });
  }
  $("menu-scripts").addEventListener("click", async () => {
    $("avatar-menu").hidePopover();
    const mod = await import("./scripts.js");
    mod.init();
    mod.openScriptsDialog();
  });
  // (BetterRobotics dropdown wiring moved to wireRecoveryMenu(), called
  // first in this DOMContentLoaded inside try/catch — see top of file.)

  $("label-close").addEventListener("click", () => $("label-modal").close());
  const labelUrlEl = $("label-url");
  let _labelCopyTimer = null;
  async function copyLabelUrl() {
    const original = labelUrlEl.dataset.url || labelUrlEl.textContent;
    try {
      await navigator.clipboard.writeText(original);
      labelUrlEl.textContent = "Copied";
      labelUrlEl.classList.add("copied");
      clearTimeout(_labelCopyTimer);
      _labelCopyTimer = setTimeout(() => {
        labelUrlEl.textContent = original;
        labelUrlEl.classList.remove("copied");
      }, 1500);
    } catch {}
  }
  labelUrlEl.addEventListener("click", copyLabelUrl);
  labelUrlEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copyLabelUrl(); }
  });
  $("label-print").addEventListener("click", () => window.print());
  $("menu-disconnect").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    const m = state.devices.get(id);
    if (m && (m.status === "connected" || m.status === "firmware-down")) disconnect(id);
  });
  $("menu-forget").addEventListener("click", () => {
    const id = menuTargetId;
    if (!id) return;
    const entry = state.devices.get(id);
    if (!entry) return;
    const name = entry.name;
    closeMenu();
    if (confirm(`Forget ${name}?\n\nYou'll need to pair it again to use it.`)) {
      forgetDevice(id);
    }
  });

  // Pip backend, API keys, GitHub auth, and vision all moved to slash
  // commands (/model, /vision) — managed in assistant.js. /model is
  // contextual: picking a backend that needs auth or a key prompts inline.
  // Settings keeps only identity + advanced one-time setup.

  // Profile — classroom-local identity (no auth, browser-only). Seeded hue from name hash.
  const seedColor = (str) => {
    if (!str) return null;
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffff;
    return `hsl(${h % 360}, 55%, 50%)`;
  };
  const profileInitials = (name) => {
    if (!name) return "?";
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    if (words.length === 1) return words[0][0].toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  };
  const renderAvatar = (name) => {
    const initials = profileInitials(name);
    const color = seedColor(name);
    for (const el of [$("avatar-btn"), $("avatar-preview")]) {
      el.textContent = initials;
      el.style.background = color || "";
    }
    $("avatar-menu-name").textContent = name || "Not set — open Settings to add your name";
  };
  // Fun random default so first-time users get an identity without a prompt.
  // Adjective + robot/space noun → 576 combos. User can edit/clear anytime.
  const NAME_ADJ = ["Curious","Clever","Bold","Brave","Bright","Kind","Quick",
    "Cheerful","Gentle","Nimble","Mighty","Witty","Playful","Keen","Eager",
    "Daring","Friendly","Snappy","Plucky","Swift","Sunny","Lively","Cozy","Happy"];
  const NAME_NOUN = ["Rover","Pilot","Beacon","Pixel","Bolt","Circuit","Gear",
    "Sprocket","Widget","Cog","Comet","Orbit","Nova","Spark","Relay","Echo",
    "Satellite","Buffer","Byte","Atom","Chip","Node","Bot","Gadget"];
  const randomName = () => `${NAME_ADJ[Math.floor(Math.random() * NAME_ADJ.length)]} ${NAME_NOUN[Math.floor(Math.random() * NAME_NOUN.length)]}`;

  const profile = JSON.parse(localStorage.getItem("br-profile") || "{}");
  if (!profile.name) {
    profile.name = randomName();
    localStorage.setItem("br-profile", JSON.stringify(profile));
  }
  const nameInput = $("setting-name");
  const nameHint = $("setting-name-hint");
  function saveProfile() { localStorage.setItem("br-profile", JSON.stringify(profile)); }
  // Identity flows from settings.githubAuth — one OAuth grant powers both
  // the username display AND the GitHub Models Pip backend. /model github
  // (in assistant.js) triggers the OAuth dance when not yet signed in.
  function displayName() {
    return settings.githubAuth?.username || profile.name;
  }
  function syncIdentityUI() {
    const signedIn = !!settings.githubAuth?.username;
    nameInput.value = displayName();
    nameInput.disabled = signedIn;
    nameHint.textContent = signedIn
      ? "Signed in with GitHub — name is from your account."
      : "Stored in this browser only. Run /model github to sign in.";
    renderAvatar(displayName());
  }
  // Exposed so the /model handler can refresh the UI after sign-in lands.
  window.__syncIdentityUI = syncIdentityUI;
  syncIdentityUI();
  nameInput.addEventListener("input", () => {
    if (settings.githubAuth) return;  // disabled, but defensive
    profile.name = nameInput.value.trim();
    saveProfile();
    renderAvatar(displayName());
  });

  // Avatar menu — popover="manual" matches robot-menu's pattern (no native outside-click/Escape).
  // Right-anchored: menu's right edge pins to avatar's right edge, grows leftward.
  // Keeps it inside the viewport regardless of content width.
  $("avatar-btn").addEventListener("click", (e) => {
    const menu = $("avatar-menu");
    if (menu.matches(":popover-open")) {
      menu.hidePopover();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    menu.style.left = "auto";
    if (menu.showPopover) menu.showPopover();
  });
  $("menu-settings").addEventListener("click", () => {
    $("avatar-menu").hidePopover();
    $("settings-modal").showModal();
  });
  document.addEventListener("click", (e) => {
    const menu = $("avatar-menu");
    if (!menu.matches(":popover-open")) return;
    if (e.target.closest("#avatar-menu")) return;
    if (e.target.closest("#avatar-btn")) return;
    menu.hidePopover();
  });
  document.addEventListener("keydown", (e) => {
    const menu = $("avatar-menu");
    if (e.key === "Escape" && menu.matches(":popover-open")) menu.hidePopover();
  });

  $("settings-close").addEventListener("click", () => $("settings-modal").close());

  const openSetup = () => $("setup-dialog").showModal();
  $("add-robot-btn").addEventListener("click", openSetup);
  $("empty-add-robot-btn").addEventListener("click", openSetup);
  $("setup-close").addEventListener("click", () => $("setup-dialog").close());

  // Setup card's Flash button → canonical install flow in esp-serial.js.
  // The "Web Serial required" hint replaces the button when the browser
  // can't support it.
  const setupInstallBtn = document.getElementById("setup-esp-install");
  if (setupInstallBtn) {
    if (!("serial" in navigator)) {
      setupInstallBtn.disabled = true;
      document.getElementById("setup-esp-unsupported").hidden = false;
    } else {
      setupInstallBtn.addEventListener("click", async () => {
        // Close the setup chooser — install dialog takes over from here.
        // Two stacked modals split focus and make "which X dismisses what"
        // ambiguous (HIG: avoid competing modals). Setup card has done
        // its job by routing us into installEsp32.
        $("setup-dialog").close();
        // Release any console-held port before installEsp32 picks a new one.
        await Promise.all([
          import("./recovery.js").then(m => m.releasePort?.()).catch(() => {}),
          import("./esp-serial.js").then(m => m.releasePort?.()).catch(() => {}),
        ]);
        const { installEsp32 } = await import("./esp-serial.js");
        await installEsp32();
      });
    }
  }

  initGamepad();
  initMotorsKeyboard();
  initAuthUI();
  initPasswordsUI();
  // Pip is additive; if it can't init (CDN failure, regression in pip-core,
  // bad cached SW), the rest of the dashboard must keep working. Fence the
  // call so a Pip throw doesn't take down BLE / phones / robot presence.
  // initAssistant is async (it dynamic-imports pip-core from jsdelivr); a
  // bare try/catch wouldn't catch the rejected promise, so use .catch and
  // let the rest of init continue synchronously.
  initAssistant().catch(err => console.error("[pip] init failed:", err));
  initPhones();
  initHelpers();
  initRobotPresence();

  // Lazy-load prepare.js on first click — it's ~230 LOC and touches the File
  // System Access API; no reason to pull it into first-paint. prepare.js's
  // openDialog() runs its own initOnce() internally so one-time setup still
  // happens. ?prepare URL param keeps working via the same path.
  $("prepare-open-btn").addEventListener("click", async () => {
    const mod = await import("./prepare.js");
    await mod.openDialog();
  });
  if (new URLSearchParams(location.search).get("prepare") !== null) {
    import("./prepare.js").then(m => m.openDialog());
  }
  loadPaired().then(() => {
    highlightKnownRobotFromUrl();
  });
});
