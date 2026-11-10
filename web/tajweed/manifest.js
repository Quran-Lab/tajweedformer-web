// Model folders and their signed manifest (manifest.json, formats 1, 2 and 3), for browsers and Node.
//
// The manifest lists every file of a model folder with its size and SHA-256, says which file plays
// which part, and may carry an Ed25519 signature over a plain-text rendering of all of it. The text
// is built exactly as tajweedformer-coreml's publish/make_manifest.py `signed_text` builds it (and
// tajweedformer-sdk-swift's ModelManifest.signedMessage), so the same signature verifies in every SDK;
// test/tajweed/manifest_v2_vector.json is the shared vector.
//
// A V4 folder (sdk/v4.0) is manifest format 2 with engine_format 2: calibration.json and the expected
// table must be listed, min_sdk_version must be at most this SDK's version. A file the manifest does
// not list is never read. Hashing and the signature use WebCrypto (globalThis.crypto.subtle), present
// in every current browser and in Node 20 and later.

import { validateCalibration, TajweedSettingsError } from './settings.js';

/** The version of this SDK, compared with a manifest's min_sdk_version. */
export const SDK_VERSION = '2.0.2';

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

/** Files a V4 folder must list besides the manifest's own role files (tokens, sidecar, keeps). */
export const V4_REQUIRED_FILES = Object.freeze(['calibration.json', 'expected_tj3.zfx']);

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
export function signedText(m, { tolerance = true } = {}) {
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
    for (const k of V3_HEADER) t += `${k} ${Array.isArray(m[k]) ? m[k].join(',') : m[k]}\n`;
    if (tolerance) t += toleranceLines(m.golden_tolerance);
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

// The golden_tolerance lines of the signed text: every entry whose value is an object, sorted by
// the build key's UTF-8 bytes (none for an absent field or one that is not an object).
function toleranceLines(gt) {
  if (!isObject(gt)) return '';
  const val = (x) => (x === undefined || x === null ? '-' : String(x));
  return Object.keys(gt).filter((b) => isObject(gt[b]))
    .sort((a, b) => compareBytes(utf8(a), utf8(b)))
    .map((b) => `golden_tolerance ${b} ${GOLDEN_TOLERANCE_KEYS.map((k) => val(gt[b][k])).join(' ')}\n`).join('');
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
  const count = (x) => isInt(x) && x >= 0 && x <= 1000000;
  for (const [b, v] of Object.entries(gt)) {
    if (!b || /[ \n]/.test(b) || !isObject(v) || !GOLDEN_TOLERANCE_KEYS.every((k) => count(v[k]))) continue;
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
  const no = { valid: false, toleranceSigned: false };
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
  const hasTolerance = m.format === 3 && m.golden_tolerance !== undefined && m.golden_tolerance !== null;
  if (!hasTolerance) return { valid: await ok(signedText(m, { tolerance: false })), toleranceSigned: false };
  if (await ok(signedText(m))) return { valid: true, toleranceSigned: true };
  return { valid: await ok(signedText(m, { tolerance: false })), toleranceSigned: false };
}

// ---------------------------------------------------------------------------------------------
// Readers: where a folder's bytes come from. A reader is { read(path) -> Promise<Uint8Array|null> }
// (null: no such file). Paths are the manifest's, "/"-separated and already checked safe.
// ---------------------------------------------------------------------------------------------

/** A folder held in memory: { 'manifest.json': bytes, 'c16_l64/layers.zfw': bytes, ... }. */
export function memoryReader(files) {
  const map = new Map(Object.entries(files || {}));
  return { async read(path) { const d = map.get(path); return d === undefined ? null : asBytes(d); } };
}

/** A folder served over HTTP(S): `baseUrl` + path, with `fetch` (or the one given). A 404 is a
 * missing file; any other failure throws. */
export function urlReader(baseUrl, fetchImpl = globalThis.fetch) {
  const base = String(baseUrl).endsWith('/') ? String(baseUrl) : String(baseUrl) + '/';
  return {
    async read(path) {
      const r = await fetchImpl(base + path.split('/').map(encodeURIComponent).join('/'));
      if (r.status === 404) return null;
      if (!r.ok) throw new ModelFolderError('file_missing', `${path}: HTTP ${r.status}`, path);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
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
    let m;
    try { m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch (e) {
      throw new ModelFolderError('manifest_invalid', `manifest.json is not JSON: ${e.message}`, 'manifest.json');
    }
    checkManifestShape(m);

    let toleranceSigned = false;
    if (typeof m.signature === 'string') {
      const sig = await checkManifestSignature(m, opts.trustedKeys || [QURANLAB_PUBLIC_KEY_HEX]);
      if (!sig.valid) throw new ModelFolderError('signature_invalid', 'the manifest signature does not verify with a trusted key', 'manifest.json');
      toleranceSigned = sig.toleranceSigned;
    } else if (opts.requireSignature) {
      throw new ModelFolderError('signature_required', 'the manifest is not signed and a signature is required', 'manifest.json');
    }

    // format 3: files are known by their DECODED path (what the engine opens); the stored (gzip) path is
    // how a reader fetches them. Formats 1 and 2: one path.
    const listed = new Map(m.files.map((f) => [logicalPath(f), logicalEntry(f)]));
    for (const role of m.format === 3 ? ['tokens'] : ['tokens', 'sidecar', 'keeps']) {
      const p = m[role];
      if (p === '-' && role !== 'tokens') continue;
      if (!listed.has(p)) throw new ModelFolderError('not_listed', `${role} ${p} is not listed in the manifest`, p);
    }
    if (m.format >= 2) {
      const sdk = opts.sdkVersion || SDK_VERSION;
      if (!versionAtLeast(sdk, m.min_sdk_version)) {
        throw new ModelFolderError('sdk_too_old', `${m.model_id} ${m.revision} needs SDK ${m.min_sdk_version} or newer (this is ${sdk})`);
      }
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
 * Open a V4 TajweedFormer folder (sdk/v4.0): a format 2 manifest with engine_format 2, every
 * V4_REQUIRED_FILES entry listed, calibration.json valid and naming the manifest's model, tokens.txt
 * with 38 entries matching calibration's tokens_sha256 when it gives one.
 * @param {{read(path: string): Promise<Uint8Array|null>}} reader
 * @param {object} [opts]  as ModelFolder.open
 * @returns {Promise<{ folder: ModelFolder, calibration: object, tokens: string[], contexts: string[] }>}
 */
export async function openTajweedFolder(reader, opts = {}) {
  const folder = await ModelFolder.open(reader, { ...opts, engineFormats: [...ENGINE_FORMATS_TAJWEEDFORMER] });
  const m = folder.manifest;
  if (!(m.format === 2 && m.engine_format === 2) && !(m.format === 3 && m.engine_format === 3)) {
    throw new ModelFolderError('format_unsupported', 'a TajweedFormer folder needs manifest format 2 (engine_format 2) or 3 (engine_format 3)');
  }
  for (const p of V4_REQUIRED_FILES) {
    if (!folder.has(p)) throw new ModelFolderError('not_listed', `${p} is required by a TajweedFormer folder and is not listed`, p);
  }
  let calibration;
  try {
    calibration = validateCalibration(JSON.parse(await folder.readText('calibration.json')));
  } catch (e) {
    if (e instanceof ModelFolderError) throw e;
    throw new ModelFolderError('calibration_invalid', `calibration.json: ${e instanceof TajweedSettingsError ? e.message : e}`, 'calibration.json');
  }
  if (calibration.model_id !== m.model_id) {
    throw new ModelFolderError('calibration_invalid', `calibration.json is for ${calibration.model_id}, the manifest for ${m.model_id}`, 'calibration.json');
  }
  if (HEX64_RE.test(calibration.tokens_sha256 || '') && calibration.tokens_sha256.toLowerCase() !== m.tokens_sha256.toLowerCase()) {
    throw new ModelFolderError('calibration_invalid', 'calibration.json tokens_sha256 does not match the manifest', 'calibration.json');
  }
  const tokens = parseTokens(await folder.readText(m.tokens));
  if (tokens.length !== 38 || tokens.some((t) => t === undefined)) {
    throw new ModelFolderError('tokens_invalid', `${m.tokens} has ${tokens.length} entries, a TajweedFormer has 38`, m.tokens);
  }
  if (m.format === 3) {
    const a = [...m.contexts].sort().join(','), c = Object.keys(calibration.contexts).sort().join(',');
    if (a !== c) throw new ModelFolderError('calibration_invalid', `the manifest's contexts (${a}) are not calibration.json's (${c})`, 'calibration.json');
  }
  return { folder, calibration, tokens, contexts: Object.keys(calibration.contexts) };
}
