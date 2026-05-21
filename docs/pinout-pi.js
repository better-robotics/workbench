import { $, escapeHtml } from "./dom.js";
import { getConfig } from "./capabilities/runtime/command.js";
import { onOpsResponse } from "./ops-response.js";
import { uploadFile } from "./capabilities/ota.js";
import { beginMotorsCalibration } from "./motors-calibrate.js";
import { flattenPins, wireUpMotorChains, clearPinHighlight } from "./pinout-shared.js";

// BCM GPIO is what config + firmware use; physical pin is what the header
// silkscreen shows. Users wire against physical, so lead with those.
// [phys, label, kind] — kind ∈ {"3v3", "5v", "gnd", "gpio", "i2c-id"}
const PINS = [
  [ 1, "3V3",   "3v3"], [ 2, "5V",    "5v"],
  [ 3, "GPIO2", "gpio"],[ 4, "5V",    "5v"],
  [ 5, "GPIO3", "gpio"],[ 6, "GND",   "gnd"],
  [ 7, "GPIO4", "gpio"],[ 8, "GPIO14","gpio"],
  [ 9, "GND",   "gnd"], [10, "GPIO15","gpio"],
  [11, "GPIO17","gpio"],[12, "GPIO18","gpio"],
  [13, "GPIO27","gpio"],[14, "GND",   "gnd"],
  [15, "GPIO22","gpio"],[16, "GPIO23","gpio"],
  [17, "3V3",   "3v3"], [18, "GPIO24","gpio"],
  [19, "GPIO10","gpio"],[20, "GND",   "gnd"],
  [21, "GPIO9", "gpio"],[22, "GPIO25","gpio"],
  [23, "GPIO11","gpio"],[24, "GPIO8", "gpio"],
  [25, "GND",   "gnd"], [26, "GPIO7", "gpio"],
  [27, "ID_SD", "i2c-id"],[28, "ID_SC", "i2c-id"],
  [29, "GPIO5", "gpio"],[30, "GND",   "gnd"],
  [31, "GPIO6", "gpio"],[32, "GPIO12","gpio"],
  [33, "GPIO13","gpio"],[34, "GND",   "gnd"],
  [35, "GPIO19","gpio"],[36, "GPIO16","gpio"],
  [37, "GPIO26","gpio"],[38, "GPIO20","gpio"],
  [39, "GND",   "gnd"], [40, "GPIO21","gpio"],
];

const GPIO_TO_PHYS = new Map(
  PINS.filter(([, lbl]) => lbl.startsWith("GPIO"))
      .map(([phys, lbl]) => [parseInt(lbl.slice(4), 10), phys]),
);

// Firmware defaults — MUST match pi_robot.py's LED_PIN and MOTORS_PINS.
// Used as input fallbacks AND as claimsFromConfig fallbacks so the SVG
// wires appear on first open of a fresh robot (where the conf is empty
// and pi_robot.py is running on its compiled-in defaults). Also the
// safe-defaults button's restore target.
const PI_DEFAULTS = {
  led_pin: 17,
  motors_pins: {
    left:  { forward: 5,  backward: 6  },
    right: { forward: 13, backward: 26 },
  },
  encoders_pins: { left: 22, right: 24 },
  ultrasonic_pins: { trig: 23, echo: 27 },
};

function claimsFromEntry(entry) {
  // Pi caps no longer carry pin info in fw-info (kept tiny so the full
  // payload fits the 512 B GATT attribute cap — pre-fix at 615 B Chrome
  // truncated the JSON and dropped every capability card). Derive claims
  // from cap-name presence + PI_DEFAULTS so the read-only diagram still
  // highlights the canonical wiring; Edit fetches the live pi-robot.conf
  // via get-config for users with custom pins.
  const names = new Set((entry?.capSchema || []).map(c => c.name));
  return claimsFromConfig({
    led_enabled:        names.has("led"),
    led_pin:            PI_DEFAULTS.led_pin,
    motors_enabled:     names.has("motors"),
    motors_pins:        PI_DEFAULTS.motors_pins,
    encoders_enabled:   names.has("encoders"),
    encoders_pins:      PI_DEFAULTS.encoders_pins,
    ultrasonic_enabled: names.has("ultrasonic"),
    ultrasonic_pins:    PI_DEFAULTS.ultrasonic_pins,
  });
}

// Shared Pi-header SVG geometry — exposed so the combined "Pi + driver board"
// view (renderBoardWithDriver) can compute wire endpoints in the same
// coordinate space.
const PI_W = 450;
const PI_ROW_H = 24;
const PI_PAD_Y = 14;
const PI_H = PI_PAD_Y * 2 + PI_ROW_H * 20;   // 508
const PI_LEFT_CX  = 195;
const PI_RIGHT_CX = 255;
const PI_PIN_R = 7;

// Returns: { cx, cy } for a physical pin on the Pi header.
function piPinCenter(phys) {
  const idx = PINS.findIndex(([p]) => p === phys);
  if (idx < 0) return null;
  const row = Math.floor(idx / 2);
  const cx = (idx % 2 === 0) ? PI_LEFT_CX : PI_RIGHT_CX;
  const cy = PI_PAD_Y + row * PI_ROW_H + PI_ROW_H / 2;
  return { cx, cy };
}

