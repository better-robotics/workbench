// Experimental options must gate on both the flag AND the underlying browser API.
const SETTINGS_KEY = "better-robotics:settings";

// Stored settings are a wire format: values written by an older build have to
// keep meaning something. Read on load, before the defaults merge, so a rename
// never silently drops a user back to a default.
//   2026-07-17 "bridge" -> "subscription": the old name said which transport
//   carried the request, not what the choice is to the person picking it — and
//   this codebase already had three other bridges (H-bridge, USB-UART,
//   ShellBridge). NOT "local", which is spoken for by the planned on-robot
//   Gemma rung; this backend is subscription-backed auth, not local compute —
//   the request still goes to api.anthropic.com. Without this migration an
//   existing browser loads an unknown backend and falls through to "no
//   credentials", i.e. gets asked for an API key it never needed.
function migrateSettings(stored) {
  if (stored.pipBackend === "bridge") stored.pipBackend = "subscription";
  return stored;
}

export const settings = Object.assign(
  // pipBackend: "subscription" (AI Bridge localhost proxy at 127.0.0.1:7337,
  //   Keychain-backed — default) | "anthropic" (direct, user's key)
  //   | "openai" (direct, user's key).
  // pipApiKey:    Anthropic key — only when pipBackend === "anthropic".
  // pipOpenaiKey: OpenAI key    — only when pipBackend === "openai".
  // pipClaudeModel: which Claude variant to use on the subscription/anthropic
  //   backends — "claude-opus-4-7" | "claude-sonnet-5" | "claude-haiku-4-5-20251001".
  // pipVisionEnabled: when true AND backend supports images, Pip gets
  //   view_robot_frame, sending the actual frame. ON by default — the
  //   "off by default, model still narrates 'let me check'" failure mode
  //   was worse than the cost trade-off. Documented anti-pattern: the
  //   training corpus has a strong "I'll check the camera" prior, so
  //   filtering the tool out of getTools() doesn't suppress the verbal
  //   commitment, it just makes Pip lie. Better to keep the tool live.
  //   Off via /vision off if cost/privacy becomes a real concern.
  // Keys + tokens in localStorage — browser-only, never leaves origin,
  // but treat like passwords (don't share your browser).
  // pipDetector: active closed-vocab object detection backend, read by
  //   detectors.js on import. "mediapipe" (default, ~4MB EfficientDet-
  //   Lite0 via @mediapipe/tasks-vision) or "yolo26" (~10MB ONNX via
  //   onnxruntime-web + WebGPU). Switch via /detector <name>; persists
  //   here so the next session picks up the same backend.
  { pipBackend: "subscription", pipApiKey: "", pipOpenaiKey: "", pipClaudeModel: "claude-sonnet-5", pipVisionEnabled: true, pipDetector: "mediapipe" },
  migrateSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")),
);

export function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
