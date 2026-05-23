import { ask, askWithTools, activeModelForBackend } from "./claude.js";
import { setAgentState } from "./agent-light.js";
import { escapeHtml } from "../dom.js";
import { getTools, executor, setAskInChatHandler, isVisionAvailable } from "./pip-tools.js";
import { labelTool, summarizeTool } from "../format.js";
import { settings, saveSettings } from "../settings.js";
import { state } from "../state.js";
import { tryMatchCommand, SAFETY_INTENTS } from "./voice-commands.js";
import { tryMatchDemo, STATIC_DEMO_PHRASES } from "./demos.js";
import { prewarmCache as prewarmTtsCache } from "../voice.js";
import { setDeps as setVoiceDeps, makeMicConfig, wireTtsGating } from "./assistant-voice.js";
import { registerSlashCommands } from "./assistant-slash.js";
import { wireWatcherFireBridge } from "./assistant-watcher-bridge.js";
import { releaseAllGates } from "../watcher.js";
import { emit as busEmit, TOPICS } from "../event-bus.js";
import { AUTH_URL } from "../endpoints.js";

// pip-core is dynamic-imported inside initAssistant() (not statically at
// module-load) so that a CDN failure on the jsdelivr URL cannot brick
// the whole module graph and strand the user without the BetterRobotics
// recovery menu. The static-import shape would propagate the 404 to
// assistant.js → app.js → DOMContentLoaded never fires → wireRecoveryMenu
// never runs. Dynamic-import turns that into a runtime throw that the
// initAssistant try/catch in app.js catches gracefully.
const PIP_CDN_URL = "https://cdn.jsdelivr.net/npm/@nevescloud/pip@latest/pip-core.esm.js";
let createPip = null;

const HISTORY_LIMIT = 12;

// Executor-enforced rules (signed-pair clamp, firmware pulse caps) live
// in pip-tools.js. Per-tool guidance (when to detect vs view, ask_human
// routing) lives in tool descriptions. The system prompt carries only
// identity + the rules the planner can't infer from schemas. The
// connected-robot snapshot is appended per-turn by buildSystem() so
// Pip can skip list_robots when ids are unambiguous.
const PIP_SYSTEM = [
  "You are an assistant in a browser robotics dashboard for ESP32 and Pi robots.",
  // Anti-narrate-without-acting — dominant failure mode in patrol runs;
  // Sonnet skips actual tool calls without it.
  "If you say you will call a tool, call it in the SAME turn. Don't promise tool calls for future turns. Don't describe actions you didn't take.",
  // Sensor freshness (arxiv 2510.23853 "Temporally Blind").
  "When get_robot_state returns motion_invalidated: true, telemetry was captured BEFORE the last motor action — re-read state or take a frame before trusting dist_cm.",
  // Loop anti-pattern guard — Nav2 recovery BTs reset on preempt, ours
  // doesn't, so otherwise the planner can keep retrying the same plan
  // against a continuous reflex (drive toward sign → halt → drive → halt).
  "If a [reflex-fire] reports the same class halting your motion twice in one turn, the floor is rejecting your plan — stop or call ask_human; don't retry the same approach.",
  // Reply shape constraints (the chat bubble's markdown subset).
  "REPLY FORMAT: concise plain-text summary. One short sentence is the default; never more than three lines unless the user asks for detail. No preamble, no recap, no narrating what you're about to do.",
  "Supported markdown: **bold**, *italic*, `code`, - bullets, 1. numbered lists, ```code blocks```. Do NOT use headers (#, ##, ###), horizontal rules (---), tables, or decorative section emojis — those render as raw text.",
].join("\n");