function piRowsFragment(claims) {
  const rows = [];
  for (let i = 0; i < PINS.length; i += 2) {
    const [lp, ll, lk] = PINS[i];
    const [rp, rl, rk] = PINS[i + 1];
    const lc = claims[lp];
    const rc = claims[rp];
    const y = PI_PAD_Y + (i / 2) * PI_ROW_H + PI_ROW_H / 2;
    // data-wire links pin-dot + claim text to the motor-wire chain
    // (claim-text + wire path + driver terminal share the same value, so
    // hovering any element lights up the whole connection). Only motor
    // claims get the attribute; LED/camera-style single-pin caps have
    // nothing to chain to. Tooltips intentionally minimal — the GPIO
    // label, physical pin number, and cap/role are already shown in
    // adjacent columns, so a verbose title would just restate them.
    const lWire = lc?.cap === "motors" ? ` data-wire="${escapeHtml(lc.role)}"` : "";
    const rWire = rc?.cap === "motors" ? ` data-wire="${escapeHtml(rc.role)}"` : "";
    // Encoder claims are redundant with the breakout-module label that
    // sits beside the pin row in the SVG — suppress the row text so it
    // doesn't compete with the module for the same horizontal space.
    const lcText = lc && lc.cap !== "encoders"
      ? `<text class="pin-claim" x="118" y="${y}" text-anchor="end"${lWire}>${escapeHtml(lc.cap)} · ${escapeHtml(lc.role)}</text>` : "";
    const rcText = rc && rc.cap !== "encoders"
      ? `<text class="pin-claim" x="332" y="${y}" text-anchor="start"${rWire}>${escapeHtml(rc.cap)} · ${escapeHtml(rc.role)}</text>` : "";
    rows.push(`
      <g class="pin-row">
        ${lcText}
        <text class="pin-label" x="178" y="${y}" text-anchor="end">${escapeHtml(ll)}</text>
        <circle class="pin-dot kind-${lk} ${lc ? "claimed" : ""}" cx="${PI_LEFT_CX}" cy="${y}" r="${PI_PIN_R}" data-phys="${lp}"${lWire}><title>${escapeHtml(ll)}</title></circle>
        <text class="pin-num" x="225" y="${y}" text-anchor="middle">${lp}·${rp}</text>
        <circle class="pin-dot kind-${rk} ${rc ? "claimed" : ""}" cx="${PI_RIGHT_CX}" cy="${y}" r="${PI_PIN_R}" data-phys="${rp}"${rWire}><title>${escapeHtml(rl)}</title></circle>
        <text class="pin-label" x="272" y="${y}" text-anchor="start">${escapeHtml(rl)}</text>
        ${rcText}
      </g>
    `);
  }
  return rows.join("");
}

// SVG representation of the Pi 40-pin header. Looks like a physical header
// (green PCB, black plastic strip, gold pin dots) so users mentally match it
// to the board in front of them. Later phases attach click-to-pulse and
// live pin-state here — the SVG substrate makes animations cheap and
// keyboard/screen-reader semantics honest.
function renderBoard(claims) {
  return `
    <div class="pinout-svg-wrap">
      <svg class="pinout-svg" viewBox="0 0 ${PI_W} ${PI_H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Raspberry Pi 40-pin header with current pin assignments">
        <rect class="pinout-strip" x="180" y="${PI_PAD_Y - 4}" width="90" height="${PI_H - 2 * PI_PAD_Y + 8}" rx="3"/>
        ${piRowsFragment(claims)}
      </svg>
    </div>
  `;
}

// Encoder breakout modules sit beside the Pi strip. VCC nearest the Pi
// (3V3 fan-in is short), GND outermost. VCC/GND wires faint
// (infrastructure); OUT pops in blue (editable signal).
const ENC_PCB_W    = 100;
const ENC_PCB_H    = 72;
const ENC_DOT_R    = 6;
const ENC_PIN_DX   = 28;
const ENC_CY       = 218;
const ENC_DOT_Y    = ENC_CY;
const ENC_LEFT_CX  = 68;
const ENC_RIGHT_CX = 382;
const ENC_VCC_PHYS = 17;                        // 3V3 (left col, row 8)
const ENC_GND_LEFT_PHYS  = 25;                  // GND (left col, row 12)
const ENC_GND_RIGHT_PHYS = 20;                  // GND (right col, row 9)
const ENCODER_TO_PATH = { left: "encoders_pins.left", right: "encoders_pins.right" };

// Ultrasonic breakout module — single PCB centered above the Pi header.
// ViewBox extends upward (negative Y) only when the cap is claimed,
// keeping the layout unchanged for robots without the sensor. 4 pin dots
// (VCC, TRIG, ECHO, GND) drop wires down to fixed 5V/GND pins + the
// configured GPIO claims. Edit mode puts inputs on TRIG/ECHO only.
const US_PCB_W    = 230;
const US_PCB_H    = 80;
const US_DOT_R    = 6;
const US_PIN_DX   = 38;
const US_CX       = PI_W / 2;
const US_CY       = -55;
const US_DOT_Y    = US_CY;
const US_PCB_TOP  = US_CY - US_PCB_H / 2;
const US_REGION_H = 105;
const US_VCC_PHYS = 2;                         // 5V (row 0, right col)
const US_GND_PHYS = 6;                         // GND (row 2, right col)
const ULTRA_LAYOUT = [
  { role: "vcc",  kind: "5v",   label: "5V",   path: null,                   dx: -1.5 },
  { role: "trig", kind: "gpio", label: "TRIG", path: "ultrasonic_pins.trig", dx: -0.5 },
  { role: "echo", kind: "gpio", label: "ECHO", path: "ultrasonic_pins.echo", dx:  0.5 },
  { role: "gnd",  kind: "gnd",  label: "GND",  path: null,                   dx:  1.5 },
];

