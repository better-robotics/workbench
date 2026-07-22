// The IDE view — a full-viewport surface (not a modal), the successor to the
// cramped scripts dialog. Monaco with real IntelliSense for the script API,
// a file tree spanning on-robot files (BLE file service) and offline-safe
// Local drafts, tabs with per-file dirty markers, and the unchanged Run
// path. Opened non-modally (.show()) like the serial console so Pip's
// top-layer popover stays clickable.
import { $ } from "../dom.js";
import { state } from "../state.js";
import { loadMonaco } from "./monaco.js";
import { runUserScript, TEMPLATES } from "./script-runtime.js";
import {
  fsAvailable, listFiles, readFileText, writeFile, deleteFile,
} from "../fs/fs-client.js";

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
function clearOutput() {
  const out = $("ide-output");
  if (out) { out.innerHTML = ""; out.hidden = true; }
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
    el.className = "ide-tab" + (tab.key === _activeKey ? " active" : "");
    el.title = tab.source === "board" ? `${tab.name} — on ${robotName(tab.robotId)}` : `${tab.name} — Local`;
    const label = document.createElement("span");
    label.className = "ide-tab-label";
    label.textContent = (isDirty(tab) ? "• " : "") + tab.name;
    el.appendChild(label);
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
  const uri = _monaco.Uri.parse(`inmemory://ide/${encodeURIComponent(key)}.js`);
  const model = _monaco.editor.createModel(text, "javascript", uri);
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

let _running = false;
async function run() {
  if (_running) return;
  const tab = _tabs.get(_activeKey);
  if (!tab) return;
  _running = true;
  const btn = $("ide-run");
  if (btn) btn.disabled = true;
  clearOutput();
  const body = tab.model.getValue();
  // Auto-persist the running body so a crash mid-run doesn't lose it, same
  // as the old dialog saved on Run. Board files aren't auto-pushed (a BLE
  // write per run is wasteful + slow); only local drafts persist here.
  if (tab.source === "local") saveLocalFile(tab.name, body);
  try {
    await runUserScript(body, {
      onLog: (line) => appendOutput(line),
      onError: (msg) => appendOutput(`Error: ${msg}`, "ide-out-error"),
    });
  } finally {
    _running = false;
    if (btn) btn.disabled = false;
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

async function newFile(source, robotId, seedBody = "// New script\n") {
  const name = promptName(source === "board" ? "script.js" : "draft.js");
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
  const stem = name.replace(/\.js$/, "");
  for (let i = 2; i < 999; i++) {
    const candidate = `${stem}-${i}.js`;
    if (!map[candidate]) return candidate;
  }
  return `${stem}-${Date.now()}.js`;
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
  for (const name of names) {
    localSec.list.appendChild(treeRow(name, "", {
      onOpen: () => openTab({ source: "local", name }),
      onDelete: () => {
        if (!confirm(`Delete local draft ${name}?`)) return;
        deleteLocalFile(name);
        closeTab(keyFor("local", null, name));
        renderTree();
      },
    }));
  }
}

function treeSection(title, onNew) {
  const header = document.createElement("div");
  header.className = "ide-tree-section";
  const label = document.createElement("span");
  label.className = "ide-tree-title";
  label.textContent = title;
  const meta = document.createElement("span");
  meta.className = "ide-tree-meta";
  const add = document.createElement("button");
  add.className = "ide-tree-add";
  add.setAttribute("aria-label", `New file in ${title}`);
  add.textContent = "+";
  add.addEventListener("click", onNew);
  header.append(label, meta, add);
  const list = document.createElement("ul");
  list.className = "ide-tree-list";
  return { header, list, meta };
}

function treeRow(name, meta, { onOpen, onDelete }) {
  const li = document.createElement("li");
  li.className = "ide-tree-row";
  const openBtn = document.createElement("button");
  openBtn.className = "ide-tree-file";
  openBtn.textContent = name;
  openBtn.addEventListener("click", onOpen);
  const metaEl = document.createElement("span");
  metaEl.className = "ide-tree-size";
  metaEl.textContent = meta;
  const del = document.createElement("button");
  del.className = "ide-tree-del";
  del.setAttribute("aria-label", `Delete ${name}`);
  del.textContent = "🗑";
  del.addEventListener("click", onDelete);
  li.append(openBtn, metaEl, del);
  return li;
}

function fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
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
      tabSize: 2,
      padding: { top: 10 },
    });
    _editor.addCommand(_monaco.KeyMod.CtrlCmd | _monaco.KeyCode.Enter, () => run());
    _editor.addCommand(_monaco.KeyMod.CtrlCmd | _monaco.KeyCode.KeyS, () => save());
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
  const sel = $("ide-template");
  sel.innerHTML = `<option value="">New from template…</option>` +
    TEMPLATES.map(t => `<option value="${t.id}">${t.label}</option>`).join("");
  sel.addEventListener("change", loadTemplateInto);
}
