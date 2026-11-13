// Model folders and their signed manifest (manifest.json, formats 1, 2 and 3), for browsers and Node.
//
// The manifest lists every file of a model folder with its size and SHA-256, says which file plays
// which part, and may carry an Ed25519 signature over a plain-text rendering of all of it. The text
// is built exactly as tajweedformer-coreml's publish/make_manifest.py `signed_text` builds it (and
// tajweedformer-sdk-swift's ModelManifest.signedMessage), so the same signature verifies in every SDK;
// test/tajweed/manifest_v2_vector.json is the shared vector.
//
// A model folder for SDK 3.0 is manifest format 3 (engine_format 3) with a `version` (the model's semver;
// the folder is one build of it): min_sdk_version must be at most this SDK's version. calibration.json is
// read-only data and may be absent. A file the manifest does not list is never read. Hashing and the
// signature use WebCrypto (globalThis.crypto.subtle), present in every current browser and in Node 20 and later.

/** The version of this SDK, compared with a manifest's min_sdk_version. */
export const SDK_VERSION = '3.1.2';

/** Manifest formats this SDK reads. */
export const SUPPORTED_MANIFEST_FORMATS = Object.freeze([1, 2, 3]);
/** Engine formats this SDK knows: 1 = the v3 zipformer (the Zipformer class), 2 = V4 TajweedFormer. */
export const SUPPORTED_ENGINE_FORMATS = Object.freeze([1, 2, 3]);
/** The engine format of a V4 TajweedFormer folder in layout 1 (one engine folder per context). */
export const ENGINE_FORMAT_TAJWEEDFORMER = 2;
/** Engine formats of a V4 folder: 2 (layout 1), 3 (layout 3: one shared layers.zfw and frontend.zfw,
 * <ctx>/frames.zfw overlays; manifest format 3, big files stored gzip; contract LAYOUT.md v2). */
export const ENGINE_FORMATS_TAJWEEDFORMER = Object.freeze([2, 3]);
/** Platform order of a format 3 file's platforms field. */
export const V3_PLATFORMS = Object.freeze(['android', 'apple', 'web', 'native']);
const V3_HEADER = ['model_id', 'family', 'revision', 'min_sdk_version', 'engine_format', 'coreml_format', 'tokens',
  'tokens_sha256', 'default_context', 'contexts'];
/** The three values of a `golden_tolerance` entry, in the order of its signed line. */
export const GOLDEN_TOLERANCE_KEYS = Object.freeze(['token_diffs', 'site_flag_diffs', 'word_flag_diffs']);

/** Quran Lab's manifest signing key (raw Ed25519 public key, hex): the public half of qlab-cdn's and
 * qlab-api's MANIFEST_SIGNING_KEY, key id 660a07197c4808da, as compiled into the Swift and Android SDKs. */
export const QURANLAB_PUBLIC_KEY_HEX = 'fc02fbd906608ebc206a371d8e61c1062ea555778b44b1ac834061043aee4a33';

/** A model version: x.y.z, no leading zeros, no suffix (SPEC 2a). Anything else is not a version. */
export const MODEL_VERSION_RE = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,5})$/;
// a build key of a tolerance field: 1 to 64 printable ASCII characters (no space)
const BUILD_KEY_RE = /^[\x21-\x7e]{1,64}$/;
const RAW_HEAD_RE = /^[a-z][a-z0-9_]{0,31}$/;

const V2_FIELDS = ['model_id', 'family', 'revision', 'min_sdk_version', 'engine_format', 'coreml_format',
  'tokens_sha256', 'coreml', 'sidecar', 'keeps', 'tokens'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

/** Why a model folder was refused. `code` is one of: manifest_missing, manifest_invalid,
 * signature_invalid, signature_required, signature_unsupported, sdk_too_old, format_unsupported,
 * engine_format_unsupported, not_listed, file_missing, checksum_mismatch, calibration_invalid,
 * tokens_invalid. `file` names the file when one is at fault. */
export class ModelFolderError extends Error {
  constructor(code, message, file) {
    super(message);
    this.name = 'ModelFolderError';
    this.code = code;
    if (file !== undefined) this.file = file;
  }
}

const enc = new TextEncoder();
const utf8 = (s) => enc.encode(s);
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isInt = (x) => typeof x === 'number' && Number.isInteger(x);

function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Hex <-> bytes. */
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) throw new TypeError('not hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(2 * i, 2), 16);
  return out;
}
export function bytesToHex(b) {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
function base64ToBytes(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) return null;
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const asBytes = (d) => (d instanceof Uint8Array ? d : ArrayBuffer.isView(d)
  ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));