function ultrasonicModuleFragment(opts) {
  const { editable, editConfig, flagged } = opts || {};
  const dots = ULTRA_LAYOUT.map((p) => {
    const x = US_CX + p.dx * US_PIN_DX;
    const wireAttr = p.path ? ` data-wire="${escapeHtml(`ultrasonic.${p.role}`)}"` : "";
    let inputFrag = "";
    if (editable && p.path) {
      const keys = p.path.split(".");
      let v = editConfig;
      for (const k of keys) v = v?.[k];
      if (v == null) v = PI_DEFAULTS.ultrasonic_pins[p.role];
      const conflictCls = flagged.has(v) ? " conflict" : "";
      inputFrag = `
        <foreignObject x="${x - 22}" y="${US_DOT_Y + 12}" width="44" height="22">
          <input xmlns="http://www.w3.org/1999/xhtml" type="text" inputmode="numeric" maxlength="2"
                 class="terminal-input${conflictCls}" data-path="${p.path}"${wireAttr}
                 value="${escapeHtml(String(v))}" />
        </foreignObject>
      `;
    }
    return `
      <text class="enc-pin-label" x="${x}" y="${US_DOT_Y - 11}" text-anchor="middle">${escapeHtml(p.label)}</text>
      <circle class="pin-dot enc-pin kind-${p.kind}" cx="${x}" cy="${US_DOT_Y}" r="${US_DOT_R}"${wireAttr}/>
      ${inputFrag}
    `;
  }).join("");
  return `
    <rect class="enc-pcb" x="${US_CX - US_PCB_W / 2}" y="${US_PCB_TOP}" width="${US_PCB_W}" height="${US_PCB_H}" rx="6"/>
    <text class="enc-title" x="${US_CX}" y="${US_PCB_TOP + 16}" text-anchor="middle">ultrasonic · HC-SR04</text>
    ${dots}
  `;
}

// VCC + GND always draw (infrastructure hint); TRIG/ECHO draw only when
// a live claim exists. Same convention as the encoder module wires.
function ultrasonicWiresFragment(claims) {
  const out = [];
  const vccX  = US_CX + ULTRA_LAYOUT[0].dx * US_PIN_DX;
  const trigX = US_CX + ULTRA_LAYOUT[1].dx * US_PIN_DX;
  const echoX = US_CX + ULTRA_LAYOUT[2].dx * US_PIN_DX;
  const gndX  = US_CX + ULTRA_LAYOUT[3].dx * US_PIN_DX;
  const vccPt = piPinCenter(US_VCC_PHYS);
  if (vccPt) out.push(usWirePath(vccX, US_DOT_Y, vccPt.cx, vccPt.cy, "wire-vcc"));
  const gndPt = piPinCenter(US_GND_PHYS);
  if (gndPt) out.push(usWirePath(gndX, US_DOT_Y, gndPt.cx, gndPt.cy, "wire-gnd"));
  const roleToX = { trig: trigX, echo: echoX };
  for (const [physStr, info] of Object.entries(claims)) {
    if (info?.cap !== "ultrasonic") continue;
    const x = roleToX[info.role];
    if (x == null) continue;
    const pt = piPinCenter(parseInt(physStr, 10));
    if (!pt) continue;
    out.push(usWirePath(x, US_DOT_Y, pt.cx, pt.cy, "wire-out", `ultrasonic.${info.role}`));
  }
  return out.join("");
}

function usWirePath(modX, modY, piX, piY, cls, wireRole) {
  // Drop from the bottom edge of the module's pin dot to the top edge
  // of the Pi pin. Cubic Bézier with control points at midY gives a
  // smooth vertical-dominant S even when the Pi pin is offset
  // horizontally — same shape language as the encoder wires.
  const sy = modY + US_DOT_R;
  const ey = piY - PI_PIN_R;
  const midY = (sy + ey) / 2;
  const dataAttr = wireRole ? ` data-wire="${escapeHtml(wireRole)}"` : "";
  return `<path class="enc-wire ${cls}" d="M${modX},${sy} C${modX},${midY} ${piX},${midY} ${piX},${ey}"${dataAttr}/>`;
}

const DRIVER_GAP = 60;
const DRIVER_Y   = PI_H + DRIVER_GAP;
const DRIVER_H   = 175;
const TOTAL_H    = DRIVER_Y + DRIVER_H;
const TERM_R     = 7;
const TERMINAL_XS = [45, 117, 189, 261, 333, 405];
const TERMINAL_ROLES = ["ena", "in1", "in2", "in3", "in4", "enb"];
const TERMINAL_LABELS = { ena: "ENA", in1: "IN1", in2: "IN2", in3: "IN3", in4: "IN4", enb: "ENB" };
const TERM_CY = DRIVER_Y + 85;
// motors_pins path (role from flattenPins) → driver terminal role. The
// per-motor names (forward/backward/enable) match gpiozero's Motor()
// constructor; the L298N chip-side names (IN1..IN4/ENA/ENB) match the
// silkscreen. Two vocabularies on purpose — the wires between them
// document the mapping that "forward/backward" hides on the chip.
const ROLE_TO_TERMINAL = {
  "left forward":   "in1",
  "left backward":  "in2",
  "left enable":    "ena",
  "right forward":  "in3",
  "right backward": "in4",
  "right enable":   "enb",
};

