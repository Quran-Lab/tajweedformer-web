// Bytes, hex, base64url, UTF-8 and SHA-256, the same in a page, a frame, a Worker and Node. No dependencies.

export const utf8 = (s) => new TextEncoder().encode(s);
export const fromUtf8 = (b) => new TextDecoder('utf-8', { fatal: true }).decode(b);

export function hex(b) {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function unhex(s) {
  if (typeof s !== 'string' || s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new TypeError('not hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** base64url without padding (RFC 4648 section 5). */
export function b64u(b) {
  let s = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < b.length) {
    const n = (b[i] << 16) | ((i + 1 < b.length ? b[i + 1] : 0) << 8);
    s += B64[n >> 18] + B64[(n >> 12) & 63];
    if (i + 1 < b.length) s += B64[(n >> 6) & 63];
  }
  return s;
}

export function unb64u(s) {
  if (typeof s !== 'string' || s.length % 4 === 1) throw new TypeError('not base64url');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0, acc = 0, bits = 0;
  for (const c of s) {
    const v = B64_INDEX.get(c);
    if (v === undefined) throw new TypeError('not base64url');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return out.subarray(0, o);
}

export function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function equal(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export const subtle = () => globalThis.crypto.subtle;

export async function sha256(b) { return new Uint8Array(await subtle().digest('SHA-256', b)); }
export async function sha256Hex(b) { return hex(await sha256(b)); }

export function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 65536) globalThis.crypto.getRandomValues(out.subarray(at, Math.min(n, at + 65536)));
  return out;
}
