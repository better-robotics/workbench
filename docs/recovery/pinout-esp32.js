import { $, escapeHtml } from "../dom.js";
import { SERVICE_UUID, PIN_CONFIG_CHAR_UUID, encodeJson } from "../ble.js";
import { beginMotorsCalibration } from "../motors-calibrate.js";
import { boardById, cameraReservedSet, boardForbiddenSet, boardMaxGpio, boardPinDefaults } from "./boards.js";
import { flattenPins, wireUpMotorChains, clearPinHighlight } from "./pinout-shared.js";

// Pin layouts, labels, footer notes, and camera-reserved sets come from
// boards.js — single source of truth shared with esp-serial.js. boardPins
// adapts the shape (pinsTop/pinsBot/pcbLabel) to the {top, bot, label}
// triple the renderers below expect.
function boardPins(entry) {
  const b = boardById(entry?.fwInfo?.board);
  return { top: b.pinsTop, bot: b.pinsBot, label: b.pcbLabel };
}
function esp32FooterNote(entry) {
  return boardById(entry?.fwInfo?.board).footerNote || "";
}

// ESP32-CAM canvas layout — top-to-bottom matches signal flow:
//   encoders (sensors / inputs)
//        ↓
//   ESP32-CAM (compute)
//        ↓
//   L298N driver (output to motors)
// Encoder OUT wires travel a short distance DOWN to the ESP32 top row
// instead of UP across the L298N region, removing the worst diagonal
// crossings the previous below-the-driver layout produced.
const ESP_W            = 520;
const ESP_PIN_R        = 9;
const ESP_PIN_SPACING  = 56;
const ESP_FIRST_PIN_X  = 50;

const ESP_ENC_PCB_W    = 130;
const ESP_ENC_PCB_H    = 80;
const ESP_ENC_DOT_R    = 6;
const ESP_ENC_PIN_DX   = 32;
const ESP_ENC_Y        = 10;
const ESP_ENC_DOT_Y    = ESP_ENC_Y + 40;
const ESP_ENC_LEFT_CX  = 130;
const ESP_ENC_RIGHT_CX = 390;

const ESP_ENC_TO_BOARD_GAP = 35;
const ESP_TOP_ROW_Y    = ESP_ENC_Y + ESP_ENC_PCB_H + ESP_ENC_TO_BOARD_GAP;
const ESP_BOT_ROW_Y    = ESP_TOP_ROW_Y + 160;
const ESP_H            = ESP_BOT_ROW_Y + 50;

const ESP_DRIVER_GAP   = 60;
const ESP_DRIVER_Y     = ESP_H + ESP_DRIVER_GAP;
const ESP_DRIVER_H     = 175;
const ESP_TERM_R       = 7;
const ESP_TERMINAL_XS  = [50, 134, 218, 302, 386, 470];
const ESP_TERM_CY      = ESP_DRIVER_Y + 85;
const ESP_TOTAL_H      = ESP_DRIVER_Y + ESP_DRIVER_H + 40;

// GPIO → (cx, cy) lookup for routing wires to ESP32 pins. Rebuilt per
// render via gpioToPosMap(layout) since pin arrays differ across boards.
// Pin spacing tightens automatically when there are more pins per row so
// the SVG stays within ESP_W. Only labeled GPIO pins make it in;
// power/ground pins are looked up separately by kind.
function pinSpacingForLayout(layout) {
  const n = Math.max(layout.top.length, layout.bot.length);
  const usable = ESP_W - 2 * ESP_FIRST_PIN_X;
  return n > 1 ? usable / (n - 1) : ESP_PIN_SPACING;
}
function gpioToPosMap(layout) {
  const spacing = pinSpacingForLayout(layout);
  const m = new Map();
  layout.top.forEach((p, i) => {
    if (p.gpio != null) m.set(p.gpio, {
      cx: ESP_FIRST_PIN_X + i * spacing,
      cy: ESP_TOP_ROW_Y,
      row: "top",
    });
  });
  layout.bot.forEach((p, i) => {
    if (p.gpio != null) m.set(p.gpio, {
      cx: ESP_FIRST_PIN_X + i * spacing,
      cy: ESP_BOT_ROW_Y,
      row: "bot",
    });
  });
  return m;
}

function espPinPosByKind(rowArr, rowY, kind, spacing) {
  for (let i = 0; i < rowArr.length; i++) {
    if (rowArr[i].kind === kind) {
      return { cx: ESP_FIRST_PIN_X + i * spacing, cy: rowY };
    }
  }
  return null;
}

