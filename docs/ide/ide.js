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
  fsAvailable, listFiles, readFileText, writeFile, deleteFile,
} from "../fs/fs-client.js";
import { updateFirmware, updateFromFile } from "../capabilities/ota.js";
import { FLASH_MAP } from "./flash-map.js";

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
  const tree = $("ide-tree"), flash = $("ide-flash"), title = $("ide-sidebar-title");
  if (tree) tree.hidden = name !== "explorer";
  if (flash) flash.hidden = name !== "flash";
  if (title) title.textContent = name === "flash" ? "Flash" : "Explorer";
  for (const btn of document.querySelectorAll(".ide-act")) {
    btn.classList.toggle("active", btn.dataset.view === name);
  }
  if (name === "flash") renderFlash();
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

// ---- output pane ---------------------------------------------------------

function appendOutput(line, cls) {
  const out = $("ide-output");
  if (!out) return;
  const div = document.createElement("div");
  div.textContent = line;
  if (cls) div.className = cls;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
  out.hidden = false;
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
  out.hidden = false;
}
function clearOutput() {
  const out = $("ide-output");
  if (out) { out.innerHTML = ""; out.hidden = true; }
  _streamEl = null;
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
  const sel = $("ide-template");
  sel.innerHTML = `<option value="">New from template…</option>` +
    TEMPLATES.map(t => `<option value="${t.id}">${t.label}</option>`).join("");
  sel.addEventListener("change", loadTemplateInto);
}
