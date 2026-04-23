// Experimental options must gate on both the flag AND the underlying browser API.
const SETTINGS_KEY = "better-robotics:settings";

export const settings = Object.assign(
  // pipBackend: "bridge" (AI Bridge extension, default) | "anthropic" (direct
  //   API call from browser) | "openai" (direct OpenAI chat completions) |
  //   "local" (Phase 3, LFM2.5-1.2B-Thinking-ONNX in-browser).
  // pipApiKey:    Anthropic key — only used when pipBackend === "anthropic".
  // pipOpenaiKey: OpenAI key   — only used when pipBackend === "openai".
  // Both stored in localStorage — browser-only, never leaves origin, but treat
  // like passwords (don't share your browser).
  { passiveScan: false, voice: false, pipBackend: "bridge", pipApiKey: "", pipOpenaiKey: "" },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"),
);

export function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
