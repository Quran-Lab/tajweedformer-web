// Error reports (quranlab-contract sdk_4.0.0 ERRORS_40.md, section 24; web 3.1.7): every failure that reaches the
// app, and every silent degradation of 24.1's list, becomes one small report on POST /v1/issues with kind "error":
// where it failed (the stage of the cause), why (a reason token), what the app was told (the TajweedError code, or
// "none"), and what this browser can do. One report per install, UTC day and signature, with a count; at most 16
// signatures a day and 32 queued; sent at the launch, at every telemetry send point and 30 s after a new one.
//
// Never in a report: audio, text, a message, a URL or path, the user agent string, an identifier. An error's
// message is read here only to tell its class (a CompileError from a memory failure); it never leaves this file.
import { utcDay } from './telemetry.js';
import { ed25519Known } from './ed25519.js';

export const STAGES = Object.freeze(['config', 'register', 'attest', 'lease', 'manifest', 'download', 'verify', 'storage', 'runtime',
  'model_open', 'accelerator', 'audio', 'session', 'sharing', 'events']);
/** The codes that only say the app used the API wrongly: never reported (24.1). */
export const NOT_REPORTED = Object.freeze(['invalid_argument', 'client_exists', 'session_open', 'session_closed', 'cancelled']);
export const LIMITS = Object.freeze({ dailySignatures: 16, queueMax: 32, reportedMax: 64, firstAgainDays: 90, keepDays: 7, countMax: 100_000 });
/** 30 s after an occurrence that made a new report, while the page is visible (24.6). */
export const SEND_AFTER_MS = 30_000;

const TOKEN = /^[a-z][a-z0-9_]{0,31}$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.:$-]{0,47}$/;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,32}$/;
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const DAY_MS = 86_400_000;
const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);

/** 24.5: the signature string of a report. */
export const signatureOf = (stage, reason, code, status) => `error\n${stage}\n${reason}\n${code}\n${status || 0}`;

/** Whether a failure makes a report at all (24.1): never the app's own misuse, never a silent plain network failure. */
export const reportable = (stage, reason, code) => !NOT_REPORTED.includes(code) && !(code === 'none' && reason === 'network');

/** 24.8: the telemetry name of a download failure's reason. */
export function telemetryReason(reason) {
  return { network: 'network', timeout: 'network', http: 'http', rate_limited: 'http', refused: 'http', redirect: 'http',
    invalid_answer: 'http', hash: 'hash_mismatch', signature: 'signature', storage: 'storage', quota: 'storage' }[reason] || 'other';
}

// ---- 24.7: what the page can tell ----

const UAD_BRANDS = [['Microsoft Edge', 'edge'], ['Opera', 'opera'], ['Opera GX', 'opera'], ['Samsung Internet', 'samsung'],
  ['Android WebView', 'webview'], ['Google Chrome', 'chrome'], ['Chromium', 'chromium']];
const UAD_OS = { Android: 'android', iOS: 'ios', Windows: 'windows', macOS: 'macos', 'Chrome OS': 'chromeos', ChromeOS: 'chromeos', Linux: 'linux' };
const UA_RULES = [[/SamsungBrowser\/(\d+)/, 'samsung'], [/Edg(?:A|iOS)?\/(\d+)/, 'edge'], [/OPR\/(\d+)/, 'opera'],
  [/FxiOS\/(\d+)/, 'firefox'], [/CriOS\/(\d+)/, 'chrome'], [/Firefox\/(\d+)/, 'firefox']];
const major = (v) => { const m = /^(\d+)/.exec(String(v)); return m ? Math.min(999, Number(m[1])) : 0; };

