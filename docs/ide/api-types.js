// The script API as a TypeScript declaration, registered with Monaco's TS
// worker via addExtraLib("workbench.d.ts") so `robot.`, `pip.`, `phones[0].`
// get real completions, hover docs, and typo squiggles across the whole
// surface — from VS Code's actual TypeScript engine. Kept as an inline
// string (not a fetched .d.ts) so it needs no extra round-trip and works
// offline. Mirror USER-CODE.md + docs/ide/script-runtime.js when the
// surface changes; this is the type-level cache of that runtime.
export const WORKBENCH_DTS = `
/** One detection from the closed-vocab reflex detector. */
interface Detection {
  /** COCO class label, e.g. "stop sign", "person". */
  label: string;
  /** Confidence 0..1. */
  score: number;
  /** Normalized bounding box (0..1), origin top-left. */
  bbox: { cx: number; cy: number; w: number; h: number };
}

/** A connected robot. \`robot\` is the first; \`robots\` is all of them. */
interface Robot {
  /** Stable per-chassis id (BLE device id). */
  readonly id: string;
  /** Advertised name, e.g. "ESP-1A2B". */
  readonly name: string;
  /** True while the BLE link is up. */
  readonly connected: boolean;
  /** Capability names this robot advertises (led, motors, camera, …). */
  readonly capabilities: string[];

  /**
   * Pulse-bounded motion. \`left\`/\`right\` are signed magnitudes; the
   * firmware auto-stops at the end of \`durationMs\` (clamped 50–2000 ms) —
   * the safety floor every motion path shares.
   */
  move(cmd: { left?: number; right?: number; durationMs?: number }): Promise<void>;

  /** Toggle the robot's LED. Throws if the robot has no LED capability. */
  led(on: boolean): Promise<void>;

  /**
   * Send a typed op over the structured command channel — the same channel
   * Pip uses. By default awaits the response carrying the same op name.
   * Pass \`{ await: false }\` for ops where the robot drops BLE mid-call
   * (reboot, restart-service); \`{ timeoutMs }\` for slow ops.
   */
  op(name: string, args?: Record<string, unknown>, opts?: { await?: boolean; timeoutMs?: number }): Promise<any>;

  /** Capture the current camera frame as a data URL (camera must be running). */
  frame(maxDim?: number): string;

  /** One-shot closed-vocab detection on the current frame. Throws if unavailable. */
  detections(opts?: Record<string, unknown>): Promise<Detection[]>;

  /**
   * Resolve with the first detection matching \`classes\`, or null on timeout.
   * Drives the "see X → do Y" reflex — \`await robot.watchFor("stop sign")\`.
   */
  watchFor(classes: string | string[], opts?: { timeoutMs?: number }): Promise<Detection | null>;
}

/** A paired phone (WebRTC pair layer). */
interface Phone {
  readonly id: string;
  readonly label: string;
  /**
   * Pop a question on the phone; resolve with the chosen answer, or null if
   * skipped / timed out. Same ask_human primitive Pip uses to defer upward.
   */
  ask(opts: { question: string; options?: string[]; imageDataUrl?: string; timeoutMs?: number }): Promise<string | null>;
}

/** The tool-using LLM in the loop — same bridge Pip uses. Costs API quota. */
interface Pip {
  /** Send a prompt, resolve with the model's text. Throws on backend failure. */
  ask(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string>;
}

/** First connected robot, or null if none are connected. */
declare const robot: Robot | null;
/** Every connected robot — multi-robot orchestration is a forEach. */
declare const robots: Robot[];
/** Every paired phone. */
declare const phones: Phone[];
/** The LLM-in-the-loop namespace. */
declare const pip: Pip;
/** Sleep for \`ms\` milliseconds. */
declare function sleep(ms: number): Promise<void>;
/** Print to the output pane. Non-strings are JSON-stringified. */
declare function log(...args: unknown[]): void;
/** Speak text aloud (Web Speech). */
declare function speak(text: string): void;
`;

// Virtual filename Monaco associates the lib with.
export const WORKBENCH_DTS_PATH = "ts:workbench.d.ts";