function espPinFragment(pin, cx, cy, labelAbove, claimed) {
  const statusClass = pin.status ? `esp-${pin.status}` : "";
  const claimedClass = claimed ? "claimed" : "";
  const title = pin.note ? `${pin.label} — ${pin.note}` : pin.label;
  const labelY = labelAbove ? cy - 22 : cy + 26;
  // data-gpio enables the focus-highlight chain (input → matching pin
  // dot) and is the ESP32 analogue of the Pi side's data-phys.
  const gpioAttr = pin.gpio != null ? ` data-gpio="${pin.gpio}"` : "";
  return `
    <text class="pin-label" x="${cx}" y="${labelY}" text-anchor="middle">${escapeHtml(pin.label)}</text>
    <circle class="pin-dot kind-${pin.kind} ${statusClass} ${claimedClass}" cx="${cx}" cy="${cy}" r="${ESP_PIN_R}"${gpioAttr}>
      <title>${escapeHtml(title)}</title>
    </circle>
  `;
}

// Encoder VCC + GND destinations are derived per-board from the active
// layout (boards differ in where 3V3 / GND pins sit on the header).
// boardKindPositions() returns the first-matching position per kind.
function boardKindPositions(layout) {
  const spacing = pinSpacingForLayout(layout);
  return {
    vcc:      espPinPosByKind(layout.bot, ESP_BOT_ROW_Y, "3v3", spacing)
           || espPinPosByKind(layout.top, ESP_TOP_ROW_Y, "3v3", spacing),
    gndLeft:  espPinPosByKind(layout.top, ESP_TOP_ROW_Y, "gnd", spacing)
           || espPinPosByKind(layout.bot, ESP_BOT_ROW_Y, "gnd", spacing),
    gndRight: espPinPosByKind(layout.top, ESP_TOP_ROW_Y, "gnd", spacing)
           || espPinPosByKind(layout.bot, ESP_BOT_ROW_Y, "gnd", spacing),
  };
}

// Maps the motors_pins.* paths the fw advertises into L298N terminal
// roles. Same mapping as the Pi side because the schema is shared.
const ESP_ROLE_TO_TERMINAL = {
  "left forward":  "in1",
  "left backward": "in2",
  "right forward": "in3",
  "right backward":"in4",
};

function esp32ClaimsFromEntry(entry) {
  // ESP32 claims are keyed by GPIO number directly (there's no separate
  // "physical pin number" identifier — the silkscreen label is the GPIO).
  const claims = {};
  for (const cap of entry?.capSchema || []) {
    if (cap.pin != null) {
      claims[cap.pin] = { cap: cap.name, role: cap.pin_mode || cap.type };
    }
    for (const [role, gpio] of flattenPins(cap.pins)) {
      claims[gpio] = { cap: cap.name, role };
    }
  }
  return claims;
}

function espMotorWiresFragment(claims, gpioMap) {
  const wires = [];
  for (const [gpioStr, info] of Object.entries(claims)) {
    if (info?.cap !== "motors") continue;
    const term = ESP_ROLE_TO_TERMINAL[info.role];
    if (!term) continue;
    const pos = gpioMap.get(parseInt(gpioStr, 10));
    if (!pos) continue;
    const termIdx = ["ena", "in1", "in2", "in3", "in4", "enb"].indexOf(term);
    const termCx = ESP_TERMINAL_XS[termIdx];
    const startY = pos.cy + ESP_PIN_R;
    const endY = ESP_TERM_CY - ESP_TERM_R;
    const midY = (startY + endY) / 2;
    wires.push(`<path class="motor-wire wire-input" d="M${pos.cx},${startY} C${pos.cx},${midY} ${termCx},${midY} ${termCx},${endY}" data-wire="${escapeHtml(info.role)}"/>`);
  }
  return wires.join("");
}

function espEncoderModuleFragment(side, cx, opts) {
  const { editable, editConfig, flagged } = opts || {};
  const pcbX = cx - ESP_ENC_PCB_W / 2;
  const vccDx = side === "left" ? +ESP_ENC_PIN_DX : -ESP_ENC_PIN_DX;
  const gndDx = -vccDx;
  const vccX  = cx + vccDx;
  const outX  = cx;
  const gndX  = cx + gndDx;
  const pcbTopY = ESP_ENC_Y;

  let inputFrag = "";
  if (editable) {
    const key = side === "left" ? "enc_l" : "enc_r";
    const v = editConfig?.[key];
    const display = v == null || v < 0 ? "" : String(v);
    const conflictCls = v != null && v >= 0 && flagged?.has(v) ? " conflict" : "";
    inputFrag = `
      <foreignObject x="${outX - 22}" y="${ESP_ENC_DOT_Y + 12}" width="44" height="22">
        <input xmlns="http://www.w3.org/1999/xhtml" type="text" inputmode="numeric" maxlength="2"
               class="terminal-input${conflictCls}" data-key="${key}"
               value="${escapeHtml(display)}" placeholder="—" />
      </foreignObject>
    `;
  }

  return `
    <rect class="enc-pcb" x="${pcbX}" y="${pcbTopY}" width="${ESP_ENC_PCB_W}" height="${ESP_ENC_PCB_H}" rx="6"/>
    <text class="enc-title" x="${cx}" y="${pcbTopY + 16}" text-anchor="middle">encoder · ${side}</text>
    <text class="enc-pin-label" x="${vccX}" y="${ESP_ENC_DOT_Y - 11}" text-anchor="middle">VCC</text>
    <circle class="pin-dot enc-pin kind-3v3" cx="${vccX}" cy="${ESP_ENC_DOT_Y}" r="${ESP_ENC_DOT_R}"/>
    <text class="enc-pin-label" x="${outX}" y="${ESP_ENC_DOT_Y - 11}" text-anchor="middle">OUT</text>
    <circle class="pin-dot enc-pin kind-gpio" cx="${outX}" cy="${ESP_ENC_DOT_Y}" r="${ESP_ENC_DOT_R}" data-wire="${escapeHtml(`encoders.${side}`)}"/>
    <text class="enc-pin-label" x="${gndX}" y="${ESP_ENC_DOT_Y - 11}" text-anchor="middle">GND</text>
    <circle class="pin-dot enc-pin kind-gnd" cx="${gndX}" cy="${ESP_ENC_DOT_Y}" r="${ESP_ENC_DOT_R}"/>
    ${inputFrag}
  `;
}

