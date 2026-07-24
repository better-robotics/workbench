// The IDE view — a full-viewport surface (not a modal), the successor to the
// cramped scripts dialog. Monaco with real IntelliSense for the script API,
// a file tree spanning on-robot files (BLE file service) and offline-safe
// Local drafts, tabs with per-file dirty markers, and the unchanged Run
// path. Opened non-modally (.show()) like the serial console so Pip's
// top-layer popover stays clickable.
import { $ } from "../dom.js";
import { state } from "../state.js";
import { loadMonaco } from "./monaco.js";
import { TEMPLATES } from "./script-runtime.js";
import { runOnRobot, runOnFleet, pyCapable } from "./script-runner.js";
import {
  fsAvailable, listFiles, readFileText, writeFile, deleteFile, fsInfo,
} from "../fs/fs-client.js";
import { scanForNew } from "../ble/ble-lifecycle.js";
import { updateFirmware, updateFromFile } from "../capabilities/ota.js";
import { FLASH_MAP } from "./flash-map.js";
import { formatUptime, formatRssi, formatResetReason } from "../format.js";

// Local drafts: a name→body map, so the offline path survives with no robot.
// One-doc predecessor (the old scripts dialog) migrates in as draft.js.
const LOCAL_KEY = "better-robotics:ide:local:v1";
const LEGACY_KEY = "better-robotics:scripts:v1";
const LAST_KEY = "better-robotics:ide:last:v1";

function readLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) return JSON.parse(raw) || {};
  } catch {}
  // Migrate the single legacy draft, once.
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const seed = { "draft.js": legacy };
      localStorage.setItem(LOCAL_KEY, JSON.stringify(seed));
      return seed;
    }
  } catch {}
  return {};
}
function writeLocal(map) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(map)); } catch {}
}
function saveLocalFile(name, body) {
  const map = readLocal();
  map[name] = body;
  writeLocal(map);
}
function deleteLocalFile(name) {
  const map = readLocal();
  delete map[name];
  writeLocal(map);
}

let _monaco = null;
let _editor = null;
let _wired = false;
// Open tabs, keyed by an identity string. Each: { key, source, robotId?,
// name, model, saved } — `saved` is the last-persisted text for dirty compare.
const _tabs = new Map();
let _activeKey = null;

const keyFor = (source, robotId, name) =>
  source === "board" ? `board:${robotId}:${name}` : `local:${name}`;

function connectedFsRobots() {
  return [...state.devices.values()].filter(e => e.status === "connected" && fsAvailable(e));
}
function connectedRobots() {
  return [...state.devices.values()].filter(e => e.status === "connected");
}

// Activity-bar view switching (Explorer / Flash) — the VS Code shell around
// Monaco is ours to build; Monaco is only the editor.
let _view = "explorer";
function setView(name) {
  _view = name;
  // Monitor is a full-width dashboard — it swaps out the sidebar + editor.
  const isMon = name === "monitor";
  const sidebar = document.querySelector(".ide-sidebar");
  const main = document.querySelector(".ide-main");
  if (sidebar) sidebar.hidden = isMon;
  if (main) main.hidden = isMon;
  const mon = $("ide-monitor");
  if (mon) mon.hidden = !isMon;
  if (!isMon) {
    const tree = $("ide-tree"), flash = $("ide-flash"), title = $("ide-sidebar-title");
    if (tree) tree.hidden = name !== "explorer";
    if (flash) flash.hidden = name !== "flash";
    if (title) title.textContent = name === "flash" ? "Flash" : "Explorer";
  }
  for (const btn of document.querySelectorAll(".ide-act")) {
    btn.classList.toggle("active", btn.dataset.view === name);
  }
  if (name === "flash") renderFlash();
  if (isMon) startMonitor(); else stopMonitor();
}

// Flash view: the firmware panel per connected robot (flash map + OTA). Its
// own activity, distinct from the file explorer — raw flash, not files.
function renderFlash() {
  const host = $("ide-flash");
  if (!host) return;
  host.innerHTML = "";
  const robots = connectedRobots();
  if (robots.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ide-tree-empty";
    empty.textContent = "No robot connected.";
    host.appendChild(empty);
    return;
  }
  for (const entry of robots) {
    const name = document.createElement("div");
    name.className = "ide-flash-robot";
    name.textContent = entry.name;
    host.appendChild(name);
    host.appendChild(firmwareSection(entry));
  }
}

// ---- Monitor view — a device dashboard from real telemetry --------------

let _monTimer = null;
const _monHistory = new Map(); // robotId -> [{ temp, heap(KB) }] chart samples
const _monStamp = new Map();   // robotId -> last telemetry stamp sampled

function startMonitor() {
  // /fs usage (used/total) is a one-shot BLE call; fetch once for the bar.
  for (const entry of connectedRobots()) {
    if (fsAvailable(entry) && !entry._monFs) {
      fsInfo(entry).then((i) => { entry._monFs = i; if (_view === "monitor") renderMonitor(); }).catch(() => {});
    }
  }
  renderMonitor();
  if (_monTimer) clearInterval(_monTimer);
  _monTimer = setInterval(monitorTick, 2000);
}
function stopMonitor() {
  if (_monTimer) { clearInterval(_monTimer); _monTimer = null; }
}

// Push a chart sample when fresh telemetry arrived (~every 10s; telemetry
// flows into entry.telemetry via the BLE notify handler), then repaint.
function monitorTick() {
  for (const entry of connectedRobots()) {
    const stamp = entry.telemetryUpdatedAt || 0;
    if (_monStamp.get(entry.id) === stamp) continue;
    _monStamp.set(entry.id, stamp);
    const t = entry.telemetry || {};
    const hist = _monHistory.get(entry.id) || [];
    hist.push({ temp: t.temp_c ?? null, heap: t.free_heap != null ? t.free_heap / 1024 : null });
    if (hist.length > 180) hist.shift();
    _monHistory.set(entry.id, hist);
  }
  renderMonitor();
}

