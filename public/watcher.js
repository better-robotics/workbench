// Persistent reflex watcher. Lifts the "show sign → robot reacts" demo
// out of the script lifecycle and into the robot's capability surface so
// it works without a script open, and Pip can compose it ("watch for X,
// then ask_human").
//
// Loop shapes by action:
//   - speak / notify: continuous-fire on `classes` (COCO closed-vocab),
//     REARM_DEBOUNCE_MS cool-down between fires. Announce-style.
//   - halt: presence/absence poll on `classes`. On enter, halts motors +
//     sets a per-entry gate Promise that motor tools in pip-tools.js
//     await. On exit, resolves the gate. Mirrors the openpilot panda
//     pattern — safety enforced below the planner.
//   - follow: hand-tracking visual servo (MediaPipe Gesture Recognizer).
//     Centers the palm centroid via turn pulses, drives forward when far,
//     holds when close. Built-in gestures double as commands: Open_Palm
//     pauses follow, Pointing_Up resumes. Same gate-pattern as halt so
//     the user retains a hard stop without leaving the page.
//
// Actions are a closed set (halt / speak / notify / follow). Same
// containment principle as ask_human being the bottom rung: a
// hallucinated Pip call can pick which verb, not invent a new one.

import { startDetection, detectOnce, isMediapipeFailed } from "./mediapipe.js";
import { detectGestureOnce, isGesturesFailed, GESTURE_CLASSES } from "./gestures.js";
import { pulseMotors } from "./capabilities/runtime/signed-pair.js";
import { listCameraSources } from "./camera-frame.js";
import { capSection } from "./capabilities/runtime/cap-section.js";
import { renderEntry } from "./capabilities/runtime/render-bus.js";
import { escapeHtml } from "./dom.js";
import { speak as ttsSpeak } from "./voice.js";

// id → { stop }
const _running = new Map();

// Cool-down after a fire before re-entering the detect loop. Long enough
// that the same object lingering in frame doesn't re-fire every detector
// tick (~100ms); short enough that a re-appearing target is caught
// promptly. 3s lands between speak-action audio overlap (annoying below
// ~2s) and "missed a re-appearance" (annoying above ~5s).
const REARM_DEBOUNCE_MS = 3000;

// Halt-loop poll interval. Tighter than the speak/notify debounce because
// the gate-release moment (sign leaves frame) needs to feel immediate; a
// 1s wait between "I moved the sign away" and motion resuming reads as
// the demo being broken.
const HALT_POLL_MS = 200;

