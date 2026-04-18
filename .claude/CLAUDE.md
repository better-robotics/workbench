# Project layout gotchas

- **`docs/` is a symlink to `public/`.** GitHub Pages serves from `docs/` on `main`, but the site content lives in `public/`. Do not put repo-level documentation under `docs/` or `public/` unless you want it published as part of the dashboard. Repo-level docs live at the root (e.g. `HARDWARE.md`) or inside a subsystem (e.g. `firmware/pi_robot/README.md`).