function renderMonitor() {
  const host = $("ide-monitor");
  if (!host) return;
  const robots = connectedRobots();
  if (robots.length === 0) {
    // Keep the existing empty-state node across the 2 s ticks — a rebuild
    // mid-click would swallow the pointer-down and eat the user's press.
    if (!host.querySelector(".ide-mon-empty")) {
      host.innerHTML = "";
      const ble = !!navigator.bluetooth;
      const ser = "serial" in navigator;
      const empty = document.createElement("div");
      empty.className = "ide-mon-empty";
      const title = document.createElement("div");
      title.className = "ide-mon-empty-title";
      title.textContent = "No robot connected";
      empty.appendChild(title);
      const sub = document.createElement("div");
      sub.className = "ide-mon-empty-sub";
      sub.textContent = ble
        ? "Pair a robot to see its live telemetry and run your scripts on it."
        : "This browser can't do Bluetooth — use Chrome or Edge on desktop.";
      empty.appendChild(sub);
      if (ble || ser) {
        const row = document.createElement("div");
        row.className = "ide-mon-actions";
        if (ble) {
          const btn = document.createElement("button");
          btn.className = "ide-mon-connect";
          btn.textContent = "Connect a robot";
          // scanForNew needs the click's user activation for requestDevice;
          // the monitor tick re-render picks up the new robot within 2 s.
          btn.addEventListener("click", () => scanForNew());
          row.appendChild(btn);
        }
        if (ser) {
          // The fresh-board on-ramp: nothing to find over BLE until firmware
          // is flashed over USB — same flow as the dashboard's setup card.
          const usb = document.createElement("button");
          usb.className = "secondary";
          usb.textContent = "Set up a new board (USB)";
          usb.addEventListener("click", async () => {
            await import("../recovery/console.js").then(m => m.releasePort?.()).catch(() => {});
            const { installEsp32 } = await import("../recovery/esp-serial.js");
            installEsp32();
          });
          row.appendChild(usb);
        }
        empty.appendChild(row);
      }
      host.appendChild(empty);
    }
    return;
  }
  const scroll = host.scrollTop;
  host.innerHTML = "";
  for (const entry of robots) host.appendChild(monitorPanel(entry));
  host.scrollTop = scroll;
  // Charts draw after layout (need clientWidth).
  requestAnimationFrame(() => {
    for (const cv of host.querySelectorAll("canvas.ide-mon-chart")) {
      drawMonitorChart(cv, _monHistory.get(cv.dataset.robot) || []);
    }
  });
}

const fmtKB = (b) => (b == null ? "—" : `${Math.round(b / 1024)} KB`);
const fmtMB = (b) => (b == null ? "—" : `${(b / 1048576).toFixed(1)} MB`);
const tempSub = (c) => (c < 60 ? "normal" : c < 80 ? "warm" : "hot");
const tempCls = (c) => (c < 60 ? "ok" : c < 80 ? "warn" : "danger");

function monTile(label, value, sub, subCls) {
  const el = document.createElement("div");
  el.className = "ide-mon-tile";
  const l = document.createElement("div"); l.className = "ide-mon-tile-label"; l.textContent = label;
  const v = document.createElement("div"); v.className = "ide-mon-tile-value"; v.textContent = value;
  el.append(l, v);
  if (sub) { const s = document.createElement("div"); s.className = "ide-mon-tile-sub" + (subCls ? " " + subCls : ""); s.textContent = sub; el.appendChild(s); }
  return el;
}

function monitorPanel(entry) {
  const t = entry.telemetry || {};
  const info = entry.fwInfo || {};
  const panel = document.createElement("div");
  panel.className = "ide-mon-panel";

  const head = document.createElement("div");
  head.className = "ide-mon-head";
  const hl = document.createElement("div"); hl.className = "ide-mon-head-left";
  const title = document.createElement("div"); title.className = "ide-mon-title"; title.textContent = entry.name;
  const meta = document.createElement("div"); meta.className = "ide-mon-meta"; meta.textContent = `${info.chip || "esp32"} · ${t.sha || info.version || "?"}`;
  hl.append(title, meta);
  const hr = document.createElement("div"); hr.className = "ide-mon-head-right";
  hr.innerHTML = `<span class="ide-mon-online"><span class="ide-mon-dot"></span>Online</span><span class="ide-mon-refresh">refresh 10s</span>`;
  head.append(hl, hr);
  panel.appendChild(head);

  const tiles = document.createElement("div");
  tiles.className = "ide-mon-tiles";
  if (t.temp_c != null) tiles.appendChild(monTile("Chip temp", `${t.temp_c.toFixed(1)}°C`, tempSub(t.temp_c), tempCls(t.temp_c)));
  tiles.appendChild(monTile("Free heap", fmtKB(t.free_heap), t.min_free_heap != null ? `min ever ${fmtKB(t.min_free_heap)}` : ""));
  if (t.free_psram != null) tiles.appendChild(monTile("PSRAM free", fmtMB(t.free_psram), ""));
  tiles.appendChild(monTile("Wi-Fi RSSI", formatRssi(t.rssi_dbm) || "—", ""));
  tiles.appendChild(monTile("Uptime", formatUptime(t) || "—", t.reset_reason ? `reset: ${formatResetReason(t.reset_reason) || t.reset_reason}` : ""));
  if (t.tasks != null) tiles.appendChild(monTile("Tasks", String(t.tasks), ""));
  panel.appendChild(tiles);

  const chartWrap = document.createElement("div");
  chartWrap.className = "ide-mon-chartwrap";
  chartWrap.innerHTML = `<div class="ide-mon-legend"><span><i style="background:#f0883e"></i>Chip temp</span><span><i style="background:#4c9be8"></i>Free heap</span></div>`;
  const canvas = document.createElement("canvas");
  canvas.className = "ide-mon-chart";
  canvas.dataset.robot = entry.id;
  chartWrap.appendChild(canvas);
  panel.appendChild(chartWrap);

  const bottom = document.createElement("div");
  bottom.className = "ide-mon-bottom";
  bottom.append(monFlashCard(entry), monSystemCard(t, info));
  panel.appendChild(bottom);
  return panel;
}