// Follow-loop poll interval. The Gesture Recognizer is ~20ms GPU and
// the motor pulses below take 150-1200ms, so the loop's outer cadence
// is paced by the pulse, not the poll. 150ms gives near-real-time
// gesture pickup without redundant detector spam between pulses.
const FOLLOW_POLL_MS = 150;
// Visual-servo defaults (Hiwonder MentorPi + GestureBot references,
// retuned after first real-world run showed bang-bang overshoot — the
// robot turned past the hand on every detection, lost it out of FOV,
// then reacquired and overshot the other way):
//   - Deadband 0.15 (15% of frame width) — wider than the 0.1 reference
//     because our turn pulses produce more angular displacement per ms
//     than MentorPi's gimbal; the tighter band created twitch.
//   - Turn speed PROPORTIONAL to centroid offset (P-controller, not
//     bang-bang). Hand barely off-center → MIN_TURN; hand at frame edge
//     → MAX_TURN. Without this any offset > deadband triggers a full
//     28-speed pulse and overshoots a hand near the camera.
//   - Turn pulse 120ms — short enough that a single correction can't
//     swing past a close-range hand. Drive pulse 400ms — covers ground
//     when far without committing past the next perception tick.
//   - bboxArea 0.30 = "close enough, hold position." Above this the
//     palm-detector also starts losing the hand (it needs surrounding
//     context to localize), so trying to drive closer would lose track.
const FOLLOW_DEADBAND = 0.15;
const FOLLOW_TURN_MS  = 120;
const FOLLOW_DRIVE_MS = 400;
const FOLLOW_HOLD_AREA = 0.30;
const FOLLOW_MIN_TURN_SPEED = 15;
const FOLLOW_MAX_TURN_SPEED = 28;
const FOLLOW_DRIVE_SPEED = 32;
// How many consecutive null detections before we announce "lost hand"
// and switch from drive/turn to a passive idle. Single dropouts are
// common when the hand crosses the FOV edge — don't react to noise.
const FOLLOW_LOST_TICKS = 4;
// Cool-down on lost/reacquire announcements. Without this, the natural
// "hand briefly at edge of FOV → lost streak → back in frame" cycle
// triggers an announcement every few seconds. 3s lands between "still
// feels live" and "not whip-sawing chat for noise."
const FOLLOW_ANNOUNCE_COOLDOWN_MS = 3000;
// Gesture command map. Open_Palm and Closed_Fist are the most reliably
// classified across the literature for the pause role. Thumb_Up replaced
// the original Pointing_Up resume choice after the floor-mounted robot
// run showed Pointing_Up is awkward from above (operator looking down
// at robot doesn't naturally point an index finger UP at it). Thumb_Up
// is the natural "go / continue" gesture and benchmarks reliably above
// 90% in the GestureBot data. Thumb_Down explicitly skipped — 70.7% in
// the same benchmark, confuses with similar poses.
const FOLLOW_GESTURE_COMMANDS = {
  Open_Palm:   "pause",
  Closed_Fist: "pause",
  Thumb_Up:    "resume",
};

// Fire-event listeners — assistant.js subscribes so it can inject a
// synthetic observation into Pip's active turn (L2 "harness pushes state
// to planner" pattern from Butter-Bench / ExploreVLM). `kind` is "fire"
// (target entered frame) or "clear" (target left frame); only halt-mode
// watchers emit "clear" — speak/notify have no concept of "stopped seeing."
const _fireListeners = new Set();
export function onWatcherFire(fn) {
  _fireListeners.add(fn);
  return () => _fireListeners.delete(fn);
}
function emitFire(entry, det, kind = "fire") {
  for (const fn of _fireListeners) {
    try { fn(entry, det, kind); } catch (err) { console.warn("[watcher] fire listener:", err); }
  }
}

// Per-entry motor gate. While `blocked`, motor tools in pip-tools.js await
// `promise`; on release (sign left frame, watcher stopped, or operator hit
// Stop), the promise resolves and blocked tool calls proceed. Lifecycle:
//   - blocked: false on first ensureGate()
//   - entry transition → blocked=true, fresh promise
//   - exit/stop/abort → resolve(), blocked=false
// One gate per entry — multiple halt-classes share it. The kept-stale
// reference after exit is harmless: awaitReflexGate short-circuits when
// !blocked.
const _gates = new Map();

function ensureGate(entryId) {
  let g = _gates.get(entryId);
  if (!g) {
    g = { blocked: false, promise: Promise.resolve(), resolve: () => {}, sinceMs: 0, label: null };
    _gates.set(entryId, g);
  }
  return g;
}

// label = what engaged the gate ("stop sign", "person", "Open_Palm", ...).
// Surfaced through the awaitReflexGate result + the motor-tool timeout
// error so the planner / operator see what's actually blocking motion
// instead of a hardcoded literal that lies whenever the gate-trigger
// isn't a stop sign.
function setGateBlocked(entryId, label = null) {
  const g = ensureGate(entryId);
  if (g.blocked) return;
  g.blocked = true;
  g.sinceMs = Date.now();
  g.label = label;
  g.promise = new Promise((resolve) => { g.resolve = resolve; });
}

function releaseGate(entryId) {
  const g = _gates.get(entryId);
  if (!g || !g.blocked) return;
  g.blocked = false;
  try { g.resolve(); } catch {}
}

