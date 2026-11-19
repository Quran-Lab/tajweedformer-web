// Ed25519 signature verification (RFC 8032) for the signed engine index. One verifier for the whole SDK
// (web/platform/ed25519.js, which the signed config and the 3.x manifest use too): WebCrypto's Ed25519 where the
// runtime has it, and where it does not (Chrome before 137, Safari before 17) the vendored @noble/ed25519 2.3.0
// (web/third_party/noble-ed25519, MIT, verify only, ZIP 215 off). So the frame never depends on WebCrypto's Ed25519;
// what the Core verifies (the lease, a signed stop, the data piece) it verifies itself. Nothing here holds a private
// key. Before, this file had a BigInt implementation of its own.
import { verifyEd25519, verifyFallback as vendored } from '../../web/platform/ed25519.js';

/** The vendored verifier alone (the path of a runtime without Ed25519 in WebCrypto). Never throws. */
export const verifyFallback = (pub, msg, sig) => vendored(pub, sig, msg);

/**
 * True when `sig` is a valid Ed25519 signature of `msg` by the 32-byte public key `pub`. Never throws: a runtime with
 * no WebCrypto at all (never a frame served over https) is a false answer.
 */
export async function verify(pub, msg, sig) {
  try { return await verifyEd25519(pub, sig, msg); } catch (_) { return false; }
}

/** The key id of an Ed25519 public key: the first 8 bytes of its SHA-256, as hex (the config's x-qlab-key-id). */
export async function keyIdOf(pub) {
  const h = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', pub));
  return [...h.subarray(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