// Per-turn context. Collapses the "you must call list_robots first" round
// trip when the id is already unambiguous from current state.
function currentRobotsLine() {
  const usable = [...state.devices.values()].filter(e =>
    e.status === "connected" || e.status === "firmware-down"
  );
  if (usable.length === 0) {
    return "No robots are connected. Tools requiring an id will return errors until the user pairs and connects one.";
  }
  if (usable.length === 1) {
    const r = usable[0];
    const note = r.status === "firmware-down" ? " (firmware down — only recovery ops work)" : "";
    return `Connected robot: id="${r.id}" name="${r.name}" type=${r.fwType || "unknown"}${note}. Use this id directly; list_robots is unnecessary.`;
  }
  const lines = usable.map(r => {
    const note = r.status === "firmware-down" ? " [firmware down]" : "";
    return `- id="${r.id}" name="${r.name}" type=${r.fwType || "unknown"}${note}`;
  }).join("\n");
  return `${usable.length} connected robots (use these ids directly; list_robots only to refresh status):\n${lines}`;
}

function buildSystem() {
  // Vision availability flagged here so Pip doesn't narrate "let me
  // take a snapshot" when the tool is filtered out of getTools().
  const now = new Date().toISOString();
  const vision = isVisionAvailable()
    ? "view_robot_frame is available — use it for visual queries."
    : "view_robot_frame is NOT available this turn (vision off, or backend doesn't accept inline images). Don't promise visual snapshots. If a frame is needed, tell the user to run /vision on or switch backend with /model.";
  return `${PIP_SYSTEM}\n\nCurrent time: ${now}\n${vision}\n\n${currentRobotsLine()}`;
}

export const PIP_INTRO = "Try: \"why isn't this robot connecting\" or \"what's in the camera\". /help for commands.";

let _pip = null;

// Turn lifecycle. Voice (assistant-voice.js) and the watcher-fire bridge
// inject observations; runTurn drains them between askWithTools
// iterations so Pip sees the events on its next loop without polling.
// cancel() flips abort so the loop yields after the current iteration
// (in-flight tool call still completes — firmware safety floor caps
// blast radius). Bounded by fire-once-and-disable on the watcher side,
// so the observation queue can't pile up.
const turn = {
  el: null,
  abort: false,
  observations: [],
  isActive() { return !!this.el; },
  start(el) {
    this.el = el; this.abort = false; this.observations.length = 0;
    setAgentState("thinking");
  },
  end() { this.el = null; setAgentState("done"); },
  cancel() { this.abort = true; },
  pushObservation(text) { this.observations.push(text); },
  drainObservations() { return this.observations.splice(0); },
};

// Thin wrappers around pip-core's tool-using turn primitives. Pip ships
// the pill/bubble/image DOM; we add the robotics state (agent-light)
// and the labelTool / summarizeTool name formatting.
function appendStepPill(turnEl, name, input = null) {
  setAgentState(name === "ask_human" ? "asking" : "working");
  busEmit(TOPICS.TOOL_CALL, { tool: name, input });
  return _pip.appendToolPill(turnEl, name, { label: `${labelTool(name)} …` });
}
function finishStepPill(pill, name, input, result, error, durationMs) {
  setAgentState("thinking");
  busEmit(TOPICS.TOOL_RESULT, {
    tool: name,
    ok: !error && !(result?.error),
    error: error || result?.error || null,
  });
  // pip-core's pill renders elapsed time in its own span; we pass
  // null durationMs to summarizeTool so the label stays semantic
  // (name + arg summary) and pip handles right-edge timing.
  pill?.finish({
    label: summarizeTool(name, input, result, error, null),
    input, result, error, durationMs,
  });
}

// Pill lifecycle + tool execution in one place. Returns
// { ok, result, error } where error is an Error on a JS throw or a
// string on an in-band failure (caller can branch via instanceof).
async function executeWithPill(turnEl, tool, input) {
  const pill = appendStepPill(turnEl, tool, input);
  const startedAt = performance.now();
  try {
    const result = await executor(tool, input);
    const isErr = result && (result.error || result.ok === false);
    const errMsg = isErr ? (result.error || "failed") : null;
    finishStepPill(pill, tool, input, result, errMsg, performance.now() - startedAt);
    return { ok: !isErr, result, error: errMsg };
  } catch (err) {
    finishStepPill(pill, tool, input, null, err, performance.now() - startedAt);
    return { ok: false, result: null, error: err };
  }
}

function pickRobotId() {
  return [...state.devices.values()].find(e => e.status === "connected")?.id;
}

