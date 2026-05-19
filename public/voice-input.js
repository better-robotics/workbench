// Browser-native speech-to-text via the Web Speech API
// (SpeechRecognition / webkitSpeechRecognition). Counterpart to voice.js's
// TTS — both are browser-native, no install, no API key. Caveat: Chrome's
// implementation forwards audio to Google's cloud STT under the hood, so
// this is the one path in the dashboard where audio leaves the tab.
// For the strict no-data-leaving variant, swap to transformers.js + Whisper
// (~100MB model, ~500ms–2s latency) — same shape, different backend.
//
// Push-to-talk by design: caller controls start + stop. continuous=true so
// natural pauses don't auto-end the session; interimResults=true so the UI
// can show the live transcript as the user speaks.

const SR = typeof window !== "undefined"
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

export function isSupported() { return !!SR; }

export function startDictation({ onInterim, onFinal, onError, onEnd, lang = "en-US" } = {}) {
  if (!SR) {
    onError?.("not-supported");
    onEnd?.();
    return { stop: () => {} };
  }
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = lang;

  let finalText = "";
  let stopped = false;

  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    // Caller sees the running concatenation (finalized so far + current
    // interim) — same model used by Gboard/iOS dictation, lets the input
    // field grow smoothly instead of flickering.
    onInterim?.(finalText + interim);
  };

  rec.onerror = (e) => {
    onError?.(e.error || "unknown");
  };

  rec.onend = () => {
    // Chrome sometimes fires onend prematurely (~10s of silence) even with
    // continuous=true. We don't restart automatically — that's the caller's
    // job if they want a longer session; restart-on-end is a feature, not
    // a default, because some errors (not-allowed, network) shouldn't loop.
    if (!stopped && finalText) onFinal?.(finalText.trim());
    else if (stopped) onFinal?.(finalText.trim());
    onEnd?.();
  };

  try { rec.start(); }
  catch (err) {
    // start() throws if recognition is already running (rare on PTT but
    // possible if the caller double-clicks the mic button before onend).
    onError?.(`start-failed: ${err.message || err}`);
    onEnd?.();
    return { stop: () => {} };
  }

  return {
    stop: () => {
      stopped = true;
      try { rec.stop(); } catch {}
    },
  };
}