function monFlashCard(entry) {
  const card = document.createElement("div");
  card.className = "ide-mon-card";
  const h = document.createElement("div"); h.className = "ide-mon-card-title"; h.textContent = "Flash partitions"; card.appendChild(h);
  for (const p of FLASH_MAP) {
    const row = document.createElement("div"); row.className = "ide-mon-part";
    const top = document.createElement("div"); top.className = "ide-mon-part-top";
    const label = document.createElement("span"); label.className = "ide-mon-part-label"; label.textContent = `${p.label}  ${partNote(p)}`;
    const amt = document.createElement("span"); amt.className = "ide-mon-part-amt";
    let pct = null;
    if (p.label === "storage" && entry._monFs) {
      amt.textContent = `${fmtKB(entry._monFs.used)} / ${fmtKB(entry._monFs.total)}`;
      pct = entry._monFs.total ? entry._monFs.used / entry._monFs.total : 0;
    } else {
      amt.textContent = fmtBytes(p.size);
    }
    top.append(label, amt); row.appendChild(top);
    if (pct != null) {
      const bar = document.createElement("div"); bar.className = "ide-mon-bar";
      const fill = document.createElement("div"); fill.className = "ide-mon-bar-fill"; fill.style.width = `${Math.round(pct * 100)}%`;
      bar.appendChild(fill); row.appendChild(bar);
    }
    card.appendChild(row);
  }
  return card;
}

function monSystemCard(t, info) {
  const card = document.createElement("div");
  card.className = "ide-mon-card";
  const h = document.createElement("div"); h.className = "ide-mon-card-title"; h.textContent = "System"; card.appendChild(h);
  const rows = [
    ["Firmware", t.sha || info.version || "—"],
    ["IDF", info.idf || "—"],
    ["PSRAM free", fmtMB(t.free_psram)],
    ["IP", t.ip || "—"],
    ["Reset", t.reset_reason ? (formatResetReason(t.reset_reason) || t.reset_reason) : "—"],
    ["Tasks", t.tasks != null ? String(t.tasks) : "—"],
    ["Uptime", formatUptime(t) || "—"],
  ];
  const table = document.createElement("table"); table.className = "ide-mon-table";
  for (const [k, v] of rows) {
    const tr = document.createElement("tr");
    const kc = document.createElement("td"); kc.className = "ide-mon-k"; kc.textContent = k;
    const vc = document.createElement("td"); vc.className = "ide-mon-v"; vc.textContent = v;
    tr.append(kc, vc); table.appendChild(tr);
  }
  card.appendChild(table);
  return card;
}

// Hand-rolled canvas line chart — two auto-scaled series (temp + heap) over the
// session. No dependency; each series normalized to its own range (sparkline
// style), precise values live in the tiles.
function drawMonitorChart(canvas, history) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600, h = canvas.clientHeight || 170;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = 10;
  ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = pad + (h - 2 * pad) * i / 3;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
  }
  if (history.length < 2) {
    ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.font = "12px system-ui"; ctx.textAlign = "center";
    ctx.fillText("collecting telemetry…", w / 2, h / 2);
    return;
  }
  const series = (key, color, dash) => {
    const vals = history.map((s) => s[key]).filter((v) => v != null);
    if (vals.length < 2) return;
    const min = Math.min(...vals), max = Math.max(...vals), range = (max - min) || 1;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash || []); ctx.beginPath();
    let started = false;
    history.forEach((s, i) => {
      if (s[key] == null) return;
      const x = pad + (w - 2 * pad) * i / (history.length - 1);
      const y = (h - pad) - (h - 2 * pad) * (s[key] - min) / range;
      if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
    });
    ctx.stroke(); ctx.setLineDash([]);
  };
  series("temp", "#f0883e");
  series("heap", "#4c9be8", [5, 3]);
}

// ---- bottom panel (Output | Serial) --------------------------------------
// Output is script stdout over BLE; Serial is the USB console — same
// category (text streaming back from a board), so one panel with tabs
// instead of a second full-bleed dialog fighting this one for the viewport.

let _panelTab = "output";
let _serialMod = null;  // recovery/console.js, loaded on first Serial visit

function setPanelTab(tab) {
  _panelTab = tab;
  const panel = $("ide-panel");
  if (!panel) return;
  // .serial on the panel drives both pane height (a terminal needs real
  // rows; a one-line "Saved" note doesn't) and .serial-only control
  // visibility — CSS-gated so there's no per-control hidden juggling here.
  panel.classList.toggle("serial", tab === "serial");
  $("ide-output").hidden = tab !== "output";
  $("ide-serial").hidden = tab !== "serial";
  for (const b of panel.querySelectorAll(".ide-panel-tab")) {
    b.classList.toggle("active", b.dataset.panel === tab);
  }
  applyPanelH();
  if (tab === "serial") ensureSerial();
}