/** browser, browser_major, os, mobile from the user agent string and navigator.userAgentData, exactly as 24.7 says. */
export function parseBrowser(ua = '', uad = null, maxTouch = 0) {
  let browser = null, ver = 0;
  if (uad && Array.isArray(uad.brands)) {
    const have = new Map(uad.brands.map((b) => [b && b.brand, b && b.version]));
    for (const [brand, name] of UAD_BRANDS) if (have.has(brand)) { browser = name; ver = major(have.get(brand)); break; }
  }
  if (!browser) {
    for (const [rx, name] of UA_RULES) { const m = rx.exec(ua); if (m) { browser = name; ver = major(m[1]); break; } }
  }
  if (!browser) {
    const c = /Chrome\/(\d+)/.exec(ua), v = /Version\/(\d+)/.exec(ua);
    if (c && ua.includes('; wv)')) { browser = 'webview'; ver = major(c[1]); }
    else if (c) { browser = 'chrome'; ver = major(c[1]); }
    else if (v && ua.includes('Safari/')) { browser = 'safari'; ver = major(v[1]); }
    else if (/iPhone|iPad|iPod/.test(ua) && ua.includes('AppleWebKit') && !ua.includes('Safari/')) {
      const o = /OS (\d+)_/.exec(ua);
      browser = 'wkwebview'; ver = o ? major(o[1]) : 0;
    } else { browser = 'other'; ver = 0; }
  }
  let os;
  const plat = uad && uad.platform;
  if (plat) os = UAD_OS[plat] || 'other';
  else if (ua.includes('Android')) os = 'android';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'ios';
  else if (ua.includes('CrOS')) os = 'chromeos';
  else if (ua.includes('Windows')) os = 'windows';
  else if (ua.includes('Macintosh')) os = maxTouch > 1 ? 'ios' : 'macos';
  else if (ua.includes('Linux')) os = 'linux';
  else os = 'other';
  const mobile = uad && typeof uad.mobile === 'boolean' ? uad.mobile : /Mobi|iPhone|iPod/.test(ua);
  return { browser, browser_major: ver, os, mobile };
}

/** 24.7: free bytes to the bucket. */
export function storageBucket(n) {
  return n < 100e6 ? 'lt_100m' : n < 500e6 ? 'lt_500m' : n < 1e9 ? 'lt_1g' : n < 5e9 ? 'lt_5g' : 'ge_5g';
}

/** The two WebAssembly feature modules of 24.7 (wasm-feature-detect's). */
export const SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
export const THREADS = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11]);
let probed = null; // the two WebAssembly probes, once per page
function wasmProbes() {
  if (probed) return probed;
  const W = globalThis.WebAssembly;
  const ok = (bytes) => { try { return !!W && W.validate(bytes); } catch (_) { return false; } };
  let sabPost = false;
  try {
    if (typeof SharedArrayBuffer === 'function' && typeof MessageChannel === 'function') {
      const ch = new MessageChannel();
      ch.port1.postMessage(new SharedArrayBuffer(1));
      ch.port1.close(); ch.port2.close();
      sabPost = true;
    }
  } catch (_) { sabPost = false; }
  probed = { wasm: !!W, simd: ok(SIMD), threads: sabPost && ok(THREADS) };
  return probed;
}

const safe = (f) => { try { return f(); } catch (_) { return undefined; } };
const isNode = () => typeof process !== 'undefined' && !!(process.versions && process.versions.node) && typeof globalThis.window === 'undefined';
const MEMORY = ['0.25', '0.5', '1', '2', '4', '8'];

// navigator.storage.estimate(): asked at most once a minute, never waited on for more than 500 ms (24.7)
const estimate = { at: -Infinity, bucket: null };
export function refreshStorageEstimate(now = Date.now()) {
  if (now - estimate.at < 60_000) return;
  estimate.at = now;
  const s = safe(() => globalThis.navigator && globalThis.navigator.storage);
  if (!s || typeof s.estimate !== 'function') return;
  let done = false;
  const timer = setTimeout(() => { done = true; }, 500);
  if (timer && typeof timer.unref === 'function') timer.unref();
  Promise.resolve().then(() => s.estimate()).then((e) => {
    clearTimeout(timer);
    if (done || !e || !Number.isFinite(e.quota) || !Number.isFinite(e.usage)) return;
    estimate.bucket = storageBucket(Math.max(0, e.quota - e.usage));
  }, () => { clearTimeout(timer); });
}

