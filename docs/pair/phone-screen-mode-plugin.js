// Sole reader of settings.phoneAttachedMode; both attach sites emit
// phone.attached and forget. Off via not calling init.

import { on, TOPICS } from "../event-bus.js";
import { setPhoneScreenMode, SCREEN_MODES } from "./phones.js";
import { settings } from "../settings.js";

export function resolveAttachedMode() {
  return settings.phoneAttachedMode === SCREEN_MODES.OPERATOR_CAM
    ? SCREEN_MODES.OPERATOR_CAM
    : SCREEN_MODES.PIP_FACE;
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
// faking a fresh attach use this. Settings flips and reconnect paths
// hit this; the bus topic stays attach/detach-only.
export function reapplyPhoneScreenMode(phoneId, robotLabel = null) {
  setPhoneScreenMode(phoneId, resolveAttachedMode(), robotLabel);
}
