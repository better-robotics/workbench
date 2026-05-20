import { $ } from "./dom.js";
import { state } from "./state.js";
import { getLog } from "./capabilities/runtime/command.js";
import { onOpsResponse } from "./ops-response.js";

let logTimeoutId = null;
let logTailRobotId = null;   // robot whose log dialog is currently open
let logTailChannel = null;   // open WebRTC logs channel, if tailing

function stopLogTail() {
  if (logTailChannel) {
    try { logTailChannel.send(JSON.stringify({ type: "stop" })); } catch {}
    try { logTailChannel.close(); } catch {}
    logTailChannel = null;
  }
  if (logTailRobotId) {
    // Lazy-import to keep webrtc-robot.js out of the eager bundle.
    import("./webrtc-robot.js").then((m) => m.closePeer(logTailRobotId)).catch(() => {});
  }
  $("log-dialog-status").hidden = true;
  $("log-dialog-tail").textContent = "Tail live";
}

// Robot menu fires the open; deps inject the menu's current target +
// dismiss so the log dialog doesn't have to know about menu state.
export function wireLogDialog({ getMenuTargetId, closeMenu }) {
  $("menu-log").addEventListener("click", () => {
    const id = getMenuTargetId();
    closeMenu();
    const entry = state.devices.get(id);
    if (!entry?.opsChar) return;
    logTailRobotId = id;
    $("log-dialog-title").textContent = `Log · ${entry?.name || "robot"}`;
    $("log-dialog-body").textContent = "Loading…";
    // Tail-live is Pi-only (journalctl) and needs a name to find the WebRTC
    // peer's room. Hide the button on robots that don't qualify.
    $("log-dialog-tail").hidden = !(entry?.fwType === "pi" && entry?.name);
    $("log-dialog-tail").textContent = "Tail live";
    $("log-dialog-status").hidden = true;
    $("log-dialog").showModal();
    if (logTimeoutId) clearTimeout(logTimeoutId);
    // Reply arrives as a single get-log notify; if none lands within 10 s the
    // robot likely silently dropped the request (no ops-response handler,
    // stalled service, link congestion). Surface it instead of hanging.
    logTimeoutId = setTimeout(() => {
      logTimeoutId = null;
      if ($("log-dialog").open && $("log-dialog-body").textContent === "Loading…") {
        $("log-dialog-body").textContent = "(timed out — no response from robot)";
      }
    }, 10000);
    getLog(id);
  });
  $("log-dialog-tail").addEventListener("click", async () => {
    if (logTailChannel) { stopLogTail(); return; }
    const id = logTailRobotId;
    if (!id) return;
    const entry = state.devices.get(id);
    if (!entry) return;
    $("log-dialog-status").hidden = false;
    $("log-dialog-tail").textContent = "Stop";
    const body = $("log-dialog-body");
    body.textContent = "Connecting to live log…\n";
    try {
      const { openChannel } = await import("./webrtc-robot.js");
      logTailChannel = await openChannel(id, entry.name, "logs", {
        onStatus: (s) => { body.textContent = `${s}\n`; },
        robotType: entry.fwType,
        signalChar: entry.signalChar,
      });
    } catch (err) {
      body.textContent = `Couldn't reach pi-robot-rtc: ${err.message || err}\n`;
      stopLogTail();
      return;
    }
    body.textContent = "";  // clear connection-status so the journal owns it
    logTailChannel.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      // Pi may send {"type":"error",...} alongside log lines; treat as line
      // either way (errors are useful in the body).
      body.textContent += e.data;
      // Auto-scroll to bottom — `<pre>` doesn't follow new content by default.
      body.scrollTop = body.scrollHeight;
    });
    logTailChannel.addEventListener("close", () => stopLogTail());
    logTailChannel.send(JSON.stringify({ type: "follow", unit: "pi-robot.service" }));
  });
  $("log-dialog-close").addEventListener("click", () => {
    if (logTimeoutId) { clearTimeout(logTimeoutId); logTimeoutId = null; }
    stopLogTail();
    $("log-dialog").close();
  });
  onOpsResponse("get-log", (entry, msg) => {
    if (!$("log-dialog").open) return;
    if (logTimeoutId) { clearTimeout(logTimeoutId); logTimeoutId = null; }
    $("log-dialog-body").textContent = msg.text || "(empty)";
  });
}
