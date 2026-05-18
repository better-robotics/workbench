// Single source of truth for supported board variants.
//
// Both the install dialog (esp-serial.js) and the pin visualizer +
// editor (pinout.js) consume from here. Adding a new board variant
// is a single-file change: append an entry below, plus the firmware
// side gets a matching CONFIG_BR_BOARD_* + sdkconfig.defaults overlay
// + build.sh case. Anything UI-facing that distinguishes boards
// (chooser label, USB hint, pin map, WebRTC capability, camera-pin
// reservations, footer note) lives in this object.
//
// Status vocabulary on pin entries — keep these aligned with the
// CSS classes in styles.css (`esp-${status}`):
//   "free"        — usable, no constraints
//   "sd-shared"   — usable but contends with µSD / camera DMA
//   "reserved"    — needs explicit user override (UART, EN, etc.)
//   "warn"        — strapping pin / shared peripheral, recoverable
//   "input-only"  — ESP32 input-only pin (GPIO34–39)
//   "forbidden"   — never assignable from the dashboard

// AI-Thinker ESP32-CAM (8+8 camera-pinned header).
const AITHINKER_PINS_TOP = [
  { label: "IO4",  gpio: 4,  kind: "gpio", status: "sd-shared", note: "SD DATA1 + onboard flash LED on most AI-Thinker boards — free only if SD unmounted and LED unused" },
  { label: "IO2",  gpio: 2,  kind: "gpio", status: "sd-shared", note: "SD DATA0; also a bootstrap pin (must float high at boot)" },
  { label: "IO14", gpio: 14, kind: "gpio", status: "sd-shared", note: "SD CLK — free only if µSD is unused" },
  { label: "IO15", gpio: 15, kind: "gpio", status: "sd-shared", note: "SD CMD; also bootstrap — free only if µSD is unused" },
  { label: "IO13", gpio: 13, kind: "gpio", status: "sd-shared", note: "SD DATA3 — free only if µSD is unused" },
  { label: "IO12", gpio: 12, kind: "gpio", status: "sd-shared", note: "SD DATA2; bootstrap pin (must be LOW at boot or flash voltage mis-detects) — use only with pull-down" },
  { label: "GND",  kind: "gnd" },
  { label: "5V",   kind: "5v" },
];
// Order mirrors top row's spatial layout: header positions sit across
// from each other on the PCB (5V ↔ 3V3, IO4 ↔ GND).
const AITHINKER_PINS_BOT = [
  { label: "GND",  kind: "gnd" },
  { label: "U0T",  gpio: 1,  kind: "gpio", status: "reserved", note: "GPIO1 — UART0 TX, used for USB-serial programming. Usable as GPIO only if you give up serial." },
  { label: "U0R",  gpio: 3,  kind: "gpio", status: "reserved", note: "GPIO3 — UART0 RX, used for USB-serial programming. Usable as GPIO only if you give up serial." },
  { label: "VCC",  kind: "5v",  note: "Jumper-selectable 3V3 or 5V on some boards" },
  { label: "GND",  kind: "gnd" },
  { label: "IO0",  gpio: 0,  kind: "gpio", status: "reserved", note: "Camera XCLK + boot-mode strap (hold LOW to enter flash mode). Do not reassign." },
  { label: "IO16", gpio: 16, kind: "gpio", status: "forbidden", note: "PSRAM #CS — the AI-Thinker ESP32-CAM always ships with PSRAM (required for camera frame buffers), so IO16 is never free. Driving it via LEDC crashes the chip mid-boot." },
  { label: "3V3",  kind: "3v3" },
];

