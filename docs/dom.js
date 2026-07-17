export const $ = (id) => document.getElementById(id);

// Unique-query cache bust. `cache: "no-cache"` on fetch triggers a
// revalidation, not a forced refetch — GH Pages CDN's "still fresh" reply
// keeps the cached bytes. A novel query string is the only reliable bypass.
// Rule: any fetch targeting `firmware/*` (OTA bundles, binaries, prep assets)
// must go through this.
export const freshUrl = (path) =>
  `${path}${path.includes("?") ? "&" : "?"}v=${Date.now()}`;

// Timeout-wrapped fetch so a stalled CDN/network doesn't leave a prepare or
// OTA flow hanging indefinitely. Default 20s covers small manifest/template
// fetches; callers override for larger bundles.
export async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// popover="manual" menus get no native outside-click/Escape dismiss — wire
// both at document level, plus (when btnId is given) the anchored open/
// toggle on the trigger button. `triggerSelector` names the element whose
// clicks must NOT count as outside (it handles its own toggle); `onClose`
// overrides the default hidePopover (robot-menu needs its closeMenu()).
export function wirePopover(btnId, menuId, { anchor = "left", triggerSelector, onClose } = {}) {
  const menu = $(menuId);
  const btn = btnId ? $(btnId) : null;
  if (!menu || (btnId && !btn)) return;
  const close = onClose || (() => menu.hidePopover());
  if (btn) {
    btn.addEventListener("click", (e) => {
      if (menu.matches(":popover-open")) { close(); return; }
      const rect = e.currentTarget.getBoundingClientRect();
      menu.style.top = `${rect.bottom + 6}px`;
      if (anchor === "right") {
        menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
        menu.style.left = "auto";
      } else {
        menu.style.left = `${Math.max(8, rect.left)}px`;
        menu.style.right = "auto";
      }
      if (menu.showPopover) menu.showPopover();
    });
  }
  const trigger = triggerSelector || `#${btnId}`;
  document.addEventListener("click", (e) => {
    if (!menu.matches(":popover-open")) return;
    if (e.target.closest(`#${menuId}`)) return;
    if (e.target.closest(trigger)) return;
    close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.matches(":popover-open")) close();
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
