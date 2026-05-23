// Generic "poll detectOnce until something matches or stop()" loop.
// Both mediapipe.js and yolo26.js had identical 28-line implementations
// of this — the shape rhymes per detector backend but doesn't change.
// Each backend exports its own startDetection that delegates here.
//
// Hard-failure (isFailed() returns true mid-loop) ends the poll with
// null — persistent watchers riding out transient nulls (camera blip,
// stream re-attach) keep going, but a dead detector aborts.

export function pollUntilHit({ detectOnce, isFailed }, entry, opts = {}) {
  const { classes, source = null, threshold, intervalMs, timeoutMs = 0 } = opts;
  let stopped = false;
  let timer = null;
  let timeoutTimer = null;
  let resolveResult;
  const promise = new Promise((r) => { resolveResult = r; });
  const finish = (val) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    resolveResult(val);
  };
  const loop = async () => {
    if (stopped) return;
    const dets = await detectOnce(entry, { classes, source, threshold });
    if (stopped) return;
    if (dets === null) {
      if (isFailed()) { finish(null); return; }
      timer = setTimeout(loop, intervalMs);
      return;
    }
    if (dets.length > 0) { finish(dets[0]); return; }
    timer = setTimeout(loop, intervalMs);
  };
  if (timeoutMs > 0) timeoutTimer = setTimeout(() => finish(null), timeoutMs);
  loop();
  return { promise, stop: () => finish(null) };
}