function subtle() {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new ModelFolderError('signature_unsupported', 'WebCrypto (crypto.subtle) is not available here; it needs a secure context in browsers');
  return s;
}

/** Lowercase hex SHA-256 of bytes. */
export async function sha256Hex(bytes) {
  return bytesToHex(new Uint8Array(await subtle().digest('SHA-256', asBytes(bytes))));
}

/**
 * The exact text the signature covers, for a manifest of format 1 or 2 (make_manifest.py
 * signed_text): a header line, the fields in a fixed order as "<key> <value>", then one
 * "file <sha256 lowercase> <size> <path>" line per file, sorted by the path's UTF-8 bytes.
 *
 * Format 3 (make_manifest3.py signed_text): the header lines; then, when the manifest has a
 * `golden_tolerance` field and `tolerance` is not false, one line per build sorted by the build
 * key's UTF-8 bytes, `golden_tolerance <build> <token_diffs> <site_flag_diffs> <word_flag_diffs>`
 * (each value as the JSON writes it, `-` when missing; as the Android SDK's Manifest.signedMessage);
 * then the `file` lines. Without the field the text is the 2.0.0 one, byte for byte.
 * @param {object} m  the parsed manifest.json
 * @param {{tolerance?: boolean}} [o]  tolerance: false leaves the golden_tolerance lines out
 * @returns {string}
 */
export function signedText(m, { tolerance = true, raw = true } = {}) {
  const files = [...m.files].sort((a, b) => compareBytes(utf8(a.path), utf8(b.path)));
  let t;
  if (m.format === 1) {
    t = `quranlab-model-manifest 1\nmodel ${m.model}\nrevision ${m.revision}\ncoreml ${m.coreml}\n`;
    t += `sidecar ${m.sidecar}\nkeeps ${m.keeps}\ntokens ${m.tokens}\n`;
  } else if (m.format === 2) {
    t = 'quranlab-model-manifest 2\n';
    for (const k of V2_FIELDS) t += `${k} ${m[k]}\n`;
  } else if (m.format === 3) {
    // contract LAYOUT.md v2 (tajweedformer-coreml publish/make_manifest3.py signed_text)
    t = 'quranlab-model-manifest 3\n';
    for (const k of V3_HEADER) {
      t += `${k} ${Array.isArray(m[k]) ? m[k].join(',') : m[k]}\n`;
      // SDK 3.0 (SPEC 2a): the model version, one line right after the revision, only when the field is present
      if (k === 'revision' && m.version !== undefined) t += `version ${m.version}\n`;
    }
    if (tolerance) t += toleranceLines(m.golden_tolerance);
    if (raw) t += rawToleranceLines(m.golden_raw_tolerance);
    const plat = (p) => (p === '*' ? '*' : V3_PLATFORMS.filter((x) => [].concat(p).includes(x)).join(','));
    for (const f of files) {
      const d = f.decoded || null;
      t += `file ${String(f.sha256).toLowerCase()} ${f.size} ${f.path} ${plat(f.platforms)} ${f.soc} ${f.context} ${f.role} ${f.need} ` +
        `${f.encoding} ${d ? String(d.sha256).toLowerCase() : '-'} ${d ? d.size : '-'} ${d ? d.path : '-'}\n`;
    }
    return t;
  } else {
    throw new ModelFolderError('format_unsupported', `manifest format ${m.format} is not supported`);
  }
  for (const f of files) t += `file ${String(f.sha256).toLowerCase()} ${f.size} ${f.path}\n`;
  return t;
}

