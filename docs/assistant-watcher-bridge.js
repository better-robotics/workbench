import { escapeHtml } from "./dom.js";
import { on as busOn } from "./event-bus.js";

// L2 reflex-fire bridge. On every watcher fire-event:
//   - queue a synthetic observation for askWithTools to drain on the
//     next iteration (so Pip sees it without having to poll state)
//   - render a small inline notice in the active turn so the operator
//     sees what got injected
// `kind` is one of:
//   "fire"             — halt-mode target entered frame (motion gate engaged)
//   "clear"            — halt-mode target left frame (motion gate released)
//   "gesture-detected" — follow-mode classifier returned a high-confidence
//                        gesture; informational, no gate change
//   "follow-lost"      — follow-mode lost the hand for N consecutive ticks
//   "follow-reacquire" — follow-mode regained the hand after a lost streak
export function wireWatcherFireBridge({ turn, scrollToBottom }) {
  busOn("watcher.fire", ({ entry, detection: det, kind = "fire" }) => {
    const ts = new Date(det?.ts || Date.now()).toISOString();
    const score = typeof det?.score === "number" ? det.score.toFixed(2) : "?";
    const action = entry?.watcher?.action || "?";
    // Terse fact-only observation — no "surface this / pause your plan"
    // prescriptions (the firmware-bounded reflex already gated motion;
    // planner narrates the fact, doesn't second-guess the safety floor).
    let obsText, noticeHtml, isReleaseShape;
    switch (kind) {
      case "clear":
        obsText = `[reflex-clear] "${det?.label}" no longer visible on ${entry.name} at ${ts}; motion gate released, your queued motor calls will proceed.`;
        noticeHtml = `Reflex clear: <strong>${escapeHtml(String(det?.label || ""))}</strong> left frame — motion resumed.`;
        isReleaseShape = true;
        break;
      case "gesture-detected":
        obsText = `[reflex-fire] operator gestured "${det?.gesture}" to ${entry.name} (score ${score}) at ${ts}; informational — follow tracking continues.`;
        noticeHtml = `Gesture: <strong>${escapeHtml(String(det?.gesture || ""))}</strong> (${score})`;
        isReleaseShape = false;
        break;
      case "follow-lost":
        obsText = `[reflex-fire] follow lost the operator's hand on ${entry.name} at ${ts}; robot is idle (not chasing) until the hand reappears.`;
        noticeHtml = `Follow: lost the hand — holding position until it reappears.`;
        isReleaseShape = false;
        break;
      case "follow-reacquire":
        obsText = `[reflex-clear] follow reacquired the operator's hand on ${entry.name} at ${ts}.`;
        noticeHtml = `Follow: hand reacquired — tracking resumed.`;
        isReleaseShape = true;
        break;
      default:  // "fire"
        obsText = `[reflex-fire] saw "${det?.label}" (${score}) on ${entry.name} at ${ts}; action ${action} ran${action === "halt" ? " and motion is now gated until the target leaves frame" : ""}.`;
        noticeHtml = `Reflex: saw <strong>${escapeHtml(String(det?.label || ""))}</strong> (${score}) — action <code>${escapeHtml(action)}</code> executed.`;
        isReleaseShape = false;
    }
    turn.pushObservation(obsText);
    // (The Pip-face react-to-fire path lives in pip-face-plugin.js,
    // subscribing to the same bus topic. This bridge handles only the
    // planner-observation + chat-notice concern.)
    if (!turn.isActive()) return;  // not mid-turn — planner sees it on the next user turn via convo replay
    const el = document.createElement("div");
    el.className = `pip-reflex-notice${isReleaseShape ? " pip-reflex-notice--clear" : ""}`;
    el.innerHTML =
      `<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">` +
        `<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
        `<circle cx="6" cy="6" r="1.8" fill="currentColor"/>` +
      `</svg> ` + noticeHtml;
    turn.el.appendChild(el);
    scrollToBottom();
  });
}
