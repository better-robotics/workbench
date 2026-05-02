// Replay log — every Pip tool call is one record, so a past session can
// be re-evaluated against a new model/prompt without hitting hardware.
// Openpilot's pattern for sanity-checking driving-model upgrades offline.
//
// Storage: IndexedDB, store 'calls', auto-incrementing id, ms timestamps.
//   { id, sessionId, name, input, output, startedAt, endedAt, durationMs, error }
// imageDataUrl payloads stored as-is (JPEG base64 ~40 KB/frame; full
// session lands in a few MB).
//
// wrapExecutor() wraps an executor; downloadReplay() / clearReplay() expose
// the store. window.replayDownload is the DevTools entry point.

const DB_NAME = "better-robotics-replay";
const DB_VERSION = 1;
const STORE = "calls";

// One sessionId per page-load to group records across the cross-session
// IDB. randomUUID falls back for older browsers.
const SESSION_ID = (typeof crypto !== "undefined" && crypto.randomUUID)
  ? crypto.randomUUID()
  : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        s.createIndex("sessionId", "sessionId");
        s.createIndex("startedAt", "startedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function writeRecord(record) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).add(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    // Never let replay logging break the actual tool call. Silent drop.
    try { console.warn("[replay] write failed", err); } catch {}
  }
}

// Persists every call. Returns an executor with identical signature and
// behavior; observation only, no interception.
export function wrapExecutor(executor) {
  return async function wrapped(name, input) {
    const startedAt = Date.now();
    let output, error;
    try {
      output = await executor(name, input);
      return output;
    } catch (err) {
      error = String(err?.message || err);
      throw err;
    } finally {
      const endedAt = Date.now();
      writeRecord({
        sessionId: SESSION_ID,
        name,
        input: safeClone(input),
        output: safeClone(output),
        error: error ?? null,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
      });
    }
  };
}

// Strip huge / non-serializable. Image data URLs stay (the whole point
// of replay). Functions, DOM nodes, BigInts → strings so structuredClone
// doesn't throw.
function safeClone(v) {
  try {
    return structuredClone(v);
  } catch {
    try { return JSON.parse(JSON.stringify(v)); }
    catch { return String(v); }
  }
}

export async function allRecords() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Episodic memory for Pip: up to `n` (≤50) most-recent records for the
// current session, newest-first, heavy payloads stripped so they don't
// re-enter the context. Image data URLs and strings >500 chars become
// "[image]" / "[large]".
export async function getRecentActions(sessionId, n = 10) {
  if (!sessionId) return [];
  const limit = Math.min(Math.max(Number(n) || 10, 1), 50);
  const db = await openDb();
  // Cursor sessionId index in "prev" so iterator yields newest-first.
  // Break at limit instead of getAll → sort → slice — long sessions with
  // image records would otherwise serialize many MB just to drop them.
  const records = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const idx = tx.objectStore(STORE).index("sessionId");
    const out = [];
    const req = idx.openCursor(IDBKeyRange.only(sessionId), "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) { resolve(out); return; }
      out.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return records.map(sanitizeRecord);
}

function sanitizeRecord(r) {
  return {
    name: r.name,
    durationMs: r.durationMs ?? null,
    error: r.error ?? null,
    input: sanitizeValue(r.input),
    output: sanitizeValue(r.output),
  };
}

function sanitizeValue(v) {
  if (v == null) return v;
  if (typeof v === "string") return summarizeString(v);
  if (Array.isArray(v)) return v.map(sanitizeValue);
  if (typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = sanitizeValue(val);
    return out;
  }
  return v;
}

function summarizeString(s) {
  if (s.startsWith("data:image/")) return "[image]";
  if (s.length > 500) return "[large]";
  return s;
}

export async function downloadReplay(filename = null) {
  const records = await allRecords();
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `replay-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { count: records.length, session: SESSION_ID };
}

export async function clearReplay() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Dev handles, callable from DevTools. No UI; would be premature until
// replay is a real workflow rather than an occasional debug dump.
if (typeof window !== "undefined") {
  window.replayDownload = downloadReplay;
  window.replayClear = clearReplay;
  window.replayAll = allRecords;
  window.replaySession = SESSION_ID;
}