// Serial-tab panel height — sash-dragged, persisted, clamped to leave the
// toolbar + tab strip + a sliver of editor reachable. Monaco (automaticLayout)
// and xterm (ResizeObserver in xterm-host.js) both re-fit on their own, so
// resizing is pure CSS height from here.
const PANEL_H_KEY = "better-robotics:ide:panel-h:v1";
let _panelH = null;  // user-chosen px; null = the CSS default (40vh)
try { _panelH = parseInt(localStorage.getItem(PANEL_H_KEY), 10) || null; } catch {}

function panelMaxH() {
  const body = document.querySelector(".ide-body");
  return body ? Math.max(160, body.getBoundingClientRect().height - 84) : 600;
}
const clampPanelH = (h) => Math.min(panelMaxH(), Math.max(120, Math.round(h)));
// Inline height only while the serial tab owns the panel — cleared on the
// output tab so its auto-height CSS governs again.
function applyPanelH() {
  const panel = $("ide-panel");
  if (!panel) return;
  panel.style.height = (_panelTab === "serial" && _panelH) ? `${clampPanelH(_panelH)}px` : "";
}
function setPanelH(h) {
  _panelH = clampPanelH(h);
  applyPanelH();
  $("ide-panel-sash")?.setAttribute("aria-valuenow", String(_panelH));
}

function wireSash() {
  const sash = $("ide-panel-sash");
  if (!sash) return;
  sash.addEventListener("pointerdown", (e) => {
    e.preventDefault();  // no text/terminal selection while dragging
    sash.setPointerCapture(e.pointerId);
    sash.classList.add("dragging");
    const startY = e.clientY;
    const startH = $("ide-panel").getBoundingClientRect().height;
    const move = (ev) => setPanelH(startH + (startY - ev.clientY));
    const up = () => {
      sash.classList.remove("dragging");
      sash.removeEventListener("pointermove", move);
      try { localStorage.setItem(PANEL_H_KEY, String(_panelH)); } catch {}
    };
    sash.addEventListener("pointermove", move);
    sash.addEventListener("pointerup", up, { once: true });
    sash.addEventListener("pointercancel", up, { once: true });
  });
  // Double-click: maximize ⇄ restore (VS Code's panel toggle, minus the icon).
  sash.addEventListener("dblclick", () => {
    const max = panelMaxH();
    const cur = $("ide-panel").getBoundingClientRect().height;
    setPanelH(cur >= max - 8 ? Math.round(window.innerHeight * 0.4) : max);
    try { localStorage.setItem(PANEL_H_KEY, String(_panelH)); } catch {}
  });
  // Keyboard resize — role="separator" earns arrow keys, not just a cursor.
  sash.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowUp" ? 24 : e.key === "ArrowDown" ? -24 : 0;
    if (!step) return;
    e.preventDefault();
    setPanelH($("ide-panel").getBoundingClientRect().height + step);
    try { localStorage.setItem(PANEL_H_KEY, String(_panelH)); } catch {}
  });
}
function openPanel(tab) {
  const panel = $("ide-panel");
  if (!panel) return;
  panel.hidden = false;
  if (tab && tab !== _panelTab) setPanelTab(tab);
  else if (tab === "serial") ensureSerial();
}
// Hiding the panel does NOT end a serial session — the port stays open and
// xterm keeps buffering (ResizeObserver's zero-box guard skips the hidden
// fit; reveal re-fits). Disconnect is the only session terminator.
function closePanel() {
  const panel = $("ide-panel");
  if (panel) panel.hidden = true;
}
// Lazy: xterm.js + Web Serial plumbing load on first Serial-tab visit, not
// with the IDE. console.js's init is idempotent, so re-entry is free.
async function ensureSerial() {
  _serialMod = await import("../recovery/console.js");
  _serialMod.init();
}

function appendOutput(line, cls) {
  const out = $("ide-output");
  if (!out) return;
  const div = document.createElement("div");
  div.textContent = line;
  if (cls) div.className = cls;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
  openPanel("output");
}
// Append streamed VM output (print / traceback text) into one running node so
// partial-line chunks concatenate instead of each becoming its own row.
let _streamEl = null;
function appendStream(text) {
  const out = $("ide-output");
  if (!out) return;
  if (!_streamEl) {
    _streamEl = document.createElement("div");
    _streamEl.className = "ide-out-stream";
    out.appendChild(_streamEl);
  }
  _streamEl.textContent += text;
  out.scrollTop = out.scrollHeight;
  openPanel("output");
}
function clearOutput() {
  const out = $("ide-output");
  if (out) out.innerHTML = "";
  _streamEl = null;
  // Retract the panel only when it's showing (now-empty) output and no
  // serial session would vanish with it.
  if (_panelTab === "output" && !_serialMod?.isConnected?.()) closePanel();
}

// ---- tabs ----------------------------------------------------------------

function isDirty(tab) {
  return tab.model && tab.model.getValue() !== tab.saved;
}

function renderTabs() {
  const bar = $("ide-tabs");
  if (!bar) return;
  bar.innerHTML = "";
  for (const tab of _tabs.values()) {
    const el = document.createElement("div");
    el.className = "ide-tab" + (tab.key === _activeKey ? " active" : "") + (isDirty(tab) ? " dirty" : "");
    el.title = tab.source === "board" ? `${tab.name} — on ${robotName(tab.robotId)}` : `${tab.name} — Local`;
    el.appendChild(fileIconEl());
    const label = document.createElement("span");
    label.className = "ide-tab-label";
    label.textContent = tab.name;
    el.appendChild(label);
    if (isDirty(tab)) {
      const dot = document.createElement("span");
      dot.className = "ide-tab-dirty";
      dot.textContent = "●";
      el.appendChild(dot);
    }
    const close = document.createElement("button");
    close.className = "ide-tab-close";
    close.setAttribute("aria-label", `Close ${tab.name}`);
    close.textContent = "×";
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab.key); });
    el.appendChild(close);
    el.addEventListener("click", () => activateTab(tab.key));
    bar.appendChild(el);
  }
  const active = _tabs.get(_activeKey);
  const fileLabel = $("ide-active-file");
  if (fileLabel) fileLabel.textContent = active
    ? `${active.name} · ${active.source === "board" ? robotName(active.robotId) : "Local"}`
    : "";
}