/** What this runtime can do, read without a prompt at the time of a failure (24.2 error.web). `worker`: whether the
 * engine runs in a Worker, when an engine was started. */
export function webSnapshot({ worker } = {}) {
  const g = globalThis;
  const w = wasmProbes();
  const out = {};
  if (isNode()) {
    out.browser = 'node';
    out.browser_major = major(process.versions.node);
    out.os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] || 'other';
    out.mobile = false;
  } else {
    const nav = g.navigator || {};
    Object.assign(out, parseBrowser(String(nav.userAgent || ''), safe(() => nav.userAgentData) || null, Number(nav.maxTouchPoints) || 0));
  }
  out.coi = g.crossOriginIsolated === true;
  out.simd = w.simd;
  out.threads = w.threads;
  out.sab = typeof SharedArrayBuffer === 'function';
  out.webcrypto = !!(g.crypto && g.crypto.subtle);
  const ed = ed25519Known();
  if (ed === 'webcrypto' || ed === 'fallback') out.ed25519 = ed === 'webcrypto';
  out.worklet = typeof g.AudioWorkletNode === 'function';
  if (typeof worker === 'boolean') out.worker = worker;
  out.cache_api = !!safe(() => g.caches);
  out.idb = !!safe(() => g.indexedDB);
  const nav = g.navigator;
  if (nav && typeof nav.onLine === 'boolean') out.online = nav.onLine;
  const dm = nav && nav.deviceMemory;
  if (dm !== undefined && MEMORY.includes(String(dm))) out.device_memory = String(dm);
  if (estimate.bucket) out.storage_free = estimate.bucket;
  return out;
}

// ---- what failed: the stage and reason of an internal failure ----

/** Mark a failure where it is seen with what only that place knows ({ stage, reason, http_status, error_code }); the
 * first mark stays. Returns the failure. */
export function tag(e, info) {
  if (e && typeof e === 'object' && !e.qlReport) { try { Object.defineProperty(e, 'qlReport', { value: info, configurable: true }); } catch (_) { /* a frozen error keeps its class's reading */ } }
  return e;
}

const INTERNAL = new Set(['TajweedError', 'PlatformError', 'DeliveryError', 'ModelFolderError', 'SharingError', 'SdkError', 'CoreError', 'Error']);
const MEMORY_RE = /out of memory|could not allocate|allocation failed|cannot allocate|Memory\(\)|grow memory|memory access out of bounds|OOM/i;
const FETCH_RE = /failed to fetch|fetching of the wasm failed|failed to load wasm|networkerror|load failed|importing a module script failed|dynamically imported module|404/i;
// a 401 invalid_token that names no stop reason is the token's own answer (renewed once, repeated once), never a
// refusal (PLATFORM_CLIENT.md 8; model_gate.json: "no error of its own"): reason http
const STOPS = ['key_revoked', 'key_unknown', 'app_not_allowed', 'origin_not_allowed', 'key_type_mismatch', 'app_blocked', 'developer_not_approved'];
export const tokenAnswer = (status, error, reason) => status === 401 && error === 'invalid_token' && !STOPS.includes(reason);

// A 403 lease_integrity_failed (PROTECTED_MODEL.md 18.4.10) at the attest or the lease names the failed check with
// `why` (verdict, downgrade, core) and, for a verdict, `check` (ERRORS_40.md 24.3, contract 69326fb). Only tokens of
// 24.2 are read: a why or check that is not one is left out, never echoed into a message or a report.
const token = (v) => (typeof v === 'string' && TOKEN.test(v) ? v : null); // TOKEN: 24.2's reason token, above
/** The report's error_code of a 403 lease_integrity_failed: `why:check` (verdict:boot), `why` alone when the two would
 *  pass 32 characters or check is not a token, null when the answer names no why (the caller then uses the error). */
export function integrityCode(why, check) {
  const w = token(why), c = token(check);
  if (!w) return null;
  return c && w.length + 1 + c.length <= 32 ? `${w}:${c}` : w;
}
/** The developer's detail of a 403 lease_integrity_failed: the check in words, then the server's tokens. The words
 *  are the Android SDK's (sdk-4.0.0 38ffa96), so every SDK says the same. */