export function isReflexGated(entryId) {
  return !!_gates.get(entryId)?.blocked;
}

// Drop any active motor block on every entry. Called from assistant.js on
// Stop — guarantees the loop unblocks even if a tool is mid-await on a
// gate Promise that the watcher poll hasn't gotten to resolve yet.
export function releaseAllGates() {
  for (const id of _gates.keys()) releaseGate(id);
}

// Await the gate to clear, with a max wait and an isAborted poll. Returns
// { blocked: false } immediately if not gated, else { blocked: true,
// released: "clear" | "abort" | "timeout" } when one of the three fires.
// Polled rather than promise-chained so abort + timeout share one code
// path with the natural release.
const DEFAULT_GATE_TIMEOUT_MS = 10000;
export async function awaitReflexGate(entryId, { maxMs = DEFAULT_GATE_TIMEOUT_MS, isAborted = () => false } = {}) {
  const g = _gates.get(entryId);
  if (!g || !g.blocked) return { blocked: false };
  const label = g.label;
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (released) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      resolve({ blocked: true, released, label });
    };
    const poll = setInterval(() => {
      if (done) return;
      if (!g.blocked) finish("clear");
      else if (isAborted()) finish("abort");
      else if (Date.now() - started > maxMs) finish("timeout");
    }, 100);
  });
}

const ACTIONS = {
  // halt + follow are implemented as their own loops (runHaltLoop,
  // runFollowLoop) — they need richer per-tick logic than the speak/notify
  // single-shot pattern. The entries here are no-ops so cfg.action
  // validation and the UI dropdown still work.
  halt:   async ()           => {},
  speak:  async (_entry, det) => { ttsSpeak(`saw ${det.label}`); },
  notify: async (entry, det) => {
    console.log(`[watcher] ${entry.name} saw ${det.label} (${(det.score * 100 | 0)}%)`);
  },
  follow: async ()           => {},
};
export const ACTION_NAMES = Object.keys(ACTIONS);

// COCO 80 — the exact closed vocabulary EfficientDet-Lite0 detects. Exposed
// so the tool description can list them for the planner (no more guessing)
// and the Reflex card body can show them for the operator (no more "what
// can I watch for?"). Pinned here as the single source of truth instead of
// duplicating in pip-tools.js + watcher UI.
export const COCO_CLASSES = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
  "truck", "boat", "traffic light", "fire hydrant", "stop sign",
  "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
  "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag",
  "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
  "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
  "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana",
  "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza",
  "donut", "cake", "chair", "couch", "potted plant", "bed", "dining table",
  "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone",
  "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock",
  "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
];

function ensureConfig(entry) {
  if (!entry.watcher) entry.watcher = { classes: ["stop sign"], action: "halt", enabled: false, lastDetection: null };
  return entry.watcher;
}

// One iteration of the detect→fire→cool-down loop. Pulled out so the
// post-fire path can recursively start the next iteration without
// re-running startWatcher's config + UI bookkeeping.
function runDetectIteration(entry, cfg) {
  const { promise, stop } = startDetection(entry, { classes: cfg.classes });
  _running.set(entry.id, { stop });
  promise.then(async (det) => {
    _running.delete(entry.id);
    // null = manually stopped, timed out, or detector permanently failed.
    // Either way, exit the loop and reflect disarmed in the UI.
    if (!det || !cfg.enabled) {
      cfg.enabled = false;
      renderEntry(entry);
      return;
    }
    cfg.lastDetection = { label: det.label, score: det.score, ts: Date.now() };
    renderEntry(entry);
    try { await ACTIONS[cfg.action]?.(entry, det); }
    catch (err) { console.warn(`[watcher] action ${cfg.action} failed:`, err); }
    // Notify subscribers AFTER the action ran so the observation reads
    // "saw X, action Y executed" rather than "saw X, about to act."
    emitFire(entry, det);
    // Cool-down, then re-enter the loop unless the watcher was stopped
    // (manual stop, disconnect, or detector hard-failed) during the wait.
    setTimeout(() => {
      if (!cfg.enabled || entry.status !== "connected") return;
      runDetectIteration(entry, cfg);
    }, REARM_DEBOUNCE_MS);
  });
}