// Voice-as-sensor injection: when a voice command (or any utterance)
// arrives mid-turn (Claude is in the askWithTools loop), we don't open
// a new turn — pip's input is disabled and a parallel turn would split
// the conversation. Instead we:
//   - render any tool we directly dispatch as a .pip-step pill in the
//     active turn so the operator sees the side-channel intervention
//   - push an observation into turn.observations so claude.js drains
//     it on the next iteration alongside the tool_results, making the
//     intervention visible to the planner
//   - on safety verbs (stop), also call turn.cancel() so the loop yields
//     after the current iteration instead of continuing to plan around
//     the interrupt
//
// Match → direct dispatch. No-match utterances are still injected as
// informational observations ("user said: ...") so the user knows
// they were heard even when there's no actionable verb.
async function injectVoiceMidTurn(text) {
  if (!turn.isActive()) return false;
  const cmd = tryMatchCommand(text);
  if (cmd) {
    const robotId = pickRobotId();
    if (!robotId) {
      turn.pushObservation(`[user-voice] User said "${text}" — no robot connected.`);
      return true;
    }
    const input = { id: robotId, ...cmd.partialInput };
    const r = await executeWithPill(turn.el, cmd.tool, input);
    const resultStr = r.ok ? "ok" : `error: ${r.error?.message || r.error}`;
    const ts = new Date().toISOString();
    turn.pushObservation(
      `[user-voice ${ts}] User said "${text}" — direct-dispatched ${cmd.tool}(${JSON.stringify(input)}) → ${resultStr}. ` +
      (SAFETY_INTENTS.has(cmd.intent)
        ? "This is a safety override; stop your current plan."
        : "Adjust your plan if this affects what you were about to do.")
    );
    if (SAFETY_INTENTS.has(cmd.intent)) turn.cancel();
    _pip.scrollToBottom();
    return true;
  }
  // Non-command utterance: just inform the planner. Cheap and useful —
  // lets the user nudge Claude ("slow down", "head to the kitchen")
  // without taking over.
  turn.pushObservation(
    `[user-voice ${new Date().toISOString()}] User said "${text}". Treat as live guidance; adjust your plan if relevant.`
  );
  return true;
}

// Stop button while askWithTools iterates. Click sets abort flag the loop
// polls between iterations; current in-flight tool call still completes
// (firmware safety floor caps blast radius — .claude/CLAUDE.md → Control-loop invariants).
// Send + stop buttons live in pip-core 2.1.0+; we just toggle responding
// state and provide an onAbort callback below.

// Lazy GitHub OAuth helper — shared between /model handler and the
// failure-recovery flow. Module-scope so both code paths reach it.
let _connectGitHubFn = null;
async function _loadConnectGitHub() {
  if (_connectGitHubFn) return _connectGitHubFn;
  const mod = await import(`${AUTH_URL}/connect.js`);
  _connectGitHubFn = mod.connectGitHub;
  return _connectGitHubFn;
}

// Bridge failure copy. github / anthropic / openai use the
// inline-button + main-input recovery path in actOnFailure, so they
// don't need text hints anymore.
function backendFailureHint(backend) {
  const hints = {
    bridge:
      "ai-bridge isn't responding. Check the local service is running, or `/model` to switch backends.",
  };
  return hints[backend] || "Can't think right now — try again?";
}

