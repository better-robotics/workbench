// Supports both flat {role: gpio} and nested {left: {forward: 17, backward: 27}} shapes.
export function flattenPins(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const label = prefix ? `${prefix} ${k}` : k;
    if (typeof v === "number") out.push([label, v]);
    else if (v && typeof v === "object") out.push(...flattenPins(v, label));
  }
  return out;
}

// Wires up cross-element hover + click on motor connections. Elements
// tagged with the same `data-wire` value (pin-dot, claim-text, wire
// path, driver terminal) light up together on hover. Click jumps focus
// to the matching editor input — only effective in edit mode, when the
// inputs exist; in view mode it's a no-op so the chain still works as a
// read-only legend.
export function wireUpMotorChains(container) {
  const activate = (wire) => {
    container.querySelectorAll(`[data-wire="${wire}"]`)
      .forEach(e => e.classList.add("wire-active"));
  };
  const deactivate = () => {
    container.querySelectorAll(".wire-active")
      .forEach(e => e.classList.remove("wire-active"));
  };
  container.querySelectorAll("[data-wire]").forEach(el => {
    const wire = el.dataset.wire;
    el.addEventListener("mouseenter", () => activate(wire));
    el.addEventListener("mouseleave", deactivate);
    el.addEventListener("click", () => {
      // role "left forward" → config path "motors_pins.left.forward".
      const path = `motors_pins.${wire.replace(" ", ".")}`;
      const input = container.querySelector(`input[data-path="${path}"]`);
      if (input) {
        input.focus();
        try { input.setSelectionRange(0, input.value.length); } catch {}
      }
    });
  });
}

export function clearPinHighlight() {
  document.querySelectorAll(".pinout-svg .pin-dot.focused")
    .forEach(el => el.classList.remove("focused"));
}
