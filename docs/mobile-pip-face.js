// Pip's face on the phone screen when mounted on a robot. The phone
// bezel is the head; the screen is the face. Shape lifted from
// pip-core's chat-bubble icon (head + antennas + ears + spark +
// sleep Z's) so the operator's chat-bubble Pip and the on-robot Pip
// read as the same character. The line-stroke eyes pip-core uses
// can't carry expressive states — they're replaced here with filled
// rounded-rect targets that morph via CSS transform.
//
// State source is the desktop's pip-event stream (bus topics tool.*
// and watcher.*), forwarded by pip/pip-face-plugin.js.

// Each state: transform string per eye, opacity, optional auto-revert
// duration. Continuous states (idle, scan, ask, halted, sleepy) leave
// transient_ms undefined and persist until explicitly cleared.
const STATES = {
  idle:       { l: "",                              r: "",                              opacity: 1   },
  blink:      { l: "scaleY(0.1)",                   r: "scaleY(0.1)",                   opacity: 1,   transient_ms: 200 },
  scan_left:  { l: "translateX(-3px)",              r: "translateX(-3px)",              opacity: 1   },
  scan_right: { l: "translateX(3px)",               r: "translateX(3px)",               opacity: 1   },
  look_up:    { l: "translateY(-2px)",              r: "translateY(-2px)",              opacity: 1   },
  look_down:  { l: "translateY(2px)",               r: "translateY(2px)",               opacity: 1   },
  think:      { l: "translateY(-1.5px) scale(0.8)", r: "translateY(-1.5px) scale(0.8)", opacity: 1,   transient_ms: 1800 },
  alert:      { l: "scale(1.35)",                   r: "scale(1.35)",                   opacity: 1,   transient_ms: 700 },
  ask:        { l: "rotate(-14deg)",                r: "rotate(14deg)",                 opacity: 1   },
  happy:      { l: "scale(1.2, 0.22)",              r: "scale(1.2, 0.22)",              opacity: 1,   transient_ms: 600 },
  halted:     { l: "scale(0.55, 0.35)",             r: "scale(0.55, 0.35)",             opacity: 0.5, transient_ms: 1500 },
  sleepy:     { l: "translateY(1px) scaleY(0.45)",  r: "translateY(1px) scaleY(0.45)",  opacity: 0.8 },
};

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
let _svg = null;
let _leftEye = null;
let _rightEye = null;
let _state = null;       // null when unmounted — timer guards check this
// Single timer slot; setFaceState replaces any prior one. Use timeout-
// based scheduling even for scan (which schedules its own next tick).
let _activeTimer = null;

function _clearTimer() {
  if (_activeTimer) { clearTimeout(_activeTimer); _activeTimer = null; }
}

export function mountPipFace(container) {
  _container = container;
  container.innerHTML = SVG_MARKUP;
  _svg = container.querySelector(".pip-face-svg");
  _leftEye = container.querySelector(".pip-face-eye-l");
  _rightEye = container.querySelector(".pip-face-eye-r");
  _state = "idle";
  _applyTarget("idle");
  _scheduleBlink();
}

export function unmountPipFace() {
  _clearTimer();
  if (_container) _container.innerHTML = "";
  _container = null;
  _svg = null;
  _leftEye = null;
  _rightEye = null;
  _state = null;
}

function _applyTarget(name) {
  const t = STATES[name] || STATES.idle;
  if (!_leftEye || !_rightEye) return;
  _leftEye.style.transform = t.l;
  _rightEye.style.transform = t.r;
  _leftEye.style.opacity = t.opacity;
  _rightEye.style.opacity = t.opacity;
  if (_svg) {
    _svg.classList.toggle("is-halted", name === "halted");
    _svg.classList.toggle("is-sleepy", name === "sleepy");
    _svg.classList.toggle("is-alert", name === "alert");
    _svg.classList.toggle("is-thinking", name === "think");
  }
}

// Public state-setter. Default duration comes from STATES[name].transient_ms
// (or stays indefinite). Callers can override but rarely need to.
export function setFaceState(name, { transient_ms } = {}) {
  if (_state === null) return;  // unmounted
  _clearTimer();
  _state = name;
  _applyTarget(name);
  const duration = transient_ms ?? STATES[name]?.transient_ms;
  if (duration > 0) {
    _activeTimer = setTimeout(() => setFaceState("idle"), duration);
  } else if (name === "idle") {
    _scheduleBlink();
  } else if (name === "scan") {
    let dir = true;
    const tick = () => {
      if (_state !== "scan") return;
      _applyTarget(dir ? "scan_left" : "scan_right");
      dir = !dir;
      _activeTimer = setTimeout(tick, 600);
    };
    tick();
  }
}

function _scheduleBlink() {
  if (_state !== "idle") return;
  _activeTimer = setTimeout(() => {
    if (_state !== "idle") return;
    _applyTarget("blink");
    _activeTimer = setTimeout(() => {
      if (_state !== "idle") return;
      _applyTarget("idle");
      _scheduleBlink();
    }, 140);
  }, 2000 + Math.random() * 3000);
}

// Desktop-emitted pip-event → face state. Centralized so the mapping
// is one place: when we change which tool maps to which expression,
// only this function changes.
export function applyPipEvent(event, data = {}) {
  if (_state === null) return;
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
        case "get_robot_detections": setFaceState("scan"); return;
        case "view_robot_frame":     setFaceState("think"); return;
        case "ask_human":
        case "ask_human_via_phone":  setFaceState("ask"); return;
        case "speak":                setFaceState("happy"); return;
        case "start_robot_camera":
        case "start_robot_watcher":  setFaceState("blink"); return;
        case "stop":
        case "stop_robot_watcher":   setFaceState("halted"); return;
      }
      return;
    }
    case "tool_result":
      // ask_human stays in "ask" until the operator answers.
      if (data.tool === "ask_human" || data.tool === "ask_human_via_phone") return;
      setFaceState(data.error || data.ok === false ? "halted" : "idle");
      return;
    case "watcher_fire":  setFaceState("alert"); return;
    case "watcher_clear": setFaceState("happy"); return;
    case "idle":          setFaceState("idle"); return;
  }
}
