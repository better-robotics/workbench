// Bus-driven phone screen mode arbitration. Both attach sites emit
// phone.attached and forget. With pip-face extracted to its own repo,
// the only attached mode left is OPERATOR_CAM — `resolveAttachedMode`
// is a placeholder for re-introducing per-phone mode preferences if
// another attached mode shows up.

import { on, TOPICS } from "../event-bus.js";
import { setPhoneScreenMode, SCREEN_MODES } from "./phones.js";

export function resolveAttachedMode() {
  return SCREEN_MODES.OPERATOR_CAM;
}

export function initPhoneScreenModePlugin() {
  on(TOPICS.PHONE_ATTACHED, ({ phoneId, robotLabel }) => {
    setPhoneScreenMode(phoneId, resolveAttachedMode(), robotLabel);
  });
  on(TOPICS.PHONE_DETACHED, ({ phoneId }) => {
    setPhoneScreenMode(phoneId, SCREEN_MODES.DEFAULT);
  });
}

// Public re-apply: callers that want to refresh a phone's mode without
// faking a fresh attach use this. Reconnect paths hit this.
export function reapplyPhoneScreenMode(phoneId, robotLabel = null) {
  setPhoneScreenMode(phoneId, resolveAttachedMode(), robotLabel);
}
