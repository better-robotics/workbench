import { $ } from "../dom.js";
import { state } from "../state.js";
import { getLog } from "../capabilities/runtime/command.js";
import { onOpsResponse } from "../ops-response.js";

let logTimeoutId = null;

// DOM refs captured once in wireLogDialog (DOMContentLoaded is past by then).
let dialog, title, body;

// Robot menu fires the open; deps inject the menu's current target +
// dismiss so the log dialog doesn't have to know about menu state.
export function wireLogDialog({ getMenuTargetId, closeMenu }) {
  dialog = $("log-dialog");
  title = $("log-dialog-title");
  body = $("log-dialog-body");

  $("menu-log").addEventListener("click", () => {
    const id = getMenuTargetId();
    closeMenu();
    const entry = state.devices.get(id);
    if (!entry?.opsChar) return;
    title.textContent = `Log · ${entry?.name || "robot"}`;
    body.textContent = "Loading…";
    dialog.showModal();
    if (logTimeoutId) clearTimeout(logTimeoutId);
    // Reply arrives as a single get-log notify; if none lands within 10 s the
    // robot likely silently dropped the request (no ops-response handler,
    // stalled service, link congestion). Surface it instead of hanging.
    logTimeoutId = setTimeout(() => {
      logTimeoutId = null;
      if (dialog.open && body.textContent === "Loading…") {
        body.textContent = "(timed out — no response from robot)";
      }
    }, 10000);
    getLog(id);
  });
  $("log-dialog-close").addEventListener("click", () => {
    if (logTimeoutId) { clearTimeout(logTimeoutId); logTimeoutId = null; }
    dialog.close();
  });
  onOpsResponse("get-log", (entry, msg) => {
    if (!dialog.open) return;
    if (logTimeoutId) { clearTimeout(logTimeoutId); logTimeoutId = null; }
    body.textContent = msg.text || "(empty)";
  });
}