function espEncoderWiresFragment(side, claims, gpioMap, kindPos) {
  const cx   = side === "left" ? ESP_ENC_LEFT_CX : ESP_ENC_RIGHT_CX;
  const vccX = side === "left" ? cx + ESP_ENC_PIN_DX : cx - ESP_ENC_PIN_DX;
  const outX = cx;
  const gndX = side === "left" ? cx - ESP_ENC_PIN_DX : cx + ESP_ENC_PIN_DX;
  const gndPos = side === "left" ? kindPos.gndLeft : kindPos.gndRight;
  const vccPos = kindPos.vcc;
  const out = [];

  // Encoder pin bottoms face down toward the ESP32 (encoders sit above
  // the board). Wires emerge from the bottom of the encoder dot and
  // arrive at the top of the ESP32 pin dot.
  const path = (sx, sy, ex, ey, cls, role) => {
    const midY = (sy + ey) / 2;
    const dataAttr = role ? ` data-wire="${escapeHtml(role)}"` : "";
    return `<path class="enc-wire ${cls}" d="M${sx},${sy} C${sx},${midY} ${ex},${midY} ${ex},${ey}"${dataAttr}/>`;
  };
  const encY = ESP_ENC_DOT_Y + ESP_ENC_DOT_R;
  const targetY = (pos) => pos.cy - ESP_PIN_R;

  if (vccPos) out.push(path(vccX, encY, vccPos.cx, targetY(vccPos), "wire-vcc"));
  if (gndPos) out.push(path(gndX, encY, gndPos.cx, targetY(gndPos), "wire-gnd"));

  let outGpio = null;
  for (const [g, info] of Object.entries(claims)) {
    if (info?.cap === "encoders" && info?.role === side) { outGpio = parseInt(g, 10); break; }
  }
  if (outGpio != null) {
    const pos = gpioMap.get(outGpio);
    if (pos) out.push(path(outX, encY, pos.cx, targetY(pos), "wire-out", `encoders.${side}`));
  }
  return out.join("");
}

// ESP32 has two driving modes — same shape as the Pi side's gpiozero
// Motor(enable=…) constructor:
//   PWM-on-direction: ENA/ENB tied HIGH externally; PWM on IN1..IN4.
//                     Firmware ignores m_ena / m_enb (left -1).
//   PWM-on-enable:    ENA/ENB wired to MCU pins; firmware PWMs on them
//                     and toggles IN1..IN4 as digital direction lines.
const ESP_TERMINAL_TO_KEY = {
  ena: "m_ena",
  in1: "m_l_fwd",
  in2: "m_l_bwd",
  in3: "m_r_fwd",
  in4: "m_r_bwd",
  enb: "m_enb",
};