// Halt-action loop. Polls the detector at HALT_POLL_MS; on the rising
// edge (no hit → hit) it pulses motors to zero, speaks, blocks the gate,
// and emits a "fire" observation. On the falling edge (hit → no hit) it
// speaks "resuming", releases the gate, and emits "clear". The pulse on
// enter is one-shot — firmware watchdog (~1s) handles continued braking
// of any already-in-flight pulse; the gate prevents new motion. No
// per-tick re-pulsing — that'd flood BLE for no extra safety.
function runHaltLoop(entry, cfg) {
  let stopped = false;
  let timer = null;
  const stopFn = () => {
    if (stopped) return;
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    releaseGate(entry.id);
  };
  _running.set(entry.id, { stop: stopFn });

  const tick = async () => {
    if (stopped) return;
    if (!cfg.enabled || entry.status !== "connected") {
      stopFn();
      _running.delete(entry.id);
      cfg.enabled = false;
      renderEntry(entry);
      return;
    }
    let dets = null;
    try {
      dets = await detectOnce(entry, { classes: cfg.classes });
    } catch {
      dets = null;
    }
    if (stopped) return;
    // Hard failure (detector permanently down) → exit. Transient null
    // (camera blip, frame not ready) → just keep polling.
    if (dets === null && isMediapipeFailed()) {
      stopFn();
      _running.delete(entry.id);
      cfg.enabled = false;
      renderEntry(entry);
      return;
    }
    const hit = (dets && dets.length > 0) ? dets[0] : null;
    const g = ensureGate(entry.id);
    const wasBlocked = g.blocked;

    if (hit && !wasBlocked) {
      cfg.lastDetection = { label: hit.label, score: hit.score, ts: Date.now() };
      try { await pulseMotors(entry.id, 0, 0, 200); } catch {}
      // stopWatcher / Stop button could fire while pulseMotors awaits —
      // skip the setGateBlocked below in that case, otherwise the gate
      // re-engages with no loop alive to release it and motor tools hang
      // until the 10s timeout.
      if (stopped) return;
      if (!cfg.silent) ttsSpeak(`stopped, ${hit.label}`);
      setGateBlocked(entry.id, hit.label);
      emitFire(entry, { ...cfg.lastDetection }, "fire");
      renderEntry(entry);
    } else if (!hit && wasBlocked) {
      if (!cfg.silent) ttsSpeak("resuming");
      releaseGate(entry.id);
      emitFire(entry, cfg.lastDetection, "clear");
      renderEntry(entry);
    }

    if (!stopped) timer = setTimeout(tick, HALT_POLL_MS);
  };

  tick();
}

