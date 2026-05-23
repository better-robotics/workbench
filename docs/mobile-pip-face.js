// Pip's face on the phone screen when mounted on a robot. The phone
// bezel is the head; the screen is the face. The visual shape comes
// from pip-core's bubble icon (head rect + antennas + ears + spark +
// Z's) — same character the operator sees in the chat bubble, scaled
// to fill the phone. Continuity is the point: someone seeing the
// robot's face and Pip's chat bubble should recognize the same Pip.
//
// What's new vs the pip-core icon: the line-stroke eyes (a `|  |`
// pair, 2 units tall) are replaced with filled rounded-rect eyes that
// can morph through 10+ expressive states. The pip-core eye shape
// can't squint, widen, scan, or raise a brow; the rounded-rect can.
// Everything else (head, antennas, spark, Z's) is preserved verbatim.
//
// State source is the desktop's pip-event stream (bus topics tool.*
// and watcher.*), forwarded by pip-face-plugin.js. Phone owns the
// rendering; desktop owns the events.

const STATES = {
  idle:       { l: "",                              r: "",                              opacity: 1   },
  blink:      { l: "scaleY(0.1)",                   r: "scaleY(0.1)",                   opacity: 1   },
  scan_left:  { l: "translateX(-3px)",              r: "translateX(-3px)",              opacity: 1   },
  scan_right: { l: "translateX(3px)",               r: "translateX(3px)",               opacity: 1   },
  look_up:    { l: "translateY(-2px)",              r: "translateY(-2px)",              opacity: 1   },
  look_down:  { l: "translateY(2px)",               r: "translateY(2px)",               opacity: 1   },
  think:      { l: "translateY(-1.5px) scale(0.8)", r: "translateY(-1.5px) scale(0.8)", opacity: 1   },
  alert:      { l: "scale(1.35)",                   r: "scale(1.35)",                   opacity: 1   },
  ask:        { l: "rotate(-14deg)",                r: "rotate(14deg)",                 opacity: 1   },
  happy:      { l: "scale(1.2, 0.22)",              r: "scale(1.2, 0.22)",              opacity: 1   },
  halted:     { l: "scale(0.55, 0.35)",             r: "scale(0.55, 0.35)",             opacity: 0.5 },
  sleepy:     { l: "translateY(1px) scaleY(0.45)",  r: "translateY(1px) scaleY(0.45)",  opacity: 0.8 },
};

// pip-core's robot icon (viewBox 0 0 24 24), inlined with the eyes
// swapped for morphing rounded-rect targets. vector-effect on the
// stroke-art keeps the lines crisp at phone-screen scale instead of
// turning into a finger-thick outline. Same DOM class names as
// pip-core uses (.robot-spark, .robot-antenna-*, .robot-zzz-*) so
// future cross-pollination of animations is a copy-paste away.
const SVG_MARKUP = `
  <svg class="pip-face-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <g class="pip-face-art">
      <path class="robot-spark" d="M12 1v1.5 M11.25 1.75h1.5"/>
      <g class="robot-antenna">
        <path class="robot-antenna-s" d="M12 8V2"/>
      </g>
      <rect width="16" height="12" x="4" y="8" rx="2"/>
      <path d="M2 14h2"/>
      <path d="M20 14h2"/>
    </g>
    <g class="pip-face-eyes">
      <rect class="pip-face-eye pip-face-eye-l" x="7"  y="11" width="3.5" height="4" rx="1.75" />
      <rect class="pip-face-eye pip-face-eye-r" x="13.5" y="11" width="3.5" height="4" rx="1.75" />
    </g>
    <g class="robot-zzz" fill="currentColor" stroke="none" font-family="system-ui, -apple-system, sans-serif" font-weight="700">
      <text class="robot-zzz-1" x="15" y="6" font-size="3.5">Z</text>
      <text class="robot-zzz-2" x="16.5" y="4.5" font-size="2.5">Z</text>
      <text class="robot-zzz-3" x="17.5" y="3" font-size="1.8">Z</text>
    </g>
  </svg>
`;

let _container = null;
let _leftEye = null;
let _rightEye = null;
let _state = "idle";
let _stateTimer = null;
let _blinkTimer = null;
let _scanTimer = null;

export function mountPipFace(container) {
  _container = container;
  container.innerHTML = SVG_MARKUP;
  _leftEye = container.querySelector(".pip-face-eye-l");
  _rightEye = container.querySelector(".pip-face-eye-r");
  setFaceState("idle");
  _scheduleBlink();
}

export function unmountPipFace() {
  _clearTimers();
  if (_container) _container.innerHTML = "";
  _container = null;
  _leftEye = null;
  _rightEye = null;
  _state = "idle";
}

function _clearTimers() {
  if (_stateTimer) { clearTimeout(_stateTimer); _stateTimer = null; }
  if (_blinkTimer) { clearTimeout(_blinkTimer); _blinkTimer = null; }
  if (_scanTimer)  { clearInterval(_scanTimer); _scanTimer = null; }
}