function renderEsp32BoardWithDriver(entry, opts = {}) {
  const { editable = false, editConfig = null, flagged = new Set() } = opts;
  const layout = boardPins(entry);
  const spacing = pinSpacingForLayout(layout);
  const gpioMap = gpioToPosMap(layout);
  const kindPos = boardKindPositions(layout);
  const claims = esp32ClaimsFromEntry(entry);
  // Mark a top/bot pin as "claimed" if any cap currently uses its GPIO
  // — gives the same blue-ring affordance the Pi pin dots have.
  const renderRow = (arr, y, labelAbove) => arr.map((p, i) =>
    espPinFragment(p, ESP_FIRST_PIN_X + i * spacing, y, labelAbove,
                   p.gpio != null && claims[p.gpio] != null),
  ).join("");
  const topPins = renderRow(layout.top, ESP_TOP_ROW_Y, true);
  const botPins = renderRow(layout.bot, ESP_BOT_ROW_Y, false);
  const pcbY = ESP_TOP_ROW_Y + 18;
  const pcbH = ESP_BOT_ROW_Y - ESP_TOP_ROW_Y - 36;

  const driverPcb = `
    <rect class="driver-pcb" x="15" y="${ESP_DRIVER_Y}" width="${ESP_W - 30}" height="${ESP_DRIVER_H}" rx="6"/>
    <text class="driver-title" x="${ESP_W / 2}" y="${ESP_DRIVER_Y + 22}" text-anchor="middle">H-bridge driver inputs</text>
  `;
  const terminals = ["ena", "in1", "in2", "in3", "in4", "enb"].map((role, i) => {
    const cx = ESP_TERMINAL_XS[i];
    const kind = role.startsWith("en") ? "enable" : "input";
    const label = { ena: "ENA", in1: "IN1", in2: "IN2", in3: "IN3", in4: "IN4", enb: "ENB" }[role];
    let inputFrag = "";
    if (editable && ESP_TERMINAL_TO_KEY[role]) {
      const key = ESP_TERMINAL_TO_KEY[role];
      const v = editConfig?.[key];
      const display = v == null || v < 0 ? "" : String(v);
      const conflictCls = v != null && v >= 0 && flagged.has(v) ? " conflict" : "";
      inputFrag = `
        <foreignObject x="${cx - 22}" y="${ESP_TERM_CY + 12}" width="44" height="22">
          <input xmlns="http://www.w3.org/1999/xhtml" type="text" inputmode="numeric" maxlength="2"
                 class="terminal-input${conflictCls}" data-key="${key}"
                 value="${escapeHtml(display)}" />
        </foreignObject>
      `;
    }
    return `
      <text class="driver-label" x="${cx}" y="${ESP_TERM_CY - 14}" text-anchor="middle">${label}</text>
      <circle class="driver-pin ${kind}" cx="${cx}" cy="${ESP_TERM_CY}" r="${ESP_TERM_R}" data-role="${role}"/>
      ${inputFrag}
    `;
  }).join("");

  const encoderModules = `
    ${espEncoderModuleFragment("left",  ESP_ENC_LEFT_CX, { editable, editConfig, flagged })}
    ${espEncoderModuleFragment("right", ESP_ENC_RIGHT_CX, { editable, editConfig, flagged })}
  `;
  const encoderWires = `
    ${espEncoderWiresFragment("left",  claims, gpioMap, kindPos)}
    ${espEncoderWiresFragment("right", claims, gpioMap, kindPos)}
  `;
  const motorWires = espMotorWiresFragment(claims, gpioMap);

  const supplyNote = `
    <text class="driver-supply" x="${ESP_W / 2}" y="${ESP_TOTAL_H - 18}" text-anchor="middle">
      Also connect (not shown): common GND between ESP32 + L298N · motor supply 7–12V to VS
    </text>
  `;

  return `
    <div class="pinout-svg-wrap esp32">
      <svg class="pinout-svg esp32" viewBox="0 0 ${ESP_W} ${ESP_TOTAL_H}" preserveAspectRatio="xMidYMid meet"
           xmlns="http://www.w3.org/2000/svg" role="img"
           aria-label="ESP32-CAM header with encoder modules and H-bridge driver wiring">
        <rect class="esp-pcb" x="20" y="${pcbY}" width="${ESP_W - 40}" height="${pcbH}" rx="6"/>
        <text class="esp-chip-label" x="${ESP_W / 2}" y="${(ESP_TOP_ROW_Y + ESP_BOT_ROW_Y) / 2}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(layout.label)}</text>
        ${topPins}
        ${botPins}
        ${encoderModules}
        ${driverPcb}
        ${terminals}
        ${encoderWires}
        ${motorWires}
        ${supplyNote}
      </svg>
    </div>
  `;
}

// State for edit mode. Scoped per-open-dialog; cleared on close via resetEsp32().
let editMode = false;
let editConfig = null;