// Follow-action loop. Polls the Gesture Recognizer for the operator's
// hand; runs a centroid P-loop that turn-pulses to center the palm in
// frame and drive-pulses to close distance when far. Built-in gestures
// double as commands — Open_Palm/Closed_Fist pause (engage motor gate
// + halt), Pointing_Up resumes. Same gate primitive as runHaltLoop, so
// "pause follow" cleanly composes with Pip if it's running concurrently
// AND a hard-stop verb survives whatever the operator is otherwise doing.
//
// State machine:
//   tracking → (Open_Palm)      → paused
//   tracking → (Closed_Fist)    → paused
//   paused   → (Pointing_Up)    → tracking
//   tracking → (no hand × N)    → idle (no chase-spin — staying put is
//                                  far less unnerving than a robot that
//                                  hunts for you when you've stepped away)
//   idle     → (hand reappears) → tracking
function runFollowLoop(entry, cfg) {
  let stopped = false;
  let timer = null;
  let paused = false;
  let lostCount = 0;
  let lastGesture = null;
  let lastAnnounceTs = 0;
  const stopFn = () => {
    if (stopped) return;
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    releaseGate(entry.id);
  };
  _running.set(entry.id, { stop: stopFn });

  const tick = async () => {
    if (stopped) return;
    if (!cfg.enabled || entry.status !== "connected") {
      stopFn();
      _running.delete(entry.id);
      cfg.enabled = false;
      renderEntry(entry);
      return;
    }
    let det = null;
    try { det = await detectGestureOnce(entry); }
    catch { det = null; }
    if (stopped) return;
    if (det === null && isGesturesFailed()) {
      stopFn();
      _running.delete(entry.id);
      cfg.enabled = false;
      renderEntry(entry);
      return;
    }

    // Gesture commands — fire only on transition (not every tick the
    // gesture stays held) so the audience hears one announcement per
    // user action, not a stream.
    const g = det?.gesture;
    if (g && g !== "None" && g !== lastGesture && FOLLOW_GESTURE_COMMANDS[g]) {
      const cmd = FOLLOW_GESTURE_COMMANDS[g];
      if (cmd === "pause" && !paused) {
        paused = true;
        try { await pulseMotors(entry.id, 0, 0, 200); } catch {}
        if (stopped) return;
        if (!cfg.silent) ttsSpeak(`paused, ${g.toLowerCase().replace(/_/g, " ")}`);
        setGateBlocked(entry.id, `gesture ${g}`);
        emitFire(entry, { gesture: g, ts: Date.now() }, "gesture-pause");
      } else if (cmd === "resume" && paused) {
        paused = false;
        if (!cfg.silent) ttsSpeak("following again");
        releaseGate(entry.id);
        emitFire(entry, { gesture: g, ts: Date.now() }, "gesture-resume");
      }
    }
    if (g) lastGesture = g;

    // Tracking — skipped entirely while paused (the gate is engaged;
    // even an erroneous pulse here would be a no-op via pip-tools, but
    // skipping is cheaper + cleaner).
    if (!paused) {
      if (!det) {
        lostCount++;
        if (lostCount === FOLLOW_LOST_TICKS) {
          const now = Date.now();
          if (now - lastAnnounceTs > FOLLOW_ANNOUNCE_COOLDOWN_MS) {
            if (!cfg.silent) ttsSpeak("lost the hand");
            emitFire(entry, { ts: now }, "follow-lost");
            lastAnnounceTs = now;
            renderEntry(entry);
          }
        }
      } else {
        if (lostCount >= FOLLOW_LOST_TICKS) {
          const now = Date.now();
          if (now - lastAnnounceTs > FOLLOW_ANNOUNCE_COOLDOWN_MS) {
            if (!cfg.silent) ttsSpeak("found you");
            emitFire(entry, { ts: now }, "follow-reacquire");
            lastAnnounceTs = now;
          }
        }
        lostCount = 0;
        cfg.lastDetection = { label: "hand", score: det.score, ts: Date.now() };
        const cx = det.palmCentroid.cx;
        const area = det.bboxArea;
        const offset = cx - 0.5;          // -0.5 (far left) … +0.5 (far right)
        const absOffset = Math.abs(offset);

        if (area >= FOLLOW_HOLD_AREA) {
          // Close enough — hold. No pulse, no narration. Keeps the
          // operator in the "I can move my hand around without dragging
          // the robot in" sweet spot the audience reads as "it knows
          // I'm close." Lower than this and we'd overshoot the hand;
          // higher and the palm detector starts losing context.
        } else if (absOffset < FOLLOW_DEADBAND) {
          try { await pulseMotors(entry.id, FOLLOW_DRIVE_SPEED, FOLLOW_DRIVE_SPEED, FOLLOW_DRIVE_MS); } catch {}
        } else {
          // Proportional turn — small offset → small pulse, edge of
          // frame → max pulse. Linear ramp from MIN_TURN at the deadband
          // boundary to MAX_TURN at the frame edge. Without this, every
          // off-center hand triggered a full-speed pulse and the robot
          // overshot a near-camera hand on a single tick.
          const overshoot = absOffset - FOLLOW_DEADBAND;
          const ramp = Math.min(1, overshoot / (0.5 - FOLLOW_DEADBAND));
          const speed = Math.round(FOLLOW_MIN_TURN_SPEED + ramp * (FOLLOW_MAX_TURN_SPEED - FOLLOW_MIN_TURN_SPEED));
          const lMot = offset < 0 ? -speed :  speed;
          const rMot = offset < 0 ?  speed : -speed;
          try { await pulseMotors(entry.id, lMot, rMot, FOLLOW_TURN_MS); } catch {}
        }
        if (stopped) return;
        renderEntry(entry);
      }
    }

    if (!stopped) timer = setTimeout(tick, FOLLOW_POLL_MS);
  };

  tick();
}

