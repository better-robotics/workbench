// Per-origin persistent device key + sign/verify primitives.
//
// Used by discover.js (opt-in signed ads) and by consumers that build
// trust stores on top — e.g. "this is the Mac I paired yesterday, the
// pubkey continues to match, so trust the discovery ad."
//
// Trust model (consumer's responsibility, not ours):
//   - First pair binds trust via an out-of-band channel (QR scan in person).
//   - The QR encodes the publisher's pubkey; the scanner stores it.
//   - Subsequent ads signed by the same key are trusted; same key but a
//     new "label" is unsurprising; a known label with a new key is the
//     identity-changed alert path.
//
// What this file does NOT do: trust storage, UI, key rotation policy,
// cross-device sync. Those are app-level decisions.
//
// Storage: localStorage under a stable key. Cleared = new identity.
// That's a feature, not a bug — the consumer's trust store treats a
// reset as "this device is new" which is exactly correct.

const STORAGE_KEY = 'signal:peer-key:v1';

let _keyPair = null;
let _pubkeyB64 = null;
let _loadPromise = null;

function _b64encode(buf) {
  // base64url for URL-safe embedding (e.g. in QR pair URLs).
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _b64decode(s) {
  const base = (s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = base.length % 4 === 0 ? base : base + '='.repeat(4 - (base.length % 4));
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function _loadOrCreate() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      const privateKey = await crypto.subtle.importKey(
        'jwk', parsed.privateKey,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['sign']
      );
      const publicKey = await crypto.subtle.importKey(
        'jwk', parsed.publicKey,
        { name: 'ECDSA', namedCurve: 'P-256' },
        true, ['verify']
      );
      return { privateKey, publicKey };
    }
  } catch {
    // Stored key unreadable → regenerate. Consumer's trust store will
    // treat us as a new identity, which is the correct response to a
    // corrupted local key.
  }
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, ['sign', 'verify']
  );
  try {
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ privateKey: privateJwk, publicKey: publicJwk }));
  } catch {
    // localStorage unavailable (Safari private browsing, quota): the
    // key still works for this session, just won't persist. Acceptable.
  }
  return pair;
}

export async function getMyKeyPair() {
  if (_keyPair) return _keyPair;
  if (!_loadPromise) _loadPromise = _loadOrCreate();
  _keyPair = await _loadPromise;
  return _keyPair;
}

// base64url(SPKI raw export) — short, URL-safe, deterministic across
// devices that import/export the same key. Use as the trust-store key.
export async function getMyPubkeyB64() {
  if (_pubkeyB64) return _pubkeyB64;
  const { publicKey } = await getMyKeyPair();
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  _pubkeyB64 = _b64encode(raw);
  return _pubkeyB64;
}

export async function signBytes(bytes) {
  const { privateKey } = await getMyKeyPair();
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey, bytes
  );
  return _b64encode(sig);
}

export async function verifyBytes(bytes, sigB64, pubkeyB64) {
  try {
    const raw = _b64decode(pubkeyB64);
    const pubkey = await crypto.subtle.importKey(
      'raw', raw,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['verify']
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubkey, _b64decode(sigB64), bytes
    );
  } catch {
    return false;
  }
}

// Stable JSON for signing — sort keys recursively so two implementations
// that reconstruct the same object produce the same bytes.
export function canonical(obj) {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}