// ESP32 path — read current pin assignments straight from fw-info (no
// get-config round-trip needed; the firmware already advertises them on
// the led/flash/motors cap entries). Edit in place; save by writing JSON
// to the PIN_CONFIG char (firmware persists to NVS + restarts).
function esp32PinsFromFwInfo(entry) {
  const caps = entry?.capSchema || [];
  const led      = caps.find(c => c.name === "led")?.pin;
  const flash    = caps.find(c => c.name === "flash")?.pin;
  const motors   = caps.find(c => c.name === "motors")?.pins;
  const encoders = caps.find(c => c.name === "encoders")?.pins;
  const servo    = caps.find(c => c.name === "servo")?.pin;
  const rgb      = caps.find(c => c.name === "rgb")?.pins;
  return {
    led:     led    ?? 33,
    // No-cap fallback: -1 (disabled). C3/DevKit firmware doesn't advertise
    // flash at all; defaulting to GPIO 4 fabricates a phantom claim that
    // collides with whatever the user has on 4 (often a motor IN pin).
    flash:   flash  ?? -1,
    m_l_fwd: motors?.left?.forward   ?? 14,
    m_l_bwd: motors?.left?.backward  ?? 15,
    m_r_fwd: motors?.right?.forward  ?? 13,
    m_r_bwd: motors?.right?.backward ?? 12,
    // ENA/ENB optional — firmware uses PWM-on-direction when these are
    // -1 (L298N's factory jumpers on +5V), PWM-on-enable when set.
    m_ena:   motors?.left?.enable    ?? -1,
    m_enb:   motors?.right?.enable   ?? -1,
    // Encoders default disabled on ESP32 (firmware ships -1) — pin
    // pressure on ESP32-CAM makes a sensible default infeasible.
    enc_l:   encoders?.left  ?? -1,
    enc_r:   encoders?.right ?? -1,
    servo:   servo  ?? -1,
    // RGB triple (Yahboom BST-03 headlights and similar common-cathode
    // 3-channel boards). All three need to be wired for the firmware to
    // claim LEDC channels; partial = disabled. C3 stays disabled even
    // when assigned — not enough LEDC channels after motors+servo.
    rgb_r:   rgb?.r ?? -1,
    rgb_g:   rgb?.g ?? -1,
    rgb_b:   rgb?.b ?? -1,
  };
}

function cameraReservedFor(entry) {
  return cameraReservedSet(entry?.fwInfo?.board);
}
function forbiddenFor(entry) {
  return boardForbiddenSet(entry?.fwInfo?.board);
}
function maxGpioFor(entry) {
  return boardMaxGpio(entry?.fwInfo?.board);
}
// Static AI-Thinker camera set for esp32PinNote — the read-only pin
// notes default to the AI-Thinker context where the camera surface is
// the most common confusion. DevKit/C3 don't render notes through this
// function for those pins because their pin entries already carry
// board-specific notes via boards.js.
const ESP32_CAMERA_RESERVED_AITHINKER = cameraReservedSet("aithinker_cam");

function esp32PinNote(pin) {
  if (ESP32_CAMERA_RESERVED_AITHINKER.has(pin)) return "camera";
  if (pin === 1 || pin === 3) return "UART (sacrifices serial)";
  if (pin === 2)  return "strap (must be HIGH/floating at boot)";
  if (pin === 12) return "strap (must be LOW at boot — most blue L298N boards work; some need a 10k pull-down)";
  if (pin === 16 || pin === 17) return "PSRAM CS/CLK — every AI-Thinker ESP32-CAM ships with PSRAM; off-limits";
  if (pin === 4)  return "white flash LED";
  if (pin === 33) return "red status LED";
  if (pin >= 13 && pin <= 15) return "safe (SD pins, free when SD unused)";
  return "";
}

function renderEsp32View(entry) {
  const pins = esp32PinsFromFwInfo(entry);
  const row = (label, key) => {
    const v = pins[key];
    const note = v < 0 ? "(disabled)" : esp32PinNote(v);
    return `<div class="pinout-edit-row">
      <span class="pinout-edit-label">${label}</span>
      <code>${v < 0 ? "—" : "GPIO " + v}</code>
      ${note ? `<span class="meta">· ${escapeHtml(note)}</span>` : ""}
    </div>`;
  };
  // The Flash row is the AI-Thinker camera-flash LED. Boards without a
  // camera (DevKit, C3) have nowhere to wire it; the firmware also
  // disables it by default. Hide the row instead of showing a permanently
  // disabled slot that reads as "we're reserving something for camera."
  const hasFlash = (entry?.capSchema || []).some(c => c.name === "flash");
  const connected = entry?.status === "connected";
  const editBtn = connected
    ? `<button class="secondary sm" id="pinout-edit-btn">Edit pins</button>`
    : "";
  $("pinout-body").innerHTML = `
    ${renderEsp32BoardWithDriver(entry)}
    <div class="pinout-edit">
      <div class="pinout-edit-section">
        ${row("LED",            "led")}
        ${hasFlash ? row("Flash", "flash") : ""}
        ${row("Left forward",   "m_l_fwd")}
        ${row("Left backward",  "m_l_bwd")}
        ${row("Left enable",    "m_ena")}
        ${row("Right forward",  "m_r_fwd")}
        ${row("Right backward", "m_r_bwd")}
        ${row("Right enable",   "m_enb")}
        ${row("Encoder left",   "enc_l")}
        ${row("Encoder right",  "enc_r")}
        ${row("Servo",          "servo")}
        ${row("RGB · R",        "rgb_r")}
        ${row("RGB · G",        "rgb_g")}
        ${row("RGB · B",        "rgb_b")}
      </div>
    </div>
    <div class="row" style="margin-top: 12px;">
      <div class="meta">${esp32FooterNote(entry)}</div>
      ${editBtn}
    </div>
  `;
  $("pinout-edit-btn")?.addEventListener("click", () => beginEsp32Edit(entry));
  wireUpMotorChains($("pinout-body"));
}

