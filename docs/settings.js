// Experimental options must gate on both the flag AND the underlying browser API.
const SETTINGS_KEY = "better-robotics:settings";

export const settings = Object.assign(
  // pipBackend: "github" (GitHub Models, default — OAuth via auth.neevs.io)
  //   | "bridge" (AI Bridge localhost proxy at 127.0.0.1:7337, Keychain-backed)
  //   | "anthropic" (direct, user's key) | "openai" (direct, user's key).
  // pipApiKey:    Anthropic key — only when pipBackend === "anthropic".
  // pipOpenaiKey: OpenAI key    — only when pipBackend === "openai".
  // pipClaudeModel: which Claude variant to use on the bridge/anthropic
  //   backends — "claude-opus-4-7" | "claude-sonnet-4-6" | "claude-haiku-4-5-20251001".
  // githubAuth:   { username, token } from GitHub OAuth. Backs BOTH
  //   identity (avatar / robot labels) AND the GitHub Models Pip backend.
  //   One grant, two purposes; sign-out clears both. 401 → re-connect prompt.
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
  // arucoOverheadPhoneId / arucoOverheadLocalId: roomId of the phone, or
  //   deviceId of the local videoinput, designated as the overhead
  //   localizer. Mutually exclusive — only one is non-null at a time.
  // arucoMarkerSizeMm: printed marker side length, used by POS.Posit for
  //   metric pose. Defaults to the printable sheets' size (100 mm).
  // pipDetector: active closed-vocab object detection backend, read by
  //   detectors.js on import. "mediapipe" (default, ~4MB EfficientDet-
  //   Lite0 via @mediapipe/tasks-vision) or "yolo26" (~10MB ONNX via
  //   onnxruntime-web + WebGPU). Switch via /detector <name>; persists
  //   here so the next session picks up the same backend.
  // pipLocalModel / pipLocalDtype: in-browser model via transformers.js +
  //   WebGPU for the `local` backend. Default targets Gemma 4 E2B-it
  //   (~1.5GB decoder at q4f16, browser-cached after first load). q4f16
  //   over q4: smaller and faster on WebGPU since activations stay fp16
  //   (no int4→fp16 reroll per layer). Sampling defaults baked into
  //   claude.js's _localAsk match Google's documented Gemma-4 standards
  //   (temperature 1.0, top_k 64, top_p 0.95, no repetition_penalty).
  { pipBackend: "github", pipApiKey: "", pipOpenaiKey: "", pipClaudeModel: "claude-sonnet-4-6", githubAuth: null, pipVisionEnabled: true, pipDetector: "mediapipe", pipLocalModel: "onnx-community/gemma-4-E2B-it-ONNX", pipLocalDtype: "q4f16", arucoOverheadPhoneId: null, arucoOverheadLocalId: null, arucoMarkerSizeMm: 100 },
  (() => {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    // Migration: pipGithubAuth → githubAuth (Identity + Pip share one OAuth
    // grant now). Drop old key so migration fires once.
    if (raw.pipGithubAuth && !raw.githubAuth) {
      raw.githubAuth = raw.pipGithubAuth;
      delete raw.pipGithubAuth;
    }
    return raw;
  })(),
);

export function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
