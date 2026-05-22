import { CLAUDE_VARIANTS, CLAUDE_BACKENDS, activeModelForBackend } from "./claude.js";
import { settings, saveSettings } from "./settings.js";
import { DEMO_NAMES } from "./demos.js";
import { getActiveDetectorName, getAvailableDetectors, setActiveDetector } from "./detectors.js";

// Slash commands registered on the pip handle. /clear and /help ship as
// pip-core built-ins (v1.7.0+); these are the dashboard-specific ones.
//
// Provider list mirrors pip-core's bundle taxonomy (`./bundle/anthropic`,
// `./bundle/openai`, `./bundle/local`) plus the dashboard-specific
// transports (`bridge` = localhost ai-bridge proxy, `github` = GitHub
// Models). Anthropic's Claude variants nest under `anthropic` rather
// than living as sibling top-level entries — they're not providers.
const PIP_PROVIDERS = ["github", "bridge", "anthropic", "openai", "local"];

export function registerSlashCommands({ pip, loadConnectGitHub }) {
  pip.registerSlash({
    name: "voice",
    description: "start / stop voice dictation into the input",
    handler: () => {
      if (!pip.micSupported) {
        return { reply: "Voice input isn't supported in this browser. Chrome / Edge / Safari only." };
      }
      pip.toggleMic();
      return { reply: "" };
    },
  });

  pip.registerSlash({
    name: "scan",
    description: "open the BLE chooser to pair a robot",
    // Synthetic click on the scan button — keeps requestDevice's user-
    // activation chain (Enter keypress → click event) intact across browsers
    // without re-implementing the chooser flow here.
    handler: () => {
      const btn = document.getElementById("scan-btn");
      if (!btn) return { reply: "Scan button isn't on this page." };
      btn.click();
      return { reply: "Opened the BLE chooser." };
    },
  });

  // /model — pick a provider, optionally with a sub-arg.
  //   /model anthropic | bridge            switch provider (current variant)
  //   /model anthropic opus                switch + set Claude variant
  //   /model bridge sonnet                 same for the bridge provider
  //   /model openai | github | local
  // Both providers in CLAUDE_BACKENDS (anthropic, bridge) accept the
  // /model <provider> <variant> two-token shape — they share pipClaudeModel.
  // Setup (OAuth, API key) happens inline via pip.collectSecret so the
  // user never leaves the chat surface to enter credentials.
  const CLAUDE_ALIASES = CLAUDE_VARIANTS.map(v => v.alias);
  pip.registerSlash({
    name: "model",
    description: "switch Pip's provider; /model anthropic|bridge <variant> for opus/sonnet/haiku",
    // Two-level completion (mirrors /vision pip|detector shape): top
    // tokens are providers; after a Claude-capable provider the second
    // token completes against Claude variants.
    complete: (partial) => {
      const tokens = partial.split(/\s+/);
      if (tokens.length <= 1) {
        return PIP_PROVIDERS.filter(p => p.startsWith(tokens[0].toLowerCase()));
      }
      const [provider, ...rest] = tokens;
      const lastToken = rest[rest.length - 1] || "";
      if (CLAUDE_BACKENDS.has(provider.toLowerCase())) {
        return CLAUDE_ALIASES.filter(v => v.startsWith(lastToken.toLowerCase()));
      }
      return [];
    },
    handler: async (argsString) => {
      const trimmed = argsString.trim();
      if (!trimmed) {
        const others = PIP_PROVIDERS.filter(p => p !== settings.pipBackend);
        return {
          reply: `Current: \`${settings.pipBackend}\` · model: \`${activeModelForBackend(settings.pipBackend)}\`. Switch with \`/model <provider>\` (${others.map(p => `\`${p}\``).join(", ")}). Claude variants: \`/model anthropic|bridge ${CLAUDE_ALIASES.join("|")}\`.`,
        };
      }

      const [providerArg, ...rest] = trimmed.split(/\s+/);
      const provider = providerArg.toLowerCase();
      const subArg = rest.join(" ").trim().toLowerCase();

      if (!PIP_PROVIDERS.includes(provider)) {
        return { reply: `Unknown provider \`${provider}\`. Available: ${PIP_PROVIDERS.map(p => `\`${p}\``).join(", ")}.` };
      }

      // Claude-capable provider + variant sub-arg: stage the variant
      // locally, don't mutate settings until any auth prompt resolves.
      // Without staging, a user cancelling the API-key prompt below would
      // leave pipClaudeModel changed even though the provider switch was
      // cancelled (notably visible on `bridge`, which reads the variant live).
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

      // `local` is browser-resident inference via pip-core's
      // createTransformersRenderer (transformers.js + WebGPU). No auth /
      // key needed — just download the model on first use. Defaults to
      // Gemma 4 E2B-it at q4f16 (~1.5GB decoder, browser-cached after).
      // Tools aren't dispatched to local yet (pip-core's local provider
      // doesn't parse Gemma's inline tool-call format into tool_use
      // events) — chat works; deterministic tool calls go through slash
      // commands until that lands.
      if (provider === "local") {
        if (typeof navigator === "undefined" || !navigator.gpu) {
          return { reply: "Local inference needs WebGPU — not available in this browser. Chrome 113+ / Edge 113+ on a recent OS with GPU acceleration enabled." };
        }
        settings.pipBackend = "local";
        saveSettings();
        pip.setModelLabel?.(activeModelForBackend("local"));
        return {
          reply: `Backend set to \`local\` — \`${activeModelForBackend("local")}\`. **First message downloads ~1.5 GB of weights** (browser-cached after). Tools aren't routed to local yet; use slash commands for deterministic dispatch.`,
        };
      }

      // Contextual setup: providers that need auth/keys get prompted
      // inline before we commit. Cancellation leaves the existing
      // selection untouched. Re-running `/model <current>` is the
      // documented re-auth path, so we re-prompt even when the
      // credential already exists.
      const isReSetup = provider === settings.pipBackend;
      if (provider === "github" && (!settings.githubAuth?.username || isReSetup)) {
        try {
          const connect = await loadConnectGitHub();
          const auth = await connect("read:user", "better-robotics");
          settings.githubAuth = { username: auth.username, token: auth.token };
          window.__syncIdentityUI?.();
        } catch (err) {
          return { reply: `Sign-in failed: ${err.message || err}` };
        }
      }
      if (provider === "anthropic" && (!settings.pipApiKey || isReSetup)) {
        const key = await pip.collectSecret({ label: "Anthropic API key", format: "sk-ant-…" });
        if (!key) return { reply: "Cancelled — Anthropic needs an API key. Run `/model anthropic` to try again." };
        settings.pipApiKey = key;
      }
      if (provider === "openai" && (!settings.pipOpenaiKey || isReSetup)) {
        const key = await pip.collectSecret({ label: "OpenAI API key", format: "sk-…" });
        if (!key) return { reply: "Cancelled — OpenAI needs an API key. Run `/model openai` to try again." };
        settings.pipOpenaiKey = key;
      }

      // All gates passed (no cancellation, no auth failure). Commit the
      // staged variant alongside the backend switch so they land together.
      if (pendingClaudeModel) settings.pipClaudeModel = pendingClaudeModel;
      settings.pipBackend = provider;
      saveSettings();
      pip.setModelLabel?.(activeModelForBackend(provider));

      const modelLabel = activeModelForBackend(provider);
      return { reply: `Backend set to \`${provider}\`${provider !== modelLabel ? ` · model: \`${modelLabel}\`` : ""}.` };
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
    handler: (argsString) => {
      const arg = argsString.trim();
      if (!arg) {
        return { reply: `Demos: ${DEMO_NAMES.map(n => `\`${n}\``).join(", ")}. Try \`/demo figure8\`.` };
      }
      const input = document.querySelector(".pip-input");
      const form  = input?.form || document.querySelector(".pip-form");
      if (!input || !form) return { reply: "Demo input not available." };
      input.value = `demo ${arg}`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      requestAnimationFrame(() => form.requestSubmit?.());
      return { clearedUI: true };
    },
  });

  // /vision — namespaced surface for the two distinct vision primitives
  // the dashboard exposes. `pip` controls whether the *planner* gets raw
  // frames in its tool surface (slow, open-vocab, costs tokens, scene-
  // reasoning). `detector` controls which in-browser closed-vocab model
  // serves the *reflex layer* (~10–30ms, free, bbox-only). They live at
  // different rungs of the model-discipline cascade — kept distinct to
  // avoid the "one AI knob covers everything" anti-pattern, but unified
  // under one slash so the operator has one place to look. Pip vision
  // wires the Anthropic image-in-tool_result content shape; only the
  // bridge + anthropic backends ship the right content-block packing.
  const VISION_SUBS = ["pip", "detector"];
  const PIP_VISION_VALUES = ["on", "off"];

  const visionStatus = () => {
    const pip = settings.pipVisionEnabled ? "on" : "off";
    const det = getActiveDetectorName();
    const detLines = getAvailableDetectors().map(d => {
      const marker = d.name === det ? "•" : " ";
      return `  ${marker} \`${d.name}\` — ${d.label}`;
    }).join("\n");
    return `Vision surfaces:\n- \`pip\` (planner sees frames): \`${pip}\` — toggle with \`/vision pip on|off\`\n- \`detector\` (in-browser reflex): \`${det}\` — switch with \`/vision detector <name>\`\n${detLines}`;
  };

  pip.registerSlash({
    name: "vision",
    description: "switch planner vision (pip on|off) or reflex detector (detector mediapipe|yolo26)",
    complete: (partial) => {
      // partial is the full args string after `/vision `. Branch on
      // whether the user has typed the subcommand yet — if not, suggest
      // the sub names; if yes, suggest values for that sub.
      const tokens = partial.split(/\s+/);
      if (tokens.length <= 1) {
        return VISION_SUBS.filter(s => s.startsWith(tokens[0].toLowerCase()));
      }
      const [sub, ...rest] = tokens;
      const lastToken = rest[rest.length - 1] || "";
      if (sub === "pip") {
        return PIP_VISION_VALUES.filter(v => v.startsWith(lastToken.toLowerCase()));
      }
      if (sub === "detector") {
        return getAvailableDetectors()
          .map(d => d.name)
          .filter(n => n.startsWith(lastToken.toLowerCase()));
      }
      return [];
    },
    handler: (argsString) => {
      const trimmed = argsString.trim();
      if (!trimmed) return { reply: visionStatus() };

      const [sub, ...rest] = trimmed.split(/\s+/);
      const subArg = rest.join(" ").trim().toLowerCase();

      if (sub === "pip") {
        if (!subArg) {
          return { reply: `Pip vision is currently \`${settings.pipVisionEnabled ? "on" : "off"}\`. Use \`/vision pip on\` or \`/vision pip off\`.` };
        }
        if (subArg !== "on" && subArg !== "off") {
          return { reply: "Usage: `/vision pip on` or `/vision pip off`." };
        }
        settings.pipVisionEnabled = subArg === "on";
        saveSettings();
        return { reply: `Pip vision ${subArg}.` };
      }

      if (sub === "detector") {
        const available = getAvailableDetectors();
        if (!subArg) {
          const lines = available.map(d => {
            const marker = d.name === getActiveDetectorName() ? "•" : " ";
            return `${marker} \`${d.name}\` — ${d.label}`;
          }).join("\n");
          return { reply: `Active detector: \`${getActiveDetectorName()}\`.\n\n${lines}\n\nSwitch with \`/vision detector <name>\`.` };
        }
        if (!available.some(d => d.name === subArg)) {
          const names = available.map(d => `\`${d.name}\``).join(", ");
          return { reply: `Unknown detector \`${subArg}\`. Available: ${names}.` };
        }
        try {
          setActiveDetector(subArg);
        } catch (err) {
          return { reply: `Failed to switch: ${err.message || err}` };
        }
        const label = available.find(d => d.name === subArg)?.label || subArg;
        return { reply: `Detector set to \`${subArg}\` — ${label}. First detection call will lazy-load the model.` };
      }

      return { reply: `Unknown subcommand \`${sub}\`. Use \`pip\` (planner vision) or \`detector\` (reflex backend).` };
    },
  });
}
