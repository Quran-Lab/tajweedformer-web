// The learner's sharing key: a per-contributor P-256 key pair made with WebCrypto as
// NON-EXTRACTABLE (the private half can sign but can never be read by script, including the app's),
// stored in IndexedDB (CryptoKey objects are structured-cloneable), bound to the contributor id on the
// first upload. Deletion of what the learner shared is a challenge-response signed with it.
//
// The app gets: the public key (to send on the first upload), sign(bytes) for the SDK's own deletion
// request, and nothing else. There is no export of the private key and no call that deletes for anyone
// but this install's contributor.

const DB = 'quranlab-sharing-keys-v1';
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

function idb() {
  if (!globalThis.indexedDB) return null;
  return new Promise((res, rej) => {
    const q = globalThis.indexedDB.open(DB, 1);
    q.onupgradeneeded = () => q.result.createObjectStore('keys');
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
async function idbOp(mode, fn) {
  const d = await idb();
  if (!d) return undefined;
  return new Promise((res, rej) => {
    const t = d.transaction('keys', mode);
    const r = fn(t.objectStore('keys'));
    t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
    t.onerror = () => rej(t.error);
  });
}

/** In-memory fallback (Node, or no IndexedDB): the key lives as long as the process. */
const memory = new Map();

/**
 * The key pair of a contributor id, created on first use. Returns { contributor, publicKeyRaw
 * (65-byte uncompressed P-256 point), publicKeySpki (DER), sign(bytes) -> 64-byte r||s }.
 */
export async function contributorKey(contributor, { create = true } = {}) {
  let pair = memory.get(contributor) || (await idbOp('readonly', (s) => s.get(contributor)).catch(() => undefined));
  if (!pair) {
    if (!create) return null;
    pair = await globalThis.crypto.subtle.generateKey(ALG, false, ['sign', 'verify']);
    memory.set(contributor, pair);
    await idbOp('readwrite', (s) => s.put(pair, contributor)).catch(() => {});
  }
  const subtle = globalThis.crypto.subtle;
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  return {
    contributor,
    extractable: pair.privateKey.extractable, // always false
    publicKeyRaw: raw,
    publicKeySpki: spki,
    async sign(bytes) { return new Uint8Array(await subtle.sign(SIGN, pair.privateKey, bytes)); },
  };
}

/** Forget a contributor's key (after a deletion, or when sharing is turned off for good). */
export async function forgetContributorKey(contributor) {
  memory.delete(contributor);
  await idbOp('readwrite', (s) => s.delete(contributor)).catch(() => {});
}

// ---- the recovery code (PLATFORM_CLIENT.md section 9.1) ----
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 16 bytes as 26 Crockford base32 characters, most significant bit first (the last character carries
 * 3 bits and two zero bits), shown in groups of 4 separated by "-". */
export function recoveryCodeFromBytes(bytes) {
  if (bytes.length !== 16) throw new RangeError('a recovery code is 16 bytes');
  let bits = 0, acc = 0, out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out += CROCKFORD[(acc >> bits) & 31]; }
    acc &= (1 << bits) - 1;
  }
  if (bits) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}

/** The normalised form the hash is taken of: upper case, spaces and "-" removed, O as 0, I and L as 1. */
export function normaliseRecoveryCode(code) {
  return String(code).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** recovery_hash: lower-case hex SHA-256 of the normalised code. */
export async function recoveryHash(code) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(normaliseRecoveryCode(code)));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** A fresh recovery code (16 random bytes). */
export function newRecoveryCode() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return recoveryCodeFromBytes(b);
}

/** The exact bytes a deletion signs (LF line ends, final LF). */
export function deletionMessage({ app, contributor, nonce, timestamp }) {
  return new TextEncoder().encode(`quranlab-contribution-delete 1\napp ${app}\ncontributor ${contributor}\nnonce ${nonce}\ntimestamp ${timestamp}\naction delete-all\n`);
}

/** base64url without padding. */
export function b64url(bytes) {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
