// Slash-command registry. Mirrors pip-runtime's surface (registerSlash /
// slashSource / dispatch) so this dashboard's homegrown turn loop can
// share one command vocabulary with the autocomplete dropdown in pip-core.
//
// Pip-core calls `dispatchSlash(text)` from its onSlash hook; calls
// `slashSource()` per-keystroke to populate the dropdown.

const _commands = new Map();

export function registerSlash(s) {
  if (!s || !s.name || typeof s.handler !== "function") {
    throw new Error("registerSlash: { name, handler } required");
  }
  _commands.set(s.name.toLowerCase(), s);
}

export function unregisterSlash(name) {
  _commands.delete(String(name).toLowerCase());
}

const BUILTIN_HELP = { name: "help", description: "list commands" };

export function slashSource() {
  const out = [];
  for (const s of _commands.values()) {
    out.push({ name: s.name, description: s.description, complete: s.complete });
  }
  if (!_commands.has("help")) out.push(BUILTIN_HELP);
  return out;
}

export function dispatchSlash(text) {
  const slice = text.slice(1);
  const sp = slice.indexOf(" ");
  const cmdRaw = sp === -1 ? slice : slice.slice(0, sp);
  const args = sp === -1 ? "" : slice.slice(sp + 1);
  const cmd = cmdRaw.toLowerCase();

  const reg = _commands.get(cmd);
  if (reg) {
    try { return reg.handler(args) ?? null; }
    catch (e) { return { reply: `\`/${cmd}\` failed: ${e.message || e}` }; }
  }

  if (cmd === "help" || cmd === "?") {
    const lines = ["**Commands:**"];
    for (const s of _commands.values()) {
      lines.push(`- \`/${s.name}\` — ${s.description || ""}`);
    }
    lines.push("- `/help` — this list");
    return { reply: lines.join("\n") };
  }
  return null;
}
