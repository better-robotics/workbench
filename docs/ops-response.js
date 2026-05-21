// Ops-response dispatch registry — shared by every module that awaits a reply
// to a signed-pair ops verb (get-log, get-config, etc). Lives in its own leaf
// module so callers (app.js's connect flow, pip-tools.js's one-shot waiters)
// don't need to import each other and end up in a circular dep. Multiple
// handlers per op so persistent subscribers (pinout) and transient ones
// (pip-tools) coexist; onOpsResponse returns an unregister fn.
const _handlers = {};  // op → Array<fn>

export function onOpsResponse(op, fn) {
  (_handlers[op] ||= []).push(fn);
  return () => {
    const arr = _handlers[op] || [];
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  };
}

export function dispatchOpsResponse(entry, msg) {
  for (const fn of _handlers[msg.op] || []) {
    try { fn(entry, msg); } catch {}
  }
}

// One-shot waiter — register, resolve on first response targeting this robot,
// unregister. Times out so a dropped response doesn't stall the caller. Used
// by Pip's tool executor and the Scripts panel; same shape, same timeout
// semantics.
export function waitOpsResponse(op, robotId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unregister(); reject(new Error(`${op} timed out`)); }, timeoutMs);
    const unregister = onOpsResponse(op, (entry, msg) => {
      if (entry.id !== robotId) return;
      clearTimeout(timer);
      unregister();
      resolve(msg);
    });
  });
}
