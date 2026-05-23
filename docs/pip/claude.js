// Pip backend dispatch — picks how to reach the LLM based on user setting:
//   github    — GitHub Models inference (default; OAuth via neevs.io,
//               OpenAI-compatible request shape, no API key to manage).
//   bridge    — AI Bridge localhost proxy at 127.0.0.1:7337 (Keychain-backed
//               creds, token never visible to the page). Requires the proxy
//               launchd agent (`make install-proxy` in ai-bridge).
//   anthropic — direct fetch() to api.anthropic.com using the user's API key
//               from settings. Browser-stored, "user's responsibility" model.
//   openai    — direct fetch() to api.openai.com (chat/completions, function-
//               calling). Different protocol from Anthropic; translated below.
import { settings } from "../settings.js";

const BRIDGE_PROXY_URL = "http://127.0.0.1:7337";

// Claude variants available on the bridge + anthropic backends. Short aliases
// are what the user types into `/model`; the id is what goes on the wire.
export const CLAUDE_VARIANTS = [
  { alias: "opus",   id: "claude-opus-4-7" },
  { alias: "sonnet", id: "claude-sonnet-4-6" },
  { alias: "haiku",  id: "claude-haiku-4-5-20251001" },
];
const CLAUDE_DEFAULT = "claude-sonnet-4-6";
const CLAUDE_IDS = new Set(CLAUDE_VARIANTS.map(v => v.id));

function currentClaudeModel() {
  const id = settings.pipClaudeModel;
  return CLAUDE_IDS.has(id) ? id : CLAUDE_DEFAULT;
}

// API-shape partition. CLAUDE_BACKENDS speak the Anthropic messages API
// (used directly, or proxied through ai-bridge); OPENAI_SHAPED_BACKENDS
// speak /chat/completions (OpenAI direct + GitHub Models). Centralizing
// the predicate stops the `=== "bridge" || === "anthropic"` ladder from
// drifting between call sites. Note: do NOT alias this to "supports
// vision" or "supports tool_result images" — those happen to coincide
// today but are separate facts (see pip-tools.js's VISION_BACKENDS).
export const CLAUDE_BACKENDS = new Set(["bridge", "anthropic"]);
export const OPENAI_SHAPED_BACKENDS = new Set(["openai", "github"]);

// User-facing model identifier per backend. Single source of truth for
// what name shows up in the Pip placeholder ("Ask Pip… · gpt-4o-mini")
// and in any future model picker. Keeps display logic out of assistant.js
// — model knowledge lives next to the actual API calls.
export function activeModelForBackend(backend) {
  if (CLAUDE_BACKENDS.has(backend)) return currentClaudeModel();
  if (OPENAI_SHAPED_BACKENDS.has(backend)) return "gpt-4o-mini";
  if (backend === "local") {
    const id = settings.pipLocalModel || "onnx-community/gemma-4-E2B-it-ONNX";
    const tail = (settings.pipLocalDtype || "q4f16");
    return `${id.split("/").pop().replace(/-ONNX$/i, "")} · ${tail}`;
  }
  return backend;
}
// Per-Claude-call ceiling. Tool-using conversations make several requests in
// series; 20s covers typical Anthropic response time with headroom for slow
// networks and first-request cold-start.
const TIMEOUT_MS = 20000;