const TERMINAL_TO_PATH = {
  in1: { path: "motors_pins.left.forward",   optional: false },
  in2: { path: "motors_pins.left.backward",  optional: false },
  in3: { path: "motors_pins.right.forward",  optional: false },
  in4: { path: "motors_pins.right.backward", optional: false },
  ena: { path: "motors_pins.left.enable",    optional: true  },
  enb: { path: "motors_pins.right.enable",   optional: true  },
};

// One encoder breakout — three pin dots inside a small rounded PCB.
// Mirror layout: left module is [GND,OUT,VCC], right is [VCC,OUT,GND].
function encoderModuleFragment(side, cx, opts) {
  const { editable, editConfig, flagged } = opts;
  const pcbX = cx - ENC_PCB_W / 2;
  const vccDx = side === "left" ? +ENC_PIN_DX : -ENC_PIN_DX;
  const gndDx = -vccDx;
  const vccX  = cx + vccDx;
  const outX  = cx;
  const gndX  = cx + gndDx;
  const pcbTopY = ENC_CY - ENC_PCB_H / 2;
  const wireAttr = ` data-wire="${escapeHtml(`encoders.${side}`)}"`;

  let inputFrag = "";
  if (editable) {
    const path = ENCODER_TO_PATH[side];
    const v = editConfig?.encoders_pins?.[side] ?? PI_DEFAULTS.encoders_pins[side];
    const display = String(v);
    const conflictCls = flagged.has(v) ? " conflict" : "";
    inputFrag = `
      <foreignObject x="${outX - 22}" y="${ENC_DOT_Y + 12}" width="44" height="22">
        <input xmlns="http://www.w3.org/1999/xhtml" type="text" inputmode="numeric" maxlength="2"
               class="terminal-input${conflictCls}" data-path="${path}"${wireAttr}
               value="${escapeHtml(display)}" />
      </foreignObject>
    `;
  }

  return `
    <rect class="enc-pcb" x="${pcbX}" y="${pcbTopY}" width="${ENC_PCB_W}" height="${ENC_PCB_H}" rx="6"/>
    <text class="enc-title" x="${cx}" y="${pcbTopY + 16}" text-anchor="middle">encoder · ${side}</text>
    <text class="enc-pin-label" x="${vccX}" y="${ENC_DOT_Y - 11}" text-anchor="middle">VCC</text>
    <circle class="pin-dot enc-pin kind-3v3" cx="${vccX}" cy="${ENC_DOT_Y}" r="${ENC_DOT_R}"/>
    <text class="enc-pin-label" x="${outX}" y="${ENC_DOT_Y - 11}" text-anchor="middle">OUT</text>
    <circle class="pin-dot enc-pin kind-gpio" cx="${outX}" cy="${ENC_DOT_Y}" r="${ENC_DOT_R}"${wireAttr}/>
    <text class="enc-pin-label" x="${gndX}" y="${ENC_DOT_Y - 11}" text-anchor="middle">GND</text>
    <circle class="pin-dot enc-pin kind-gnd" cx="${gndX}" cy="${ENC_DOT_Y}" r="${ENC_DOT_R}"/>
    ${inputFrag}
  `;
}

function encoderWiresFragment(side, claims) {
  const cx   = side === "left" ? ENC_LEFT_CX : ENC_RIGHT_CX;
  const vccX = side === "left" ? cx + ENC_PIN_DX : cx - ENC_PIN_DX;
  const outX = cx;
  const gndX = side === "left" ? cx - ENC_PIN_DX : cx + ENC_PIN_DX;
  const gndPhys = side === "left" ? ENC_GND_LEFT_PHYS : ENC_GND_RIGHT_PHYS;
  const out = [];

  const vccPt = piPinCenter(ENC_VCC_PHYS);
  if (vccPt) out.push(encWirePath(side, vccX, ENC_DOT_Y, vccPt.cx, vccPt.cy, "wire-vcc"));
  const gndPt = piPinCenter(gndPhys);
  if (gndPt) out.push(encWirePath(side, gndX, ENC_DOT_Y, gndPt.cx, gndPt.cy, "wire-gnd"));

  let outPhys = null;
  for (const [physStr, info] of Object.entries(claims)) {
    if (info?.cap === "encoders" && info?.role === side) {
      outPhys = parseInt(physStr, 10);
      break;
    }
  }
  if (outPhys != null) {
    const pt = piPinCenter(outPhys);
    if (pt) out.push(encWirePath(side, outX, ENC_DOT_Y, pt.cx, pt.cy, "wire-out", `encoders.${side}`));
  }
  return out.join("");
}

function encWirePath(side, encX, encY, piX, piY, cls, wireRole) {
  const sx = side === "left" ? encX + ENC_DOT_R : encX - ENC_DOT_R;
  const ex = side === "left" ? piX  - PI_PIN_R  : piX  + PI_PIN_R;
  const midX = (sx + ex) / 2;
  const dataAttr = wireRole ? ` data-wire="${escapeHtml(wireRole)}"` : "";
  return `<path class="enc-wire ${cls}" d="M${sx},${encY} C${midX},${encY} ${midX},${piY} ${ex},${piY}"${dataAttr}/>`;
}

