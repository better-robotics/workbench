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

  // /vision on|off — toggle whether Pip can see camera frames directly.
  // Tool wires the Anthropic image-in-tool_result content shape; only the
  // bridge + anthropic backends ship the right content-block packing.
  pip.registerSlash({
    name: "vision",
    description: "let Pip see camera frames directly (on/off)",
    complete: (partial) => ["on", "off"].filter(s => s.startsWith(partial.toLowerCase())),
    handler: (argsString) => {
      const arg = argsString.trim().toLowerCase();
      if (!arg) {
        return { reply: `Vision is currently \`${settings.pipVisionEnabled ? "on" : "off"}\`. Use \`/vision on\` or \`/vision off\`.` };
      }
      if (arg !== "on" && arg !== "off") {
        return { reply: "Usage: `/vision on` or `/vision off`." };
      }
      settings.pipVisionEnabled = arg === "on";
      saveSettings();
      return { reply: `Vision ${arg}.` };
    },
  });

  // /detector — switch the closed-vocab detector backend. Backends are
  // lazy-loaded by detectors.js, so switching is cheap: the previously-
  // active module stays cached in memory but a switch immediately routes
  // all future detectOnce / startDetection calls (and the active
  // vocabulary surfaced in tool schemas + the Reflex card UI). Persists
  // through settings.pipDetector inside setActiveDetector().
  pip.registerSlash({
    name: "detector",
    description: "switch the closed-vocab detector backend (mediapipe / yolo26)",
    complete: (partial) => getAvailableDetectors()
      .map(d => d.name)
      .filter(n => n.startsWith(partial.toLowerCase())),
    handler: (argsString) => {
      const arg = argsString.trim().toLowerCase();
      const available = getAvailableDetectors();
      if (!arg) {
        const lines = available.map(d => {
          const marker = d.name === getActiveDetectorName() ? "•" : " ";
          return `${marker} \`${d.name}\` — ${d.label}`;
        }).join("\n");
        return { reply: `Active detector: \`${getActiveDetectorName()}\`.\n\n${lines}\n\nSwitch with \`/detector <name>\`.` };
      }
      if (!available.some(d => d.name === arg)) {
        const names = available.map(d => `\`${d.name}\``).join(", ");
        return { reply: `Unknown detector \`${arg}\`. Available: ${names}.` };
      }
      try {
        setActiveDetector(arg);
      } catch (err) {
        return { reply: `Failed to switch: ${err.message || err}` };
      }
      const label = available.find(d => d.name === arg)?.label || arg;
      return { reply: `Detector set to \`${arg}\` — ${label}. First detection call will lazy-load the model.` };
    },
  });
}
