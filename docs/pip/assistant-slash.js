import { CLAUDE_VARIANTS, CLAUDE_BACKENDS, activeModelForBackend } from "./claude.js";
import { settings, saveSettings } from "../settings.js";
import { DEMO_NAMES } from "./demos.js";
import { getActiveDetectorName, getAvailableDetectors, setActiveDetector } from "../perception/detectors.js";

// Slash commands registered on the pip handle. /clear and /help ship as
// pip-core built-ins (v1.7.0+); these are the dashboard-specific ones.
//
// Provider list mirrors pip-core's bundle taxonomy (`./bundle/anthropic`,
// `./bundle/openai`) plus the dashboard-specific `subscription` (= the
// ai-bridge proxy on 127.0.0.1, which injects the Mac's Keychain token).
// Anthropic's Claude variants nest under `anthropic` rather than living as
// sibling top-level entries — they're not providers.
//
// `subscription`, not `local`: the token names what pays for the call, since
// that is the axis separating it from anthropic/openai. It is NOT local
// compute — the proxy forwards to api.anthropic.com — and `local` is
// reserved for the planned on-robot Gemma backend.
//
// Descriptions answer the only question that changes the user's next
// action: does picking this ask me for a key? The vendor name doesn't say
// that. pip-core renders them in the dropdown's .desc column when a
// completion returns {name, description} instead of a bare string.
const PIP_PROVIDERS = [
  { name: "subscription", description: "your Claude plan · no key" },
  { name: "anthropic",    description: "direct · needs Anthropic key" },
  { name: "openai",       description: "direct · needs OpenAI key" },
];
const PIP_PROVIDER_NAMES = PIP_PROVIDERS.map(p => p.name);

// Mark the live backend. Its own channel, deliberately: pip-core paints
// the highlighted row with --pip-accent, and that already means "the
// keyboard cursor is here" — row zero is lit on open whether or not it's
// the active provider, so reusing it for state would make the menu answer
// a question the user didn't ask. A leading glyph in .desc is the one
// channel left (pip-core gives us .name and .desc, and .name is inserted
// into the input verbatim by acceptSlashSuggest, so it can't carry marks).
// It's also the accessible half: .desc is read aloud; a background colour
// isn't. State goes first because .desc truncates with an ellipsis.
const IN_USE = "✓ in use · ";
function describeProvider(p) {
  return p.name === settings.pipBackend
    ? { name: p.name, description: IN_USE + p.description }
    : p;
}

// Prompt for + store an API key for anthropic/openai. Shared by the
// /model gate here and assistant.js's failure-recovery / onboarding
// flows. Returns the key, or null on cancel. Caller owns saveSettings()
// timing — the /model flow batches it with the backend switch.
export async function collectAndSaveKey(pip, isAnthropic) {
  const key = await pip.collectSecret({
    label: `${isAnthropic ? "Anthropic" : "OpenAI"} API key`,
    format: isAnthropic ? "sk-ant-…" : "sk-…",
  });
  if (!key) return null;
  if (isAnthropic) settings.pipApiKey = key;
  else settings.pipOpenaiKey = key;
  return key;
}