export function integrityDetail(why, check) {
  const w = token(why), c = token(check);
  const words = w === 'verdict' ? (
    c === 'boot' ? "this phone's bootloader is unlocked or its boot is not verified, and Quran Lab gives such a phone no lease"
      : c === 'digest' ? "the app's signing certificate is not one declared for this app on sdk.quranlab.ai (a device lab that re-signs the APK needs its digest on a development key)"
        : c === 'software' ? "the phone's key attestation does not come from secure hardware"
          : c === 'origin' ? "the install's key was not made inside the phone's secure hardware"
            : c === 'purpose' ? "the install's key does not have the purpose the SDK made it with"
              : c === 'package' || c === 'package_mismatch' ? "the attested package name is not this app's"
                : c === 'recorded' ? 'a failed check of this install, recorded in the last 24 hours, still stands'
                  : c === 'device_integrity' ? "Play Integrity does not confirm this device's integrity"
                    : c === 'unlicensed' ? 'Google Play says this install is not licensed'
                      : c && c.startsWith('app_') ? 'Play Integrity does not recognize this app as Google Play delivers it'
                        : "the install's attestation did not pass")
    : w === 'downgrade' ? 'this install attested with a stronger check before and did not this time'
      : w === 'core' ? 'the Quran Lab Core in this app could not be verified'
        : 'the install could not be verified';
  return `${words} (lease_integrity_failed${w ? `, why ${w}` : ''}${c ? `, check ${c}` : ''})`;
}
const integrityAnswer = (status, error) => status === 403 && error === 'lease_integrity_failed';
const FOLDER = {
  manifest_missing: ['verify', 'missing'], file_missing: ['verify', 'missing'], manifest_invalid: ['manifest', 'parse'],
  not_listed: ['verify', 'invalid'], tokens_invalid: ['verify', 'invalid'], signature_invalid: ['manifest', 'signature'],
  signature_required: ['manifest', 'signature'], checksum_mismatch: ['verify', 'hash'], sdk_too_old: ['manifest', 'incompatible'],
  format_unsupported: ['manifest', 'incompatible'], engine_format_unsupported: ['manifest', 'incompatible'],
  version_missing: ['manifest', 'incompatible'], version_mismatch: ['verify', 'invalid'], build_mismatch: ['verify', 'invalid'],
  signature_unsupported: ['runtime', 'webcrypto'],
};
// a TajweedError that carries no internal failure: its code's usual cause
const BY_CODE = {
  needs_connection: ['config', 'network'], download_failed: ['download', 'other'], model_unavailable: ['config', 'unavailable'],
  model_incompatible: ['manifest', 'incompatible'], model_invalid: ['verify', 'invalid'], model_missing: ['verify', 'missing'],
  checksum_mismatch: ['verify', 'hash'], signature_invalid: ['manifest', 'signature'], storage_full: ['storage', 'quota'],
  storage_failed: ['storage', 'write'], runtime_unsupported: ['runtime', 'wasm_unsupported'], engine_failed: ['session', 'engine'],
  reference_missing: ['download', 'other'], microphone_denied: ['audio', 'permission_denied'], microphone_unavailable: ['audio', 'unavailable'],
  interrupted: ['audio', 'interrupted'], invalid_key: ['config', 'refused'], server_rejected: ['config', 'refused'],
  sdk_too_old: ['config', 'refused'], sharing_unavailable: ['sharing', 'unavailable'],
};

