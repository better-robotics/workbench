// Dashboard identity: one ed25519 keypair per browser-origin, persisted in
// IndexedDB. Used to (a) auto-authorize SSH on prepared Pis and (b) sign
// BLE auth challenges (when gated ops land). Private key is extractable
// so the user can download an OpenSSH-format backup and SSH from a shell.
import { $ } from "./dom.js";

const DB_NAME = "better-robotics";
const STORE   = "keys";
const KEY_ID  = "dashboard-ed25519";
const COMMENT = "better-robotics";

let _cached = null;

// Notify subscribers when the stored keypair is generated, imported, or
// regenerated — app.js uses this to refresh its cached fingerprint and
// re-render enrollment banners on every connected robot.
const _keyChangeListeners = new Set();
export function onKeyChange(fn) {
  _keyChangeListeners.add(fn);
  return () => _keyChangeListeners.delete(fn);
}
function _notifyKeyChange() {
  for (const fn of _keyChangeListeners) { try { fn(); } catch {} }
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(id) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}
async function idbPut(id, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, id);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadOrGenerate() {
  if (_cached) return _cached;
  const existing = await idbGet(KEY_ID);
  if (existing) {
    _cached = existing;
    _notifyKeyChange();
    return _cached;
  }
  const kp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"],
  );
  const record = { publicKey: kp.publicKey, privateKey: kp.privateKey, createdAt: Date.now() };
  await idbPut(KEY_ID, record);
  _cached = record;
  _notifyKeyChange();
  return _cached;
}

const te = (s) => new TextEncoder().encode(s);
const concat = (...parts) => {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);  // SSH wire: big-endian
  return b;
};
const sshStr = (bytes) => concat(u32(bytes.length), bytes);
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

async function pubkeyRaw() {
  const r = await loadOrGenerate();
  return new Uint8Array(await crypto.subtle.exportKey("raw", r.publicKey));
}

// SSH pubkey wire: uint32 "ssh-ed25519" || uint32 raw32.
async function pubkeyWire() {
  return concat(sshStr(te("ssh-ed25519")), sshStr(await pubkeyRaw()));
}

export async function pubkeySsh() {
  return `ssh-ed25519 ${b64(await pubkeyWire())} ${COMMENT}`;
}

export async function fingerprint() {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await pubkeyWire()));
  return `SHA256:${b64(hash).replace(/=+$/, "")}`;
}

export async function sign(message) {
  const r = await loadOrGenerate();
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, r.privateKey, message));
}

