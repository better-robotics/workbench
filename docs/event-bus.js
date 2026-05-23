// Typed pub/sub for cross-cutting events. Replaces three ad-hoc fan-out
// shapes that were each implemented differently:
//   - assistant.js's inline calls to sendPipFaceEvent + setAgentState
//     inside appendStepPill / finishStepPill (one function, three side
//     effects, no registry).
//   - watcher.js's hand-rolled _fireListeners Set with its own onFire/
//     notifyFire pair.
//   - phones.js's per-phone fan-out from inside the event source (every
//     emit site had to know "which phones care").
//
// Topics today:
//   tool.call     { tool, input }
//   tool.result   { tool, input, ok, result, error, durationMs }
//   watcher.fire  { entry, detection, kind }   // kind: "fire"|"clear"|
//                                              //       "gesture-detected"|
//                                              //       "follow-lost"|
//                                              //       "follow-reacquire"
//
// Adding a third "tool-call-like-but-slightly-different" topic is a
// smell to investigate before doing it; renaming a topic is a search/
// replace; deleting a subscriber is a single `return () => off()` from
// `on()`'s call site.

const _subs = new Map();

export function on(topic, fn) {
  let set = _subs.get(topic);
  if (!set) { set = new Set(); _subs.set(topic, set); }
  set.add(fn);
  return () => { set.delete(fn); };
}

export function emit(topic, payload) {
  const set = _subs.get(topic);
  if (!set || set.size === 0) return;
  for (const fn of set) {
    try { fn(payload); }
    catch (err) { console.error(`[bus] ${topic} subscriber threw:`, err); }
  }
}
