// Ed25519 signature verification for every signature the SDK checks (the signed config, the model manifest):
// WebCrypto's Ed25519 where the runtime has it, and where it does not (Chrome before 137, Safari before 17, some
// embedded browsers) the vendored @noble/ed25519 2.3.0 (web/third_party/noble-ed25519, MIT, verify only, RFC 8032
// strict: zip215 off). Which one is decided once per page or process, by importing a known key and verifying a known
// signature (RFC 8032 section 7.1, test 1); the result is kept. 3.1.6: before it, a browser without WebCrypto Ed25519
// could never verify the config (DOMException NotSupportedError, code 9) and the learner saw needs_connection.
import { verifyAsync, etc } from '../third_party/noble-ed25519/index.js';

const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || null;

// RFC 8032 7.1 test 1: the empty message
const T1_PUB = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const T1_SIG = 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
const fromHex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

/** Thrown when this runtime cannot verify Ed25519 at all (no WebCrypto: not a secure context, an old runtime). */
export class Ed25519Unavailable extends Error {
  constructor(message) { super(message); this.name = 'Ed25519Unavailable'; this.code = 'runtime_unsupported'; }
}

let mode = null; // 'webcrypto' | 'fallback' | 'none', decided once
let deciding = null;

async function decide() {
  const s = subtle();
  if (!s || typeof s.digest !== 'function') return 'none';
  try {
    const key = await s.importKey('raw', fromHex(T1_PUB), { name: 'Ed25519' }, false, ['verify']);
    if (await s.verify({ name: 'Ed25519' }, key, fromHex(T1_SIG), new Uint8Array(0))) return 'webcrypto';
  } catch (_) { /* NotSupportedError (code 9), or a runtime that answers wrongly: the fallback */ }
  return 'fallback';
}

/** 'webcrypto', 'fallback' or 'none' (no WebCrypto at all), decided at the first call and kept. */
export async function ed25519Mode() {
  if (mode) return mode;
  if (!deciding) deciding = decide().then((m) => { mode = m; return m; });
  return deciding;
}

// noble needs SHA-512; it takes WebCrypto's digest (present wherever crypto.subtle is)
etc.sha512Async = async (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return new Uint8Array(await subtle().digest('SHA-512', all));
};

/**
 * True when `sig` (64 bytes) is a valid Ed25519 signature of `msg` by the raw 32-byte public key `pub`. Throws
 * Ed25519Unavailable on a runtime with no WebCrypto at all. A malformed key or signature is a false answer.
 */
export async function verifyEd25519(pub, sig, msg) {
  const m = await ed25519Mode();
  if (m === 'none') throw new Ed25519Unavailable('this runtime has no WebCrypto (crypto.subtle): signatures cannot be checked');
  if (!(pub instanceof Uint8Array) || pub.length !== 32 || !(sig instanceof Uint8Array) || sig.length !== 64) return false;
  if (m === 'webcrypto') {
    try {
      const key = await subtle().importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
      return await subtle().verify({ name: 'Ed25519' }, key, sig, msg);
    } catch (_) { return false; }
  }
  return verifyFallback(pub, sig, msg);
}

/** The vendored verifier alone, whatever WebCrypto has (the path a runtime without Ed25519 takes). Never throws. */
export async function verifyFallback(pub, sig, msg) {
  if (!(pub instanceof Uint8Array) || pub.length !== 32 || !(sig instanceof Uint8Array) || sig.length !== 64) return false;
  try { return await verifyAsync(sig, msg, pub, { zip215: false }); } catch (_) { return false; }
}

/** Tests: forget the decision (a test that removes Ed25519 from WebCrypto, then puts it back). */
export function resetEd25519ForTests() { mode = null; deciding = null; }
