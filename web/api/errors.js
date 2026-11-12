// The one error type of the SDK. Every failure the SDK raises is a TajweedError with a code from the
// catalogue shared by the four SDKs (errors-catalogue.js, generated from errors.json): `code` is stable,
// `message` says what happened, `fix` is one sentence a developer can act on, `docs` links the portal page.
//
// Internals keep their own error classes (ModelFolderError, DeliveryError, PlatformError, SharingError);
// toTajweedError maps each of them to a catalogue code at the public boundary.
import { ERRORS_JSON } from './errors-catalogue.js';

const CATALOGUE = JSON.parse(ERRORS_JSON);
const BY_CODE = new Map(CATALOGUE.errors.map((e) => [e.code, e]));
/** The catalogue's codes, in its order. */
export const ERROR_CODES = Object.freeze(CATALOGUE.errors.map((e) => e.code));

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, k) => (values[k] === undefined || values[k] === null ? '' : String(values[k])));
// a message whose only placeholder was left empty ("...: .") reads better without the dangling colon
const tidy = (s) => s.replace(/: \.$/, '.').replace(/\s+\./g, '.');

export class TajweedError extends Error {
  /**
   * @param {string} code  a catalogue code
   * @param {Record<string, unknown>} [values]  the placeholders of the catalogue's message and fix ({detail}, {file}, ...)
   * @param {{cause?: unknown}} [options]
   */
  constructor(code, values = {}, options = {}) {
    const entry = BY_CODE.get(code);
    if (!entry) throw new RangeError(`TajweedError: ${code} is not a catalogue code`);
    super(tidy(fill(entry.message, values)), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TajweedError';
    this.code = code;
    this.fix = tidy(fill(entry.fix, values));
    this.docs = CATALOGUE.docs_base + code;
  }
}

/** What the SDK needs to run, in one place: the {minimum} of runtime_unsupported and the README's "Before you start". */
export const RUNTIME_MINIMUM = 'a browser with WebAssembly SIMD, AudioWorklet and Ed25519 in WebCrypto (Chrome 137, Firefox 129, Safari 17, or later), or Node 20 or later';

/** The reasons of a refusal that have their own message and fix (the catalogue's server_rejected.reasons). */
const REASONS = BY_CODE.get('server_rejected').reasons || {};
export const REJECTION_REASONS = Object.freeze(Object.keys(REASONS));

/**
 * A refusal as a TajweedError: server_rejected with the message and fix of `reason` when the catalogue has it
 * (a 403 code of the server, or the origin check's answer), else the entry's own text with the code as {detail}.
 * No message text is written in code. `values`: { origin } for the reasons that name the page's origin.
 */
export function serverRejected(reason, values = {}, options = {}) {
  const err = new TajweedError('server_rejected', { detail: reason, ...values }, options);
  const r = Object.prototype.hasOwnProperty.call(REASONS, reason) ? REASONS[reason] : null;
  if (r) {
    err.message = tidy(fill(r.message, values));
    err.fix = tidy(fill(r.fix, values));
  }
  return err;
}

/**
 * The reasons that stop a model on this device (SPEC 15.3; the vector model_gate.json's `stop_reasons`). An
 * answer of the server stops a model exactly when its JSON body carries a `reason` of this list; an answer
 * without one never does, whatever its status and its `error`. THE ONE LIST: the server's, in one place.
 */
export const MODEL_STOP_REASONS = Object.freeze(['key_revoked', 'key_unknown', 'app_not_allowed', 'origin_not_allowed',
  'key_type_mismatch', 'app_blocked', 'developer_not_approved']);
/** The stop reasons whose error is `invalid_key` (the vector's `key_reasons`); the others are server_rejected. */
export const MODEL_KEY_REASONS = Object.freeze(['key_revoked', 'key_unknown']);
/** The stop reason an answer carries (its body's `reason` when it is of the list), or null: no stop. */
export const stopReasonOf = (reason) => (typeof reason === 'string' && MODEL_STOP_REASONS.includes(reason) ? reason : null);

/** The {detail} of download_failed for the CDN's 429 `model_limit` (SPEC 15.4). */
export const MODEL_LIMIT_DETAIL = "Quran Lab's daily limit for model downloads is reached; try again later";

/** An invalid argument, the API's most common refusal. */
export const invalid = (detail) => new TajweedError('invalid_argument', { detail });

const FOLDER = {
  manifest_missing: 'model_missing', file_missing: 'model_missing', manifest_invalid: 'model_invalid', not_listed: 'model_invalid',
  tokens_invalid: 'model_invalid', signature_invalid: 'signature_invalid', signature_required: 'signature_invalid',
  checksum_mismatch: 'checksum_mismatch', sdk_too_old: 'model_incompatible', format_unsupported: 'model_incompatible',
  engine_format_unsupported: 'model_incompatible', signature_unsupported: 'runtime_unsupported', version_missing: 'model_incompatible',
  version_mismatch: 'model_invalid', build_mismatch: 'checksum_mismatch',
};
const VERSION_RE = /\b(\d+\.\d+\.\d+)\b/;

/**
 * Any failure as a TajweedError. A TajweedError passes through; the internal classes map by their code;
 * anything else is `fallback` (engine_failed by default) with the original as `cause`.
 * @param {unknown} e
 * @param {{fallback?: string, sdk?: string, origin?: string}} [o]  origin: the page's origin, for a refusal that names it
 */
export function toTajweedError(e, { fallback = 'engine_failed', sdk = '', origin = '' } = {}) {
  if (e instanceof TajweedError) return e;
  const name = e && e.name, code = e && e.code, message = (e && e.message) || String(e);
  const make = (c, values = {}) => new TajweedError(c, { detail: message, ...values }, { cause: e });
  // a runtime that cannot check a signature at all (no Ed25519 in WebCrypto) is not a fault of the model
  if (name === 'ModelFolderError' && code === 'signature_unsupported') return make('runtime_unsupported', { detail: 'this runtime has no Ed25519 in WebCrypto', minimum: RUNTIME_MINIMUM });
  if (name === 'ModelFolderError' && FOLDER[code]) return make(FOLDER[code], { file: e.file || message });
  if (name === 'DeliveryError') {
    if (code === 'checksum_mismatch') return make('checksum_mismatch', { file: e.path || message });
    if (code === 'aborted') return make('cancelled');
    if (code === 'http' && (e.status === 401 || e.status === 403)) {
      // a model request the CDN refused: a revoked or unknown key is the key's error (also on a 401
      // invalid_token, which is then not renewed); else the answer's `reason` first, then its `error`, when the
      // catalogue has an entry for it; else a bare 401 is the key, and a 403 is a refusal with the code as its detail
      if (MODEL_KEY_REASONS.includes(e.reason)) return make('invalid_key');
      const why = [e.reason, e.error].find((x) => typeof x === 'string' && Object.prototype.hasOwnProperty.call(REASONS, x));
      if (why) return serverRejected(why, { origin }, { cause: e });
      // the token was renewed once and is refused again: the download failed, the key is not at fault
      if (e.status === 401 && e.error === 'invalid_token') return make('download_failed');
      if (e.status === 401) return make('invalid_key');
      return serverRejected(e.error || e.reason || 'http_403', { origin }, { cause: e });
    }
    // the daily limit of model downloads: try later, never a refusal
    if (code === 'http' && e.status === 429 && e.error === 'model_limit') return make('download_failed', { detail: MODEL_LIMIT_DETAIL });
    if (code === 'offline' && e.nothingCached) return make('needs_connection');
    return make('download_failed');
  }
  if (name === 'PlatformError') {
    // a revoked or unknown key, whatever `error` says (401 invalid_key, or a 401 invalid_token that is then not renewed)
    if (MODEL_KEY_REASONS.includes(e.reason)) return make('invalid_key');
    // the answer's `reason` first: when the catalogue has an entry for it, that refusal, whatever `error` says
    if (typeof e.reason === 'string' && Object.prototype.hasOwnProperty.call(REASONS, e.reason)) return serverRejected(e.reason, { origin: e.origin || origin }, { cause: e });
    if (code === 'invalid_key' || code === 'unauthorized') return make('invalid_key');
    if (code === 'sdk_too_old') {
      // the 403 body names the version (min_sdk); an older server's message may
      const v = e.minSdk || (VERSION_RE.exec(message) || [])[1];
      return make('sdk_too_old', { version: v || 'the newest release', sdk });
    }
    if (code === 'model_unavailable') return make('model_unavailable', { sdk });
    // a refusal: the reason's own message and fix when the catalogue has them (a 403 code, or the origin check's answer)
    if (e.status === 403 || REASONS[code]) return serverRejected(code, { origin: e.origin || origin }, { cause: e });
    if (e.status === 0 || code === 'offline') return make('needs_connection');
    return make('download_failed');
  }
  if (name === 'QuotaExceededError') return make('storage_full', { needed: 'more', available: 'too few' });
  if (name === 'AbortError') return make('cancelled');
  if (name === 'NotAllowedError' || name === 'SecurityError') return make('microphone_denied');
  if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError') return make('microphone_unavailable');
  if (e instanceof TypeError || e instanceof RangeError) return make('invalid_argument');
  return make(fallback);
}