// Streams a Claude /v1/messages request through the localhost proxy.
// Returns a parsed-response shape — { status, content, stop_reason } —
// identical to JSON.parse(non-stream-body), plus emits onTextDelta(fullText)
// as text_delta events arrive. Falls back to { status, body } on HTTP error
// and { status: 0, error } on network failure so the caller's existing
// branches still match. Anthropic SSE format reference:
// docs.anthropic.com/en/docs/build-with-claude/streaming
async function streamAnthropicViaProxy(body, onTextDelta) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(BRIDGE_PROXY_URL + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "text/event-stream" },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") return null;
    return { status: 0, error: err.message || String(err) };
  }
  if (!resp.ok) {
    clearTimeout(timer);
    const text = await resp.text().catch(() => "");
    return { status: resp.status, body: text };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const content = [];
  let stopReason = null;
  let textSoFar = "";  // cumulative text across every text block in this call

  const handleEvent = (eventType, data) => {
    if (eventType === "content_block_start") {
      const block = { ...data.content_block };
      if (block.type === "text") block.text = "";
      // Anthropic streams tool input as a JSON string in deltas; accumulate
      // raw, parse at content_block_stop.
      if (block.type === "tool_use") block._rawInput = "";
      content[data.index] = block;
    } else if (eventType === "content_block_delta") {
      const block = content[data.index];
      if (!block) return;
      if (data.delta?.type === "text_delta") {
        block.text += data.delta.text;
        textSoFar += data.delta.text;
        onTextDelta?.(textSoFar);
      } else if (data.delta?.type === "input_json_delta") {
        block._rawInput += data.delta.partial_json;
      }
    } else if (eventType === "content_block_stop") {
      const block = content[data.index];
      if (block?.type === "tool_use") {
        try { block.input = JSON.parse(block._rawInput || "{}"); }
        catch { block.input = {}; }
        delete block._rawInput;
      }
    } else if (eventType === "message_delta") {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let eventType = null, data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trimStart();
        }
        if (!data) continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        handleEvent(eventType, parsed);
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return null;
    return { status: 0, error: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }

  return { status: 200, content: content.filter(Boolean), stop_reason: stopReason };
}

// Talks to the AI Bridge localhost proxy. The proxy injects the OAuth token
// and Claude-Max billing header; we just send the bare messages body. Returns
// the same {status, body} | null shape the rest of this file already consumes.
async function bridgeRequest({ path, method, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(BRIDGE_PROXY_URL + path, {
      method: method || "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return { status: resp.status, body: await resp.text() };
  } catch (err) {
    if (err.name === "AbortError") return null;
    return { status: 0, error: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Direct Anthropic API call. Returns the same {status, body} shape bridgeRequest
// uses so the rest of this file doesn't care which transport ran.
// `anthropic-dangerous-direct-browser-access` is required by Anthropic's CORS
// policy to allow fetch() from a browser origin (vs a server). Name is
// intentionally alarming because the alternative — a backend proxy — is the
// industry default for hiding keys; we accept the trade-off because the key
// stays on the user's machine and never crosses our infrastructure.
async function anthropicDirectRequest(body) {
  const key = settings.pipApiKey;
  if (!key) return { status: 401, body: '{"error":"no API key configured in Settings"}' };
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.text() };
  } catch (err) {
    return { status: 0, error: err.message || String(err) };
  }
}

async function callAnthropic(body) {
  if (settings.pipBackend === "anthropic") return anthropicDirectRequest(body);
  return bridgeRequest({ path: "/v1/messages", method: "POST", body });
}

// OpenAI-compatible chat-completions request. Used by two backends:
//   - "openai":  api.openai.com (user's key)
//   - "github":  models.github.ai/inference (GitHub OAuth token; vendor-
//                prefixed model id like "openai/gpt-4o-mini")
// Body shape is identical, only URL + auth + model id differ.
const OPENAI_MODEL = "gpt-4o-mini";        // cheap default for direct OpenAI
const GITHUB_MODEL = "openai/gpt-4o-mini"; // GitHub Models requires vendor prefix
async function callOpenai(body) {
  // GitHub Models requires the vendor-prefixed model id, so override body.model
  // when calling them.
  const isGithub = settings.pipBackend === "github";
  let url, token;
  if (isGithub) {
    const auth = settings.githubAuth;
    if (!auth?.token) return { status: 401, body: '{"error":"GitHub not signed in — open Settings and Sign in with GitHub"}' };
    url = "https://models.github.ai/inference/chat/completions";
    token = auth.token;
    body = { ...body, model: GITHUB_MODEL };  // override regardless of caller default
  } else {
    const key = settings.pipOpenaiKey;
    if (!key) return { status: 401, body: '{"error":"no OpenAI API key configured in Settings"}' };
    url = "https://api.openai.com/v1/chat/completions";
    token = key;
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.text() };
  } catch (err) {
    return { status: 0, error: err.message || String(err) };
  }
}

// Anthropic tool spec → OpenAI function spec. Anthropic uses
// {name, description, input_schema}; OpenAI wraps as
// {type:"function", function:{name, description, parameters}}.
// Both use JSON Schema for the parameters object so the schema body itself
// transfers verbatim — only the wrapper differs.
function anthropicToolToOpenai(t) {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } };
}

// Anthropic's messages API rejects tool entries with unknown keys (annotations,
// etc). pip-tools.js carries webmcp-style annotations on some tool defs for
// documentation + future external MCP exposure; strip to the API-allowed shape
// before every request so extra metadata doesn't fail the call.
const TOOL_API_FIELDS = ["name", "description", "input_schema", "cache_control"];
function sanitizeTool(t) {
  const out = {};
  for (const k of TOOL_API_FIELDS) if (k in t) out[k] = t[k];
  return out;
}

// Prompt caching: mark stable prefix blocks (system prompt + tool schema)
// with cache_control so Anthropic bills cached reads at ~10% of the base
// input rate (5-minute TTL, refreshed on each cache-hit). System + tools
// are ~3000 tokens and stable across iterations of a turn, so this is the
// highest-leverage cache. A cache_control marker caches everything up to
// and including that block — one on the last tool covers all tools, one
// on the last system block covers the system prompt. Max 4 breakpoints
// per request; we use 2.
//
// Tested 2026-05: Claude Max OAuth tokens (the bridge backend's default)
// silently IGNORE cache_control — confirmed via /v1/messages with 3000+
// token system prompts returning usage.cache_creation_input_tokens: 0
// even with the prompt-caching-2024-07-31 beta header. Prompt caching is
// gated to API-key tier. The marker is left in place because (a) it's a
// no-op on tiers that don't honor it, (b) the anthropic-direct backend
// (own API key) DOES get the discount, (c) any future Claude Max policy
// change makes it active immediately. Reference:
// docs.anthropic.com/en/docs/build-with-claude/prompt-caching
function withPromptCache(body) {
  const out = { ...body };
  if (typeof out.system === "string" && out.system.length > 0) {
    out.system = [{ type: "text", text: out.system, cache_control: { type: "ephemeral" } }];
  } else if (Array.isArray(out.system) && out.system.length > 0) {
    const last = out.system[out.system.length - 1];
    if (last && !last.cache_control) last.cache_control = { type: "ephemeral" };
  }
  if (Array.isArray(out.tools) && out.tools.length > 0) {
    const lastIdx = out.tools.length - 1;
    out.tools = out.tools.map((t, i) =>
      i === lastIdx && !t.cache_control
        ? { ...t, cache_control: { type: "ephemeral" } }
        : t
    );
  }
  return out;
}

// Logged after retry exhausted — null/error/non-2xx all mean we won't get
// useful content back. Names the active backend so the message points at the
// right thing to investigate.
function logBackendError(label, res) {
  const b = settings.pipBackend || "github";
  const which = b === "anthropic" ? "anthropic-direct"
              : b === "openai"    ? "openai-direct"
              : b === "github"    ? "github-models"
              :                     "bridge";
  if (!res)           console.info(`[claude/${which}] ${label}: unreachable`);
  else if (res.error) console.warn(`[claude/${which}] ${label}: ${res.error}`);
  else                console.warn(`[claude/${which}] ${label}: HTTP ${res.status}`, res.body?.slice?.(0, 500) ?? res.body);
}

export async function ask(userText, opts = {}) {
  if (settings.pipBackend === "local")
    return _localAsk(userText, opts);
  if (OPENAI_SHAPED_BACKENDS.has(settings.pipBackend))
    return _openaiAsk(userText, opts);
  return _anthropicAsk(userText, opts);
}

// Single-shot Claude call that includes an image — for demos / hosts
// that need a short LLM observation about a frame without going through
// the full askWithTools tool-loop. Image is sent as a base64 content
// block alongside the prompt. Returns the response text, or null on
// any failure. Bridge backend only (the path that proxies through
// 127.0.0.1:7337); falls through to null on github/openai backends
// since they don't share the same vision content-block protocol.
export async function askAboutFrame(imageDataUrl, prompt, { maxTokens = 100, system } = {}) {
  if (!CLAUDE_BACKENDS.has(settings.pipBackend)) return null;
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(imageDataUrl || "");
  if (!m) return null;
  const body = withPromptCache({
    model: currentClaudeModel(),
    max_tokens: maxTokens,
    system,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } },
        { type: "text", text: String(prompt || "Describe this image in one short sentence.") },
      ],
    }],
    stream: false,
  });
  const res = await callAnthropic(body);
  if (!res || res.error) { logBackendError("askAboutFrame", res); return null; }
  if (res.status < 200 || res.status >= 300) { logBackendError("askAboutFrame", res); return null; }
  try {
    const json = JSON.parse(res.body);
    return json?.content?.[0]?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

// In-browser local model via pip-core's `local()` runtime provider —
// transformers.js + WebGPU under the hood, with the system-prompt
// augmentation, message flattening, and <tool_call> streaming parser
// all living in pip-core (3.8+). Lazy-imported on first use so a user
// staying on github/anthropic/openai never pays the ~hundreds of KB
// pip-local bundle.
//
// The provider's event protocol is { text_delta, tool_use, turn_end }
// with stopReason — the same conceptual shape Anthropic's tool-use
// loop expects, just streamed instead of returned in a content array.
// _localAskWithTools below runs the loop against that event stream
// using the same executor + onTool* callbacks as _anthropicAskWithTools.
//
// Gemma 4 sampling: temperature 1.0, top_k 64, top_p 0.95, no
// repetition_penalty — Google's documented standards. chatTemplate
// suppresses <|channel>thought</|channel> leaks.
const LOCAL_PROVIDER_URL = "https://cdn.jsdelivr.net/npm/@nevescloud/pip@latest/providers/local.esm.js";
let _localProvider = null;
let _localProviderKey = null;
async function loadLocalProvider() {
  const id = settings.pipLocalModel || "onnx-community/gemma-4-E2B-it-ONNX";
  const dtype = settings.pipLocalDtype || "q4f16";
  const key = `${id}:${dtype}`;
  if (_localProvider && _localProviderKey === key) return _localProvider;
  const mod = await import(LOCAL_PROVIDER_URL);
  _localProvider = mod.local({
    model: id,
    dtype,
    maxTokens: 1024,
    genParams: { temperature: 1.0, top_p: 0.95, top_k: 64 },
    chatTemplate: { enable_thinking: false },
  });
  _localProviderKey = key;
  return _localProvider;
}

async function _localAsk(userText, { system, onDelta, signal } = {}) {
  let provider;
  try { provider = await loadLocalProvider(); }
  catch (err) { console.warn("[claude/local] provider load failed:", err); return null; }
  const stream = provider({
    messages: [{ role: "user", content: userText }],
    system, signal, turnEl: null,
  });
  let text = "";
  try {
    for await (const ev of stream) {
      // onDelta contract here matches streamAnthropicViaProxy's: pass the
      // FULL text so far (callers replace the bubble each tick rather
      // than diff/append). Sending just ev.text would have the host
      // repaint with each chunk in isolation.
      if (ev.type === "text_delta") { text += ev.text; onDelta?.(text); }
    }
  } catch (err) {
    if (err?.name === "AbortError") return null;
    console.warn("[claude/local] generate failed:", err);
    return null;
  }
  return text.trim() || null;
}

// Wrap one tool dispatch in the onToolStart/onToolEnd hook lifecycle
// + try/catch shape that all three providers share. Returns
// { result, error } — error is a string when the executor threw,
// null otherwise. Providers stay responsible for packing the result
// into provider-specific tool_result content.
async function callToolWithHooks(executor, name, input, onToolStart, onToolEnd) {
  const startedAt = performance.now();
  onToolStart?.({ name, input });
  try {
    const result = await executor(name, input);
    onToolEnd?.({ name, input, result, error: null, durationMs: performance.now() - startedAt });
    return { result, error: null };
  } catch (err) {
    const error = String(err.message || err);
    onToolEnd?.({ name, input, result: null, error, durationMs: performance.now() - startedAt });
    return { result: null, error };
  }
}

// Tool-using loop against pip-core 3.8's local provider event stream.
// Mirrors _anthropicAskWithTools' shape: same executor callback, same
// onToolStart/onToolEnd hooks, same shouldAbort/onMaxIterations gates,
// same priorText accumulation across iterations. The provider handles
// the <tool_call> prompt-augmentation + parsing internally — we just
// consume tool_use events and feed tool_result blocks back.
async function _localAskWithTools(messages, { system, tools, executor, maxIterations = 10, onToolStart, onToolEnd, shouldAbort, onMaxIterations, onDelta } = {}) {
  let provider;
  try { provider = await loadLocalProvider(); }
  catch (err) { console.warn("[claude/local] provider load failed:", err); return null; }

  const convo = [...messages];
  let priorText = "";
  let budget = maxIterations;
  while (budget > 0) {
    if (shouldAbort?.()) return "(stopped)";
    budget--;

    // Per-iteration AbortController so a mid-stream Stop click (shouldAbort
    // flipping true while tokens are arriving) actually halts the
    // transformers.js generate loop — the runtime won't notice
    // shouldAbort() between events on its own, and a single Gemma 4
    // turn at q4f16 can run 5-10s.
    const iterAbort = new AbortController();
    const stream = provider({ messages: convo, system, tools, turnEl: null, signal: iterAbort.signal });
    const assistantContent = [];
    let iterText = "";
    let stopReason = "end_turn";

    try {
      for await (const ev of stream) {
        if (shouldAbort?.()) { iterAbort.abort(); return "(stopped)"; }
        if (ev.type === "text_delta") {
          iterText += ev.text;
          // Pass the iteration's cumulative text — matches
          // streamAnthropicViaProxy's contract (callers replace the
          // bubble per tick, not append).
          onDelta?.(iterText);
        } else if (ev.type === "tool_use") {
          // Flush any text that preceded this tool call into the content
          // array so the assistant turn preserves arrival order.
          if (iterText) { assistantContent.push({ type: "text", text: iterText }); iterText = ""; }
          assistantContent.push({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
        } else if (ev.type === "turn_end") {
          stopReason = ev.stopReason || "end_turn";
        }
      }
    } catch (err) {
      if (err?.name === "AbortError") return "(stopped)";
      console.warn("[claude/local] iteration failed:", err);
      return null;
    }
    if (iterText) assistantContent.push({ type: "text", text: iterText });

    convo.push({ role: "assistant", content: assistantContent });
    const iterReply = assistantContent.filter(b => b.type === "text").map(b => b.text).join("\n");
    if (stopReason !== "tool_use") return (priorText + iterReply).trim();
    if (iterReply) priorText += iterReply + "\n";

    const toolUses = assistantContent.filter(b => b.type === "tool_use");
    const toolResults = [];
    for (const tu of toolUses) {
      const { result: out, error } = await callToolWithHooks(executor, tu.name, tu.input, onToolStart, onToolEnd);
      if (error) {
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, name: tu.name, content: `Error: ${error}`, is_error: true });
      } else {
        // local provider can't render image blocks; flatten _pipContent to JSON.
        const content = (out && out._pipContent)
          ? JSON.stringify(out._pipContent)
          : (typeof out === "string" ? out : JSON.stringify(out));
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, name: tu.name, content });
      }
    }
    convo.push({ role: "user", content: toolResults });

    if (budget === 0) {
      const grant = await (onMaxIterations?.() || 0);
      if (grant > 0) budget = grant;
    }
  }
  return (priorText + "(reached iteration limit)").trim();
}