function robotName(robotId) {
  return state.devices.get(robotId)?.name || robotId || "robot";
}

function activateTab(key) {
  const tab = _tabs.get(key);
  if (!tab || !_editor) return;
  _activeKey = key;
  _editor.setModel(tab.model);
  _editor.focus();
  renderTabs();
  highlightTreeActive();
  updateStatus();
}

function closeTab(key) {
  const tab = _tabs.get(key);
  if (!tab) return;
  if (isDirty(tab) && !confirm(`Discard unsaved changes to ${tab.name}?`)) return;
  tab.model.dispose();
  _tabs.delete(key);
  if (_activeKey === key) {
    _activeKey = null;
    const next = [..._tabs.keys()].pop();
    if (next) activateTab(next);
    else if (_editor) _editor.setModel(null);
  }
  renderTabs();
  persistSession();
}

// Open (or focus) a tab for the given file, creating its Monaco model. Board
// files load their content lazily via the file service.
async function openTab({ source, robotId, name, body }) {
  const key = keyFor(source, robotId, name);
  if (_tabs.has(key)) { activateTab(key); return; }
  let text = body;
  if (text == null && source === "board") {
    appendOutput(`Reading ${name} from ${robotName(robotId)}…`, "ide-out-note");
    try {
      const entry = state.devices.get(robotId);
      text = await readFileText(entry, name);
      clearOutput();
    } catch (err) {
      appendOutput(`Couldn't read ${name}: ${err.message}`, "ide-out-error");
      return;
    }
  }
  if (text == null && source === "local") text = readLocal()[name] ?? "";
  const uri = _monaco.Uri.parse(`inmemory://ide/${encodeURIComponent(key)}.py`);
  const model = _monaco.editor.createModel(text, "python", uri);
  const tab = { key, source, robotId, name, model, saved: text };
  model.onDidChangeContent(() => { if (key === _activeKey) renderTabs(); });
  _tabs.set(key, tab);
  activateTab(key);
  persistSession();
}

// ---- save ----------------------------------------------------------------

async function save() {
  const tab = _tabs.get(_activeKey);
  if (!tab) return;
  const text = tab.model.getValue();
  if (tab.source === "local") {
    saveLocalFile(tab.name, text);
    tab.saved = text;
    renderTabs();
    appendOutput(`Saved ${tab.name} (Local)`, "ide-out-note");
    return;
  }
  const entry = state.devices.get(tab.robotId);
  if (!entry || !fsAvailable(entry)) {
    appendOutput(`${robotName(tab.robotId)} disconnected — can't save ${tab.name}`, "ide-out-error");
    return;
  }
  appendOutput(`Saving ${tab.name} to ${robotName(tab.robotId)}…`, "ide-out-note");
  try {
    await writeFile(entry, tab.name, text);
    tab.saved = text;
    renderTabs();
    appendOutput(`Saved ${tab.name} → ${robotName(tab.robotId)}`, "ide-out-note");
    renderTree();  // size/used may have changed
  } catch (err) {
    // Quota + validation errors carry a code the UI maps to plain language.
    appendOutput(`Save failed: ${saveErrorText(err)}`, "ide-out-error");
  }
}

function saveErrorText(err) {
  switch (err.fsCode) {
    case "too-big":       return "file too large (32 KB max)";
    case "fs-full":       return "robot storage full";
    case "too-many":      return "too many files on the robot (64 max)";
    case "bad-name":      return "invalid filename (use letters, digits, . _ -)";
    case "bad-crc":       return "transfer corrupted — try again";
    case "size-mismatch": return "transfer incomplete — try again";
    default:              return err.message || "unknown error";
  }
}

// ---- run -----------------------------------------------------------------

let _activeRun = null;

// Which robot runs the active file: a board file runs on its own robot; a
// Local draft runs on the first connected Python-capable robot (shipped there).
function pickRunTarget(tab) {
  if (tab.source === "board") {
    const entry = state.devices.get(tab.robotId);
    return pyCapable(entry) ? entry : null;
  }
  return [...state.devices.values()].find(pyCapable) || null;
}

function setRunning(on) {
  const btn = $("ide-run");
  if (!btn) return;
  const label = btn.querySelector(".run-label");
  if (label) label.textContent = on ? "Stop" : "Run";
  btn.classList.toggle("running", on);
}

// Run toggles: fire → ship+run on the robot; while running → stop.
async function run() {
  if (_activeRun) { await stopRun(); return; }
  const tab = _tabs.get(_activeKey);
  if (!tab) return;
  const entry = pickRunTarget(tab);
  clearOutput();
  if (!entry) {
    appendOutput("No Python-capable robot connected — flash the S3 firmware and connect one to run on it.", "ide-out-error");
    return;
  }
  const body = tab.model.getValue();
  if (tab.source === "local") saveLocalFile(tab.name, body);
  appendOutput(`Running ${tab.name} on ${entry.name}…`, "ide-out-note");
  setRunning(true);
  try {
    _activeRun = await runOnRobot(entry, tab.name, body, {
      onText: (t) => appendStream(t),
      onDone: () => { setRunning(false); _activeRun = null; appendOutput("— done —", "ide-out-note"); renderTree(); },
      onError: (tb) => { appendStream(tb); setRunning(false); _activeRun = null; appendOutput("— error —", "ide-out-error"); },
    });
  } catch (err) {
    appendOutput(`Run failed: ${err.message}`, "ide-out-error");
    setRunning(false);
    _activeRun = null;
  }
}