// When the backend returns null/empty, the failure copy already names a
// likely cause and a specific action. Surface that action as an inline
// button (sign-in) or repurpose the main input (key paste) rather than
// asking the user to type a slash command. Same input the user's already
// looking at — no browser modal, no fragmentation.
async function actOnFailure(backend, turnEl) {
  if (backend === "github") {
    const choice = await _pip.askInChat({
      question: "GitHub Models needs sign-in (or token expired).",
      options: ["Sign in", "Switch backend"],
    }, turnEl);
    if (choice === "Sign in") {
      try {
        const connect = await _loadConnectGitHub();
        const auth = await connect("read:user", "better-robotics");
        settings.githubAuth = { username: auth.username, token: auth.token };
        saveSettings();
        window.__syncIdentityUI?.();
        return `Signed in as \`@${auth.username}\`. Try sending again.`;
      } catch (err) {
        return `Sign-in failed: ${err.message || err}`;
      }
    }
    return "Run `/model` to pick a different backend.";
  }
  if (backend === "anthropic" || backend === "openai") {
    const isAnthropic = backend === "anthropic";
    const label = isAnthropic ? "Anthropic" : "OpenAI";
    const format = isAnthropic ? "sk-ant-…" : "sk-…";
    const has = isAnthropic ? !!settings.pipApiKey : !!settings.pipOpenaiKey;
    const question = has
      ? `${label} call failed — key may be invalid or out of quota.`
      : `${label} needs an API key.`;
    const choice = await _pip.askInChat({
      question,
      options: [has ? "Re-enter key" : "Enter key", "Switch backend"],
    }, turnEl);
    if (choice === "Enter key" || choice === "Re-enter key") {
      const key = await _pip.collectSecret({ label: `${label} API key`, format });
      if (!key) return "Cancelled.";
      if (isAnthropic) settings.pipApiKey = key;
      else settings.pipOpenaiKey = key;
      saveSettings();
      return "Key saved. Try sending again.";
    }
    return "Run `/model` to pick a different backend.";
  }
  return backendFailureHint(backend);
}

// "Does the current backend have what it needs to make a request?" Used
// to decide whether to surface the first-message onboarding picker. Bridge
// is Keychain-backed by the ai-bridge proxy, opaque to the page; treat it
// as always-credentialed and let the existing failure-recovery flow handle
// "proxy not running." `local` runs entirely in-browser via WebGPU — no
// credentials, just the one-time model download on first generate.
function hasCredentialsForBackend(backend) {
  switch (backend) {
    case "github":    return !!settings.githubAuth?.token;
    case "anthropic": return !!settings.pipApiKey;
    case "openai":    return !!settings.pipOpenaiKey;
    case "bridge":    return true;
    case "local":     return typeof navigator !== "undefined" && !!navigator.gpu;
    default:          return false;
  }
}

// First-message onboarding. The default backend is github with no auth,
// so a brand-new user pressing send would otherwise eat a doomed request
// + the generic recovery prompt. Surface the choice up front, route
// through the same inline primitives the /model slash uses, and then
// continue into the user's original message — no manual retry.
async function offerBackendChoice(turnEl) {
  const labels = {
    github:    "GitHub Models (free · sign in)",
    anthropic: "Anthropic (paste API key)",
    openai:    "OpenAI (paste API key)",
    local:     "Local (in-browser · Gemma 4 E2B · ~1.5 GB download)",
  };
  const choice = await _pip.askInChat({
    question: "Pick a backend for Pip — your message will continue after setup.",
    options: Object.values(labels),
  }, turnEl);

  if (choice === labels.github) {
    // Narrow the try to OAuth only — a localStorage quota or post-auth UI
    // glitch shouldn't surface as "Sign-in failed" and bury the actual cause.
    let auth;
    try {
      const connect = await _loadConnectGitHub();
      auth = await connect("read:user", "better-robotics");
    } catch (err) {
      _pip.appendReplyBubble(turnEl).setText(`Sign-in failed: ${err?.message || err}`);
      return false;
    }
    settings.githubAuth = { username: auth.username, token: auth.token };
    settings.pipBackend = "github";
    saveSettings();
    window.__syncIdentityUI?.();
    _pip.setModelLabel?.(activeModelForBackend("github"));
    return true;
  }
  if (choice === labels.anthropic || choice === labels.openai) {
    const isAnthropic = choice === labels.anthropic;
    const label = isAnthropic ? "Anthropic" : "OpenAI";
    const format = isAnthropic ? "sk-ant-…" : "sk-…";
    const key = await _pip.collectSecret({ label: `${label} API key`, format });
    if (!key) return false;
    if (isAnthropic) settings.pipApiKey = key;
    else settings.pipOpenaiKey = key;
    settings.pipBackend = isAnthropic ? "anthropic" : "openai";
    saveSettings();
    _pip.setModelLabel?.(activeModelForBackend(settings.pipBackend));
    return true;
  }
  if (choice === labels.local) {
    if (typeof navigator === "undefined" || !navigator.gpu) {
      _pip.appendReplyBubble(turnEl).setText(
        "Local inference needs WebGPU — not available in this browser. Chrome 113+ / Edge 113+ on a recent OS with GPU acceleration enabled. Pick another backend.",
      );
      return false;
    }
    settings.pipBackend = "local";
    saveSettings();
    _pip.setModelLabel?.(activeModelForBackend("local"));
    _pip.appendReplyBubble(turnEl).setText(
      "Local model selected. First message downloads ~1.5 GB of weights (browser-cached after). Tools work but small-model reliability varies; slash commands stay as the deterministic fallback.",
    );
    return true;
  }
  return false;  // user dismissed
}

