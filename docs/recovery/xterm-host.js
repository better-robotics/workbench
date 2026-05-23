// Shared xterm.js loader + Terminal mounter. Three consumers (recovery,
// esp-serial, shell) all want the same theme + font + raf-deferred fit
// + ResizeObserver, so the shape lives here once.
let _module = null;

export async function ensureXtermLoaded() {
  if (_module) return _module;
  if (!document.querySelector('link[data-xterm-css]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.css";
    link.dataset.xtermCss = "1";
    document.head.appendChild(link);
  }
  const [core, fit] = await Promise.all([
    import("https://cdn.jsdelivr.net/npm/@xterm/xterm@5/+esm"),
    import("https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10/+esm"),
  ]);
  _module = { Terminal: core.Terminal, FitAddon: fit.FitAddon };
  return _module;
}

const BASE_OPTS = {
  fontSize: 13,
  fontFamily: '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace',
  theme: { background: "#1e1e1e", foreground: "#e4e4e4", cursor: "#e4e4e4" },
};

// Mount a Terminal into `container` with the project's standard theme.
// Adds FitAddon + a ResizeObserver unless `fit: false` (short-lived
// progress terminals like the flash log don't need responsive resize).
// Defers the initial fit() one rAF: pre-fit measures a mid-animation
// container and picks too few rows; xterm later pads by inserting rows
// at the TOP of the buffer, shoving prior content (boot banner, login
// prompt) to the bottom of the viewport.
// Returns { term, fit, resizeObs } — caller owns dispose order.
export async function mountTerminal(container, opts = {}) {
  const { Terminal, FitAddon } = await ensureXtermLoaded();
  container.innerHTML = "";
  const term = new Terminal({
    ...BASE_OPTS,
    cursorBlink: opts.cursorBlink ?? true,
    convertEol: opts.convertEol ?? false,
  });
  let fit = null;
  let resizeObs = null;
  if (opts.fit !== false) {
    fit = new FitAddon();
    term.loadAddon(fit);
  }
  term.open(container);
  if (fit) {
    await new Promise(r => requestAnimationFrame(r));
    try { fit.fit(); } catch {}
    resizeObs = new ResizeObserver(() => {
      const r = container.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return;  // ignore closing-dialog zero boxes
      try { fit?.fit(); } catch {}
    });
    resizeObs.observe(container);
  }
  return { term, fit, resizeObs };
}