// ESP32 DevKitV1 (WROOM-32, 30-pin DOIT/LOLIN-style — USB-C variant
// with CP210x bridge). Orientation: USB at the top of the silkscreen.
// In the SVG, `top` is the right-edge column of the physical board and
// `bot` is the left-edge column, each rendered as a horizontal row of
// dots. Pin order in each array reads top-to-bottom on the physical
// board, left-to-right in the SVG.
//
// SPI flash pins (IO6–IO11) and the BOOT button (IO0) aren't exposed
// on this variant's header; firmware's PINS_FORBIDDEN blocks IO6–IO11
// anyway in case someone wires to them directly via the PCB pads.
const DEVKIT_PINS_TOP = [
  { label: "EN",   kind: "reserved", note: "Chip enable / reset. Tied to RTS via the USB bridge; don't repurpose." },
  { label: "VIN",  kind: "5v",   note: "5V input from USB or external supply." },
  { label: "GND",  kind: "gnd" },
  { label: "IO13", gpio: 13, kind: "gpio", status: "free" },
  { label: "IO12", gpio: 12, kind: "gpio", status: "warn", note: "Strapping pin (MTDI) — must be LOW at reset for 3.3V flash. Safe as GPIO after boot; avoid hard pull-up at reset." },
  { label: "IO14", gpio: 14, kind: "gpio", status: "free" },
  { label: "IO27", gpio: 27, kind: "gpio", status: "free" },
  { label: "IO26", gpio: 26, kind: "gpio", status: "free" },
  { label: "IO25", gpio: 25, kind: "gpio", status: "free" },
  { label: "IO33", gpio: 33, kind: "gpio", status: "free" },
  { label: "IO32", gpio: 32, kind: "gpio", status: "free" },
  { label: "IO35", gpio: 35, kind: "gpio", status: "input-only", note: "GPIO35 — input-only, no internal pull-up/down." },
  { label: "IO34", gpio: 34, kind: "gpio", status: "input-only", note: "GPIO34 — input-only." },
  { label: "VN",   gpio: 39, kind: "gpio", status: "input-only", note: "GPIO39 (VN, ADC1_3) — input-only." },
  { label: "VP",   gpio: 36, kind: "gpio", status: "input-only", note: "GPIO36 (VP, ADC1_0) — input-only." },
];
// Order matches the DOIT V1 30-pin USB-C silkscreen exactly. Read
// top-to-bottom on the physical board (USB at top): 3V3, GND, IO15,
// IO2, IO4, RX2, TX2, IO5, IO18, IO19, IO21, RX0, TX0, IO22, IO23.
// Cross-checked against a user's physical sample; earlier guesses
// missed IO21 entirely and had RX2/TX2 transposed.
const DEVKIT_PINS_BOT = [
  { label: "3V3",  kind: "3v3" },
  { label: "GND",  kind: "gnd" },
  { label: "IO15", gpio: 15, kind: "gpio", status: "warn", note: "Strapping pin (MTDO) — pulling LOW at reset silences boot messages on UART0. Safe as GPIO after boot." },
  { label: "IO2",  gpio: 2,  kind: "gpio", status: "warn", note: "Strapping pin + onboard blue LED. Must not be HIGH at boot when the internal pull-down is disabled; usable as output safely once running." },
  { label: "IO4",  gpio: 4,  kind: "gpio", status: "free" },
  { label: "RX2",  gpio: 16, kind: "gpio", status: "free", note: "GPIO16, default UART2 RX. Silkscreen RX2." },
  { label: "TX2",  gpio: 17, kind: "gpio", status: "free", note: "GPIO17, default UART2 TX. Silkscreen TX2." },
  { label: "IO5",  gpio: 5,  kind: "gpio", status: "free" },
  { label: "IO18", gpio: 18, kind: "gpio", status: "free" },
  { label: "IO19", gpio: 19, kind: "gpio", status: "free" },
  { label: "IO21", gpio: 21, kind: "gpio", status: "free" },
  { label: "RX0",  gpio: 3,  kind: "gpio", status: "reserved", note: "GPIO3 — UART0 RX. Used for USB-serial programming and console logs." },
  { label: "TX0",  gpio: 1,  kind: "gpio", status: "reserved", note: "GPIO1 — UART0 TX. Reassigning loses the serial console." },
  { label: "IO22", gpio: 22, kind: "gpio", status: "free" },
  { label: "IO23", gpio: 23, kind: "gpio", status: "free" },
];

// ESP32-C3 SuperMini (RISC-V, 24-pin board). Native USB on GPIO 18/19;
// onboard LED on GPIO 8 (also strapping). Flash pins 11–17 are internal
// flash on the FH4 package — not on the header but listed forbidden in
// firmware for safety.
const C3_PINS_TOP = [
  { label: "5V",   kind: "5v" },
  { label: "GND",  kind: "gnd" },
  { label: "3V3",  kind: "3v3" },
  { label: "IO4",  gpio: 4,  kind: "gpio", status: "free" },
  { label: "IO3",  gpio: 3,  kind: "gpio", status: "free" },
  { label: "IO2",  gpio: 2,  kind: "gpio", status: "warn", note: "Strapping pin (boot-mode select). Safe as GPIO after boot." },
  { label: "IO1",  gpio: 1,  kind: "gpio", status: "free" },
  { label: "IO0",  gpio: 0,  kind: "gpio", status: "free" },
];
const C3_PINS_BOT = [
  { label: "IO5",  gpio: 5,  kind: "gpio", status: "free" },
  { label: "IO6",  gpio: 6,  kind: "gpio", status: "free" },
  { label: "IO7",  gpio: 7,  kind: "gpio", status: "free" },
  { label: "IO8",  gpio: 8,  kind: "gpio", status: "warn", note: "Onboard LED + strapping pin. Used as LED by default; safe as GPIO after boot." },
  { label: "IO9",  gpio: 9,  kind: "gpio", status: "warn", note: "BOOT button + strapping. Driving LOW at reset forces download mode." },
  { label: "IO10", gpio: 10, kind: "gpio", status: "free" },
  { label: "IO20", gpio: 20, kind: "gpio", status: "reserved", note: "UART0 TX. Reassigning loses the serial console (USB-CDC console stays available)." },
  { label: "IO21", gpio: 21, kind: "gpio", status: "reserved", note: "UART0 RX. Reassigning loses the serial console (USB-CDC console stays available)." },
];