function renderBoardWithDriver(claims, opts = {}) {
  const { editable = false, editConfig = null, flagged = new Set() } = opts;
  const driverPcb = `
    <rect class="driver-pcb" x="15" y="${DRIVER_Y}" width="${PI_W - 30}" height="${DRIVER_H}" rx="6"/>
    <text class="driver-title" x="${PI_W / 2}" y="${DRIVER_Y + 22}" text-anchor="middle">H-bridge driver inputs</text>
  `;
  const encoderModules = `
    ${encoderModuleFragment("left",  ENC_LEFT_CX,  { editable, editConfig, flagged })}
    ${encoderModuleFragment("right", ENC_RIGHT_CX, { editable, editConfig, flagged })}
  `;
  const encoderWires = `
    ${encoderWiresFragment("left",  claims)}
    ${encoderWiresFragment("right", claims)}
  `;

  const terminalToWire = {};
  for (const info of Object.values(claims)) {
    if (info?.cap !== "motors") continue;
    const t = ROLE_TO_TERMINAL[info.role];
    if (t) terminalToWire[t] = info.role;
  }

  const terminals = TERMINAL_ROLES.map((role, i) => {
    const cx = TERMINAL_XS[i];
    const kind = role.startsWith("en") ? "enable" : "input";
    const wireRole = terminalToWire[role];
    const wireAttr = wireRole ? ` data-wire="${escapeHtml(wireRole)}"` : "";

    let inputFrag = "";
    if (editable) {
      const { path, optional } = TERMINAL_TO_PATH[role];
      const parts = path.split(".");
      let v = editConfig;
      for (const p of parts) v = v?.[p];
      if (v == null && !optional) {
        let dv = PI_DEFAULTS.motors_pins;
        for (const p of parts.slice(1)) dv = dv?.[p];
        v = dv;
      }
      const display = v == null ? "" : String(v);
      const placeholder = optional ? "—" : "";
      const conflictCls = (v != null && flagged.has(v)) ? " conflict" : "";
      inputFrag = `
        <foreignObject x="${cx - 22}" y="${TERM_CY + 12}" width="44" height="22">
          <input xmlns="http://www.w3.org/1999/xhtml" type="text" inputmode="numeric" maxlength="2"
                 class="terminal-input${conflictCls}" data-path="${path}"${optional ? ' data-optional="true"' : ""}${wireAttr}
                 value="${escapeHtml(display)}" placeholder="${placeholder}" />
        </foreignObject>
      `;
    }

    return `
      <text class="driver-label" x="${cx}" y="${TERM_CY - 14}" text-anchor="middle">${TERMINAL_LABELS[role]}</text>
      <circle class="driver-pin ${kind}" cx="${cx}" cy="${TERM_CY}" r="${TERM_R}" data-role="${role}"${wireAttr}/>
      ${inputFrag}
    `;
  }).join("");

  // Decorative supply-side note — reminds the user of connections they
  // must make themselves (not wireable via the dashboard config). Most
  // common failure after removing ENA/ENB jumpers: no common GND between
  // Pi and driver, or motor supply not hooked up.
  const supplyY = TERM_CY + (editable ? 58 : 45);
  const supplyNote = `
    <text class="driver-supply" x="${PI_W / 2}" y="${supplyY}" text-anchor="middle">
      Also connect (not shown): Pi GND ↔ L298N GND · motor supply 7–12V to VS
    </text>
  `;

  const wires = [];
  for (const [physStr, info] of Object.entries(claims)) {
    if (info?.cap !== "motors") continue;
    const driverRole = ROLE_TO_TERMINAL[info.role];
    if (!driverRole) continue;
    const phys = parseInt(physStr, 10);
    const piPt = piPinCenter(phys);
    if (!piPt) continue;
    const termIdx = TERMINAL_ROLES.indexOf(driverRole);
    const termCx = TERMINAL_XS[termIdx];
    const startX = piPt.cx, startY = piPt.cy + PI_PIN_R;
    const endX   = termCx,  endY   = TERM_CY - TERM_R;
    const midY = (startY + endY) / 2;
    const wireClass = driverRole.startsWith("en") ? "wire-enable" : "wire-input";
    wires.push(`<path class="motor-wire ${wireClass}" d="M${startX},${startY} C${startX},${midY} ${endX},${midY} ${endX},${endY}" data-wire="${escapeHtml(info.role)}"/>`);
  }

  const hasUltrasonic = Object.values(claims).some(c => c?.cap === "ultrasonic");
  const usModule  = hasUltrasonic ? ultrasonicModuleFragment({ editable, editConfig, flagged }) : "";
  const usWires   = hasUltrasonic ? ultrasonicWiresFragment(claims) : "";
  const vbTopY    = hasUltrasonic ? -US_REGION_H : 0;
  const vbHeight  = TOTAL_H + (hasUltrasonic ? US_REGION_H : 0);

  return `
    <div class="pinout-svg-wrap">
      <svg class="pinout-svg" viewBox="0 ${vbTopY} ${PI_W} ${vbHeight}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Raspberry Pi header with encoder modules and H-bridge driver wiring">
        <rect class="pinout-strip" x="180" y="${PI_PAD_Y - 4}" width="90" height="${PI_H - 2 * PI_PAD_Y + 8}" rx="3"/>
        ${piRowsFragment(claims)}
        ${encoderModules}
        ${usModule}
        ${driverPcb}
        ${terminals}
        ${encoderWires}
        ${usWires}
        ${wires.join("")}
        ${supplyNote}
      </svg>
    </div>
  `;
}

// State for edit mode. Scoped per-open-dialog; cleared on close via resetPi().
let currentId = null;
let editMode = false;
let editConfig = null;   // parsed pi-robot.conf contents
let awaitingConfig = false;
let awaitingTimer = null;
const CONFIG_RESPONSE_TIMEOUT_MS = 6000;