// A count of a tolerance entry: a number with an integer value 0 to 1,000,000.
const isCount = (x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 1000000;
// A well-formed `golden_tolerance` entry: its three counts (other keys of the entry are ignored).
const toleranceEntryOk = (b, v) => BUILD_KEY_RE.test(b) && isObject(v) && GOLDEN_TOLERANCE_KEYS.every((k) => isCount(v[k]));

// The golden_tolerance lines of the signed text: one per WELL-FORMED entry, sorted by the build key's UTF-8
// bytes (none for an absent field or one that is not an object). An entry that is not well formed has no line.
function toleranceLines(gt) {
  if (!isObject(gt)) return '';
  return Object.keys(gt).filter((b) => toleranceEntryOk(b, gt[b]))
    .sort((a, b) => compareBytes(utf8(a), utf8(b)))
    .map((b) => `golden_tolerance ${b} ${GOLDEN_TOLERANCE_KEYS.map((k) => String(gt[b][k])).join(' ')}\n`).join('');
}

// A distance or probability of a golden_raw entry: a number in [0, max] with at most 6 digits after the dot.
const isRawNum = (x, max) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max && Number(x.toFixed(6)) === x;
const sameKeys = (o, keys) => { const k = Object.keys(o); return k.length === keys.length && keys.every((x) => k.includes(x)); };
// A well-formed build of `golden_raw_tolerance` (SPEC section 5): every head is `attr` with exactly { p_mean } or a
// CTC head name with exactly { token_edits, lp_mean, lp_p99 }, each in range. One bad head makes the build malformed.
function rawBuildOk(b, v) {
  if (!BUILD_KEY_RE.test(b) || !isObject(v)) return false;
  for (const [h, e] of Object.entries(v)) {
    if (!isObject(e)) return false;
    if (h === 'attr') { if (!(sameKeys(e, ['p_mean']) && isRawNum(e.p_mean, 1))) return false; continue; }
    if (!RAW_HEAD_RE.test(h)) return false;
    if (!(sameKeys(e, ['token_edits', 'lp_mean', 'lp_p99']) && isCount(e.token_edits) && isRawNum(e.lp_mean, 30) && isRawNum(e.lp_p99, 30))) return false;
  }
  return true;
}
// <num> of a golden_raw line: the value with 6 digits after the dot, trailing zeros removed, one digit kept
// ("0.05", "1.5", "2.0"). Made from the parsed number, never from the characters of the JSON.
const rawNum = (x) => x.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');

// The golden_raw lines of the signed text: one per head of each well-formed build, sorted by the bytes of
// "<build> <head>", after the golden_tolerance lines and before the first file line.
function rawToleranceLines(grt) {
  if (!isObject(grt)) return '';
  const rows = [];
  for (const b of Object.keys(grt)) {
    if (!rawBuildOk(b, grt[b])) continue;
    for (const [h, e] of Object.entries(grt[b])) {
      const line = h === 'attr' ? `golden_raw ${b} attr p_mean=${rawNum(e.p_mean)}\n`
        : `golden_raw ${b} ${h} token_edits=${String(e.token_edits)} lp_mean=${rawNum(e.lp_mean)} lp_p99=${rawNum(e.lp_p99)}\n`;
      rows.push([utf8(`${b} ${h}`), line]);
    }
  }
  return rows.sort((x, y) => compareBytes(x[0], y[0])).map((x) => x[1]).join('');
}

/**
 * The `golden_raw_tolerance` field read as signed (SPEC section 5): { tolerance: the well-formed builds,
 * tokensOnly: the malformed ones (judged on tokens only) }. null when the field is absent or not an object. The
 * web SDK has no accelerator and never applies it; it reads it because the signature covers its lines.
 */
export function parseGoldenRawTolerance(grt) {
  if (!isObject(grt)) return null;
  const tolerance = {}, tokensOnly = [];
  for (const [b, v] of Object.entries(grt)) { if (rawBuildOk(b, v)) tolerance[b] = v; else tokensOnly.push(b); }
  return { tolerance, tokensOnly };
}

/**
 * The `golden_tolerance` field read leniently: per accelerator build (`coreml`, `coreml-compact`,
 * `npu:<soc>:<context>`) its three counts, for each entry whose counts are integers 0 to 1000000;
 * any other entry is left out (that build is exact). null when the field is absent or not an
 * object. The web SDK runs the CPU engine only and never depends on it.
 * @returns {Record<string, {token_diffs: number, site_flag_diffs: number, word_flag_diffs: number}>|null}
 */
export function parseGoldenTolerance(gt) {
  if (!isObject(gt)) return null;
  const out = {};
  for (const [b, v] of Object.entries(gt)) {
    if (!toleranceEntryOk(b, v)) continue;
    out[b] = { token_diffs: v.token_diffs, site_flag_diffs: v.site_flag_diffs, word_flag_diffs: v.word_flag_diffs };
  }
  return out;
}

/** Whether `version` (x.y.z) is at or above `minimum`, part by part as numbers; a pre-release
 * suffix after "-" is ignored, missing parts count as 0, anything else makes it false (as Swift). */
export function versionAtLeast(version, minimum) {
  const parts = (v) => {
    if (typeof v !== 'string') return null;
    const core = v.split('-')[0];
    const p = core.split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
    return !p.length || p.some(Number.isNaN) ? null : p;
  };
  const a = parts(version), b = parts(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** A path a manifest may list: relative, "/"-separated, no empty, "." or ".." part, no backslash,
 * no drive letter, no NUL. */
export function isSafePath(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\') || p.includes('\0') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((s) => s && s !== '.' && s !== '..');
}

/**
 * Check a parsed manifest's shape (not the files, not the signature). Throws ModelFolderError.
 * @param {unknown} m
 * @returns {object} the same manifest
 */
export function checkManifestShape(m) {
  const bad = (why) => { throw new ModelFolderError('manifest_invalid', `manifest.json: ${why}`); };
  if (!isObject(m)) bad('not an object');
  if (!SUPPORTED_MANIFEST_FORMATS.includes(m.format)) {
    throw new ModelFolderError('format_unsupported', `manifest format ${JSON.stringify(m.format)} is not supported by this SDK`);
  }
  const strs = m.format === 1 ? ['model', 'revision', 'coreml', 'sidecar', 'keeps', 'tokens']
    : m.format === 2 ? ['model_id', 'family', 'revision', 'min_sdk_version', 'tokens_sha256', 'coreml', 'sidecar', 'keeps', 'tokens']
      : ['model_id', 'family', 'revision', 'min_sdk_version', 'tokens_sha256', 'tokens', 'default_context'];
  for (const k of strs) if (typeof m[k] !== 'string' || !m[k]) bad(`${k} missing`);
  if (m.format === 3) {
    if (!Array.isArray(m.contexts) || !m.contexts.length || m.contexts.some((c) => typeof c !== 'string' || !/^c\d+_l\d+$/.test(c))) bad('contexts');
    if (!m.contexts.includes(m.default_context)) bad('default_context is not one of contexts');
    // SDK 3.0 (SPEC 2a): a version, when present, is x.y.z without leading zeros or a suffix; so is min_sdk_version
    if (m.version !== undefined && (typeof m.version !== 'string' || !MODEL_VERSION_RE.test(m.version))) bad('version is not a model version (x.y.z)');
    if (!MODEL_VERSION_RE.test(m.min_sdk_version)) bad('min_sdk_version is not x.y.z');
  }
  if (m.format >= 2) {
    if (!ID_RE.test(m.model_id)) bad('model_id is not a model id');
    if (!ID_RE.test(m.family)) bad('family is not an id');
    if (!SEMVER_RE.test(m.min_sdk_version)) bad('min_sdk_version is not x.y.z');
    if (!isInt(m.engine_format)) bad('engine_format is not an integer');
    if (!isInt(m.coreml_format)) bad('coreml_format is not an integer');
    if (!HEX64_RE.test(m.tokens_sha256)) bad('tokens_sha256 is not a SHA-256');
  }
  if (!Array.isArray(m.files) || !m.files.length) bad('files missing');
  const seen = new Set();
  for (const f of m.files) {
    if (!isObject(f) || !isSafePath(f.path)) throw new ModelFolderError('manifest_invalid', `manifest.json: bad path ${JSON.stringify(f && f.path)}`);
    if (!isInt(f.size) || f.size < 0) bad(`size of ${f.path}`);
    if (typeof f.sha256 !== 'string' || !HEX64_RE.test(f.sha256)) bad(`sha256 of ${f.path}`);
    if (seen.has(f.path)) bad(`${f.path} is listed twice`);
    seen.add(f.path);
    if (m.format === 3) {
      const plats = f.platforms === '*' ? [] : f.platforms;
      if (!(f.platforms === '*' || (Array.isArray(plats) && plats.length && plats.every((x) => V3_PLATFORMS.includes(x))))) bad(`platforms of ${f.path}`);
      for (const k of ['soc', 'context', 'role']) if (typeof f[k] !== 'string' || !f[k]) bad(`${k} of ${f.path}`);
      if (!['required', 'optional'].includes(f.need)) bad(`need of ${f.path}`);
      if (f.encoding === 'gzip') {
        const d = f.decoded;
        if (!isObject(d) || !isSafePath(d.path) || !isInt(d.size) || d.size < 0 || !HEX64_RE.test(String(d.sha256))) bad(`decoded of ${f.path}`);
        if (seen.has('\0' + d.path)) bad(`${d.path} is decoded twice`);
        seen.add('\0' + d.path);
      } else if (f.encoding !== 'identity') {
        bad(`encoding of ${f.path}`);
      } else {
        if (seen.has('\0' + f.path)) bad(`${f.path} is listed twice`);
        seen.add('\0' + f.path);
      }
    }
  }
  if (m.signature !== undefined && typeof m.signature !== 'string') bad('signature is not a string');
  return m;
}

/**
 * Whether the signature verifies with one of `trustedKeys` (raw Ed25519 public keys, hex or bytes).
 * Throws ModelFolderError signature_unsupported when this runtime has no Ed25519 in WebCrypto.
 * @returns {Promise<boolean>}
 */
export async function verifyManifestSignature(m, trustedKeys = [QURANLAB_PUBLIC_KEY_HEX]) {
  return (await checkManifestSignature(m, trustedKeys)).valid;
}

/**
 * The signature check with what it covers. A manifest with `golden_tolerance` is verified with the
 * tolerance lines first; when that fails it is verified again without them, and if that passes the
 * tolerance is unsigned and ignored (toleranceSigned false: every build exact), as in the Android
 * and Swift SDKs. Throws ModelFolderError signature_unsupported as verifyManifestSignature.
 * @returns {Promise<{valid: boolean, toleranceSigned: boolean}>}
 */
export async function checkManifestSignature(m, trustedKeys = [QURANLAB_PUBLIC_KEY_HEX]) {
  const r = await verifySignedTexts(m, trustedKeys);
  return { valid: r.valid, toleranceSigned: r.toleranceSigned };
}

/**
 * The signature check of SDK 3.0 with everything it found: { valid, toleranceSigned, rawToleranceSigned, text }
 * (text: the signed text the signature verified on, or null).
 */
export async function verifySignedTexts(m, trustedKeys = [QURANLAB_PUBLIC_KEY_HEX]) {
  const no = { valid: false, toleranceSigned: false, rawToleranceSigned: false, text: null };
  const sig = base64ToBytes(m.signature);
  if (!sig || sig.length !== 64) return no;
  const s = subtle();
  const keys = [];
  for (const k of trustedKeys) {
    try {
      keys.push(await s.importKey('raw', typeof k === 'string' ? hexToBytes(k) : asBytes(k), { name: 'Ed25519' }, false, ['verify']));
    } catch (e) {
      if (e && (e.name === 'NotSupportedError' || /not supported|unrecognized/i.test(String(e.message)))) {
        throw new ModelFolderError('signature_unsupported', 'this runtime has no Ed25519 in WebCrypto, so the manifest signature cannot be checked');
      }
      // a malformed key never verifies
    }
  }
  const ok = async (text) => {
    const msg = utf8(text);
    for (const key of keys) if (await s.verify({ name: 'Ed25519' }, key, sig, msg)) return true;
    return false;
  };
  if (m.format !== 3) { const text = signedText(m); return (await ok(text)) ? { valid: true, toleranceSigned: false, rawToleranceSigned: false, text } : no; }
  // with the golden_tolerance and golden_raw lines; then without the raw lines (the raw tolerance then counts as
  // absent); then without the 2.x lines; then without both. A text equal to one already tried is skipped.
  const tried = new Set();
  for (const [tolerance, raw] of [[true, true], [true, false], [false, true], [false, false]]) {
    const text = signedText(m, { tolerance, raw });
    if (tried.has(text)) continue;
    tried.add(text);
    if (await ok(text)) {
      return { valid: true, toleranceSigned: tolerance && toleranceLines(m.golden_tolerance) !== '', rawToleranceSigned: raw && isObject(m.golden_raw_tolerance), text };
    }
  }
  return no;
}

// ---------------------------------------------------------------------------------------------
// Readers: where a folder's bytes come from. A reader is { read(path) -> Promise<Uint8Array|null> }
// (null: no such file). Paths are the manifest's, "/"-separated and already checked safe.
// ---------------------------------------------------------------------------------------------

/**
 * The acceptance checks of a manifest file, in their fixed order (the first that fails decides the code):
 * 1. a config named the build (`expect.build`): the SHA-256 of the bytes starts with it, else build_mismatch;
 * 2. the bytes are a JSON object of a known manifest shape, else manifest_invalid (format_unsupported);
 * 3. the signature verifies with a trusted key, else signature_invalid (an unsigned manifest: signature_required
 *    when `requireSignature`);
 * 4. with `requireVersion` (SDK 3.0 models): the manifest has `version`, else version_missing (a 2.x build);
 * 5. min_sdk_version is not above the SDK's, else sdk_too_old;
 * 6. a config named the version (`expect.version`): the manifest's equals it, else version_mismatch.
 * @param {Uint8Array} raw  manifest.json as stored
 * @param {object} [opts]  trustedKeys, requireSignature, requireVersion, sdkVersion, expect: { version, build }
 * @returns {Promise<{manifest: object, build: string, toleranceSigned: boolean, rawToleranceSigned: boolean, signedText: string|null}>}
 */
export async function acceptManifest(raw, opts = {}) {
  const expect = opts.expect || {};
  const build = (await sha256Hex(raw)).slice(0, 40);
  if (expect.build && !(await sha256Hex(raw)).startsWith(String(expect.build).toLowerCase())) {
    throw new ModelFolderError('build_mismatch', `manifest.json is not the build the config named (${expect.build})`, 'manifest.json');
  }
  let m;
  try { m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch (e) {
    throw new ModelFolderError('manifest_invalid', `manifest.json is not JSON: ${e.message}`, 'manifest.json');
  }
  checkManifestShape(m);
  let toleranceSigned = false, rawToleranceSigned = false, text = null;
  if (typeof m.signature === 'string') {
    const sig = await verifySignedTexts(m, opts.trustedKeys || [QURANLAB_PUBLIC_KEY_HEX]);
    if (!sig.valid) throw new ModelFolderError('signature_invalid', 'the manifest signature does not verify with a trusted key', 'manifest.json');
    ({ toleranceSigned, rawToleranceSigned, text } = sig);
  } else if (opts.requireSignature) {
    throw new ModelFolderError('signature_required', 'the manifest is not signed and a signature is required', 'manifest.json');
  }
  if (opts.requireVersion && m.version === undefined) {
    throw new ModelFolderError('version_missing', 'the manifest names no model version; this SDK needs a model build made for SDK 3.0.0 or later', 'manifest.json');
  }
  if (m.format >= 2) {
    const sdk = opts.sdkVersion || SDK_VERSION;
    if (!versionAtLeast(sdk, m.min_sdk_version)) {
      throw new ModelFolderError('sdk_too_old', `${m.model_id} ${m.revision} needs SDK ${m.min_sdk_version} or newer (this is ${sdk})`);
    }
  }
  if (expect.version && expect.version !== m.version) {
    throw new ModelFolderError('version_mismatch', `the manifest is model version ${m.version}, the config named ${expect.version}`, 'manifest.json');
  }
  return { manifest: m, build, toleranceSigned, rawToleranceSigned, signedText: text };
}

/**
 * A verified model folder. open() checks the manifest (shape, signature, compatibility, role files
 * listed) and, by default, every listed file's size and SHA-256; read() returns a listed file's
 * bytes, checked against the manifest on first read and cached only when `cache` is set.
 */
export class ModelFolder {
  /**
   * @param {{read(path: string): Promise<Uint8Array|null>}} reader
   * @param {object} [opts]
   * @param {string[]|Uint8Array[]} [opts.trustedKeys]  Ed25519 public keys (default: Quran Lab's)
   * @param {boolean} [opts.requireSignature=false]  refuse an unsigned manifest; a signature that is
   *        present must always verify
   * @param {'all'|'on-read'} [opts.verify='all']  check every listed file now, or each when read
   * @param {string} [opts.sdkVersion]  compared with min_sdk_version (default SDK_VERSION)
   * @param {number[]} [opts.engineFormats]  engine formats accepted (default SUPPORTED_ENGINE_FORMATS)
   */
  static async open(reader, opts = {}) {
    const raw = await reader.read('manifest.json');
    if (!raw) throw new ModelFolderError('manifest_missing', 'no manifest.json in the model folder', 'manifest.json');
    const { manifest: m, toleranceSigned, rawToleranceSigned, build } = await acceptManifest(raw, opts);

    // format 3: files are known by their DECODED path (what the engine opens); the stored (gzip) path is
    // how a reader fetches them. Formats 1 and 2: one path.
    const listed = new Map(m.files.map((f) => [logicalPath(f), logicalEntry(f)]));
    for (const role of m.format === 3 ? ['tokens'] : ['tokens', 'sidecar', 'keeps']) {
      const p = m[role];
      if (p === '-' && role !== 'tokens') continue;
      if (!listed.has(p)) throw new ModelFolderError('not_listed', `${role} ${p} is not listed in the manifest`, p);
    }
    if (m.format >= 2) {
      if (!(opts.engineFormats || SUPPORTED_ENGINE_FORMATS).includes(m.engine_format)) {
        throw new ModelFolderError('engine_format_unsupported', `engine format ${m.engine_format} is not supported by this SDK`);
      }
      if (listed.get(m.tokens).sha256.toLowerCase() !== m.tokens_sha256.toLowerCase()) {
        throw new ModelFolderError('manifest_invalid', `tokens_sha256 does not match ${m.tokens}`, m.tokens);
      }
    }

    const f = new ModelFolder();
    f.manifest = m;
    f._reader = reader;
    f._listed = listed;
    f._verified = new Set();
    f._cache = new Map();
    f._keep = !!opts.cache;
    // golden_tolerance only when the signature covers it; otherwise absent (every build exact)
    f.goldenTolerance = toleranceSigned ? parseGoldenTolerance(m.golden_tolerance) : null;
    f.goldenRawTolerance = rawToleranceSigned ? parseGoldenRawTolerance(m.golden_raw_tolerance) : null;
    // the build id (SPEC 2a): the first 40 hex of the SHA-256 of the manifest file as stored
    f.build = build;
    if ((opts.verify || 'all') === 'all') await f.verifyAll();
    return f;
  }

  /** The model id ("v4.0"); format 1's "model". */
  get modelId() { return this.manifest.format === 1 ? this.manifest.model : this.manifest.model_id; }
  /** engine_format (1 for a format 1 manifest). */
  get engineFormat() { return this.manifest.format === 1 ? 1 : this.manifest.engine_format; }
  /** A build's golden test tolerance when the signature covers golden_tolerance, else exact (zeros). */
  toleranceFor(build) {
    return (this.goldenTolerance && this.goldenTolerance[build]) || { token_diffs: 0, site_flag_diffs: 0, word_flag_diffs: 0 };
  }
  /** The manifest's entry of a logical path ({ path, size, sha256, stored, role, context, ... }), or null. */
  entry(path) { return this._listed.get(path) || null; }
  /** Logical paths whose role is `role`. */
  withRole(role) { return this.paths.filter((p) => this._listed.get(p).role === role); }
  /** Every listed path, sorted by UTF-8 bytes. */
  get paths() { return [...this._listed.keys()].sort((a, b) => compareBytes(utf8(a), utf8(b))); }
  /** Whether the manifest lists `path`. */
  has(path) { return this._listed.has(path); }
  /** Listed paths under a folder prefix ("c16_l64/"). */
  under(prefix) { const p = prefix.endsWith('/') ? prefix : prefix + '/'; return this.paths.filter((x) => x.startsWith(p)); }

  /** A listed file's bytes, its size and SHA-256 checked. Throws not_listed, file_missing or
   * checksum_mismatch. */
  async read(path) {
    const f = this._listed.get(path);
    if (!f) throw new ModelFolderError('not_listed', `${path} is not listed in the manifest`, path);
    if (this._cache.has(path)) return this._cache.get(path);
    let data = await this._reader.read(path);
    if (!data && f.stored) {
      // a reader of the transport folder: the stored (gzip) bytes, checked, then inflated
      const st = await this._reader.read(f.stored.path);
      if (!st) throw new ModelFolderError('file_missing', `${f.stored.path} is listed but missing`, f.stored.path);
      if (st.length !== f.stored.size || (await sha256Hex(st)) !== f.stored.sha256) {
        throw new ModelFolderError('checksum_mismatch', `${f.stored.path} does not match its size and SHA-256 in the manifest`, f.stored.path);
      }
      data = await gunzip(st);
    }
    if (!data) throw new ModelFolderError('file_missing', `${path} is listed but missing`, path);
    if (data.length !== f.size || (await sha256Hex(data)) !== f.sha256.toLowerCase()) {
      throw new ModelFolderError('checksum_mismatch', `${path} does not match its size and SHA-256 in the manifest`, path);
    }
    this._verified.add(path);
    if (this._keep) this._cache.set(path, data);
    return data;
  }

  /** A listed text file, UTF-8. */
  async readText(path) { return new TextDecoder('utf-8', { fatal: true }).decode(await this.read(path)); }

  /** Check every listed file now. */
  async verifyAll() {
    for (const p of this.paths) if (!this._verified.has(p)) await this.read(p);
  }
}

/** A format 3 file's decoded path (the path the engine opens); the path itself otherwise. */
export function logicalPath(f) { return f.encoding === 'gzip' && f.decoded ? f.decoded.path : f.path; }

/** { path, size, sha256 } of the logical (decoded) file, with `stored` for a gzip transport file and
 * the delivery tags of format 3. */
function logicalEntry(f) {
  if (f.encoding === 'gzip' && f.decoded) {
    return { path: f.decoded.path, size: f.decoded.size, sha256: String(f.decoded.sha256).toLowerCase(),
      stored: { path: f.path, size: f.size, sha256: String(f.sha256).toLowerCase() },
      platforms: f.platforms, soc: f.soc, context: f.context, role: f.role, need: f.need };
  }
  return { path: f.path, size: f.size, sha256: String(f.sha256).toLowerCase(), stored: null,
    platforms: f.platforms, soc: f.soc, context: f.context, role: f.role, need: f.need };
}

/** gzip -> bytes with the platform's DecompressionStream (browsers, Node 18+). */
export async function gunzip(bytes) {
  if (typeof globalThis.DecompressionStream !== 'function') {
    throw new ModelFolderError('format_unsupported', 'this runtime has no DecompressionStream for gzip files');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new globalThis.DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Parse tokens.txt ("<symbol> <id>" per line, or one symbol per line) into an id-indexed array. */
export function parseTokens(text) {
  const out = [];
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  lines.forEach((l, i) => {
    const m = /^(.*\S)\s+(\d+)$/.exec(l);
    if (m) out[Number(m[2])] = m[1]; else out[i] = l.trim();
  });
  return out;
}

/**
 * Open a TajweedFormer model folder for SDK 3.0: manifest format 3 with engine_format 3 and a `version`
 * (SPEC 2a: a manifest without one is refused), tokens.txt with 38 entries. calibration.json is not needed:
 * when listed it is handed over as data by the caller. `expect` names what the signed config asked for:
 * the model version the manifest must carry and the build (the manifest's SHA-256 must start with it).
 * @param {{read(path: string): Promise<Uint8Array|null>}} reader
 * @param {object} [opts]  as ModelFolder.open, plus expect: { version?: string, build?: string }
 * @returns {Promise<{ folder: ModelFolder, tokens: string[], contexts: string[], version: string, build: string }>}
 */
export async function openTajweedFolder(reader, opts = {}) {
  const folder = await ModelFolder.open(reader, { ...opts, engineFormats: [3], requireVersion: true });
  const m = folder.manifest;
  if (!(m.format === 3 && m.engine_format === 3)) {
    throw new ModelFolderError('format_unsupported', 'a TajweedFormer folder needs manifest format 3 (engine_format 3)');
  }
  const tokens = parseTokens(await folder.readText(m.tokens));
  if (tokens.length !== 38 || tokens.some((t) => t === undefined)) {
    throw new ModelFolderError('tokens_invalid', `${m.tokens} has ${tokens.length} entries, a TajweedFormer has 38`, m.tokens);
  }
  return { folder, tokens, contexts: [...m.contexts], version: m.version, build: folder.build };
}

/** Two model versions compared part by part as integers: -1, 0 or 1; null when either is not a version. */
export function compareModelVersions(a, b) {
  const pa = MODEL_VERSION_RE.exec(String(a)), pb = MODEL_VERSION_RE.exec(String(b));
  if (!pa || !pb || typeof a !== 'string' || typeof b !== 'string') return null;
  for (let i = 1; i <= 3; i++) { const x = Number(pa[i]), y = Number(pb[i]); if (x !== y) return x < y ? -1 : 1; }
  return 0;
}