export function registerSlashCommands({ pip }) {
  // /model — pick a provider, optionally with a sub-arg.
  //   /model anthropic | subscription           switch provider (current variant)
  //   /model anthropic opus                switch + set Claude variant
  //   /model subscription sonnet           same for that provider
  //   /model openai
  // Both providers in CLAUDE_BACKENDS (anthropic, subscription) accept the
  // /model <provider> <variant> two-token shape — they share pipClaudeModel.
  // Setup (API key) happens inline: an askInChat confirmation card first
  // (same card the failure-recovery path in assistant.js shows), then
  // pip.collectSecret for the actual paste — so the user never leaves
  // the chat surface, and never lands in the masked field with no warning.
  const CLAUDE_ALIASES = CLAUDE_VARIANTS.map(v => v.alias);
  pip.registerSlash({
    name: "model",
    description: "switch Pip's provider; /model anthropic|subscription <variant> for opus/sonnet/haiku",
    // Two-level completion: top tokens are providers; after a
    // Claude-capable provider the second token completes against
    // Claude variants. (Real drill-down, unlike /vision — see its comment.)
    complete: (partial) => {
      const tokens = partial.split(/\s+/);
      if (tokens.length <= 1) {
        return PIP_PROVIDERS
          .filter(p => p.name.startsWith(tokens[0].toLowerCase()))
          .map(describeProvider);
      }
      const [provider, ...rest] = tokens;
      const lastToken = rest[rest.length - 1] || "";
      if (CLAUDE_BACKENDS.has(provider.toLowerCase())) {
        return CLAUDE_VARIANTS
          .filter(v => v.alias.startsWith(lastToken.toLowerCase()))
          .map(v => ({
            name: v.alias,
            description: v.id === settings.pipClaudeModel ? IN_USE + v.id : v.id,
          }));
      }
      return [];
    },
    handler: async (argsString) => {
      const trimmed = argsString.trim();
      if (!trimmed) {
        // No arg = re-open the arg-mode dropdown as a provider picker
        // instead of logging help text to chat. Matches CLI palette
        // behavior — "/model" + Enter feels like opening a sub-menu.
        return { openCompletions: true };
      }

      const [providerArg, ...rest] = trimmed.split(/\s+/);
      const provider = providerArg.toLowerCase();
      const subArg = rest.join(" ").trim().toLowerCase();

      if (!PIP_PROVIDER_NAMES.includes(provider)) {
        return { reply: `Unknown provider \`${provider}\`. Available: ${PIP_PROVIDER_NAMES.map(p => `\`${p}\``).join(", ")}.` };
      }

      // Claude-capable provider + variant sub-arg: stage the variant
      // locally, don't mutate settings until any auth prompt resolves.
      // Without staging, a user cancelling the API-key prompt below would
      // leave pipClaudeModel changed even though the provider switch was
      // cancelled (notably visible on `subscription`, which reads the variant live).
      let pendingClaudeModel = null;
      if (CLAUDE_BACKENDS.has(provider) && subArg) {
        const variant = CLAUDE_VARIANTS.find(v => v.alias === subArg);
        if (!variant) {
          return { reply: `Unknown Claude variant \`${subArg}\`. Available: ${CLAUDE_ALIASES.map(v => `\`${v}\``).join(", ")}.` };
        }
        pendingClaudeModel = variant.id;
        // Fast path: variant-only change on the current backend — no
        // provider switch, no auth flow.
        if (settings.pipBackend === provider) {
          settings.pipClaudeModel = pendingClaudeModel;
          saveSettings();
          pip.setModelLabel?.(activeModelForBackend(settings.pipBackend));
          return { reply: `Claude variant set to \`${variant.id}\` on \`${provider}\`.` };
        }
        // Variant staged; continue into the provider-switch logic below.
      }