async function stopRun() {
  const r = _activeRun;
  _activeRun = null;
  setRunning(false);
  if (r) { try { await r.stop(); } catch {} }
  appendOutput("— stopped —", "ide-out-note");
}

function pyRobots() {
  return [...state.devices.values()].filter(pyCapable);
}

// Show "Run all (N)" only when ≥2 robots can run Python — ship-and-run-to-N.
function refreshRunAll() {
  const btn = $("ide-run-all");
  if (!btn) return;
  const n = pyRobots().length;
  btn.hidden = n < 2;
  btn.textContent = `Run all (${n})`;
}

// Ship + run the active file on every Python-capable robot at once.
async function runFleet() {
  if (_activeRun) { await stopRun(); return; }
  const tab = _tabs.get(_activeKey);
  if (!tab) return;
  const robots = pyRobots();
  clearOutput();
  if (robots.length === 0) { appendOutput("No Python-capable robots connected.", "ide-out-error"); return; }
  const body = tab.model.getValue();
  if (tab.source === "local") saveLocalFile(tab.name, body);
  appendOutput(`Running ${tab.name} on ${robots.length} robots…`, "ide-out-note");
  setRunning(true);
  try {
    _activeRun = await runOnFleet(robots, tab.name, body, {
      onText: (t) => appendStream(t),
      onDone: () => { setRunning(false); _activeRun = null; appendOutput("— all done —", "ide-out-note"); renderTree(); },
      onError: (tb) => appendStream(tb),
    });
  } catch (err) {
    appendOutput(`Fleet run failed: ${err.message}`, "ide-out-error");
    setRunning(false);
    _activeRun = null;
  }
}

// ---- new file / templates ------------------------------------------------

function promptName(defaultName) {
  const name = prompt("File name:", defaultName);
  if (name == null) return null;
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9._-]{1,48}$/.test(trimmed)) {
    appendOutput(`Invalid name "${trimmed}" — letters, digits, . _ - only (max 48)`, "ide-out-error");
    return null;
  }
  return trimmed;
}

async function newFile(source, robotId, seedBody = "# New script\n") {
  const name = promptName(source === "board" ? "script.py" : "draft.py");
  if (!name) return;
  if (source === "local") {
    saveLocalFile(name, seedBody);
    renderTree();
    await openTab({ source, name, body: seedBody });
  } else {
    // Open the tab first (unsaved); the user saves to push it to the robot.
    await openTab({ source, robotId, name, body: seedBody });
  }
}

function loadTemplateInto() {
  const sel = $("ide-template");
  const tpl = TEMPLATES.find(t => t.id === sel.value);
  sel.value = "";
  if (!tpl) return;
  // Templates seed a Local draft — the offline, no-robot-needed starting point.
  const name = uniqueLocalName(tpl.name);
  saveLocalFile(name, tpl.body);
  renderTree();
  openTab({ source: "local", name, body: tpl.body });
}

function uniqueLocalName(name) {
  const map = readLocal();
  if (!map[name]) return name;
  const stem = name.replace(/\.py$/, "");
  for (let i = 2; i < 999; i++) {
    const candidate = `${stem}-${i}.py`;
    if (!map[candidate]) return candidate;
  }
  return `${stem}-${Date.now()}.py`;
}

// ---- file tree -----------------------------------------------------------

async function renderTree() {
  const tree = $("ide-tree");
  if (!tree) return;
  tree.innerHTML = "";

  // Board sections — one per connected robot that has the file service.
  for (const entry of connectedFsRobots()) {
    const section = treeSection(`On ${entry.name}`, () => newFile("board", entry.id));
    tree.appendChild(section.header);
    const list = section.list;
    tree.appendChild(list);
    list.innerHTML = `<li class="ide-tree-loading">Reading…</li>`;
    try {
      const { files = [], used = 0, total = 0 } = await listFiles(entry);
      list.innerHTML = "";
      if (files.length === 0) {
        list.innerHTML = `<li class="ide-tree-empty">No files yet</li>`;
      }
      for (const f of files) {
        list.appendChild(treeRow(f.name, `${fmtBytes(f.size)}`, {
          key: keyFor("board", entry.id, f.name),
          onOpen: () => openTab({ source: "board", robotId: entry.id, name: f.name }),
          onDelete: async () => {
            if (!confirm(`Delete ${f.name} from ${entry.name}?`)) return;
            try {
              await deleteFile(entry, f.name);
              closeTab(keyFor("board", entry.id, f.name));
              renderTree();
            } catch (err) { appendOutput(`Delete failed: ${err.message}`, "ide-out-error"); }
          },
        }));
      }
      section.meta.textContent = total ? `${fmtBytes(used)} / ${fmtBytes(total)}` : "";
    } catch (err) {
      list.innerHTML = "";
      const li = document.createElement("li");
      li.className = "ide-tree-empty";
      li.textContent = `Unavailable: ${err.message}`;
      list.appendChild(li);
    }
  }

  // Local section — always present; the offline path.
  const localSec = treeSection("Local", () => newFile("local"));
  tree.appendChild(localSec.header);
  tree.appendChild(localSec.list);
  const local = readLocal();
  const names = Object.keys(local).sort();
  if (names.length === 0) {
    localSec.list.innerHTML = `<li class="ide-tree-empty">No local drafts</li>`;
  }
  refreshRunAll();
  for (const name of names) {
    localSec.list.appendChild(treeRow(name, "", {
      key: keyFor("local", null, name),
      onOpen: () => openTab({ source: "local", name }),
      onDelete: () => {
        if (!confirm(`Delete local draft ${name}?`)) return;
        deleteLocalFile(name);
        closeTab(keyFor("local", null, name));
        renderTree();
      },
    }));
  }
  highlightTreeActive();
}