function beginEsp32Edit(entry) {
  editMode = true;
  editConfig = esp32PinsFromFwInfo(entry);
  renderEsp32Edit(entry);
}

function renderEsp32Edit(entry) {
  // Preserve focus across the innerHTML rebuild so typing into a pin
  // input doesn't blur after every keystroke. Mirrors the Pi side's
  // approach.
  const active = document.activeElement;
  const savedKey = active?.dataset?.key || null;

  const c = editConfig;
  // Flash only exists on boards that advertise the cap (AI-Thinker CAM).
  // Excluding it from ALL_KEYS on no-flash boards keeps the conflict guard
  // from flagging a phantom claim against the real motor/LED assignments.
  const hasFlash = (entry?.capSchema || []).some(c => c.name === "flash");
  const ALL_KEYS = ["led", ...(hasFlash ? ["flash"] : []), "m_l_fwd", "m_l_bwd", "m_r_fwd", "m_r_bwd", "m_ena", "m_enb", "enc_l", "enc_r", "servo", "rgb_r", "rgb_g", "rgb_b"];
  const usedBy = {};
  for (const k of ALL_KEYS) {
    if (c[k] < 0) continue;
    (usedBy[c[k]] ||= []).push(k);
  }
  const dup = Object.entries(usedBy).filter(([, v]) => v.length > 1);
  const cameraReserved = cameraReservedFor(entry);
  const forbidden = forbiddenFor(entry);
  const maxGpio = maxGpioFor(entry);
  const cameraHits = ALL_KEYS.flatMap(k => {
    const p = c[k];
    return (p >= 0 && cameraReserved.has(p)) ? [[k, p]] : [];
  });
  // Hardware-forbidden minus camera (PSRAM CS/CLK + SPI flash on AI-Thinker,
  // SPI flash on DevKit/C3). Surfaced as a distinct warning because the
  // "why" differs from the camera case — the firmware would otherwise
  // accept and crash on first use of the pin.
  const hardwareHits = ALL_KEYS.flatMap(k => {
    const p = c[k];
    return (p >= 0 && forbidden.has(p) && !cameraReserved.has(p)) ? [[k, p]] : [];
  });
  // Out-of-range pins (above the chip's PIN_MAX — 21 on C3, 39 elsewhere).
  // The firmware drops the entire pin_config write on the first out-of-
  // range candidate, so flag and block save here to avoid a silent no-op.
  const rangeHits = ALL_KEYS.flatMap(k => {
    const p = c[k];
    return (p > maxGpio) ? [[k, p]] : [];
  });

  const flagged = new Set();
  for (const [, v] of dup) for (const k of v) if (c[k] >= 0) flagged.add(c[k]);
  for (const [, p] of cameraHits) flagged.add(p);
  for (const [, p] of hardwareHits) flagged.add(p);
  for (const [, p] of rangeHits) flagged.add(p);

  // C3 LEDC budget — 6 channels total, no HS mode. Motors in PWM-on-
  // direction claim 4 (one per IN pin), servo 1, leaving channel 4 free.
  // RGB needs 3, so the cap silently stays disabled in firmware (rgb_init
  // refuses to claim channels) even though the pins-in-NVS write went
  // through. The trap from the user's perspective: type pins → save →
  // chip restarts → inputs come back empty (fw-info doesn't list rgb).
  // Teach the constraint at the moment of assignment.
  const isC3 = entry?.fwInfo?.chip === "esp32c3";
  const rgbAssigned = c.rgb_r >= 0 || c.rgb_g >= 0 || c.rgb_b >= 0;
  const motorsModeDir = c.m_ena < 0 || c.m_enb < 0;
  const c3RgbBlocked = isC3 && rgbAssigned && motorsModeDir;

  const warn = [
    dup.length
      ? `<div class="pinout-warn">Conflict: ${dup.map(([g, v]) => `GPIO ${g} assigned to ${v.join(" + ")}`).join("; ")}</div>`
      : "",
    cameraHits.length
      ? `<div class="pinout-warn">Camera-reserved: ${cameraHits.map(([k, p]) => `GPIO ${p} (${k})`).join("; ")} — must be reassigned before saving.</div>`
      : "",
    hardwareHits.length
      ? `<div class="pinout-warn">Hardware-reserved: ${hardwareHits.map(([k, p]) => `GPIO ${p} (${k})`).join("; ")} — PSRAM CS/CLK or internal SPI flash; firmware refuses these.</div>`
      : "",
    rangeHits.length
      ? `<div class="pinout-warn">Out of range: ${rangeHits.map(([k, p]) => `GPIO ${p} (${k})`).join("; ")} — this chip exposes GPIO 0–${maxGpio}.</div>`
      : "",
    c3RgbBlocked
      ? `<div class="pinout-warn pinout-warn-info">RGB won't activate on C3 with motors in PWM-on-direction mode — they're using 4 of the chip's 6 LEDC channels, leaving only 1 free (RGB needs 3). Free 2 by wiring the L298N's ENA/ENB to MCU pins, then fill Left enable / Right enable. Pins below will save either way, but the cap stays disabled until channels are available.</div>`
      : "",
  ].filter(Boolean).join("");

  const blocked = dup.length > 0 || cameraHits.length > 0 || hardwareHits.length > 0 || rangeHits.length > 0;
  // Synthesize a transient entry-shaped object so renderEsp32BoardWithDriver
  // can derive claims from the in-progress edit. fwInfo carries over from
  // the live entry so the board-aware layout dispatch keeps using the
  // right pin map (DevKit / C3 / AI-Thinker) during edit.
  const previewEntry = {
    fwInfo: entry?.fwInfo,
    capSchema: [
      ...(c.m_l_fwd >= 0 ? [{
        name: "motors",
        pins: {
          left:  {
            forward: c.m_l_fwd,
            backward: c.m_l_bwd,
            ...(c.m_ena >= 0 ? { enable: c.m_ena } : {}),
          },
          right: {
            forward: c.m_r_fwd,
            backward: c.m_r_bwd,
            ...(c.m_enb >= 0 ? { enable: c.m_enb } : {}),
          },
        },
      }] : []),
      ...(c.enc_l >= 0 || c.enc_r >= 0 ? [{
        name: "encoders",
        pins: { left: c.enc_l >= 0 ? c.enc_l : -1, right: c.enc_r >= 0 ? c.enc_r : -1 },
      }] : []),
      ...(c.servo >= 0 ? [{ name: "servo", type: "level", pin: c.servo }] : []),
      ...(c.rgb_r >= 0 && c.rgb_g >= 0 && c.rgb_b >= 0
        ? [{ name: "rgb", type: "rgb", pins: { r: c.rgb_r, g: c.rgb_g, b: c.rgb_b } }]
        : []),
    ],
  };
  // Toolbar carries LED + Flash because they don't belong to any chip
  // below the ESP32 (LED is direct-attach, Flash is the white LED on
  // GPIO4). Motors + encoders edit inline on the SVG below.
  const ledV   = c.led < 0   ? "" : String(c.led);
  const flashV = c.flash < 0 ? "" : String(c.flash);
  const servoV = c.servo < 0 ? "" : String(c.servo);
  const rgbRV  = c.rgb_r < 0 ? "" : String(c.rgb_r);
  const rgbGV  = c.rgb_g < 0 ? "" : String(c.rgb_g);
  const rgbBV  = c.rgb_b < 0 ? "" : String(c.rgb_b);
  const ledCls   = c.led   >= 0 && flagged.has(c.led)   ? " conflict" : "";
  const flashCls = c.flash >= 0 && flagged.has(c.flash) ? " conflict" : "";
  const servoCls = c.servo >= 0 && flagged.has(c.servo) ? " conflict" : "";
  const rgbRCls  = c.rgb_r >= 0 && flagged.has(c.rgb_r) ? " conflict" : "";
  const rgbGCls  = c.rgb_g >= 0 && flagged.has(c.rgb_g) ? " conflict" : "";
  const rgbBCls  = c.rgb_b >= 0 && flagged.has(c.rgb_b) ? " conflict" : "";

  $("pinout-body").innerHTML = `
    <div class="pinout-toolbar">
      <label class="toolbar-toggle">
        <span>LED</span>
        <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input${ledCls}"
               data-key="led" value="${ledV}" placeholder="—">
      </label>
      ${hasFlash ? `<label class="toolbar-toggle">
        <span>Flash</span>
        <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input${flashCls}"
               data-key="flash" value="${flashV}" placeholder="—">
      </label>` : ""}
      <label class="toolbar-toggle">
        <span>Servo</span>
        <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input${servoCls}"
               data-key="servo" value="${servoV}" placeholder="—">
      </label>
      <label class="toolbar-toggle toolbar-toggle-rgb">
        <span>RGB</span>
        <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input${rgbRCls}"
               data-key="rgb_r" value="${rgbRV}" placeholder="R">
        <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input${rgbGCls}"
               data-key="rgb_g" value="${rgbGV}" placeholder="G">
        <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input${rgbBCls}"
               data-key="rgb_b" value="${rgbBV}" placeholder="B">
      </label>
    </div>
    ${renderEsp32BoardWithDriver(previewEntry, { editable: true, editConfig: c, flagged })}
    ${warn}
    <div class="meta pinout-helper">
      Numbers are ESP32 GPIO IDs. Blank input = capability disabled.
      Hardware-reserved pins (camera, PSRAM, SPI flash) are off-limits; hover any pin for its constraint.
    </div>
    <div class="modal-footer">
      <button class="secondary sm" id="pinout-cancel-btn">Cancel</button>
      <button class="secondary sm" id="pinout-defaults-btn">Use defaults</button>
      <button class="secondary sm" id="pinout-calibrate-btn">Calibrate motors</button>
      <button class="sm" id="pinout-save-btn" ${blocked ? "disabled" : ""}>Save &amp; restart</button>
    </div>
  `;
  $("pinout-body").querySelectorAll("input[data-key]").forEach(el => {
    el.addEventListener("input", () => {
      const raw = el.value.trim();
      // Empty input = -1 (cap disabled). Otherwise parse the integer; ignore
      // unparseable so partial typing doesn't snap to NaN mid-keystroke.
      const v = raw === "" ? -1 : parseInt(raw, 10);
      if (!Number.isNaN(v)) {
        editConfig[el.dataset.key] = v;
        renderEsp32Edit(entry);
      }
    });
    el.addEventListener("focus", () => highlightEsp32PinFromInput(el));
    el.addEventListener("blur",  () => clearPinHighlight());
  });
  $("pinout-cancel-btn").addEventListener("click", () => {
    editMode = false; editConfig = null; renderEsp32View(entry);
  });
  // Restore the board's firmware defaults — useful after the user drifts
  // off canonical pins (e.g., typed an AI-Thinker LED on a C3 and the
  // firmware silently rejected the save).
  $("pinout-defaults-btn").addEventListener("click", () => {
    editConfig = boardPinDefaults(entry?.fwInfo?.board);
    renderEsp32Edit(entry);
  });
  $("pinout-calibrate-btn")?.addEventListener("click", () => {
    beginMotorsCalibration({
      entry,
      editConfig,
      onCancel: () => renderEsp32Edit(entry),
      onDone: (ok) => {
        if (ok) {
          // ESP32 calibration save calls motors_set_orientation, which
          // schedules a 500ms restart on the chip. BLE drops briefly;
          // dashboard's auto-reconnect picks it back up. Close the dialog
          // so the user sees the reconnect on the card.
          editMode = false;
          editConfig = null;
          $("pinout-modal").close();
        } else {
          renderEsp32Edit(entry);
        }
      },
    });
  });
  $("pinout-save-btn").addEventListener("click", () => saveEsp32Edit(entry));
  wireUpMotorChains($("pinout-body"));

  if (savedKey) {
    const el = $("pinout-body").querySelector(`input[data-key="${savedKey}"]`);
    if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n); } catch {} }
  }
  const act = document.activeElement;
  if (act?.dataset?.key) highlightEsp32PinFromInput(act);
}