// Host onSubmit — runs askWithTools with hatch-style inline pill flow.
// We render text + tool pills directly into turnEl in arrival order
// instead of stuffing the final text into pip's single .pip-reply.
async function onSubmit(text, { turnEl }) {
  turn.start(turnEl);
  // pip-core auto-toggles responding state around onSubmit, which morphs
  // the right-edge slot (send → stop). turn.start clears abort + observations.
  //
  // turn.end() MUST run on every exit path, or the next voice utterance
  // (sticky mic) gets routed to injectVoiceMidTurn against the stale
  // turn and pushed onto turn.observations — which nothing is reading
  // once the turn (demo, direct-command, or LLM run) has ended, so the
  // utterance vanishes. Bug shipped twice: once for the demo branch,
  // once for the direct-command branch. The LLM branch already cleared
  // it inline at the bottom, but a single try/finally covers all
  // current and future return paths uniformly.
  try {
    if (!hasCredentialsForBackend(settings.pipBackend)) {
      const onboarded = await offerBackendChoice(turnEl);
      if (!onboarded) return;  // user dismissed or picked local
    }
    return await runTurn(text, turnEl);
  } finally {
    turn.end();
  }
}

async function runTurn(text, turnEl) {

  // Hide pip's default empty reply slot — we own the flow now.
  const defaultReply = turnEl.querySelector(".pip-reply");
  if (defaultReply) defaultReply.hidden = true;

  let currentReply = null;   // active iteration's text bubble; null between iterations
  let pendingPill = null;    // active tool pill awaiting onToolEnd

  // Direct-command + demo paths: if the input matches a recognized
  // command verb (drive, turn, stop…) or a demo name, dispatch
  // immediately and skip the LLM round-trip. Mycroft / OpenVoiceOS
  // pattern: regex intent gate first, LLM fallback for everything else.
  // Shared step-executor that renders a pill per tool call — same
  // affordance as LLM-driven tool calls, so direct commands and demo
  // sequences are visually indistinguishable from agent work.
  const runStep = async (tool, input) => {
    const r = await executeWithPill(turnEl, tool, input);
    if (r.error instanceof Error) throw r.error;
    return r.result;
  };
  const noRobot = () => {
    _pip.appendReplyBubble(turnEl).setHtml("No robot connected — pair one first.");
    return "";
  };

  const cmd = tryMatchCommand(text);
  if (cmd) {
    const robotId = pickRobotId();
    if (!robotId) return noRobot();
    await runStep(cmd.tool, { id: robotId, ...cmd.partialInput }).catch(() => {});
    return "";
  }

  // Demo path. Each routine orchestrates a sequence of tool calls via
  // runStep, so the whole choreography renders in the chat as pills the
  // user can audit / replay through Details. shouldAbort lets the Stop
  // button cut a long demo (follow especially) mid-sequence.
  const demo = tryMatchDemo(text);
  if (demo) {
    const robotId = pickRobotId();
    if (!robotId) return noRobot();
    // Minimal runtime kit. Demos that need watcher / ultrasonic /
    // Claude-vision import those directly (see demos.js imports).
    const ctx = {
      id: robotId,
      exec: runStep,
      sleep: (ms) => new Promise(r => setTimeout(r, ms)),
      shouldAbort: () => turn.abort,
    };
    try { await demo.run(ctx); }
    catch (err) {
      _pip.appendReplyBubble(turnEl).setHtml(escapeHtml(`Demo "${demo.label}" failed: ${err?.message || err}`));
    }
    return "";
  }

  const messages = _pip.history.slice(-HISTORY_LIMIT)
    .map(m => ({ role: m.role, content: m.content }));
  const reply = await askWithTools(messages, {
    system: buildSystem(),
    tools: getTools(),
    executor,
    maxTokens: 1024,
    // High budget + no interrupt prompt: trust the planner to stop when
    // done (stop_reason !== "tool_use") or the user to hit Stop. The old
    // "Continue?" prompt cut Claude mid-thought on multi-step tasks the
    // 10-iteration default couldn't fit. Stop button + firmware-level
    // safety floors (pulse caps, watchdog, ultrasonic clip) bound blast
    // radius — no executor-imposed observation cadence layered on top.
    maxIterations: 50,
    onToolStart: ({ name, input }) => {
      // Close out the current iteration's text bubble so the next
      // iteration's deltas land in a fresh one below the pill.
      currentReply = null;
      pendingPill = appendStepPill(turnEl, name, input);
    },
    onToolEnd: ({ name, input, result, error, durationMs }) => {
      finishStepPill(pendingPill, name, input, result, error, durationMs);
      pendingPill = null;
      // Inline render of view_robot_frame's image — the perception Pip
      // actually saw should be visible in the chat, not buried in a
      // Details JSON pre. Matches Anthropic computer-use UX where every
      // screenshot lands inline next to the action that triggered it.
      if (name === "view_robot_frame" && !error && result?._pipContent) {
        const img = result._pipContent.find(b => b?.type === "image");
        if (img?.source?.data) {
          _pip.appendTurnImage(turnEl, {
            src: `data:${img.source.media_type};base64,${img.source.data}`,
            alt: "robot camera frame",
          });
          // Reset the iter-reply pointer so the next text delta lands in
          // a fresh bubble *below* the image (same shape as the tool-pill
          // boundary) — keeps "image then narration" order legible.
          currentReply = null;
        }
      }
    },
    onDelta: (iterText) => {
      if (!currentReply) currentReply = _pip.appendReplyBubble(turnEl);
      currentReply.setText(iterText);
    },
    shouldAbort: () => turn.abort,
    getPendingObservations: () => turn.drainObservations(),
  });
  // turn.end() handled by onSubmit's try/finally — every
  // exit path of runTurn (this LLM branch, the demo branch, the direct-
  // command branch, the noRobot early-return) lands in that finally.

  // Backend returned nothing usable → render the failure inline since
  // we've hidden pip's default reply. actOnFailure can also drive an
  // inline askInChat (sign-in / key prompt), which appends its own
  // block to turnEl independently.
  if (reply == null || reply === "") {
    const failureText = await actOnFailure(settings.pipBackend, turnEl);
    if (failureText) _pip.appendReplyBubble(turnEl).setText(failureText);
  } else if (!currentReply) {
    // Non-streaming path (e.g. backend != bridge) had no deltas — render
    // the full reply once now so the user actually sees it.
    _pip.appendReplyBubble(turnEl).setText(reply);
  }
  // Return "" so pip's setReplyText writes to the hidden default reply
  // — invisible, but it keeps pip's responding-state teardown happy.
  return "";
}

