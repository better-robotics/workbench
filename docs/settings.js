// Experimental options must gate on both the flag AND the underlying browser API.
const SETTINGS_KEY = "better-robotics:settings";

export const settings = Object.assign(
  // pipBackend: "bridge" (AI Bridge localhost proxy at 127.0.0.1:7337,
  //   Keychain-backed — default) | "anthropic" (direct, user's key)
  //   | "openai" (direct, user's key).
  // pipApiKey:    Anthropic key — only when pipBackend === "anthropic".
  // pipOpenaiKey: OpenAI key    — only when pipBackend === "openai".
  // pipClaudeModel: which Claude variant to use on the bridge/anthropic
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
  { pipBackend: "bridge", pipApiKey: "", pipOpenaiKey: "", pipClaudeModel: "claude-sonnet-5", pipVisionEnabled: true, pipDetector: "mediapipe" },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"),
);

export function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