// Contextual setup: providers that need auth/keys get prompted
      // inline before we commit. Cancellation leaves the existing
      // selection untouched. Re-running `/model <current>` is the
      // documented re-auth path, so we re-prompt even when the
      // credential already exists.
      //
      // Slash handlers don't get a turnEl (see /demo below), so a card
      // that needs one — the askInChat confirmation before collectSecret
      // — has to make its own via pip.startTurn(), then render its own
      // reply through setReplyText + clearedUI:true instead of the
      // normal {reply} return, or pip-core would also auto-create the
      // default echo+reply turn and we'd get two.
      const isReSetup = provider === settings.pipBackend;
      let ownTurnEl = null;
      const needsAnthropicKey = provider === "anthropic" && (!settings.pipApiKey || isReSetup);
      const needsOpenaiKey    = provider === "openai"    && (!settings.pipOpenaiKey || isReSetup);
      if (needsAnthropicKey || needsOpenaiKey) {
        const label  = needsAnthropicKey ? "Anthropic" : "OpenAI";
        ownTurnEl = pip.startTurn({ echo: `/model ${trimmed}` });
        const choice = await pip.askInChat({
          question: `${label} needs ${isReSetup ? "a new" : "an"} API key.`,
          options: [isReSetup ? "Re-enter key" : "Enter key", "Cancel"],
        }, ownTurnEl);
        const key = (choice === "Enter key" || choice === "Re-enter key")
          ? await collectAndSaveKey(pip, needsAnthropicKey)
          : null;
        if (!key) {
          pip.setReplyText(ownTurnEl, `Cancelled — ${label} needs an API key. Run \`/model ${provider}\` to try again.`, true);
          return { clearedUI: true };
        }
      }

      // All gates passed (no cancellation, no auth failure). Commit the
      // staged variant alongside the backend switch so they land together.
      if (pendingClaudeModel) settings.pipClaudeModel = pendingClaudeModel;
      settings.pipBackend = provider;
      saveSettings();
      pip.setModelLabel?.(activeModelForBackend(provider));

      const modelLabel = activeModelForBackend(provider);
      const replyText = `Backend set to \`${provider}\`${provider !== modelLabel ? ` · model: \`${modelLabel}\`` : ""}.`;
      if (ownTurnEl) {
        pip.setReplyText(ownTurnEl, replyText, true);
        return { clearedUI: true };
      }
      return { reply: replyText };
    },
  });

  // /demo — scripted choreographies. Slash exists for tab-completion +
  // /help discoverability. The actual execution runs through onSubmit
  // (because demos need turn-scoped pill rendering, and slash handlers
  // don't get turnEl), so we synthesize `demo <name>` into the input
  // and requestSubmit. clearedUI:true keeps pip from also creating an
  // empty slash-response turn next to the real one.
  pip.registerSlash({
    name: "demo",
    description: `run a scripted demo (${DEMO_NAMES.join(", ")})`,
    complete: (partial) => DEMO_NAMES.filter(n => n.startsWith(partial.toLowerCase())),
    handler: async (argsString) => {
      // Synthesizing input+submit (rather than calling some runDemo(name)
      // directly) is required either way: demos need turn-scoped pill
      // rendering that only the real onSubmit pipeline provides, and slash
      // handlers don't get a turnEl of their own to render pills into.
      const runDemo = (name) => {
        const input = document.querySelector(".pip-input");
        const form  = input?.form || document.querySelector(".pip-form");
        if (!input || !form) return false;
        input.value = `demo ${name}`;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        requestAnimationFrame(() => form.requestSubmit?.());
        return true;
      };
      const arg = argsString.trim();
      if (!arg) {
        // No-arg = pick from a button card instead of printing a list and
        // making the user retype `/demo <name>` themselves — same pattern
        // /model uses for its API-key confirmation gate.
        const turnEl = pip.startTurn({ echo: "/demo" });
        const choice = await pip.askInChat({ question: "Which demo?", options: [...DEMO_NAMES, "Cancel"] }, turnEl);
        if (!choice || choice === "Cancel") {
          pip.setReplyText(turnEl, "No demo run.", true);
          return { clearedUI: true };
        }
        pip.setReplyText(turnEl, `Running \`${choice}\`…`, true);
        runDemo(choice);
        return { clearedUI: true };
      }
      if (!runDemo(arg)) return { reply: "Demo input not available." };
      return { clearedUI: true };
    },
  });

  // /vision and /detector — two distinct vision primitives the dashboard
  // exposes, kept as separate flat commands rather than one namespaced
  // `/vision <sub>` verb. They used to be unified under one slash on the
  // theory that one discoverable entry point beats two — but the two
  // subs aren't a hierarchy (unlike /model's provider→variant drill-down):
  // `vision` gates whether the *planner* gets raw frames in its tool
  // surface (slow, open-vocab, costs tokens, scene-reasoning); `detector`
  // picks which in-browser closed-vocab model serves the *reflex layer*
  // (~10–30ms, free, bbox-only). Two unrelated toggles under one verb
  // read as one confusing thing instead of two clear ones. Matches Claude
  // Code's own precedent: /model and /effort stay separate top-level
  // commands even though a generic /config key=value already exists that
  // could hold both — flat wins when two axes are each common enough to
  // deserve their own verb. Pip vision wires the Anthropic image-in-
  // tool_result content shape; only the subscription + anthropic backends ship
  // the right content-block packing.
  const PIP_VISION_VALUES = ["on", "off"];

  pip.registerSlash({
    name: "vision",
    description: "toggle whether Pip's planner receives raw camera frames (on|off)",
    complete: (partial) => PIP_VISION_VALUES.filter(v => v.startsWith(partial.trim().toLowerCase())),
    handler: async (argsString) => {
      const trimmed = argsString.trim().toLowerCase();
      if (!trimmed) {
        // No-arg = a one-tap toggle button instead of printing the current
        // state and making the user type the opposite value themselves.
        const current = settings.pipVisionEnabled;
        const turnEl = pip.startTurn({ echo: "/vision" });
        const choice = await pip.askInChat({
          question: `Pip vision is currently \`${current ? "on" : "off"}\`.`,
          options: [current ? "Turn off" : "Turn on", "Cancel"],
        }, turnEl);
        let text;
        if (!choice || choice === "Cancel") {
          text = `Vision unchanged — still \`${current ? "on" : "off"}\`.`;
        } else {
          settings.pipVisionEnabled = !current;
          saveSettings();
          text = `Pip vision ${settings.pipVisionEnabled ? "on" : "off"}.`;
        }
        pip.setReplyText(turnEl, text, true);
        return { clearedUI: true };
      }
      if (trimmed !== "on" && trimmed !== "off") {
        return { reply: "Usage: `/vision on` or `/vision off`." };
      }
      settings.pipVisionEnabled = trimmed === "on";
      saveSettings();
      return { reply: `Pip vision ${trimmed}.` };
    },
  });

  pip.registerSlash({
    name: "detector",
    description: "switch the reflex-layer closed-vocab detector (mediapipe|yolo26)",
    complete: (partial) => getAvailableDetectors()
      .map(d => d.name)
      .filter(n => n.startsWith(partial.trim().toLowerCase())),
    handler: async (argsString) => {
      const available = getAvailableDetectors();
      const applySwitch = (name) => {
        try {
          setActiveDetector(name);
        } catch (err) {
          return `Failed to switch: ${err.message || err}`;
        }
        const label = available.find(d => d.name === name)?.label || name;
        return `Detector set to \`${name}\` — ${label}. First detection call will lazy-load the model.`;
      };

      const subArg = argsString.trim().toLowerCase();
      if (!subArg) {
        // No-arg = pick from a button card instead of printing the list and
        // making the user retype `/detector <name>` themselves — same
        // pattern /model uses for its API-key confirmation gate.
        const current = getActiveDetectorName();
        const turnEl = pip.startTurn({ echo: "/detector" });
        const choice = await pip.askInChat({
          question: `Reflex-layer detector — currently \`${current}\`.`,
          options: [...available.map(d => d.name), "Cancel"],
        }, turnEl);
        const text = (!choice || choice === "Cancel") ? `Detector unchanged — still \`${current}\`.`
                   : choice === current ? `Already on \`${current}\`.`
                   : applySwitch(choice);
        pip.setReplyText(turnEl, text, true);
        return { clearedUI: true };
      }
      if (!available.some(d => d.name === subArg)) {
        const names = available.map(d => `\`${d.name}\``).join(", ");
        return { reply: `Unknown detector \`${subArg}\`. Available: ${names}.` };
      }
      return { reply: applySwitch(subArg) };
    },
  });
}
