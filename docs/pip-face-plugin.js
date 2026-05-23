// Desktop-side "Pip face" plugin. Subscribes to bus events and forwards
// them to every paired phone currently in pip-face screen mode. The
// phone-side renderer is mobile-pip-face.js; this module is its
// desktop fan-out.
//
// Off-switch: don't call initPipFacePlugin() in app.js. One-line cut,
// the rest of the feature unsubscribes itself.
//
// Mode selection (settings.phoneAttachedMode → "pip-face" | "operator-
// cam") is still in phones.js + phone-helpers.js attachPhoneCameraTo;
// consolidating that here is the next refactor.

import { on } from "./event-bus.js";
import { sendPipFaceEvent } from "./phones.js";

export function initPipFacePlugin() {
  on("tool.call", ({ tool, input }) => {
    sendPipFaceEvent("tool_call", { tool, input });
  });
  on("tool.result", ({ tool, ok, error }) => {
    sendPipFaceEvent("tool_result", { tool, ok, error });
  });
  on("watcher.fire", ({ detection, kind }) => {
    // The bus carries a single watcher.fire topic with `kind` as the
    // discriminator; the face cares about the fire/clear distinction
    // (alert vs happy), so translate here. Other kinds collapse onto
    // fire as a conservative default — informational events still
    // count as "something happened."
    const isClear = kind === "clear" || kind === "follow-reacquire";
    sendPipFaceEvent(isClear ? "watcher_clear" : "watcher_fire", {
      label: detection?.label || detection?.gesture || null,
    });
  });
}
