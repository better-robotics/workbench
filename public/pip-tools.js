import { state } from "./state.js";
import { waitOpsResponse } from "./ops-response.js";
import { getLog, getConfig, restartService } from "./capabilities/runtime/command.js";
import { listPhones, sendToPhone, askHuman } from "./phones.js";
import {
  listHelpers, startHelperCamera, stopHelperCamera, takeHelperSnapshot,
} from "./helpers.js";
import { pulseMotors } from "./capabilities/runtime/signed-pair.js";
import {
  getLatestScene as getRobotScene,
  isWatching as isWatchingRobot,
  observeOnce,
  captureFrameDataUrl,
  startWatching,
  stopWatching,
} from "./perception.js";

// Injected from assistant.js so dispatch can render an in-bubble question with
// option buttons (or a free-text input). Without injection we fall back to the
// phone path; ask_human surfaces an error if neither transport is available.
let _askInChat = null;
export function setAskInChatHandler(fn) { _askInChat = fn; }
import { detectOnce, GROUNDING_ENABLED } from "./grounding.js";
import { wrapExecutor, getRecentActions } from "./replay.js";

const ALL_TOOLS = [
  {
    name: "list_robots",
    description: "Returns the dashboard's known robots: id, name, type (pi|esp32), connection status (idle|connecting|connected|error), and whether Bluetooth is currently paired (so you know whether tool calls that need a BLE link will work).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_robot_state",
    description: "Returns full known state for one robot: fwInfo, wifiStatus (incl. ip), telemetry (uptime_s, mem_free_mb, temp_c), robotStatus (rebooting/installing/etc), capability schema. Cheap — uses already-cached BLE notify state, no new BLE write.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Robot id from list_robots" } },
      required: ["id"],
    },
  },
  {
    name: "get_log",
    description: "Fetches recent journalctl lines from a Pi robot via BLE. Use when diagnosing why a service is failing or to confirm what a robot did recently. Pi only — ESP32 has no journal. ~1-2 sec round trip.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Robot id" },
        lines: { type: "number", description: "Number of lines (default 50, cap 200)" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_config",
    description: "Fetches the robot's pi-robot.conf as JSON via BLE. Useful before suggesting pin or capability changes. Pi only.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Robot id" } },
      required: ["id"],
    },
  },
  {
    name: "restart_service",
    description: "Restarts pi-robot.service on a Pi. BLE drops briefly; the service comes back in ~5-10 sec. Use when a soft hang needs clearing or after a config change. The user will be prompted to confirm before the restart fires.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Robot id" } },
      required: ["id"],
    },
  },
  // Phone-awareness tools (webmcp-style). Listing is read-only and idempotent;
  // sending a notice is open-world (there's no "unsend"), so annotated as
  // non-destructive but not idempotent.
  {
    name: "list_phones",
    description: "Returns phones currently paired with this desktop dashboard (WebRTC). Empty list means nobody's on mobile right now. Pip can check this to know if the user can receive a push notice.",
    input_schema: { type: "object", properties: {}, required: [] },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  // Perception: returns the robot's most recent VLM scene description, if the
  // user has enabled "Watch with Pip" on the camera section. No spatial
  // information (VLM can't localize); treat as semantic "I see X" only.
  {
    name: "get_robot_scene",
    description: "Returns the latest VLM scene description for a robot's camera, plus how many seconds ago it was observed. Only works when the user has enabled 'Watch with Pip' on that robot's camera (otherwise returns {watching:false}). VLM is semantic only — it can say 'I see a wall' but NOT where the wall is in the frame. If a specific detail (color, count, small feature) matters to your answer, cross-check it with ask_robot_scene using a neutrally-framed follow-up.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Robot id" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ask_robot_scene",
    description: "Runs ONE on-demand VLM inference on the robot's current camera frame with a question you supply. Use this to cross-examine a fact from get_robot_scene — VLM sometimes hallucinates (especially colors, small counts), and asking a second, NEUTRALLY-framed question often reveals the hallucination. IMPORTANT: prefer open questions over leading ones: 'what color is the wall?' not 'is the wall brown?'; 'how many doors are visible?' not 'are there two doors?'. Leading prompts prime the VLM and get the same confabulation echoed back. Requires Watch to already be on (model loaded); fails otherwise. Each call spends ~1-1.5s of GPU time, so use sparingly — don't cross-check trivia.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Robot id" },
        question: { type: "string", description: "Neutral, open-ended question about the scene." },
      },
      required: ["id", "question"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "send_to_phone",
    description: "Push a short text notice to a paired phone — shows up in place of the last reply on the phone screen. Use sparingly; it interrupts whatever the phone user was reading.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Phone id from list_phones" },
        text: { type: "string", description: "One short sentence, under 200 chars." },
      },
      required: ["id", "text"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "list_helpers",
    description: "Returns the operator's non-mobile observers/operators: paired phones (id 'phone:<phoneId>') and this laptop's webcam (id 'laptop'). Each carries kind, label, status. Use to discover an external viewpoint when the robot has no usable camera, or when a third-party angle would resolve ambiguity.",
    input_schema: { type: "object", properties: {}, required: [] },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "take_helper_snapshot",
    description: "Capture one JPEG frame from a helper's video source. Use when the robot's onboard camera can't see what matters (occluded, wrong angle, no camera at all) but a helper can. Returns { imageDataUrl, width, height } on success. Phones currently can't expose video to the desktop — call only on 'laptop' or future video-capable helpers.",
    input_schema: {
      type: "object",
      properties: {
        helper_id: { type: "string", description: "Helper id from list_helpers ('laptop' or 'phone:<phoneId>')." },
      },
      required: ["helper_id"],
    },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "start_helper_camera",
    description: "Turn on the helper's camera so subsequent take_helper_snapshot calls work. For 'laptop' this prompts the user once for browser camera permission. Idempotent — safe to call when already live.",
    input_schema: {
      type: "object",
      properties: {
        helper_id: { type: "string", description: "Helper id from list_helpers." },
      },
      required: ["helper_id"],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "stop_helper_camera",
    description: "Release the helper's camera. Symmetric with start_helper_camera; idempotent.",
    input_schema: {
      type: "object",
      properties: {
        helper_id: { type: "string", description: "Helper id from list_helpers." },
      },
      required: ["helper_id"],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_robot_detections",
    description: "Runs an open-vocabulary object detector on the robot's current camera frame and returns bounding boxes for the queries you provide. Use this WHENEVER a decision depends on knowing where-in-the-frame something is — get_robot_scene and ask_robot_scene are text-only and do NOT reliably report left/right/near/far. Prefer this over guessing lateral position from scene captions. Returns {label, score, bbox:{x,y,w,h,cx,cy}} per hit, coordinates normalized to [0,1]: x=0 is left edge, x=1 is right edge, y=0 is top, y=1 is bottom. cx/cy is the center of the box — use cx to decide which way to turn (cx<0.45 = left of center, cx>0.55 = right of center). Empty array means nothing matching was found. Queries should be short concrete noun phrases (up to ~5 per call): 'yellow can', 'doorway', 'chair'. ~1-2s per call; first call after page load triggers a one-time model download (~300MB, cached). If the call returns an error, surface the error verbatim — don't attribute it to a specific model name, and note that the detector runs in the user's browser (not on the Pi / robot) so fixes belong on the dashboard side.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Robot id" },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Up to ~5 short concrete noun phrases to locate in the frame.",
        },
      },
      required: ["id", "queries"],
    },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "move_motor",
    description: "Issues a time-bounded motor pulse on the robot: runs motors at (l, r) for duration_ms milliseconds, then firmware auto-stops. THE ONLY way to move the robot from Pip — there is no persistent-motion equivalent in the LLM tool surface (that's reserved for the human's joystick). Arguments: l and r are signed wheel speeds [-100, 100]; firmware clamps LLM-issued magnitude to ±40 and duration to [50, 2000]ms, so anything outside that range is silently capped. Use short, small pulses for exploratory motion and re-observe the scene after — large commits to a direction without re-checking are how the robot gets stuck or collides. Not acknowledged (fire-and-forget); returns { ok, applied:{l,r,duration_ms} } with the actually-sent values or { ok:false, error }.",
    input_schema: {
      type: "object",
      properties: {
        id:          { type: "string", description: "Robot id" },
        l:           { type: "number", description: "Left motor speed [-100, 100]. Firmware-capped to ±40." },
        r:           { type: "number", description: "Right motor speed [-100, 100]. Firmware-capped to ±40." },
        duration_ms: { type: "number", description: "Pulse length in ms. Firmware-capped to [50, 2000]." },
      },
      required: ["id", "l", "r", "duration_ms"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "ask_human",
    description: "Ask the human user a question, blocking until they answer (60s default). Routes to a paired phone if one is available (better UX — they're holding it), otherwise renders the question as buttons inline in the dashboard chat bubble. Preferred over guessing when spatial judgment matters: 'which door should I take?', 'is this the red book you meant?'. Provide 'options' for tappable answers; omit options to get a free-text response. Optionally attach a robot camera frame ('include_robot_camera' + 'robot_id') when the question is visual. Returns {answer, timed_out, via}: answer is the string the user tapped/typed, null on skip/timeout; via is 'phone' or 'chat'.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "One short, specific question. Open-ended wording beats leading wording." },
        options: { type: "array", items: { type: "string" }, description: "Up to ~4 tappable answers. Omit or leave empty for a free-text response." },
        prefer: { type: "string", enum: ["phone", "chat"], description: "Force a transport. Default: phone if paired, chat otherwise." },
        phone_id: { type: "string", description: "Specific phone id from list_phones. Default: first paired phone." },
        include_robot_camera: { type: "boolean", description: "Attach the robot's current camera frame (phone transport only). Default false." },
        robot_id: { type: "string", description: "Robot whose camera to capture. Required when include_robot_camera is true." },
      },
      required: ["question"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "start_live_scene",
    description: "Turn on continuous in-browser VLM observation of a robot's camera. Once on, frames get a one-sentence scene description every few seconds. Use when ongoing situational awareness matters across several upcoming reasoning steps. Cheap to leave on briefly; stop with stop_live_scene when no longer earning the CPU cost.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Robot id from list_robots." } },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "stop_live_scene",
    description: "Turn off continuous VLM observation for a robot. Idempotent — safe to call when not running.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Robot id from list_robots." } },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_recent_actions",
    description: "Recall the last N tool calls this session made. Use when the user asks 'what did you just try' or when you need to avoid repeating something that failed.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "How many recent actions to return (default 5, max 50).", default: 5 },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  },
];