// Per-entry shape:
//   id                 — matches the firmware-side BOARD env var and the
//                        fw_info.board JSON field
//   chip               — IDF target (binary-compat axis). esp-serial.js
//                        filters the picker by detected chip family.
//   label / sub        — install picker UI text
//   usbHints           — VID list that auto-selects this board in the
//                        chooser. Tightened so each VID maps unique.
//   webrtc             — { capable, on?, off? }: install picker decides
//                        whether to show the WebRTC checkbox; on/off
//                        give the bundle ids per setting.
//   pcbLabel           — text rendered inside the SVG board outline
//   pinsTop / pinsBot  — header rows (see status vocabulary above)
//   footerNote         — read-only note below the pinout editor rows
//   cameraReservedGpios — camera signal pins (AI-Thinker only). Editor
//                        flags as "camera-reserved"; subset of forbidden.
//   forbiddenGpios     — full firmware-side PINS_FORBIDDEN mirror (camera
//                        + SPI flash + PSRAM CS/CLK on AI-Thinker, SPI
//                        flash on DevKit, flash + SPI on C3). The editor
//                        blocks save on any assignment to these — must
//                        stay in lock-step with pin_config.c.
export const BOARDS = [
  {
    id: "aithinker_cam",
    chip: "esp32",
    label: "AI-Thinker ESP32-CAM",
    sub: "Camera + PSRAM. The headline board.",
    // CAM-MB programmer board ships with FT232 (0x0403). Standalone setups
    // with a CP210x adapter are rare enough that we don't list CP210x
    // here — otherwise the hint is ambiguous with DevKitV1 and the
    // picker can't auto-select either way.
    usbHints: [0x0403],
    webrtc: { capable: true, on: "aithinker_cam_webrtc", off: "aithinker_cam" },
    pcbLabel: "ESP32 · camera · µSD",
    pinsTop: AITHINKER_PINS_TOP,
    pinsBot: AITHINKER_PINS_BOT,
    footerNote: "Camera pins are fixed by the AI-Thinker board layout (15 GPIOs) and can't be reassigned. PSRAM CS/CLK (IO16/IO17) and SPI flash (IO6–IO11) are also off-limits.",
    cameraReservedGpios: [0, 5, 18, 19, 21, 22, 23, 25, 26, 27, 32, 34, 35, 36, 39],
    forbiddenGpios: [0, 5, 6, 7, 8, 9, 10, 11, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 34, 35, 36, 39],
  },
  {
    id: "devkit",
    chip: "esp32",
    label: "ESP32 DevKitV1 / WROOM-32",
    sub: "Classic ESP32 module. No camera, ~25 usable GPIOs.",
    // CH340 on cheap clones, CP210x on better DevKits.
    usbHints: [0x1a86, 0x10c4],
    webrtc: { capable: false },
    pcbLabel: "ESP32 DevKitV1 · WROOM-32",
    pinsTop: DEVKIT_PINS_TOP,
    pinsBot: DEVKIT_PINS_BOT,
    footerNote: "DevKitV1 exposes ~25 usable GPIOs across both edges. Strapping pins (IO2, IO12, IO15) work fine as outputs after boot; IO34–IO39 are input-only; SPI flash pins (IO6–IO11) are forbidden.",
    cameraReservedGpios: [],
    forbiddenGpios: [6, 7, 8, 9, 10, 11],
  },
  {
    id: "c3_supermini",
    chip: "esp32c3",
    label: "ESP32-C3 SuperMini",
    sub: "RISC-V single core, native USB. No camera.",
    usbHints: [0x303a],  // Espressif native USB-CDC-JTAG
    webrtc: { capable: false },
    pcbLabel: "ESP32-C3 SuperMini",
    pinsTop: C3_PINS_TOP,
    pinsBot: C3_PINS_BOT,
    footerNote: "C3 SuperMini has ~11 usable GPIOs. IO8 doubles as the onboard LED, IO9 as the BOOT button; IO18–IO21 are the USB-CDC and UART0 console lines.",
    cameraReservedGpios: [],
    forbiddenGpios: [11, 12, 13, 14, 15, 16, 17],
  },
];

// Lookup by id with AI-Thinker fallback. Used by pinout.js where older
// firmware that pre-dates fw_info.board reports nothing — falling back
// to AI-Thinker keeps the legacy pin map working as the de facto default.
export function boardById(id) {
  return BOARDS.find((b) => b.id === id) || BOARDS.find((b) => b.id === "aithinker_cam");
}

// Boards compatible with a given chip target (esp-serial.js install picker
// filters by this after the esptool stub reports chip identity).
export function boardsForChip(chip) {
  return BOARDS.filter((b) => b.chip === chip);
}

// Camera-reserved set as a Set (membership test is the only usage).
// Empty on no-camera boards by design.
export function cameraReservedSet(boardId) {
  const b = boardById(boardId);
  return new Set(b ? b.cameraReservedGpios : []);
}

// Full hardware-forbidden set — mirrors firmware-side PINS_FORBIDDEN in
// pin_config.c. The editor blocks save on any assignment to these pins;
// firmware also rejects (and reverts to default on NVS read) so a stale
// dashboard can't poison the board. Keep in lock-step with the firmware.
export function boardForbiddenSet(boardId) {
  const b = boardById(boardId);
  return new Set(b ? b.forbiddenGpios : []);
}
