import { $ } from "./dom.js";

export function initAssistant() {
  // Clicking the mascot toggles its speech-bubble panel. While the panel is open
  // the bot is "saying" something (today a static greeting; later streamed LLM
  // output), so mirror that onto `.speaking` for the amber-icon CSS rule.
  const bubble = $("assistant-bubble");
  const panel = $("assistant-panel");
  const setSpeaking = (on) => bubble.classList.toggle("speaking", on);
  bubble.addEventListener("click", () => {
    if (panel.open) { panel.close(); setSpeaking(false); }
    else { panel.show(); setSpeaking(true); }
  });
  $("assistant-close").addEventListener("click", () => { panel.close(); setSpeaking(false); });
}
