export const $ = (id) => document.getElementById(id);

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Native <dialog> closes on Escape but not on backdrop click. A click whose
// target is the dialog element itself (not a child) means the backdrop.
export function wireDialogOutsideClick(dialog) {
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}