// Collapsed section titles persist across re-renders (in-memory).
const _collapsed = new Set();

function treeSection(title, onNew) {
  const header = document.createElement("div");
  header.className = "ide-tree-section";
  const chevron = document.createElement("span");
  chevron.className = "ide-tree-chevron";
  chevron.innerHTML = `<svg class="icon-svg"><use href="icons.svg#icon-chevron-down"/></svg>`;
  const label = document.createElement("span");
  label.className = "ide-tree-title";
  label.textContent = title;
  const meta = document.createElement("span");
  meta.className = "ide-tree-meta";
  const add = document.createElement("button");
  add.className = "ide-tree-add";
  add.setAttribute("aria-label", `New file in ${title}`);
  add.textContent = "+";
  add.addEventListener("click", (e) => { e.stopPropagation(); onNew(); });
  header.append(chevron, label, meta, add);
  const list = document.createElement("ul");
  list.className = "ide-tree-list";

  // Collapsible group (▾/▸). The robot's fs is a flat namespace, so these are
  // section groups, not real subdirectories — but the affordance is the same.
  const collapsed = _collapsed.has(title);
  header.classList.toggle("collapsed", collapsed);
  list.hidden = collapsed;
  const toggle = () => {
    const now = !_collapsed.has(title);
    if (now) _collapsed.add(title); else _collapsed.delete(title);
    header.classList.toggle("collapsed", now);
    list.hidden = now;
  };
  chevron.addEventListener("click", toggle);
  label.addEventListener("click", toggle);
  return { header, list, meta };
}

function treeRow(name, meta, { key, onOpen, onDelete }) {
  const li = document.createElement("li");
  li.className = "ide-tree-row";
  if (key) li.dataset.key = key;
  const openBtn = document.createElement("button");
  openBtn.className = "ide-tree-file";
  openBtn.appendChild(fileIconEl());
  const nameEl = document.createElement("span");
  nameEl.className = "ide-tree-name";
  nameEl.textContent = name;
  openBtn.appendChild(nameEl);
  openBtn.addEventListener("click", onOpen);
  const metaEl = document.createElement("span");
  metaEl.className = "ide-tree-size";
  metaEl.textContent = meta;
  const del = document.createElement("button");
  del.className = "ide-tree-del";
  del.setAttribute("aria-label", `Delete ${name}`);
  del.textContent = "🗑";
  del.addEventListener("click", (e) => { e.stopPropagation(); onDelete(); });
  li.append(openBtn, metaEl, del);
  return li;
}

function fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// FLASH_MAP is generated from firmware/esp32_robot_idf/partitions.csv by
// tools/gen-partitions.py (the pre-commit hook fails if it drifts) — the
// layout is the same across every board's platformio env. Shown here rather
// than shipped over BLE in fw_info, which overflowed the single read.
function partNote(p) {
  if (p.type === "app") return "app";
  if (p.subtype === "spiffs" || p.label === "storage") return "/fs";
  if (p.label === "nvs") return "config";
  return "";
}

// Firmware section: the flash map (what's on the robot beyond /fs) + the
// existing OTA path surfaced in the IDE. The compiled firmware lives in the
// ota_0/ota_1 partitions as raw images — shown here read-only, updated via
// OTA, never edited as files (they aren't files).
function firmwareSection(entry) {
  const info = entry.fwInfo || {};
  const wrap = document.createElement("div");
  wrap.className = "ide-fw";

  const head = document.createElement("div");
  head.className = "ide-fw-head";
  head.textContent = "Firmware";
  wrap.appendChild(head);

  const meta = document.createElement("div");
  meta.className = "ide-fw-meta";
  meta.textContent = `${info.chip || "esp32"} · ${info.version || "unknown"}`;
  wrap.appendChild(meta);

  const list = document.createElement("ul");
  list.className = "ide-fw-parts";
  for (const p of FLASH_MAP) {
    const li = document.createElement("li");
    li.className = "ide-fw-part";
    const label = document.createElement("span");
    label.className = "ide-fw-part-label";
    const note = partNote(p);
    label.textContent = p.label + (note ? `  ${note}` : "");
    const size = document.createElement("span");
    size.className = "ide-fw-part-size";
    size.textContent = fmtBytes(p.size);
    li.append(label, size);
    list.appendChild(li);
  }
  wrap.appendChild(list);

  const status = document.createElement("div");
  status.className = "ide-fw-status";
  wrap.appendChild(status);
  patchFwStatus(entry, status);

  const actions = document.createElement("div");
  actions.className = "ide-fw-actions";
  const upd = document.createElement("button");
  upd.className = "ide-fw-btn";
  upd.textContent = "Update firmware";
  upd.addEventListener("click", () => startOta(entry, () => updateFirmware(entry.id), status));
  const fromFile = document.createElement("button");
  fromFile.className = "ide-fw-btn";
  fromFile.textContent = "From file…";
  fromFile.addEventListener("click", () => startOta(entry, () => updateFromFile(entry.id), status));
  actions.append(upd, fromFile);
  wrap.appendChild(actions);

  return wrap;
}

