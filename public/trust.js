// Trust store for paired devices.
//
// State model: pubkey → { label, firstPairedAt, lastSeenAt }. Pubkey is the
// continuity primitive (matches across sessions); label is the user-visible
// name shown in lists. Both come from the device that's identifying itself.
//
// Three derived states for any incoming ad:
//   trusted          — pubkey is in store
//   unknown          — pubkey absent (and no other key claims this label)
//   identity-changed — label is in store but under a DIFFERENT pubkey
//
// "identity-changed" is the WhatsApp / iMessage warning path. Could be:
// (a) the user reset their browser data; (b) they switched devices but
// kept the same name; (c) a coffee-shop attacker is publishing as "Mac"
// trying to lure a re-pair. The UI surfaces it; the user re-pairs via QR
// to bind the new key in person.
//
// Persistence: localStorage under a stable key. Cleared = lose all trust;
// pairings re-establish via QR. Same threat model as Bluetooth bonded
// devices, intentional.

const STORAGE_KEY = 'better-robotics:trust:v1';

function _load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function _save(store) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch {}
}

export function isTrusted(pubkey) {
  if (!pubkey) return false;
  return !!_load()[pubkey];
}

export function getTrust(pubkey) {
  if (!pubkey) return null;
  return _load()[pubkey] || null;
}

// Find any trust entry matching this label — for "identity-changed"
// detection. Returns the first match (one device per label is the
// expected case in v1). Returns { pubkey, label, ...meta } or null.
export function findByLabel(label) {
  if (!label) return null;
  const store = _load();
  for (const [pubkey, meta] of Object.entries(store)) {
    if (meta && meta.label === label) return { pubkey, ...meta };
  }
  return null;
}

// Bind trust. Called only after an out-of-band confirmation (QR scan,
// successful pair handshake). Updates lastSeenAt on re-trust without
// resetting firstPairedAt — the relationship is older than the
// reconfirmation.
export function trust(pubkey, label) {
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
}

// Touch lastSeenAt without changing trust. Cheap to call from discovery
// listeners — quietly tracks recency for "Last seen 2h ago" hints.
export function touch(pubkey) {
  if (!pubkey) return;
  const store = _load();
  if (!store[pubkey]) return;
  store[pubkey].lastSeenAt = Date.now();
  _save(store);
}

export function untrust(pubkey) {
  if (!pubkey) return;
  const store = _load();
  delete store[pubkey];
  _save(store);
}

// Three-state classifier the UI consumes directly. Pass an ad as it
// came from discover.js (data has _pubkey + _sig already verified).
export function classify(ad) {
  const data = (ad && ad.data) || {};
  const pubkey = data._pubkey;
  const label  = data.label;
  if (!pubkey) return { state: 'unknown', pubkey: null, label, trust: null };
  if (isTrusted(pubkey)) {
    return { state: 'trusted', pubkey, label, trust: getTrust(pubkey) };
  }
  const byLabel = findByLabel(label);
  if (byLabel && byLabel.pubkey !== pubkey) {
    return { state: 'identity-changed', pubkey, label, trust: byLabel };
  }
  return { state: 'unknown', pubkey, label, trust: null };
}