function claimsFromConfig(cfg) {
  // Build a claims map identical to claimsFromEntry but from the live conf
  // being edited, so preview reflects uncommitted edits before save.
  // Fall back to PI_DEFAULTS for any field the conf doesn't override —
  // matches what pi_robot.py is actually using (and what the input fields
  // display) so SVG wires render on first open of a fresh robot.
  const claims = {};
  const ledPin = cfg?.led_pin ?? PI_DEFAULTS.led_pin;
  if (cfg?.led_enabled && ledPin != null) {
    const phys = GPIO_TO_PHYS.get(ledPin);
    if (phys) claims[phys] = { cap: "led", role: "out" };
  }
  if (cfg?.motors_enabled) {
    const mp = cfg.motors_pins || {};
    const effective = {
      left:  { ...PI_DEFAULTS.motors_pins.left,  ...(mp.left  || {}) },
      right: { ...PI_DEFAULTS.motors_pins.right, ...(mp.right || {}) },
    };
    for (const [role, gpio] of flattenPins(effective)) {
      const phys = GPIO_TO_PHYS.get(gpio);
      if (phys) claims[phys] = { cap: "motors", role };
    }
  }
  // Encoders default-on in firmware (matches camera_enabled pattern),
  // so undefined in the conf means enabled.
  if (cfg?.encoders_enabled !== false) {
    const effective = { ...PI_DEFAULTS.encoders_pins, ...(cfg?.encoders_pins || {}) };
    for (const [role, gpio] of Object.entries(effective)) {
      const phys = GPIO_TO_PHYS.get(gpio);
      if (phys) claims[phys] = { cap: "encoders", role };
    }
  }
  // Ultrasonic defaults off in firmware (level-divider trap on ECHO),
  // so only render claims when explicitly enabled.
  if (cfg?.ultrasonic_enabled) {
    const effective = { ...PI_DEFAULTS.ultrasonic_pins, ...(cfg?.ultrasonic_pins || {}) };
    for (const [role, gpio] of Object.entries(effective)) {
      const phys = GPIO_TO_PHYS.get(gpio);
      if (phys) claims[phys] = { cap: "ultrasonic", role };
    }
  }
  return claims;
}

function renderView(entry) {
  const claims = claimsFromEntry(entry);
  const legend = Object.entries(claims).length
    ? `<div class="meta">Colored rows are declared in <code>pi-robot.conf</code>.</div>`
    : `<div class="meta">No GPIO capabilities declared for this robot.</div>`;
  const connected = entry?.status === "connected" && entry?.opsChar && entry?.otaDataChar;
  const editBtn = connected
    ? `<button class="secondary sm" id="pinout-edit-btn">Edit pins</button>`
    : "";
  const hasBoardClaims = Object.values(claims).some(c => c?.cap === "motors" || c?.cap === "encoders");
  $("pinout-body").innerHTML = `
    ${hasBoardClaims ? renderBoardWithDriver(claims) : renderBoard(claims)}
    <div class="row" style="margin-top: 12px;">${legend}${editBtn}</div>
  `;
  $("pinout-edit-btn")?.addEventListener("click", () => beginEdit(entry.id));
  wireUpMotorChains($("pinout-body"));
}