function patchFwStatus(entry, el) {
  const s = entry.otaStatus;
  if (!s || s.st === "idle") { el.textContent = ""; return; }
  const total = s.total || 0;
  const n = s.n || entry.otaSent || 0;
  const pct = total ? Math.round((100 * n) / total) : 0;
  el.textContent = s.err ? `${s.st} — ${s.err}` : total ? `${s.st} ${pct}%` : s.st;
}

// Kick off an OTA and mirror its progress into the IDE status line until it
// settles (ota.js drives entry.otaStatus via its own notify subscription).
function startOta(entry, fn, statusEl) {
  if (!entry.otaDataChar) { statusEl.textContent = "Firmware update not supported by this robot"; return; }
  fn();
  const timer = setInterval(() => {
    patchFwStatus(entry, statusEl);
    const st = entry.otaStatus?.st;
    if (!st || st === "idle" || st === "done" || st === "failed") clearInterval(timer);
  }, 500);
}

// A code-file glyph for tree rows + tabs (static markup — no injection risk).
function fileIconEl() {
  const span = document.createElement("span");
  span.className = "ide-file-icon";
  span.innerHTML = `<svg class="icon-svg"><use href="icons.svg#icon-file-code"/></svg>`;
  return span;
}

// Highlight the tree row for the active tab (VS Code's "open file is selected").
function highlightTreeActive() {
  const tree = $("ide-tree");
  if (!tree) return;
  tree.querySelectorAll(".ide-tree-row").forEach((li) => {
    li.classList.toggle("active", li.dataset.key === _activeKey);
  });
}

// Status bar: active file path + cursor position.
function updateStatus() {
  const active = _tabs.get(_activeKey);
  const fileEl = $("ide-status-file");
  if (fileEl) {
    fileEl.textContent = active
      ? (active.source === "board" ? `${robotName(active.robotId)} / ${active.name}` : `Local / ${active.name}`)
      : "";
  }
  const posEl = $("ide-status-pos");
  const pos = _editor?.getPosition();
  if (posEl && pos) posEl.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
}

// ---- session (which local tabs were open) --------------------------------

function persistSession() {
  try {
    const open = [..._tabs.values()]
      .filter(t => t.source === "local")
      .map(t => t.name);
    localStorage.setItem(LAST_KEY, JSON.stringify({ open, active: _tabs.get(_activeKey)?.name }));
  } catch {}
}

async function restoreSession() {
  let sess = null;
  try { sess = JSON.parse(localStorage.getItem(LAST_KEY) || "null"); } catch {}
  const local = readLocal();
  const open = (sess?.open || []).filter(n => local[n]);
  if (open.length === 0) {
    // First run / nothing saved: open the first local draft, or seed hello.
    const first = Object.keys(local)[0];
    if (first) { await openTab({ source: "local", name: first }); return; }
    const hello = TEMPLATES[0];
    saveLocalFile(hello.name, hello.body);
    await openTab({ source: "local", name: hello.name, body: hello.body });
    return;
  }
  for (const name of open) await openTab({ source: "local", name });
  if (sess?.active && local[sess.active]) activateTab(keyFor("local", null, sess.active));
}

// ---- open / wiring -------------------------------------------------------

export async function openIde() {
  const dlg = $("ide-modal");
  if (!dlg.open) dlg.show();
  wire();
  // Landing view: no robot connected → Monitor, whose empty state carries
  // the Connect CTA — the bench order is robot first, then code, and the
  // dashboard coming alive is the confirmation that pairing worked. With a
  // robot connected, keep whatever view the user was in (explorer at first).
  if (connectedRobots().length === 0) setView("monitor");
  const tree = $("ide-tree");
  if (tree && !tree.dataset.ready) tree.innerHTML = `<div class="ide-tree-loading">Loading editor…</div>`;
  try {
    _monaco = await loadMonaco();
  } catch (err) {
    if (tree) {
      tree.innerHTML = "";
      const div = document.createElement("div");
      div.className = "ide-tree-empty";
      div.textContent = `Editor failed to load: ${err.message}`;
      tree.appendChild(div);
    }
    return;
  }
  if (!_editor) {
    _editor = _monaco.editor.create($("ide-editor"), {
      model: null,
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 4,
      insertSpaces: true,
      padding: { top: 10 },
    });
    _editor.addCommand(_monaco.KeyMod.CtrlCmd | _monaco.KeyCode.Enter, () => run());
    _editor.addCommand(_monaco.KeyMod.CtrlCmd | _monaco.KeyCode.KeyS, () => save());
    _editor.onDidChangeCursorPosition(() => updateStatus());
  }
  if ($("ide-tree")) $("ide-tree").dataset.ready = "1";
  await renderTree();
  if (_tabs.size === 0) await restoreSession();
  else renderTabs();
}

export function closeIde() {
  const dlg = $("ide-modal");
  if (dlg?.open) dlg.close();
}

function wire() {
  if (_wired) return;
  _wired = true;
  $("ide-close").addEventListener("click", closeIde);
  $("ide-run").addEventListener("click", run);
  $("ide-run-all").addEventListener("click", runFleet);
  for (const btn of document.querySelectorAll(".ide-act")) {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  }
  for (const btn of document.querySelectorAll(".ide-panel-tab")) {
    btn.addEventListener("click", () => setPanelTab(btn.dataset.panel));
  }
  $("ide-panel-close").addEventListener("click", closePanel);
  wireSash();
  const sel = $("ide-template");
  sel.innerHTML = `<option value="">New from template…</option>` +
    TEMPLATES.map(t => `<option value="${t.id}">${t.label}</option>`).join("");
  sel.addEventListener("change", loadTemplateInto);
}
