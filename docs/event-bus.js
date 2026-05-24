// Typed pub/sub for cross-cutting events. A new "X-like but slightly
// different" topic is a smell — investigate before adding one.

export const TOPICS = Object.freeze({
  TOOL_CALL:      "tool.call",       // { tool, input }
  TOOL_RESULT:    "tool.result",     // { tool, ok, error }
  WATCHER_FIRE:   "watcher.fire",    // { entry, detection, kind }
  PHONE_ATTACHED: "phone.attached",  // { phoneId, robotId, robotLabel }
  PHONE_DETACHED: "phone.detached",  // { phoneId }
});

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