// Re-enter the top layer so bubble+panel stack above a modal dialog that
// just joined the top layer. hide+show in the same task avoids a visible
// flicker. Order matters: panel last so it stacks above the bubble.
function rehoistPip() {
  if (_pip?.bubble.matches(":popover-open")) {
    _pip.bubble.hidePopover();
    _pip.bubble.showPopover();
  }
  if (_pip?.panel.matches(":popover-open")) {
    _pip.panel.hidePopover();
    _pip.panel.showPopover();
  }
}


function watchDialogs() {
  for (const dlg of document.querySelectorAll("dialog")) {
    let wasOpen = dlg.hasAttribute("open");
    new MutationObserver(() => {
      const isOpen = dlg.hasAttribute("open");
      if (isOpen && !wasOpen) rehoistPip();
      wasOpen = isOpen;
    }).observe(dlg, { attributes: true, attributeFilter: ["open"] });
  }
}

export async function initAssistant() {
  // Lazy-load pip-core from the CDN. Awaiting here is what makes the
  // outer try/catch in app.js's DOMContentLoaded actually catch CDN
  // failures — a synchronous static import at module-load would bypass it.
  ({ createPip } = await import(PIP_CDN_URL));
  // Intro fires once per install; subsequent loads stay silent at idle.
  const seenKey = "better-robotics:pip-intro-seen";
  const showIntro = !localStorage.getItem(seenKey);
  // assistant-voice.setDeps must run BEFORE createPip — pip-core fires
  // mic hooks the first time the user clicks the mic, but the config
  // closure captures _turn/_getPip/_injectVoiceMidTurn at that point.
  setVoiceDeps({ turn, getPip: () => _pip, injectVoiceMidTurn });
  _pip = createPip({
    container: document.body,
    ask,
    onSubmit,
    systemPrompt: PIP_SYSTEM,
    historyLimit: HISTORY_LIMIT,
    introText: showIntro ? PIP_INTRO : "",
    introDismissMs: 7000,
    placeholder: "Ask a question…",
    maxLength: 4000,
    // Model identifier surfaces in the input placeholder so the user
    // always knows which backend is live.
    modelLabel: activeModelForBackend(settings.pipBackend),
    // Stop button click — flag the askWithTools loop to abort between
    // iterations AND release any reflex motor-gate so a tool currently
    // awaiting "stop sign clears" unblocks immediately. Without the gate
    // release, Stop would wait up to 10s for the gate's timeout to fire
    // before the loop noticed turn.abort.
    onAbort: () => { turn.cancel(); releaseAllGates(); },
    // Mic config — pip-core mounts the Web Speech button + handles
    // sticky-mode, no-speech retry, etc. We pass hooks for safety-verb
    // instant-fire (onChunk) and mid-turn injection (onFinal).
    mic: makeMicConfig(),
  });
  registerSlashCommands({ pip: _pip, loadConnectGitHub: _loadConnectGitHub });
  if (showIntro) { try { localStorage.setItem(seenKey, "1"); } catch {} }
  // Background-fetch the cached audio for every hardcoded demo phrase
  // on first load (cache hits skip the network entirely on subsequent
  // loads). No-op when no OpenAI key is configured. Runs after pip
  // boots so the user sees the dashboard immediately; finishes within
  // a few seconds, by which time the first demo audio is already
  // staged in Cache API and plays with zero network round-trip.
  prewarmTtsCache(STATIC_DEMO_PHRASES);
  // Inject in-chat ask handler so pip-tools' ask_human can render option
  // buttons / free-text input inline in the active turn.
  //
  // pip-core's askInChat does `host.insertBefore(block, host.querySelector(".pip-reply"))`,
  // intended for single-reply turns. Our per-iteration setup emits multiple
  // `.pip-iter-reply pip-reply` bubbles, so that anchor finds the FIRST
  // reply and shoves the question above it — i.e. at the top of the turn.
  // Wrapping in a trailing empty div with no `.pip-reply` descendants makes
  // pip-core's querySelector return null and `insertBefore(block, null)`
  // fall through to appendChild, landing the question at the bottom of the
  // turn where chat UX expects it. Anchor is removed after the answer
  // resolves so it doesn't leak DOM per ask_human call.
  setAskInChatHandler(({ question, options }) => {
    if (!turn.isActive()) return Promise.resolve(null);
    const anchor = document.createElement("div");
    anchor.className = "pip-ask-anchor";
    turn.el.appendChild(anchor);
    return _pip.askInChat({ question, options }, anchor)
      .finally(() => anchor.remove());
  });
  watchDialogs();
  wireTtsGating();
  wireWatcherFireBridge({ turn, scrollToBottom: () => _pip.scrollToBottom() });
}