function renderEdit(entry) {
  // Preserve focus across the innerHTML rebuild so typing into a pin input
  // doesn't blur after every keystroke. Pin inputs are type="text" with
  // inputmode="numeric" so selection API works — we snap the cursor back to
  // end-of-value after refocusing below, or the next keystroke gets prepended.
  const active = document.activeElement;
  const savedPath = active?.dataset?.path || null;
  const savedToggle = active?.dataset?.toggle || null;
  const c = editConfig || {};
  const claims = claimsFromConfig(c);
  const ledChecked = c.led_enabled ? "checked" : "";
  const motorsChecked = c.motors_enabled ? "checked" : "";
  const cameraChecked = c.camera_enabled !== false ? "checked" : "";
  const encodersChecked = c.encoders_enabled !== false ? "checked" : "";
  const ultrasonicChecked = c.ultrasonic_enabled ? "checked" : "";
  const motors = c.motors_pins || {};
  const encoders = c.encoders_pins || {};
  const ultrasonic = c.ultrasonic_pins || {};
  // Duplicate GPIO usage detection, in two tiers:
  //   hard — every claimant is enabled; robot will misbehave on next boot.
  //   soft — at least one claimant is disabled; fine right now but a latent
  //          trap (re-enable and it breaks). Users hit this when the LED
  //          default (17) matches a motor IN they later claimed.
  // Hard blocks Save; soft just warns.
  const usage = {};
  if (c.led_pin != null) (usage[c.led_pin] ||= []).push({ role: "led", enabled: !!c.led_enabled });
  for (const [role, g] of flattenPins(motors)) {
    (usage[g] ||= []).push({ role: `motors.${role}`, enabled: !!c.motors_enabled });
  }
  const encodersEnabledEff = c.encoders_enabled !== false;
  for (const [role, g] of Object.entries(encoders)) {
    if (typeof g !== "number") continue;
    (usage[g] ||= []).push({ role: `encoders.${role}`, enabled: encodersEnabledEff });
  }
  for (const [role, g] of Object.entries(ultrasonic)) {
    if (typeof g !== "number") continue;
    (usage[g] ||= []).push({ role: `ultrasonic.${role}`, enabled: !!c.ultrasonic_enabled });
  }
  const dup = Object.entries(usage).filter(([, v]) => v.length > 1);
  const hard = dup.filter(([, v]) => v.every(x => x.enabled));
  const soft = dup.filter(([, v]) => !v.every(x => x.enabled));
  const fmt = (list) => list.map(x => x.enabled ? x.role : `${x.role} (off)`).join(" + ");
  // Reserved-function pins: the kernel interface grabs these exclusively when
  // enabled in raspi-config (usually SPI and I2C are on by default). gpiozero
  // then can't claim them and Motor() fails silently — motors won't respond
  // to slider commands even though the config looks clean.
  const RESERVED = {
    2:  "I2C1 SDA",  3:  "I2C1 SCL",
    7:  "SPI0 CE1",  8:  "SPI0 CE0",  9:  "SPI0 MISO",  10: "SPI0 MOSI",  11: "SPI0 SCLK",
    14: "UART TXD", 15: "UART RXD",
  };
  const reservedHits = [];
  const checkReserved = (pin, role, enabled) => {
    if (enabled && RESERVED[pin]) reservedHits.push({ pin, role, fn: RESERVED[pin] });
  };
  if (c.led_pin != null) checkReserved(c.led_pin, "LED", !!c.led_enabled);
  for (const [role, g] of flattenPins(motors)) checkReserved(g, `motors.${role}`, !!c.motors_enabled);
  for (const [role, g] of Object.entries(encoders)) {
    if (typeof g === "number") checkReserved(g, `encoders.${role}`, encodersEnabledEff);
  }
  for (const [role, g] of Object.entries(ultrasonic)) {
    if (typeof g === "number") checkReserved(g, `ultrasonic.${role}`, !!c.ultrasonic_enabled);
  }
  const flagged = new Set();
  for (const [g] of hard) flagged.add(parseInt(g, 10));
  for (const r of reservedHits) flagged.add(r.pin);

  const warnParts = [];
  if (hard.length) warnParts.push(`<span class="warn-hard">Conflict: ${hard.map(([g, v]) => `GPIO ${g} (${fmt(v)})`).join("; ")}</span>`);
  if (soft.length) warnParts.push(`<span class="warn-soft">Latent: ${soft.map(([g, v]) => `GPIO ${g} (${fmt(v)})`).join("; ")}</span>`);
  if (reservedHits.length) warnParts.push(`<span class="warn-soft">Reserved: ${reservedHits.map(h => `GPIO ${h.pin} (${h.fn})`).join("; ")}</span>`);
  const warnLine = warnParts.length
    ? `<div class="pinout-warn-line${hard.length ? " has-hard" : ""}">${warnParts.join(" · ")}</div>`
    : "";

  const ledFlagCls = (c.led_pin != null && flagged.has(c.led_pin)) ? " conflict" : "";

  $("pinout-body").innerHTML = `
    <div class="pinout-toolbar">
      <label class="toolbar-toggle">
        <input type="checkbox" data-toggle="led_enabled" ${ledChecked}>
        <span>LED</span>
        <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input${ledFlagCls}"
               data-path="led_pin" value="${c.led_pin ?? PI_DEFAULTS.led_pin}">
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" data-toggle="motors_enabled" ${motorsChecked}>
        <span>Motors (H-bridge)</span>
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" data-toggle="encoders_enabled" ${encodersChecked}>
        <span>Encoders</span>
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" data-toggle="camera_auto" ${cameraChecked}>
        <span>Camera (auto)</span>
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" data-toggle="ultrasonic_enabled" ${ultrasonicChecked}>
        <span>Ultrasonic</span>
      </label>
    </div>
    ${renderBoardWithDriver(claims, { editable: true, editConfig: c, flagged })}
    ${warnLine}
    <div class="meta pinout-helper">
      Numbers are BCM GPIO IDs. Empty ENA/ENB = jumpers left on (no speed-control wire).
      Swap "forward"/"backward" to fix a wheel that spins the wrong way.
      Encoder VCC/GND tap any Pi 3V3 / GND; check your sensor's voltage (most are 3V3).
    </div>
    <div class="modal-footer">
      <button class="secondary sm" id="pinout-cancel-btn">Cancel</button>
      <button class="secondary sm" id="pinout-safe-defaults-btn">Use safe defaults</button>
      <button class="secondary sm" id="pinout-calibrate-btn">Calibrate motors</button>
      <button class="sm" id="pinout-save-btn" ${hard.length ? "disabled" : ""}>Save &amp; restart</button>
    </div>
  `;
  $("pinout-body").querySelectorAll("input[data-toggle]").forEach(el => {
    el.addEventListener("change", () => {
      const key = el.dataset.toggle;
      if (key === "camera_auto") editConfig.camera_enabled = el.checked ? "auto" : false;
      else editConfig[key] = el.checked;
      renderEdit(entry);
    });
  });
  $("pinout-body").querySelectorAll("input[data-path]").forEach(el => {
    el.addEventListener("input", () => {
      const path = el.dataset.path.split(".");
      const raw = el.value.trim();
      let obj = editConfig;
      for (let i = 0; i < path.length - 1; i++) {
        obj[path[i]] ||= {};
        obj = obj[path[i]];
      }
      const key = path[path.length - 1];
      // Empty value on an optional field clears the key from config so the
      // wire disappears. Required fields stay in a transient invalid state
      // (the input is empty, editConfig still holds the prior value) and
      // skip the re-render — otherwise the rebuild snaps the input back to
      // the prior value from editConfig and the user can't replace the
      // last remaining digit.
      if (raw === "") {
        if (el.dataset.optional === "true") {
          delete obj[key];
          renderEdit(entry);
        }
        return;
      }
      const v = parseInt(raw, 10);
      if (Number.isNaN(v)) return;
      obj[key] = v;
      renderEdit(entry);
    });
    el.addEventListener("focus", () => highlightPinFromInput(el));
    el.addEventListener("blur",  () => clearPinHighlight());
  });
  $("pinout-cancel-btn")?.addEventListener("click", () => {
    editMode = false;
    editConfig = null;
    renderView(entry);
  });
  $("pinout-save-btn")?.addEventListener("click", () => saveEdit(entry));
  // Safe-defaults preset: matches pi_robot.py's MOTORS_PINS + LED_PIN
  // defaults. Now that the edit-form fallbacks match too, this button
  // is a *restore* affordance — useful after the user has drifted off
  // the canonical assignments and wants the working ones back.
  $("pinout-safe-defaults-btn")?.addEventListener("click", () => {
    editConfig.led_pin = PI_DEFAULTS.led_pin;
    editConfig.motors_pins = structuredClone(PI_DEFAULTS.motors_pins);
    editConfig.encoders_pins = structuredClone(PI_DEFAULTS.encoders_pins);
    editConfig.ultrasonic_pins = structuredClone(PI_DEFAULTS.ultrasonic_pins);
    renderEdit(entry);
  });
  $("pinout-calibrate-btn")?.addEventListener("click", () => {
    beginMotorsCalibration({
      entry,
      editConfig,
      onCancel: () => renderEdit(entry),
      onDone: (ok) => {
        if (ok) {
          editMode = false;
          editConfig = null;
          $("pinout-modal").close();
        } else {
          renderEdit(entry);
        }
      },
    });
  });

  if (savedPath) {
    const el = $("pinout-body").querySelector(`input[data-path="${savedPath}"]`);
    if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n); } catch {} }
  } else if (savedToggle) {
    $("pinout-body").querySelector(`input[data-toggle="${savedToggle}"]`)?.focus();
  }
  const act = document.activeElement;
  if (act?.dataset?.path) highlightPinFromInput(act);
  wireUpMotorChains($("pinout-body"));
}