export function startWatcher(entry, opts = {}) {
  const cfg = ensureConfig(entry);
  if (opts.classes) {
    const list = Array.isArray(opts.classes) ? opts.classes : [String(opts.classes)];
    const cleaned = list.map(s => String(s).trim()).filter(Boolean);
    if (cleaned.length) cfg.classes = cleaned;
  }
  if (opts.action && ACTIONS[opts.action]) cfg.action = opts.action;
  // silent: suppresses the watcher's built-in "stopped, X" / "resuming"
  // narration. Demos that provide their own announcements (e.g.
  // stopsign with its debounced + escalating phrasing) set silent:true
  // so the two voices don't race + overlap. Standalone watchers (no
  // demo orchestrating) default to silent:false to keep the audible
  // reflex narration the operator hears.
  if (typeof opts.silent === "boolean") cfg.silent = opts.silent;
  stopWatcher(entry, { silent: true });
  cfg.enabled = true;
  if (cfg.action === "halt") runHaltLoop(entry, cfg);
  else if (cfg.action === "follow") runFollowLoop(entry, cfg);
  else runDetectIteration(entry, cfg);
  renderEntry(entry);
  return cfg;
}

export function stopWatcher(entry, { silent = false } = {}) {
  const active = _running.get(entry.id);
  if (active) {
    active.stop();
    _running.delete(entry.id);
  }
  releaseGate(entry.id);
  if (entry.watcher) entry.watcher.enabled = false;
  if (!silent) renderEntry(entry);
}

export function watcherStatus(entry) {
  const cfg = entry.watcher;
  if (!cfg) return { enabled: false };
  return {
    enabled: !!cfg.enabled,
    classes: cfg.classes,
    action: cfg.action,
    lastDetection: cfg.lastDetection,
  };
}