function fromRuntime(name, message) {
  if (!globalThis.WebAssembly) return 'wasm_unsupported';
  if (name === 'CompileError' || /CompileError|magic word|wasm validation|invalid wasm/i.test(message)) return wasmProbes().simd ? 'wasm_compile' : 'simd';
  if (name === 'LinkError' || /LinkError|Import #\d/i.test(message)) return 'wasm_instantiate';
  if (MEMORY_RE.test(message) || name === 'RangeError') return 'memory';
  if (FETCH_RE.test(message)) return 'wasm_fetch';
  return null;
}

const CLASSIFIED = new Set(['DeliveryError', 'PlatformError', 'ModelFolderError', 'QuotaExceededError', 'NotAllowedError', 'NotReadableError',
  'NotFoundError', 'OverconstrainedError', 'AbortError', 'TajweedError']);
/**
 * Mark a failure of the engine at `stage` ('runtime': starting it; 'model_open': opening the model; 'session': a
 * take) with its reason, read from its class: memory, a module that does not compile or link, a file that did not
 * load. A failure another layer reads (a download, a refusal, a TajweedError of its own) is left as it is.
 */
export function tagEngine(e, stage) {
  let x = e;
  for (let i = 0; i < 4 && x && x.name === 'TajweedError' && x.cause; i++) x = x.cause;
  if (!x || typeof x !== 'object' || x.qlReport || CLASSIFIED.has(x.name)) return e;
  const r = fromRuntime(String(x.workerName || x.name || ''), String(x.message || ''));
  tag(x, { stage, reason: stage === 'runtime' ? r || 'other' : r === 'memory' ? 'memory' : 'engine' });
  return e;
}

/**
 * The report's fields for a failure: { stage, reason, http_status?, error_name?, error_code? }. `e` is what the app
 * was given (a TajweedError, whose cause is read) or an internal failure (a silent one).
 */
export function classify(e) {
  let x = e;
  for (let i = 0; i < 4 && x && x.name === 'TajweedError' && x.cause && !x.qlReport; i++) x = x.cause;
  const name = (x && (x.workerName || x.name)) || '';
  const message = String((x && x.message) || '');
  const t = (x && x.qlReport) || (e && e.qlReport) || {};
  const out = {};
  const set = (stage, reason) => { out.stage = t.stage || stage; out.reason = t.reason || reason; };
  if (name === 'DeliveryError') {
    const st = x.status;
    const reason = x.code === 'checksum_mismatch' ? 'hash' : x.code === 'aborted' ? 'aborted' : x.code === 'offline' ? 'network'
      : st === 429 ? 'rate_limited' : tokenAnswer(st, x.error, x.reason) ? 'http' : (st === 401 || st === 403) ? 'refused' : x.wrong ? 'invalid_answer' : 'http';
    set(x.path === 'manifest.json' ? 'manifest' : 'download', reason);
    if (Number.isInteger(st) && st >= 100) out.http_status = st;
    const ec = x.error || x.reason;
    if (ec) out.error_code = ec;
  } else if (name === 'PlatformError') {
    const st = x.status;
    const byCode = { signature_invalid: 'signature', config_expired: 'expired', offline: 'network', model_unavailable: 'unavailable' }[x.code];
    if (x.code === 'runtime_unsupported') set('runtime', 'webcrypto');
    else if (integrityAnswer(st, x.code)) set(x.stage || 'config', 'integrity_failed');
    else set(x.stage || 'config', byCode || (st === 429 ? 'rate_limited' : tokenAnswer(st, x.code, x.reason) ? 'http' : (st === 401 || st === 403) ? 'refused' : st >= 400 ? 'http' : 'refused'));
    if (Number.isInteger(st) && st >= 100) out.http_status = st;
    if (out.reason === 'refused') out.error_code = x.reason || x.code;
    // 24.3 (69326fb): the failed check, from the answer's why and check
    if (out.reason === 'integrity_failed') out.error_code = integrityCode(x.serverWhy, x.serverCheck) || x.code;
  } else if (name === 'SdkError') {
    // the 4.0 frame's error: the stage and reason it was made with, else its code's usual cause
    const inner = x.cause && typeof x.cause === 'object' && x.cause.name !== 'SdkError' ? classify(x.cause) : null;
    const [stage, reason] = BY_CODE[x.code] || ['session', 'other'];
    // `why` (an SdkError's `reason` is the server's stop reason, 15.3)
    set(x.stage || (inner && inner.stage) || stage, x.why || (inner && inner.reason) || reason);
    if (Number.isInteger(x.http_status)) out.http_status = x.http_status;
    if (x.error_code) out.error_code = x.error_code;
    if (inner && inner.error_name) out.error_name = inner.error_name;
  } else if (name === 'ModelFolderError') {
    const [stage, reason] = FOLDER[x.code] || ['verify', 'invalid'];
    set(stage, reason);
    out.error_code = x.code;
  } else if (name === 'QuotaExceededError') set('storage', 'quota');
  else if (name === 'NotAllowedError') set('audio', 'permission_denied');
  else if (name === 'NotReadableError') set('audio', 'busy');
  else if (name === 'NotFoundError' || name === 'OverconstrainedError') set('audio', 'unavailable');
  else if (t.stage) set(t.stage, fromRuntime(name, message) || 'other');
  else if (x && x !== e) { const r = fromRuntime(name, message); set(r ? 'runtime' : 'session', r || 'engine'); }
  else { const [stage, reason] = BY_CODE[e && e.code] || ['session', 'other']; set(stage, reason); }
  if (t.http_status && !out.http_status) out.http_status = t.http_status;
  if (t.error_code && !out.error_code) out.error_code = t.error_code;
  if (!INTERNAL.has(name) && ERROR_NAME.test(name)) out.error_name = name;
  if (out.error_code !== undefined && !ERROR_CODE.test(String(out.error_code))) delete out.error_code;
  return out;
}

// ---- 24.5 and 24.6: the queue ----

const KEY = 'errors.v1';
const FIELDS = ['error_name', 'error_code', 'retries', 'build'];

/**
 * One install's error reports: the queue, the day's signatures and the reported list, kept in the state store under
 * one key (memory for the page where the store keeps nothing).
 * @param {object} o
 * @param {{get(k: string): any, set(k: string, v: any): void}} o.state
 * @param {() => number} [o.clock]
 * @param {() => boolean} [o.enabled]  false: nothing is recorded and the queue is dropped (flags.issues false)
 * @param {() => object} o.top  the body's top level: platform, sdk_version, app_version, os_version, device_class
 * @param {() => void} [o.onNew]  an occurrence made a new report
 */
export class ErrorReports {
  constructor({ state, clock = Date.now, enabled = () => true, top, onNew = null }) {
    this.state = state; this.clock = clock; this.enabled = enabled; this.top = top; this.onNew = onNew;
    this._flushing = null;
  }

  _load() {
    let s = null;
    try { s = this.state.get(KEY); } catch (_) { s = null; }
    const ok = s && Array.isArray(s.queue) && s.days && typeof s.days === 'object' && Array.isArray(s.reported);
    return ok ? s : { queue: [], days: {}, reported: [] };
  }

  _save(s) { try { this.state.set(KEY, s); } catch (_) { /* this page keeps it in the store's memory */ } }

  /** The queued reports (tests, diagnostics). */
  get queue() { return this._load().queue; }

  /** Drop everything queued (flags.issues false). */
  clear() { const s = this._load(); if (s.queue.length) { s.queue = []; this._save(s); } }

  /**
   * An occurrence: { stage, reason, code ('none' for a silent one), http_status, error_name, error_code, retries,
   * first_launch, revision, build, web }. Returns true when it made a new report. Never throws.
   */
  occur(o) {
    try {
      if (!this.enabled()) return false;
      const code = typeof o.code === 'string' && CODE.test(o.code) ? o.code : 'none';
      if (!STAGES.includes(o.stage) || typeof o.reason !== 'string' || !TOKEN.test(o.reason)) return false;
      if (!reportable(o.stage, o.reason, code)) return false;
      const status = Number.isInteger(o.http_status) && o.http_status >= 100 && o.http_status <= 599 ? o.http_status : 0;
      const s = this._load();
      const day = utcDay(this.clock());
      for (const d of Object.keys(s.days)) if (days(d, day) > LIMITS.keepDays) delete s.days[d];
      const sig = signatureOf(o.stage, o.reason, code, status);
      const today = s.days[day] || (s.days[day] = {});
      if (today[sig] === 's') return false;
      const fields = {};
      for (const k of FIELDS) if (o[k] !== undefined && o[k] !== null) fields[k] = o[k];
      if (typeof o.revision === 'string') fields.revision = o.revision;
      if (o.web) fields.web = o.web;
      if (today[sig] === 'q') {
        const r = s.queue.find((q) => q.day === day && q.sig === sig);
        if (r) {
          r.count = Math.min(LIMITS.countMax, r.count + 1);
          r.first_launch = r.first_launch || !!o.first_launch;
          r.fields = fields;
          this._save(s);
          return false;
        }
        delete today[sig]; // the report itself went (the queue cap): a new one
      }
      if (Object.keys(today).length >= LIMITS.dailySignatures) return false;
      const last = s.reported.find((x) => x[0] === sig);
      const first = (!last || days(last[1], day) > LIMITS.firstAgainDays) && !s.queue.some((q) => q.sig === sig);
      s.queue.push({ day, sig, stage: o.stage, reason: o.reason, code, http_status: status, count: 1, first_report: first, first_launch: !!o.first_launch, fields });
      today[sig] = 'q';
      while (s.queue.length > LIMITS.queueMax) { const old = s.queue.shift(); if (s.days[old.day]) delete s.days[old.day][old.sig]; }
      this._save(s);
      if (typeof this.onNew === 'function') { try { this.onNew(); } catch (_) { /* never in the way */ } }
      return true;
    } catch (_) { return false; }
  }

  /** The POST body of a queued report. */
  body(r) {
    const f = r.fields || {};
    const error = { stage: r.stage, reason: r.reason };
    if (r.http_status) error.http_status = r.http_status;
    if (typeof f.error_name === 'string' && ERROR_NAME.test(f.error_name)) error.error_name = f.error_name;
    if (f.error_code !== undefined && ERROR_CODE.test(String(f.error_code))) error.error_code = String(f.error_code);
    error.count = r.count;
    if (Number.isInteger(f.retries) && f.retries >= 0) error.retries = Math.min(1000, f.retries);
    error.first_launch = !!r.first_launch;
    error.first_report = !!r.first_report;
    if (typeof f.build === 'string' && HEX40.test(f.build)) error.build = f.build;
    if (f.web && typeof f.web === 'object') {
      const web = { ...f.web };
      if (!web.storage_free && estimate.bucket) web.storage_free = estimate.bucket;
      error.web = web;
    }
    return { day: r.day, ...this.top(), ...(typeof f.revision === 'string' ? { revision: f.revision } : {}), kind: 'error', code: r.code, error };
  }

  /**
   * A send point: each queued report, oldest first. `send(body)` resolves when the server took it (202) and rejects
   * with { status } otherwise (no status: no answer). 400 and 413 drop the report; anything else stops here and
   * keeps it. Resolves with the number accepted. One send at a time.
   */
  flush(send) {
    if (this._flushing) return this._flushing;
    this._flushing = this._flush(send).finally(() => { this._flushing = null; });
    return this._flushing;
  }

  async _flush(send) {
    if (!this.enabled()) { this.clear(); return 0; }
    const today = utcDay(this.clock());
    let s = this._load();
    const kept = s.queue.filter((r) => days(r.day, today) <= LIMITS.keepDays);
    if (kept.length !== s.queue.length) { s.queue = kept; this._save(s); }
    let sent = 0;
    for (const r of kept) {
      let status = null;
      try { await send(this.body(r)); status = 202; } catch (e) { status = e && Number.isInteger(e.status) && e.status > 0 ? e.status : null; }
      if (status !== 202 && status !== 400 && status !== 413) break;
      s = this._load();
      s.queue = s.queue.filter((q) => !(q.day === r.day && q.sig === r.sig));
      (s.days[r.day] || (s.days[r.day] = {}))[r.sig] = 's';
      if (status === 202) {
        s.reported = s.reported.filter((x) => x[0] !== r.sig).concat([[r.sig, r.day]]).slice(-LIMITS.reportedMax);
        sent++;
      }
      this._save(s);
    }
    return sent;
  }
}