function highlightPinFromInput(el) {
  clearPinHighlight();
  const gpio = parseInt(el.value, 10);
  if (Number.isNaN(gpio)) return;
  const phys = GPIO_TO_PHYS.get(gpio);
  if (!phys) return;
  const circle = document.querySelector(`.pinout-svg .pin-dot[data-phys="${phys}"]`);
  circle?.classList.add("focused");
}

function beginEdit(id) {
  currentId = id;
  editMode = true;
  awaitingConfig = true;
  $("pinout-body").innerHTML = `<div class="meta">Loading current config…</div>`;
  getConfig(id);
  // Don't leave the dialog stuck on "Loading…" forever if the response
  // doesn't arrive (BLE glitch, firmware without the verb, etc.). Surface
  // a clear error and a way out.
  clearTimeout(awaitingTimer);
  awaitingTimer = setTimeout(() => {
    if (!awaitingConfig || currentId !== id) return;
    awaitingConfig = false;
    $("pinout-body").innerHTML = `
      <div class="meta" style="color: var(--danger);">
        No response from robot (timed out). Connection may have glitched —
        close this dialog and reopen once the card shows "connected".
      </div>
      <div class="row" style="margin-top: 12px; justify-content: flex-end;">
        <button class="secondary sm" id="pinout-retry-btn">Retry</button>
      </div>
    `;
    $("pinout-retry-btn")?.addEventListener("click", () => beginEdit(id));
  }, CONFIG_RESPONSE_TIMEOUT_MS);
}

async function saveEdit(entry) {
  // Reject out-of-range pin values before shipping the config. Text inputs
  // don't carry HTML5 numeric bounds, so set a custom validity message on the
  // offender and let the browser's native popover point at the bad field.
  let badInput = null;
  for (const el of $("pinout-body").querySelectorAll("input[data-path]")) {
    const v = parseInt(el.value, 10);
    const bad = el.value.trim() === "" || Number.isNaN(v) || v < 0 || v > 27;
    el.setCustomValidity(bad ? "Enter a GPIO number between 0 and 27." : "");
    if (bad && !badInput) badInput = el;
  }
  if (badInput) { badInput.reportValidity(); badInput.focus(); return; }
  const json = JSON.stringify(editConfig, null, 2) + "\n";
  $("pinout-body").innerHTML = `<div class="meta">Uploading config + restarting service…</div>`;
  const ok = await uploadFile(
    entry.id, "pi-robot.conf", "/boot/firmware/pi-robot.conf",
    new TextEncoder().encode(json),
    { restart: "pi-robot" },
  );
  editMode = false;
  editConfig = null;
  if (ok) {
    $("pinout-modal").close();
  } else {
    renderView(entry);
  }
}

// Lazy subscription to the get-config response — only Pi path uses it.
let _initialized = false;
function initOnce() {
  if (_initialized) return;
  _initialized = true;
  onOpsResponse("get-config", (entry, msg) => {
    if (!awaitingConfig || entry.id !== currentId) return;
    awaitingConfig = false;
    clearTimeout(awaitingTimer);
    awaitingTimer = null;
    try {
      editConfig = msg.text ? JSON.parse(msg.text) : {};
    } catch {
      editConfig = {};
    }
    renderEdit(entry);
  });
}

export function openPi(entry) {
  initOnce();
  currentId = entry.id;
  editMode = false;
  editConfig = null;
  renderView(entry);
}

export function resetPi() {
  editMode = false;
  editConfig = null;
  awaitingConfig = false;
  clearTimeout(awaitingTimer);
  awaitingTimer = null;
  currentId = null;
}