function _applyTarget(name) {
  const t = STATES[name] || STATES.idle;
  if (!_leftEye || !_rightEye) return;
  _leftEye.style.transform = t.l;
  _rightEye.style.transform = t.r;
  _leftEye.style.opacity = t.opacity;
  _rightEye.style.opacity = t.opacity;
}

// halted/sleepy also dim the surrounding shape (head, antennas, spark)
// and surface the sleep glyphs — borrowed from pip-core's .sleeping
// affordance. Class on the SVG root toggles the styles together.
function _applyShapeMode(name) {
  const svg = _container?.querySelector(".pip-face-svg");
  if (!svg) return;
  svg.classList.toggle("is-halted", name === "halted");
  svg.classList.toggle("is-sleepy", name === "sleepy");
  svg.classList.toggle("is-alert", name === "alert");
  svg.classList.toggle("is-thinking", name === "think");
}

// Public state-setter. `transient_ms` auto-reverts to idle after the
// duration. Use it for momentary expressions (blink, alert, happy).
// State changes cancel any pending blink — a blink scheduled to fire
// during an "alert" expression would visually fight the alert.
export function setFaceState(name, { transient_ms = 0 } = {}) {
  if (!_leftEye) return;
  _clearTimers();
  _state = name;
  _applyTarget(name);
  _applyShapeMode(name);
  if (transient_ms > 0) {
    _stateTimer = setTimeout(() => setFaceState("idle"), transient_ms);
  } else if (name === "idle") {
    _scheduleBlink();
  } else if (name === "scan") {
    // Scan is a composite — alternates scan_left / scan_right on a
    // ~600ms cadence. The "scan" name persists in _state so the next
    // setFaceState call cleanly stops the oscillation.
    let dir = true;
    const tick = () => {
      if (_state !== "scan") return;
      _applyTarget(dir ? "scan_left" : "scan_right");
      dir = !dir;
    };
    tick();
    _scanTimer = setInterval(tick, 600);
  }
}

// Auto-blink: random 2–5s after entering idle. Cancelled on state
// change. Without it the face looks frozen between events.
function _scheduleBlink() {
  if (_state !== "idle") return;
  const delay = 2000 + Math.random() * 3000;
  _blinkTimer = setTimeout(() => {
    if (_state !== "idle") return;
    _applyTarget("blink");
    setTimeout(() => {
      if (_state !== "idle") return;
      _applyTarget("idle");
      _scheduleBlink();
    }, 140);
  }, delay);
}

// Desktop-emitted pip-event → face state. Centralized so the mapping
// is one place: when we change which tool maps to which expression,
// only this function changes. tool_result events return to idle for
// most tools (the next tool_call sets a new state); ask_human is the
// exception — it leaves the face in "ask" until the operator answers.
export function applyPipEvent(event, data = {}) {
  if (!_leftEye) return;
  switch (event) {
    case "tool_call": {
      const tool = data.tool || "";
      const input = data.input || {};
      switch (tool) {
        case "move_motor":
        case "drive_distance_cm":
        case "drive_arc":
        case "approach_until": {
          const l = Number(input.l ?? input.cm ?? input.speed ?? 0);
          const r = Number(input.r ?? input.cm ?? input.speed ?? 0);
          if (l > r + 10) setFaceState("scan_right");
          else if (r > l + 10) setFaceState("scan_left");
          else if ((l < 0) || (Number(input.cm) < 0)) setFaceState("look_down");
          else setFaceState("look_up");
          return;
        }
        case "get_robot_detections":
          setFaceState("scan");
          return;
        case "view_robot_frame":
          setFaceState("think", { transient_ms: 1800 });
          return;
        case "ask_human":
        case "ask_human_via_phone":
          setFaceState("ask");
          return;
        case "speak":
          setFaceState("happy", { transient_ms: 800 });
          return;
        case "start_robot_camera":
        case "start_robot_watcher":
          setFaceState("blink", { transient_ms: 200 });
          return;
        case "stop":
        case "stop_robot_watcher":
          setFaceState("halted", { transient_ms: 1200 });
          return;
      }
      return;
    }
    case "tool_result": {
      // Most tool results restore idle so the next tool's state shows
      // cleanly. Keep "ask" persistent (cleared by the answer event).
      if (data.tool === "ask_human" || data.tool === "ask_human_via_phone") return;
      if (data.error || data.ok === false) {
        setFaceState("halted", { transient_ms: 1500 });
      } else {
        setFaceState("idle");
      }
      return;
    }
    case "watcher_fire":
      setFaceState("alert", { transient_ms: 700 });
      return;
    case "watcher_clear":
      setFaceState("happy", { transient_ms: 500 });
      return;
    case "idle":
      setFaceState("idle");
      return;
  }
}
