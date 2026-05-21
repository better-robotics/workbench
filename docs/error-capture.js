// Loaded synchronously at the top of <head> before any modules so it
// catches bootstrap errors. Maintains a small ring buffer of console
// errors / warns + uncaught exceptions + unhandled promise rejections.
// The report-issue link reads window.__getCapturedErrors() at click time
// and attaches them to the GitHub issue body. The user sees a review
// notice and can edit before submitting.
(function () {
  var MAX = 30;
  var STACK_FRAMES = 6;
  var buf = [];
  function fmt(arg) {
    if (arg && arg.stack) return arg.stack.split("\n").slice(0, STACK_FRAMES).join("\n");
    if (typeof arg === "string") return arg;
    try { return JSON.stringify(arg); } catch (e) { return String(arg); }
  }
  function push(level, message, source) {
    buf.push({
      t: new Date().toISOString(),
      level: level,
      message: String(message).slice(0, 2000),
      source: source || "",
    });
    if (buf.length > MAX) buf.shift();
  }
  window.addEventListener("error", function (e) {
    var stack = e.error && e.error.stack
      ? "\n" + e.error.stack.split("\n").slice(0, STACK_FRAMES).join("\n")
      : "";
    var src = e.filename ? e.filename + ":" + (e.lineno || "?") + ":" + (e.colno || "?") : "";
    push("error", (e.message || "Uncaught error") + stack, src);
  });
  window.addEventListener("unhandledrejection", function (e) {
    push("error", "Unhandled rejection: " + fmt(e.reason), "");
  });
  ["error", "warn"].forEach(function (lvl) {
    var orig = console[lvl];
    console[lvl] = function () {
      try {
        var msg = Array.prototype.map.call(arguments, fmt).join(" ");
        push(lvl, msg, "");
      } catch (e) {}
      orig.apply(console, arguments);
    };
  });
  window.__getCapturedErrors = function () { return buf.slice(); };
})();
