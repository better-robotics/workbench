// Desktop fan-out for the phone-side Pip face. Subscribes to bus
// events and forwards to every phone in pip-face screen mode.

import { on, TOPICS } from "../event-bus.js";
import { sendPipFaceEvent } from "../phones.js";

export function initPipFacePlugin() {
  on(TOPICS.TOOL_CALL,    ({ tool, input }) => sendPipFaceEvent("tool_call", { tool, input }));
  on(TOPICS.TOOL_RESULT,  ({ tool, ok, error }) => sendPipFaceEvent("tool_result", { tool, ok, error }));
  on(TOPICS.WATCHER_FIRE, ({ detection, kind }) => {
    // watcher.fire carries fire/clear/gesture/follow-* as `kind`; the
    // face only distinguishes the alert-vs-released axis.
    const isClear = kind === "clear" || kind === "follow-reacquire";
    sendPipFaceEvent(isClear ? "watcher_clear" : "watcher_fire", {
      label: detection?.label || detection?.gesture || null,
    });
  });
}
