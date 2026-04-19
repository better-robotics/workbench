# Project layout gotchas

- **`docs/` is a symlink to `public/`.** GitHub Pages serves from `docs/` on `main`, but the site content lives in `public/`. Do not put repo-level documentation under `docs/` or `public/` unless you want it published as part of the dashboard. Repo-level docs live at the root (e.g. `HARDWARE.md`) or inside a subsystem (e.g. `firmware/pi_robot/README.md`).

# Comment discipline

This is an AI-edited codebase. Every line of comment is context cost. The global CLAUDE.md rule ("default to writing no comments") applies with extra force here. Past drift has added module-preamble paragraphs and inline narration that collectively wasted real context window; a `brief` agent pass trimmed ~17 KB across the repo. Don't re-introduce it.

**Keep a comment when it carries:**
- **Schema / wire format** — JSON examples, opcode tables, config-file keys. The data shape isn't inferable from code.
- **WHY** — hidden constraints, workarounds, bug fixes we hit before, behavior that would surprise someone reading. Kernel quirks, API gotchas, protocol parity requirements.
- **Cross-file invariants** — "must match `firmware/pi_robot/pi_robot.py` exactly", "same protocol as OTA", "pins come from `pi-robot.conf`".
- **Gotcha notes** — Chrome flag requirements, PEP 668 externally-managed, CSI allocation after `stop()`, systemctl `reboot` vs `restart` semantics, rfkill on Trixie, `setBufferSizes` gone in arduino-esp32 3.x, `--experimental` + root for bless, drop-intermediate-values for sliders vs BLE write latency, etc.

**Cut a comment when it is:**
- A module-level preamble paragraph (5–15 lines at top) restating what filename/folder/imports already convey.
- A restatement of the next line of code.
- A section-divider banner (`// —————`, `// ===`, `// ──────`).
- A label above obvious code ("// Generic writer", "// Boot", "// Helpers").
- Procedural narration ("now we set up the listener", "first we read, then...").
- Tutorial-style explanation of self-evident function bodies.

**Heuristic:** if a comment explains why a line LOOKS wrong or surprising, keep it. If it only says what the code does, cut it.

**Commit comments + docstrings follow the same rule.** `working.md`, `direction.md`, and architecture docs are prose by design — those stay discursive. Source code is not.