// Hide disabled tools from Pip so it doesn't waste tokens proposing calls
// that would fail. Keeping the executor case below (unreachable when the
// tool isn't advertised) means re-enabling is a single flag flip in
// grounding.js, not a re-plumb.
export const TOOLS = ALL_TOOLS.filter(t => {
  if (t.name === "get_robot_detections" && !GROUNDING_ENABLED) return false;
  return true;
});

async function dispatch(name, input) {
  switch (name) {
    case "list_robots": {
      const out = [];
      for (const e of state.devices.values()) {
        out.push({
          id: e.id, name: e.name, type: e.fwType ?? null,
          status: e.status, paired: !!e.device,
        });
      }
      return out;
    }
    case "get_robot_state": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      return {
        id: e.id, name: e.name, type: e.fwType ?? null,
        status: e.status,
        fwInfo: e.fwInfo ?? null,
        wifiStatus: e.wifiStatus ?? null,
        telemetry: e.telemetry ?? null,
        robotStatus: e.robotStatus ?? null,
        capSchema: e.capSchema ?? null,
      };
    }
    case "get_log": {
      const id = input.id;
      const lines = Math.min(Math.max(input.lines || 50, 1), 200);
      const e = state.devices.get(id);
      if (!e) return { error: `no robot with id ${id}` };
      if (!e.opsChar) return { error: "robot doesn't expose the ops channel" };
      const wait = waitOpsResponse("get-log", id, 15000);
      await getLog(id, lines);
      try {
        const msg = await wait;
        return { text: msg.text || "", unit: msg.unit || "pi-robot" };
      } catch (err) {
        return { error: err.message };
      }
    }
    case "get_config": {
      const id = input.id;
      const e = state.devices.get(id);
      if (!e) return { error: `no robot with id ${id}` };
      if (!e.opsChar) return { error: "robot doesn't expose the ops channel" };
      const wait = waitOpsResponse("get-config", id, 10000);
      await getConfig(id);
      try {
        const msg = await wait;
        if (msg.err) return { error: msg.err };
        return { config: msg.text };
      } catch (err) {
        return { error: err.message };
      }
    }
    case "restart_service": {
      const id = input.id;
      const e = state.devices.get(id);
      if (!e) return { error: `no robot with id ${id}` };
      if (!e.opsChar) return { error: "robot doesn't expose the ops channel" };
      // restartService internally calls window.confirm() — kept as-is so an
      // LLM hallucination can't restart a robot without explicit user assent.
      await restartService(id);
      return { ok: true, note: "restart requested (subject to user confirm)" };
    }
    case "list_phones": {
      return listPhones();
    }
    case "get_robot_scene": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      if (!isWatchingRobot(input.id)) return { watching: false };
      const scene = getRobotScene(input.id);
      if (!scene) return { watching: true, text: null };
      return {
        watching: true,
        text: scene.text,
        observed_seconds_ago: Math.round((Date.now() - scene.at) / 1000),
      };
    }
    case "ask_robot_scene": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      if (!isWatchingRobot(input.id)) {
        return { error: "Watch isn't on for this robot — user needs to enable it first (camera card)" };
      }
      const q = String(input.question || "").trim();
      if (!q) return { error: "question is required" };
      try {
        const text = await observeOnce(e, q);
        return { text: text || null };
      } catch (err) {
        return { error: err.message || String(err) };
      }
    }
    case "send_to_phone": {
      const text = String(input.text || "").slice(0, 300);
      const ok = sendToPhone(input.id, text);
      return ok ? { ok: true } : { error: `no phone with id ${input.id}` };
    }
    case "list_helpers": {
      return listHelpers();
    }
    case "take_helper_snapshot": {
      const id = String(input.helper_id || "");
      if (!id) return { error: "helper_id is required" };
      return takeHelperSnapshot(id);
    }
    case "start_helper_camera": {
      const id = String(input.helper_id || "");
      if (!id) return { error: "helper_id is required" };
      return await startHelperCamera(id);
    }
    case "stop_helper_camera": {
      const id = String(input.helper_id || "");
      if (!id) return { error: "helper_id is required" };
      return await stopHelperCamera(id);
    }
    case "get_robot_detections": {
      const entry = state.devices.get(input.id);
      if (!entry) return { error: `no robot with id ${input.id}` };
      if (!isWatchingRobot(input.id)) {
        return { error: "Watch isn't on for this robot — user needs to enable it first so the camera feed is live" };
      }
      const queries = Array.isArray(input.queries) ? input.queries.map(String).slice(0, 5) : [];
      if (queries.length === 0) return { error: "queries is required (up to 5 short noun phrases)" };
      try {
        const detections = await detectOnce(entry, queries);
        if (detections === null) return { error: "couldn't capture a frame — camera element missing or CORS-tainted" };
        return { detections };
      } catch (err) {
        return { error: `detector failed: ${String(err.message || err)}` };
      }
    }
    case "move_motor": {
      return await pulseMotors(input.id, input.l, input.r, input.duration_ms);
    }
    case "ask_human": {
      const question = String(input.question || "").trim();
      if (!question) return { error: "question is required" };
      const options = Array.isArray(input.options) ? input.options.map(String).slice(0, 8) : [];

      const phones = listPhones();
      const phoneId = input.phone_id || phones[0]?.id || null;
      const prefer = input.prefer || (phoneId ? "phone" : "chat");

      if (prefer === "phone" && phoneId) {
        let imageDataUrl = null;
        if (input.include_robot_camera) {
          if (!input.robot_id) return { error: "robot_id required for include_robot_camera" };
          const entry = state.devices.get(input.robot_id);
          if (!entry) return { error: `no robot with id ${input.robot_id}` };
          imageDataUrl = captureFrameDataUrl(entry);
          if (!imageDataUrl) return { error: "couldn't capture a frame — feed not started or CORS-tainted" };
        }
        try {
          const r = await askHuman(phoneId, { question, options, imageDataUrl });
          return { ...r, via: "phone" };
        } catch (err) {
          // Phone path failed — try chat fallback before giving up.
          if (!_askInChat) return { error: String(err.message || err), via: "phone" };
        }
      }
      if (!_askInChat) return { error: "no transport available (no phone paired and chat bubble not initialized)" };
      try {
        const answer = await _askInChat({ question, options });
        return { answer, timed_out: false, via: "chat" };
      } catch (err) {
        return { error: String(err.message || err), via: "chat" };
      }
    }
    case "start_live_scene": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      if (isWatchingRobot(input.id)) return { ok: true, already_watching: true };
      try {
        // Mirror the cap's toggle so the next renderEntry shows the checkbox
        // checked. Cap reads entry.cameraWatching (capName + "Watching").
        e.cameraWatching = true;
        await startWatching(e);
        return { ok: true };
      } catch (err) {
        e.cameraWatching = false;
        return { error: String(err.message || err) };
      }
    }
    case "stop_live_scene": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      stopWatching(input.id);
      e.cameraWatching = false;
      return { ok: true };
    }
    case "get_recent_actions": {
      const limit = Math.min(Math.max(Number(input?.limit) || 5, 1), 50);
      const session = (typeof window !== "undefined") ? window.replaySession : null;
      if (!session) return { error: "replay session id unavailable" };
      const recs = await getRecentActions(session, limit);
      return { text: formatRecentActions(recs) };
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

function formatRecentActions(recs) {
  if (!recs || recs.length === 0) return "0 recent actions.";
  const lines = recs.map((r) => {
    const status = r.error ? `err: ${truncate(String(r.error), 80)}` : "ok";
    const dur = r.durationMs == null ? "?" : `${r.durationMs}ms`;
    const head = `- ${r.name} (${status}, ${dur})`;
    const inStr = compactJson(r.input);
    const outStr = r.error ? "" : compactJson(r.output);
    const tail = outStr ? `${inStr} -> ${outStr}` : inStr;
    return `${head}: ${tail}`;
  });
  return `${recs.length} recent actions (newest first):\n${lines.join("\n")}`;
}

function compactJson(v) {
  if (v === undefined) return "";
  try {
    const s = JSON.stringify(v);
    return truncate(s ?? "", 300);
  } catch {
    return truncate(String(v), 300);
  }
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export const executor = wrapExecutor(dispatch);
