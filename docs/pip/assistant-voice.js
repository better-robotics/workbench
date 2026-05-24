import { tryMatchCommand, SAFETY_INTENTS } from "./voice-commands.js";
import { onSpeakingChange } from "../voice.js";

// Robotics-side wiring on top of pip-core's built-in mic (see
// createPip({mic: ...}) — pip-core 2.10+). We get the dictation button,
// sticky-mode, no-speech retry, and the muted-tts visual state for free;
// this file translates them to the robot context:
//
//   onChunk — safety-verb instant-fire. Match the chunk against
//     voice-commands; if it's a stop/halt, dispatch immediately
//     (mid-turn injection if a turn is in flight, otherwise programmatic
//     submit via pip.ask).
//   onFinal — mid-turn injection when a turn is in flight (input is
//     disabled, so opening a new turn would split the conversation).
//
// onSpeakingChange (voice.js TTS lifecycle) drives suspendMic/resumeMic
// so the robot's voice doesn't echo back as the next command.

// Lifted to closure so makeMicConfig + wireTtsGating can both reach them
// after assistant.js wires them up.
let _turn = null;
let _getPip = () => null;
let _injectVoiceMidTurn = async () => false;

export function setDeps({ turn, getPip, injectVoiceMidTurn }) {
  _turn = turn;
  _getPip = getPip;
  _injectVoiceMidTurn = injectVoiceMidTurn;
}

// Config object passed to createPip({mic: ...}). Returns false from the
// hooks when nothing matches so pip-core falls back to its default
// submit-on-final behavior.
export function makeMicConfig() {
  return {
    onChunk: async (text) => {
      const m = tryMatchCommand(text);
      if (!m || !SAFETY_INTENTS.has(m.intent)) return false;
      // Safety verb — instant-fire path. Don't wait for the silence-commit
      // window; this is exactly the "stop" case where sub-second matters.
      if (_turn.isActive()) {
        await _injectVoiceMidTurn(text);
      } else {
        // No active turn — open one via pip.ask so the safety action
        // renders as a normal turn the operator can audit.
        _getPip()?.ask(text);
      }
      return true;
    },
    onFinal: async (text) => {
      // Mid-turn voice: input is disabled during a running turn, so
      // pip-core's default submit-on-final would just no-op. Inject as
      // an observation instead — claude.js drains it on the next
      // iteration alongside any tool_results.
      if (_turn.isActive()) {
        await _injectVoiceMidTurn(text);
        return true;
      }
      return false;  // idle: let pip-core submit normally
    },
  };
}

// Couple pip-core's mic to voice.js's TTS lifecycle. Robot speaking →
// suspend the mic so the recognizer can't transcribe its own voice as
// the next command (classic full-duplex problem; Alexa/Siri/Google all
// do this during TTS playback).
export function wireTtsGating() {
  onSpeakingChange((speaking) => {
    const pip = _getPip();
    if (speaking) pip?.suspendMic?.();
    else          pip?.resumeMic?.();
  });
}

export function toggleDictation() {
  _getPip()?.toggleMic?.();
}
