// Per-namespace trust store for paired peers.
//
// What "trust" means here: the user has previously accepted a pair
// request from a device with this pubkey (or bound it out-of-band via
// a QR), and chose to remember the relationship. Future requests from
// the same pubkey auto-accept silently. Same shape as Bluetooth's
// bonded-devices list or iOS's "Always allow" per-app permissions.
//
// Storage: localStorage. Cleared = lose all memory; future requests
// prompt again. Safe failure mode.
//
// Methods are closure-bound (not `this`-bound) so consumers can
// destructure without losing context:
//   const { isAutoAccept, trust } = makeTrustStore();

const storageKey = 'better-robotics:trust:v1';

export function makeTrustStore() {
  const _load = () => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  };
  const _save = (store) => {
    try { localStorage.setItem(storageKey, JSON.stringify(store)); } catch {}
  };

  const isAutoAccept = (pubkey) => {
    if (!pubkey) return false;
    return !!_load()[pubkey];
  };

  // Bind trust. Updates lastSeenAt on re-trust without resetting
  // firstPairedAt — the relationship is older than the reconfirmation.
  const trust = (pubkey, label) => {
    if (!pubkey) return;
    const store = _load();
    const now = Date.now();
    const existing = store[pubkey];
    store[pubkey] = {
      label: label || (existing && existing.label) || 'Device',
      firstPairedAt: existing ? existing.firstPairedAt : now,
      lastSeenAt: now,
    };
    _save(store);
  };

  return { isAutoAccept, trust };
}