async function _anthropicAsk(userText, { system, maxTokens = 200 } = {}) {
  const res = await callAnthropic(withPromptCache({
    model: currentClaudeModel(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userText }],
    stream: false,
  }));
  if (!res || res.error) { logBackendError("ask", res); return null; }
  if (res.status < 200 || res.status >= 300) { logBackendError("ask", res); return null; }
  try {
    const json = JSON.parse(res.body);
    // "" is distinct from null — empty means Pip chose silence; null means the call failed.
    return json?.content?.[0]?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

async function _openaiAsk(userText, { system, maxTokens = 200 } = {}) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: userText });
  const res = await callOpenai({
    model: OPENAI_MODEL,
    max_tokens: maxTokens,
    messages,
    stream: false,
  });
  if (!res || res.error) { logBackendError("ask", res); return null; }
  if (res.status < 200 || res.status >= 300) { logBackendError("ask", res); return null; }
  try {
    const json = JSON.parse(res.body);
    return json?.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

// Multi-turn loop that handles Anthropic's tool-use protocol. Sends `messages`
// + `tools`, executes any tool_use blocks via the caller-provided executor,
// loops until Claude returns a text-only reply (stop_reason !== "tool_use") or
// we hit maxIterations. Returns the final text, "" if Claude chose silence,
// or null on transport failure.
//
// Optional hooks for live UI tracing:
//   onToolStart({ name, input })           — fires before each tool dispatch
//   onToolEnd({ name, input, result, error, durationMs }) — after, with outcome
//   shouldAbort() → boolean                — checked between iterations; true
//                                             returns the aborted sentinel
//                                             "(stopped)" so the caller can
//                                             render it as a final reply
//   onMaxIterations() → Promise<number>    — when the iteration budget runs
//                                             out, caller decides whether to
//                                             extend it. Return N>0 to grant
//                                             N more iterations; 0/false to
//                                             stop and return the canned
//                                             "(reached iteration limit)".
export async function askWithTools(messages, opts = {}) {
  if (settings.pipBackend === "local")
    return _localAskWithTools(messages, opts);
  if (OPENAI_SHAPED_BACKENDS.has(settings.pipBackend))
    return _openaiAskWithTools(messages, opts);
  return _anthropicAskWithTools(messages, opts);
}

async function _anthropicAskWithTools(messages, { system, tools, executor, maxIterations = 10, maxTokens = 1024, onToolStart, onToolEnd, shouldAbort, onMaxIterations, onDelta, getPendingObservations } = {}) {
  const convo = [...messages];
  let i = 0;
  let budget = maxIterations;
  // Cumulative text across iterations so the bubble keeps growing through
  // multi-step tool conversations rather than resetting per iteration.
  let priorText = "";
  // Streaming only on the bridge backend — anthropic-direct path stays
  // buffered for now (direct fetch doesn't use this transport).
  const canStream = onDelta && settings.pipBackend === "bridge";
  while (i < budget) {
    if (shouldAbort?.()) return "(stopped)";
    const body = withPromptCache({
      model: currentClaudeModel(),
      max_tokens: maxTokens,
      system,
      messages: convo,
      tools: tools?.map(sanitizeTool),
    });
    let result;
    if (canStream) {
      // Per-iteration delta. The host renders each iteration as its own
      // inline reply element interleaved with tool pills, so it doesn't
      // need (and would mis-render) the cumulative-across-iterations
      // string we used to send.
      result = await streamAnthropicViaProxy(body, onDelta);
    } else {
      const res = await callAnthropic({ ...body, stream: false });
      if (!res || res.error) { logBackendError("askWithTools", res); return null; }
      if (res.status < 200 || res.status >= 300) { logBackendError("askWithTools", res); return null; }
      try { result = JSON.parse(res.body); result.status = 200; }
      catch (err) { console.warn("[claude] askWithTools: malformed JSON body", err); return null; }
    }
    if (!result || result.error) { logBackendError("askWithTools", result); return null; }
    if (result.status < 200 || result.status >= 300) { logBackendError("askWithTools", result); return null; }

    convo.push({ role: "assistant", content: result.content });

    const iterText = (result.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");

    if (result.stop_reason !== "tool_use") {
      return (priorText + iterText).trim();  // may be "" — caller decides what to do with silence
    }
    // Tool-use iteration: bank any text Claude said before the tool call so
    // the next iteration's stream continues from where this one left off.
    if (iterText) priorText += iterText + "\n";

    // Execute each tool_use block; pack all results into one user turn.
    const toolUses = result.content.filter(b => b.type === "tool_use");
    const toolResults = [];
    for (const tu of toolUses) {
      const { result: toolOut, error } = await callToolWithHooks(executor, tu.name, tu.input, onToolStart, onToolEnd);
      if (error) {
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ error }), is_error: true });
      } else {
        // _pipContent sentinel — micro-protocol any executor can use.
        // Default: executor returns a JS object, we JSON-stringify it.
        // Opt-in: executor returns { _pipContent: [...blocks] } where
        // blocks follow Anthropic's tool_result content shape (text +
        // image). view_robot_frame uses this so Claude's next turn
        // sees pixels, not base64.
        const content = (toolOut && toolOut._pipContent)
          ? toolOut._pipContent
          : JSON.stringify(toolOut);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content });
      }
    }
    // Drain any host-queued out-of-band observations (e.g. reflex-watcher
    // fire events that fired mid-turn) into the same user-role message
    // as the tool_results. Appending as a text block alongside the
    // tool_result blocks keeps role-alternation valid (Anthropic requires
    // user/assistant ping-pong; two user messages in a row errors).
    const obs = getPendingObservations?.();
    const content = (Array.isArray(obs) && obs.length)
      ? [...toolResults, { type: "text", text: obs.join("\n\n") }]
      : toolResults;
    convo.push({ role: "user", content });
    i++;
    if (i >= budget && onMaxIterations) {
      const more = await onMaxIterations();
      if (typeof more === "number" && more > 0) budget += more;
    }
  }
  return "(reached iteration limit)";
}

