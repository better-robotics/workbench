// Asserts the Prep card's FIRMWARE_FILES bundle includes every local module
// that pi_robot.py imports at top level. Today's loss: uuids.py was imported
// but not bundled — Prep wrote a working-looking SD that crash-looped on
// `ModuleNotFoundError: 'uuids'`. Catches the class, not just the instance.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("..", import.meta.url);
const prepareSrc = fs.readFileSync(new URL("./docs/prepare.js", root), "utf8");
const pyDir = new URL("./firmware/pi_robot/", root);
const pySrc = fs.readFileSync(new URL("./pi_robot.py", pyDir), "utf8");

function bundleFiles() {
  const m = prepareSrc.match(/const FIRMWARE_FILES\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error("FIRMWARE_FILES array not found in docs/prepare.js");
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map(x => x[1]);
}

// Top-level imports only: indented imports (try/except optional deps like
// picamera2, aiortc) intentionally skipped — those are runtime-degraded, not
// required for boot.
function localImports() {
  const names = new Set();
  for (const line of pySrc.split("\n")) {
    const m = line.match(/^(?:from|import)\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
    if (!m) continue;
    const mod = m[1];
    if (fs.existsSync(new URL(`./${mod}.py`, pyDir))) names.add(`${mod}.py`);
  }
  return [...names];
}

test("FIRMWARE_FILES bundles every local module pi_robot.py imports", () => {
  const bundle = new Set(bundleFiles());
  const missing = localImports().filter(f => !bundle.has(f));
  assert.deepEqual(
    missing, [],
    `prepare.js FIRMWARE_FILES missing locally-imported module(s): ${missing.join(", ")}`,
  );
});
