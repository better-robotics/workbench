import { CLAUDE_VARIANTS, CLAUDE_BACKENDS, activeModelForBackend } from "./claude.js";
import { settings, saveSettings } from "./settings.js";
import { DEMO_NAMES } from "./demos.js";
import { getActiveDetectorName, getAvailableDetectors, setActiveDetector } from "./detectors.js";

// Slash commands registered on the pip handle. /clear and /help ship as
// pip-core built-ins (v1.7.0+); these are the dashboard-specific ones.
const PIP_BACKENDS = ["github", "bridge", "anthropic", "openai"];

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

  // /model handles both *switching* the backend and *setting it up* if the
  // chosen one needs auth or a key. One slash, one mental model: pick a
  // backend or a Claude variant, the rest happens inline. Key entry
  // repurposes Pip's main input via pip.collectSecret — same input the
  // user's already looking at.
  const CLAUDE_ALIASES = CLAUDE_VARIANTS.map(v => v.alias);
  pip.registerSlash({
    name: "model",
    description: "switch Pip's backend (github/bridge/anthropic/openai) or Claude variant (opus/sonnet/haiku)",
    // Context-aware completion: on a Claude-capable backend, variants come
    // first (that's the next decision you'd most likely make); otherwise
    // backends lead.
    complete: (partial) => {
      const isClaude = CLAUDE_BACKENDS.has(settings.pipBackend);
      const ordered = isClaude ? [...CLAUDE_ALIASES, ...PIP_BACKENDS] : [...PIP_BACKENDS, ...CLAUDE_ALIASES];
      return ordered.filter(b => b.startsWith(partial.toLowerCase()));
    },
    handler: async (argsString) => {
      const arg = argsString.trim().toLowerCase();
      if (!arg) {
        const others = PIP_BACKENDS.filter(b => b !== settings.pipBackend);
        return {
          reply: `Current backend: \`${settings.pipBackend}\` · model: \`${activeModelForBackend(settings.pipBackend)}\`. Switch backend with \`/model <name>\` (${others.map(b => `\`${b}\``).join(", ")}) or Claude variant with \`/model opus|sonnet|haiku\`.`,
        };
      }

      // Claude variant switch — sets pipClaudeModel; takes effect on
      // bridge + anthropic backends. On other backends we still save it so
      // it'll apply once they switch to a Claude-capable backend.
      const variant = CLAUDE_VARIANTS.find(v => v.alias === arg);
      if (variant) {
        settings.pipClaudeModel = variant.id;
        try { saveSettings(); } catch {}
        pip.setModelLabel?.(activeModelForBackend(settings.pipBackend));
        const tail = CLAUDE_BACKENDS.has(settings.pipBackend)
          ? ""
          : ` — takes effect after \`/model bridge\` or \`/model anthropic\`.`;
        return { reply: `Claude variant set to \`${variant.id}\`${tail}` };
      }

      if (!PIP_BACKENDS.includes(arg)) {
        return { reply: `Unknown choice \`${arg}\`. Backends: ${PIP_BACKENDS.map(b => `\`${b}\``).join(", ")}. Claude variants: ${CLAUDE_ALIASES.map(b => `\`${b}\``).join(", ")}.` };
      }

      // Contextual setup: backends that need auth/keys get prompted inline
      // before we commit the switch. Cancellation leaves the existing
      // backend selection untouched. Re-running `/model <current>` is the
      // documented re-auth / re-key path, so we re-prompt even when the
      // credential already exists.
      const isReSetup = arg === settings.pipBackend;
      if (arg === "github" && (!settings.githubAuth?.username || isReSetup)) {
        try {
          const connect = await loadConnectGitHub();
          const auth = await connect("read:user", "better-robotics");
          settings.githubAuth = { username: auth.username, token: auth.token };
          window.__syncIdentityUI?.();
        } catch (err) {
          return { reply: `Sign-in failed: ${err.message || err}` };
        }
      }
      if (arg === "anthropic" && (!settings.pipApiKey || isReSetup)) {
        const key = await pip.collectSecret({ label: "Anthropic API key", format: "sk-ant-…" });
        if (!key) return { reply: "Cancelled — Anthropic needs an API key. Run `/model anthropic` to try again." };
        settings.pipApiKey = key;
      }
      if (arg === "openai" && (!settings.pipOpenaiKey || isReSetup)) {
        const key = await pip.collectSecret({ label: "OpenAI API key", format: "sk-…" });
        if (!key) return { reply: "Cancelled — OpenAI needs an API key. Run `/model openai` to try again." };
        settings.pipOpenaiKey = key;
      }

      // Mutate the live binding shared with claude.js, then save.
      settings.pipBackend = arg;
      saveSettings();
      pip.setModelLabel?.(activeModelForBackend(arg));

      return { reply: `Backend set to \`${arg}\`.` };
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