// OpenAI tool-use loop. Different protocol from Anthropic:
// - system inside messages as {role:"system"}
// - tools wrapped as {type:"function", function:{...}}
// - finish_reason === "tool_calls" instead of stop_reason === "tool_use"
// - tool calls live on assistant.message.tool_calls; arguments is a JSON STRING
// - tool results sent back as {role:"tool", tool_call_id, content}
//
// arguments-as-string requires JSON.parse. Parse failures surface as a
// tool_result instead of crashing the loop.
async function _openaiAskWithTools(messages, { system, tools, executor, maxIterations = 10, maxTokens = 1024, onToolStart, onToolEnd, shouldAbort, onMaxIterations } = {}) {
  const convo = [];
  if (system) convo.push({ role: "system", content: system });
  for (const m of messages) convo.push({ role: m.role, content: m.content });

  let i = 0;
  let budget = maxIterations;
  while (i < budget) {
    if (shouldAbort?.()) return "(stopped)";
    const res = await callOpenai({
      model: OPENAI_MODEL,
      max_tokens: maxTokens,
      messages: convo,
      tools: tools?.map(anthropicToolToOpenai),
      tool_choice: tools?.length ? "auto" : undefined,
      stream: false,
    });
    if (!res || res.error) { logBackendError("askWithTools", res); return null; }
    if (res.status < 200 || res.status >= 300) { logBackendError("askWithTools", res); return null; }
    let json;
    try { json = JSON.parse(res.body); }
    catch (err) { console.warn("[claude/openai] askWithTools: malformed JSON body", err); return null; }

    const choice = json?.choices?.[0];
    const msg = choice?.message;
    if (!msg) { logBackendError("askWithTools", res); return null; }

    // Push assistant's response into the convo VERBATIM — OpenAI requires
    // the same message object back when feeding tool_results, so we can't
    // reshape it.
    convo.push(msg);

    if (choice.finish_reason !== "tool_calls" || !msg.tool_calls?.length) {
      return (msg.content || "").trim();  // "" is silence, same convention as Anthropic
    }

    for (const tc of msg.tool_calls) {
      const name = tc.function?.name;
      let input;
      try { input = JSON.parse(tc.function?.arguments || "{}"); }
      catch (err) { input = { _parseError: String(err.message || err), raw: tc.function?.arguments }; }
      const { result, error } = await callToolWithHooks(executor, name, input, onToolStart, onToolEnd);
      // OpenAI tool role can't render image blocks; flatten _pipContent
      // to JSON the same way the local provider does, so a tool that
      // emits the sentinel (view_robot_frame) doesn't end up serializing
      // base64 into the tool message body.
      const content = error
        ? JSON.stringify({ error })
        : (result && result._pipContent)
          ? JSON.stringify(result._pipContent)
          : JSON.stringify(result);
      convo.push({ role: "tool", tool_call_id: tc.id, content });
    }
    i++;
    if (i >= budget && onMaxIterations) {
      const more = await onMaxIterations();
      if (typeof more === "number" && more > 0) budget += more;
    }
  }
  return "(reached iteration limit)";
}