function fmtClock(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function renderSection(entry) {
  if (entry.status !== "connected") return "";
  // No camera = no reflex source. Hide the section so it doesn't pretend
  // to be functional on a robot it can't watch.
  if (listCameraSources(entry).length === 0) return "";
  if (isMediapipeFailed()) return "";
  const cfg = ensureConfig(entry);
  const enabled = !!cfg.enabled;
  const last = cfg.lastDetection;
  const gated = isReflexGated(entry.id);
  const isFollow = cfg.action === "follow";
  // Surface the gate state explicitly when blocked — operators (and demo
  // audiences) need to see WHY motion isn't happening, not infer it from
  // a stale "last saw" line. Follow mode has its own state vocabulary
  // (tracking / paused / lost) since "watching stop sign" makes no sense.
  let state;
  if (!enabled) {
    state = last ? `saw ${last.label} at ${fmtClock(last.ts)}` : "off";
  } else if (isFollow) {
    state = gated
      ? `PAUSED — gesture engaged · show Pointing_Up to resume`
      : last
        ? `tracking hand · last seen at ${fmtClock(last.ts)}`
        : `tracking hand — show one to the camera`;
  } else {
    state = gated
      ? `BLOCKED — ${last?.label || cfg.classes[0]} visible · motion gated`
      : last
        ? `watching ${cfg.classes.join(", ")} · last saw ${last.label} at ${fmtClock(last.ts)}`
        : `watching: ${cfg.classes.join(", ")}`;
  }
  const action = enabled
    ? `<button class="secondary sm" data-action="watcher-stop">Stop</button>`
    : `<button class="secondary sm" data-action="watcher-start">Start</button>`;
  const actionOpts = ACTION_NAMES.map(a =>
    `<option value="${a}"${cfg.action === a ? " selected" : ""}>${a}</option>`
  ).join("");
  // Datalist for autocomplete on the class input — Apple-HIG combobox
  // shape, lets the operator pick from the exact 80 without consulting
  // external docs. <details>/summary surfaces the full list as a
  // disclosure so the visual default is compact.
  const datalistId = `coco-classes-${entry.id}`;
  const datalistOpts = COCO_CLASSES.map(c => `<option value="${c}">`).join("");
  const cocoListHtml = COCO_CLASSES.map(c => escapeHtml(c)).join(", ");
  // Follow mode swaps the "Watch for" combobox for a gesture cheat-sheet
  // so the audience knows which hand shapes do anything. Listed in
  // priority order — pause verbs first, resume verb after. Resume is
  // Thumb_Up rather than Pointing_Up because the operator is typically
  // looking DOWN at a floor-mounted robot, and an upward-pointing index
  // finger is awkward from that angle; thumbs-up reads naturally as
  // "good, continue."
  const followCheatSheet = `
    <div class="watcher-gestures">
      <div class="watcher-gesture-row"><strong>Open palm</strong> · pause + halt</div>
      <div class="watcher-gesture-row"><strong>Closed fist</strong> · pause + halt</div>
      <div class="watcher-gesture-row"><strong>Thumbs up</strong> · resume tracking</div>
      <div class="meta">Show a hand near the camera; gestures fire on transition (one announcement per pose change).</div>
    </div>
  `;
  const reflexBody = `
    <div class="row">
      <div class="label">Watch for</div>
      <input type="text" class="watcher-classes" data-action="watcher-classes"
             value="${escapeHtml(cfg.classes.join(", "))}"
             placeholder="stop sign, person"
             list="${datalistId}"
             ${enabled ? "disabled" : ""}>
      <datalist id="${datalistId}">${datalistOpts}</datalist>
    </div>
    <details class="watcher-coco">
      <summary>All ${COCO_CLASSES.length} COCO classes</summary>
      <div class="watcher-coco-list">${cocoListHtml}</div>
    </details>
    <div class="meta">Closed-vocab — only the classes above will trigger.</div>
  `;
  const body = `
    <div class="watcher-body">
      <div class="row">
        <div class="label">On detection</div>
        <select data-action="watcher-action" ${enabled ? "disabled" : ""}>${actionOpts}</select>
      </div>
      ${isFollow ? followCheatSheet : reflexBody}
    </div>
  `;
  return capSection({ name: "watcher", label: "Reflex", state, action, body });
}

function wireActions(entry, node) {
  const cfg = ensureConfig(entry);
  const classesInput = node.querySelector(`input[data-action="watcher-classes"]`);
  if (classesInput) {
    classesInput.addEventListener("change", () => {
      const list = classesInput.value.split(",").map(s => s.trim()).filter(Boolean);
      if (list.length) cfg.classes = list;
    });
  }
  const actionSel = node.querySelector(`select[data-action="watcher-action"]`);
  if (actionSel) {
    actionSel.addEventListener("change", () => {
      if (ACTIONS[actionSel.value]) cfg.action = actionSel.value;
    });
  }
  node.querySelector(`[data-action="watcher-start"]`)?.addEventListener("click", () => startWatcher(entry));
  node.querySelector(`[data-action="watcher-stop"]`)?.addEventListener("click", () => stopWatcher(entry));
}

export const watcherCap = {
  name: "watcher",
  renderSection,
  wireActions,
};