function highlightEsp32PinFromInput(el) {
  clearPinHighlight();
  const gpio = parseInt(el.value, 10);
  if (Number.isNaN(gpio)) return;
  const circle = document.querySelector(`.pinout-svg.esp32 .pin-dot[data-gpio="${gpio}"]`);
  circle?.classList.add("focused");
}

async function saveEsp32Edit(entry) {
  // Range check (firmware also validates, but reject early so the user
  // gets a focused error instead of a silent ignore over BLE). -1 means
  // "cap disabled" — accepted; only out-of-range positives reject. Bound
  // is board-aware: PIN_MAX is 21 on C3, 39 on classic ESP32. Without
  // this, the dashboard happily writes e.g. GPIO 25 to a C3, the firmware
  // drops the whole pin_config call, and the chip never restarts.
  const maxGpio = maxGpioFor(entry);
  for (const key of ["led", "flash", "m_l_fwd", "m_l_bwd", "m_r_fwd", "m_r_bwd", "m_ena", "m_enb", "enc_l", "enc_r", "servo", "rgb_r", "rgb_g", "rgb_b"]) {
    const v = editConfig[key];
    if (!Number.isInteger(v) || v === -1) continue;
    if (v < 0 || v > maxGpio) {
      alert(`${key}: GPIO ${v} is out of range [0, ${maxGpio}] (or leave blank to disable).`);
      return;
    }
  }
  $("pinout-body").innerHTML = `<div class="meta">Writing pin config + restarting…</div>`;
  try {
    if (!entry.device?.gatt?.connected) throw new Error("not connected");
    const svc = await entry.device.gatt.getPrimaryService(SERVICE_UUID);
    const ch  = await svc.getCharacteristic(PIN_CONFIG_CHAR_UUID);
    await ch.writeValueWithResponse(encodeJson(editConfig));
    editMode = false;
    editConfig = null;
    $("pinout-modal").close();
  } catch (err) {
    $("pinout-body").innerHTML = `
      <div class="meta" style="color: var(--danger);">Save failed: ${escapeHtml(err.message || String(err))}</div>
      <div class="row" style="margin-top: 12px; justify-content: flex-end;">
        <button class="secondary sm" id="pinout-retry-btn">Retry</button>
      </div>
    `;
    $("pinout-retry-btn")?.addEventListener("click", () => renderEsp32Edit(entry));
  }
}

export function openEsp32(entry) {
  editMode = false;
  editConfig = null;
  renderEsp32View(entry);
}

export function resetEsp32() {
  editMode = false;
  editConfig = null;
}
