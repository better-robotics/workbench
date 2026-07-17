// Sudo-password store. Populated during Customize-card when the user leaves
// the password field blank — dashboard generates a random one and keeps a
// copy so it's recoverable later (SSH uses the key, but sudo / su still
// needs a password).
//
// Entries are labeled by prep time, not by robot name: the Pi derives its
// own hostname from its serial at first boot, so the browser has no name to
// key on while writing the card. Legacy entries keyed by a typed hostname
// (from when the prep dialog had that field) keep showing that name — the
// stored `label` is what distinguishes them.
import { $, escapeHtml } from "./dom.js";

const KEY = "better-robotics:passwords";

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); }
  catch { return {}; }
}
function write(obj) {
  try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch {}
}

export function listPasswords() {
  return Object.entries(read())
    .map(([key, v]) => ({
      key,
      // Legacy entries have no label — their key was the typed hostname.
      label: (typeof v === "object" && v.label) || key,
      password: typeof v === "string" ? v : v.password,
      createdAt: (typeof v === "object" ? v.createdAt : 0) || 0,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function removePassword(key) {
  const all = read();
  delete all[key];
  write(all);
  window.dispatchEvent(new CustomEvent("br:password-change"));
}

// 96 bits of entropy as 24 hex chars. Readable, typable, same across all
// platforms / locales. Plenty of room against brute-force even online.
function generatePassword() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// One entry per prepped card. No reuse-by-host: two cards prepped from this
// browser are two robots with two passwords, and nothing at prep time can
// tell us which serial the card is about to boot into.
export function createPassword() {
  const all = read();
  const createdAt = Date.now();
  const password = generatePassword();
  const when = new Date(createdAt).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  all[`card:${createdAt}`] = { password, createdAt, label: `Pi card — ${when}` };
  write(all);
  window.dispatchEvent(new CustomEvent("br:password-change"));
  return password;
}

export function initPasswordsUI() {
  const host = $("passwords-list");
  if (!host) return;
  const summary = $("passwords-summary");
  const render = () => {
    const items = listPasswords();
    // Collapsed-row summary mirrors the count so the disclosure summary
    // is informative without expanding. Empty state stays "None yet"
    // both inside and on the summary line for consistency.
    if (summary) summary.textContent = items.length === 0 ? "None yet" : `${items.length} stored`;
    if (items.length === 0) {
      host.innerHTML = `<div class="hint">None yet.</div>`;
      return;
    }
    host.innerHTML = items.map(i => `
      <div class="pwd-entry">
        <div class="pwd-info">
          <div class="pwd-host">${escapeHtml(i.label)}</div>
          <div class="meta pwd-value">${escapeHtml(i.password)}</div>
        </div>
        <div class="pwd-actions">
          <button class="secondary sm" data-key="${escapeHtml(i.key)}" data-action="copy">Copy</button>
          <button class="secondary sm" data-key="${escapeHtml(i.key)}" data-action="delete">Forget</button>
        </div>
      </div>
    `).join("");
    host.querySelectorAll('[data-action="copy"]').forEach(btn => {
      btn.addEventListener("click", async () => {
        const entry = listPasswords().find(i => i.key === btn.dataset.key);
        if (!entry) return;
        try {
          await navigator.clipboard.writeText(entry.password);
          const prev = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(() => { btn.textContent = prev; }, 1500);
        } catch {}
      });
    });
    host.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener("click", () => {
        const entry = listPasswords().find(i => i.key === btn.dataset.key);
        if (!entry) return;
        if (!confirm(`Forget the sudo password for ${entry.label}?`)) return;
        removePassword(entry.key);
      });
    });
  };
  render();
  window.addEventListener("br:password-change", render);
}
