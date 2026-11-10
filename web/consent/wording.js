// An app's own wording for the sharing copy (SDK 2.0.1; the platform client doc, "Your own wording"). When an
// app replaces deck strings, the learner agrees to that text, so the grant is recorded under a version derived
// from it and every session of that grant sends the text's hash for Quran Lab to review:
//
//   canonical = "quranlab.consent-text/1\n" + "base " + <deck consent_version> + "\n"
//               + for each replaced key, sorted by its UTF-8 bytes: key + "\t" + escaped text + "\n"
//   escaped   = \ -> \\, newline -> \n, carriage return -> \r, tab -> \t (nothing else, no normalisation)
//   consent_text_sha256 = SHA-256 of the canonical UTF-8 bytes, lower-case hex
//   consent_version     = "custom-" + its first 24 hex digits
//
// The same derivation in every SDK, pinned by the shared vector consent_text.json. Synchronous (a small
// SHA-256 here) so the consent state can compare versions at any moment.
// Tried and rejected: WebCrypto's digest (async: the version would not be known when a sheet answer or a
// settings switch has to be recorded); JSON canonicalisation (encoders escape differently across platforms).

import { DECKS } from './decks.js';

export const CONSENT_TEXT_FORMAT = 'quranlab.consent-text/1';
/** CLDR plural categories a plural line may be given for (`impact.minutes.one`, ...). */
export const PLURAL_CATEGORIES = Object.freeze(['zero', 'one', 'two', 'few', 'many', 'other']);

const utf8 = (s) => new TextEncoder().encode(s);

// ------------------------------------------------------------------------------------------------
// SHA-256 (FIPS 180-4), synchronous

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of bytes, lower-case hex. */
export function sha256HexSync(bytes) {
  const len = bytes.length;
  const blocks = Math.ceil((len + 9) / 64);
  const m = new Uint8Array(blocks * 64);
  m.set(bytes);
  m[len] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(m.length - 8, Math.floor(len / 0x20000000), false);
  dv.setUint32(m.length - 4, (len * 8) >>> 0, false);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(b * 64 + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, bb, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

// ------------------------------------------------------------------------------------------------

/** The keys an app may replace: every string key of the decks, and each plural line by category. */
export function wordingKeys() {
  const keys = new Set();
  for (const d of Object.values(DECKS)) {
    for (const [k, v] of Object.entries(d.strings)) {
      if (typeof v === 'string') keys.add(k);
      else if (v && typeof v === 'object') for (const c of PLURAL_CATEGORIES) keys.add(`${k}.${c}`);
    }
  }
  return keys;
}

const compareUtf8 = (a, b) => {
  const x = utf8(a), y = utf8(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};
const escape = (t) => t.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');

/**
 * Checks an app's overrides: an object of deck keys to non-blank strings. Throws a TypeError naming the
 * first problem (an unknown key, a text that is not a string, empty or blank); returns a frozen copy.
 * null, undefined or {} mean no overrides.
 */
export function validateWording(overrides) {
  if (overrides === null || overrides === undefined) return Object.freeze({});
  if (typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('wording: an object of {key: text}');
  const keys = wordingKeys();
  const out = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (!keys.has(k)) throw new TypeError(`wording: unknown key ${JSON.stringify(k)}`);
    if (typeof v !== 'string') throw new TypeError(`wording: ${k} is not a string`);
    if (!v.length) throw new TypeError(`wording: ${k} is empty`);
    if (/^\s*$/u.test(v)) throw new TypeError(`wording: ${k} is blank`);
    out[k] = v;
  }
  return Object.freeze(out);
}

/** The canonical text of a wording (a string; its UTF-8 bytes are what is hashed), or null without overrides. */
export function canonicalConsentText(base, overrides) {
  const keys = Object.keys(overrides || {});
  if (!keys.length) return null;
  let out = `${CONSENT_TEXT_FORMAT}\nbase ${base}\n`;
  for (const k of keys.sort(compareUtf8)) out += `${k}\t${escape(overrides[k])}\n`;
  return out;
}

/**
 * The consent a learner gives under a deck and an app's overrides:
 * { version, textSha256, canonicalText }; without overrides the deck's version and nulls.
 */
export function deriveConsent(base, overrides) {
  const canonicalText = canonicalConsentText(base, overrides);
  if (canonicalText === null) return Object.freeze({ version: base, textSha256: null, canonicalText: null });
  const textSha256 = sha256HexSync(utf8(canonicalText));
  return Object.freeze({ version: `custom-${textSha256.slice(0, 24)}`, textSha256, canonicalText });
}