// OpenSSH private key format (unencrypted). Format ref:
//   https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key
// Structure: magic || cipher(none) || kdf(none) || kdfopts() || nkeys(1) ||
//            pubkey_blob || privkey_section_padded_to_block_size(8).
export async function exportOpenSshPrivateKey() {
  const r = await loadOrGenerate();
  const pubRaw = await pubkeyRaw();
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", r.privateKey));
  // PKCS8 tail = [0x04, 0x20, seed_32_bytes]; seed is the last 32 bytes.
  const seed = pkcs8.slice(-32);
  const priv64 = concat(seed, pubRaw);  // OpenSSH "private" = seed || pub.

  const pubWire = await pubkeyWire();
  const check = crypto.getRandomValues(new Uint8Array(4));
  let section = concat(
    check, check,
    sshStr(te("ssh-ed25519")),
    sshStr(pubRaw),
    sshStr(priv64),
    sshStr(te(COMMENT)),
  );
  // Pad to 8-byte block size with 1,2,3,…
  const padLen = (8 - (section.length % 8)) % 8;
  if (padLen) {
    const pad = new Uint8Array(padLen);
    for (let i = 0; i < padLen; i++) pad[i] = i + 1;
    section = concat(section, pad);
  }

  const body = concat(
    te("openssh-key-v1\0"),
    sshStr(te("none")),    // cipher
    sshStr(te("none")),    // kdf
    sshStr(new Uint8Array(0)),  // kdfoptions
    u32(1),                // nkeys
    sshStr(pubWire),
    sshStr(section),
  );
  const wrapped = b64(body).match(/.{1,70}/g).join("\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

// Inverse of exportOpenSshPrivateKey. Parses an unencrypted OpenSSH ed25519
// private key file and returns {seed (32 bytes), pubkey (32 bytes)}. Rejects
// anything else — other ciphers, other keytypes, passphrase-protected files.
function parseOpenSshPrivateKey(pem) {
  const m = pem.match(/-----BEGIN OPENSSH PRIVATE KEY-----\s+([\s\S]+?)\s+-----END OPENSSH PRIVATE KEY-----/);
  if (!m) throw new Error("not an OpenSSH private key (missing PEM header)");
  const buf = Uint8Array.from(atob(m[1].replace(/\s+/g, "")), c => c.charCodeAt(0));
  const MAGIC = "openssh-key-v1\0";
  if (new TextDecoder().decode(buf.subarray(0, MAGIC.length)) !== MAGIC) {
    throw new Error("bad magic");
  }
  let off = MAGIC.length;
  const readU32 = () => {
    const v = ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
    off += 4;
    return v;
  };
  const readStr = () => {
    const n = readU32();
    const s = buf.subarray(off, off + n);
    off += n;
    return s;
  };
  const ciphername = new TextDecoder().decode(readStr());
  const kdfname    = new TextDecoder().decode(readStr());
  readStr();  // kdfoptions
  if (ciphername !== "none" || kdfname !== "none") {
    throw new Error("passphrase-protected keys aren't supported — strip with `ssh-keygen -p`");
  }
  const nkeys = readU32();
  if (nkeys !== 1) throw new Error(`expected 1 key, got ${nkeys}`);
  readStr();  // outer pubkey blob — we read the inner pubkey from the private section instead.
  const section = readStr();

  let poff = 0;
  const pU32 = () => {
    const v = ((section[poff] << 24) | (section[poff+1] << 16) | (section[poff+2] << 8) | section[poff+3]) >>> 0;
    poff += 4;
    return v;
  };
  const pStr = () => {
    const n = pU32();
    const s = section.subarray(poff, poff + n);
    poff += n;
    return s;
  };
  const check1 = pU32(), check2 = pU32();
  if (check1 !== check2) throw new Error("checkint mismatch (corrupt key?)");
  const keytype = new TextDecoder().decode(pStr());
  if (keytype !== "ssh-ed25519") throw new Error(`only ssh-ed25519 supported; got ${keytype}`);
  const pubkey  = pStr();  // 32 bytes
  const privkey = pStr();  // 64 bytes: seed || pubkey
  if (pubkey.length !== 32 || privkey.length !== 64) throw new Error("bad ed25519 key sizes");
  return { seed: new Uint8Array(privkey.subarray(0, 32)), pubkey: new Uint8Array(pubkey) };
}

// Ed25519 PKCS8 DER = 16-byte fixed prefix + 32-byte seed. Web Crypto takes
// PKCS8 for private key import; no toolchain needed.
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

async function importFromOpenSsh(pem) {
  const { seed, pubkey } = parseOpenSshPrivateKey(pem);
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const publicKey  = await crypto.subtle.importKey("raw", pubkey,  { name: "Ed25519" }, true, ["verify"]);
  const record = { publicKey, privateKey, createdAt: Date.now() };
  await idbPut(KEY_ID, record);
  _cached = record;
  _notifyKeyChange();
  return record;
}

async function regenerate() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const record = { publicKey: kp.publicKey, privateKey: kp.privateKey, createdAt: Date.now() };
  await idbPut(KEY_ID, record);
  _cached = record;
  _notifyKeyChange();
  return record;
}

function downloadBlob(filename, text, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function renderKeyUI() {
  const fp  = await fingerprint();
  const pub = await pubkeySsh();
  $("key-fingerprint").textContent = fp;
  // `.onclick =` replaces any prior handler, so re-render after import /
  // regenerate doesn't stack listeners that closed over a stale pub/fp.
  $("key-copy-pub").onclick = async () => {
    try {
      await navigator.clipboard.writeText(pub);
      const btn = $("key-copy-pub");
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = prev; }, 1500);
    } catch {}
  };
  $("key-download").onclick = async () => {
    downloadBlob("id_better_robotics", await exportOpenSshPrivateKey());
  };
}

export async function initAuthUI() {
  await loadOrGenerate();
  await renderKeyUI();

  $("key-import").addEventListener("click", () => {
    if (!confirm("Replace dashboard key? Every robot enrolled with the current key will need to be re-enrolled.")) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pem,.key,text/plain";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        await importFromOpenSsh(await file.text());
        await renderKeyUI();
      } catch (err) {
        alert(`Import failed: ${err.message}`);
      }
    });
    input.click();
  });

  $("key-regenerate").addEventListener("click", async () => {
    if (!confirm("Generate a new dashboard key? Every robot enrolled with the current key will need to be re-enrolled.")) return;
    await regenerate();
    await renderKeyUI();
  });
}
