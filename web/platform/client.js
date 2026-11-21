// The Quran Lab platform client for the web product: the
// developer key, an unattested app token, register, the signed config (Ed25519 over the exact bytes,
// pinned key ids, ETag, 60 s refresh while in use), where the model's build is served, telemetry v2 (on by
// default, anonymous), issues, and the learner's sharing routes. Nothing here sits in the recognition path:
// a failing network never stops recognition.
//
// SDK internals since 3.0.0: the public object is TajweedClient (web/api/client.js), which owns one of these.

import { verifyEd25519, Ed25519Unavailable } from './ed25519.js';
import { Telemetry, deviceInfo, utcDay, productOf } from './telemetry.js';
import { localState } from './storage.js';
import { QURANLAB_PUBLIC_KEY_HEX, hexToBytes, bytesToHex } from '../tajweed/manifest.js';
import { noticeSdkLatest } from './update-notice.js';
import { ErrorReports, classify, webSnapshot, refreshStorageEstimate, tag, telemetryReason, SEND_AFTER_MS } from './error-reports.js';
import { MODEL_STOP_REASONS, stopReasonOf } from '../api/errors.js';
import { Endpoints, ROLES, API_BODY_MS, HEAD_MS } from '../../sdk4/shared/endpoints.js';

export const SDK_VERSION = '4.0.1';
// the first host of each role (ENDPOINTS_40.md 28.1): every request to the API goes through the api order of the
// endpoint set (sdk4/shared/endpoints.js), the first host first, the others when it cannot be reached (28.3)
export const API_URL = `https://${ROLES.api[0]}`;
export const CDN_URL = `https://${ROLES.models[0]}`;
/** Where model files are served: {base}/{owner}/{repo}/{revision}/{path}. The signed config's `base`
 * replaces it when present (a host of the allow-list, 28.4); a cdnUrl given without modelsUrl keeps the old
 * {cdn}/hf/ path. */
export const MODELS_URL = `${CDN_URL}/models`;
const REGIONAL_CDN = /^https:\/\/((weur|eeur|enam|wnam|apac|oc)\.)?cdn\.quranlab\.ai$/;
/**
 * 27.1: an app version or build as the config request and register carry it, cleaned in this order: only the ASCII
 * characters 0-9 A-Z a-z . + - kept; the . + - before the first letter or digit dropped; the first 32 kept. null when
 * unknown: not a string, nothing left, or "0" (register then sends its placeholder "0").
 */
export function appValue(v) {
  if (typeof v !== 'string') return null;
  const c = v.replace(/[^0-9A-Za-z.+-]/g, '').replace(/^[.+-]+/, '').slice(0, 32);
  return c && c !== '0' ? c : null;
}

/**
 * 28.3: a config answer is the route's only when it verifies (PLATFORM_CLIENT 3): { bytes, dated, cfg }, else null,
 * so that host is unreachable and the next is asked. A runtime that cannot verify at all ends the request with that
 * failure (runtime_unsupported).
 */
export function configAccept(trustedKeys, clock) {
  return async (res) => {
    const bytes = new Uint8Array(await res.arrayBuffer());
    const dated = dateHeaderMs(res);
    try { return { bytes, dated, cfg: await verifySignedConfig(bytes, res.headers.get('x-qlab-signature'), res.headers.get('x-qlab-key-id'), trustedKeys, clock(), dated) }; } catch (e) {
      if (e && e.name === 'PlatformError' && e.code === 'runtime_unsupported') { e.stage = 'config'; throw e; }
      return null;
    }
  };
}
/** Codes after which the client stops all network calls until the next launch (error table). */
const STOP_CODES = new Set(['invalid_key', 'unauthorized', 'developer_not_approved', 'not_a_member', 'key_type_mismatch',
  'origin_not_allowed', 'app_not_allowed', 'app_blocked', 'environment_mismatch', 'sdk_too_old']);
/** The reasons that stop a model on this device (SPEC 15.3): one list, defined in web/api/errors.js. */
export { MODEL_STOP_REASONS };
/** Where a stop is remembered in the state store. */
export const MODEL_REFUSED_KEY = 'model.refused';
/** The origin check's `why` (allowed false) as the refusal it stands for: the status and code a 4xx would have
 * carried, and the `reason` that the refused request's own body carried (a page cannot read that body: a key
 * answers CORS only for its own origins). `listed` is allowed; a `why` that is not here is a refusal with the
 * `why` as its code and no reason. */
const ORIGIN_CHECK = Object.freeze({
  not_listed: { status: 403, code: 'origin_not_allowed', reason: 'origin_not_allowed' },
  local_needs_development_key: { status: 403, code: 'local_needs_development_key' },
  key_unknown: { status: 401, code: 'invalid_key', reason: 'key_unknown' },
  key_revoked: { status: 401, code: 'invalid_key', reason: 'key_revoked' },
  key_not_approved: { status: 403, code: 'developer_not_approved', reason: 'developer_not_approved' },
  not_a_web_key: { status: 403, code: 'key_type_mismatch', reason: 'key_type_mismatch' },
});
/** The error reports' stage of a failed API call (ERRORS_40.md 24.3). */
const STAGE_OF = (path) => (path.startsWith('/v1/config') ? 'config' : path.startsWith('/v1/register') ? 'register'
  : path.startsWith('/v1/attest') ? 'attest' : path.startsWith('/v1/events') ? 'events' : path.startsWith('/v1/issues') ? null : 'sharing');
/** A telemetry delta every this long while the app is in use (2.0.1: Quran Lab's choice, 15 minutes). */
export const DELTA_INTERVAL_MS = 15 * 60_000;
/** How often the schedule looks at the clock. */
const TICK_MS = 60_000;

/** A platform failure: { status, code } from the API's {"error","message"} body. */
export class PlatformError extends Error {
  constructor(status, code, message) { super(`${status} ${code}${message ? ': ' + message : ''}`); this.name = 'PlatformError'; this.status = status; this.code = code; }
}

/**
 * 28.3: a 2xx of a JSON route is its answer only when it is JSON (with `field` a string, when named): a captive
 * portal's page, an empty 200 or a token answer without a token is unreachable on that host. 202 and 204 may be empty.
 */
export function acceptJson(field = null) {
  return async (res, status) => {
    const text = await res.text();
    if (!text && (status === 202 || status === 204)) return true;
    try {
      const j = JSON.parse(text);
      return j && typeof j === 'object' && (!field || (typeof j[field] === 'string' && j[field] !== '')) ? true : null;
    } catch (_) { return null; }
  };
}

const subtle = () => globalThis.crypto.subtle;
const b64uToBytes = (s) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** The key id of a raw 32-byte Ed25519 public key: the first 8 bytes of its SHA-256, hex. */
export async function keyId(raw) {
  const b = typeof raw === 'string' ? hexToBytes(raw) : raw;
  return bytesToHex(new Uint8Array(await subtle().digest('SHA-256', b)).subarray(0, 8));
}

/**
 * Verify a signed config response (PLATFORM_CLIENT.md section 3): the key id pinned, Ed25519 over
 * the exact body bytes, v 1, not expired. Returns the parsed config, or throws PlatformError
 * 'signature_invalid' / 'config_expired'.
 * @param {Uint8Array} body  the body bytes as received
 * @param {string|null} sigHeader  x-qlab-signature ("ed25519=<base64url>")
 * @param {string|null} kid  x-qlab-key-id
 * @param {Array<string|Uint8Array>} trustedKeys  raw public keys (hex or bytes)
 */
export async function verifySignedConfig(body, sigHeader, kid, trustedKeys, now = Date.now(), serverMs = null) {
  // no WebCrypto at all (not a secure context, an old runtime): nothing can be verified here (3.1.6)
  if (!globalThis.crypto || !globalThis.crypto.subtle) throw new PlatformError(0, 'runtime_unsupported', 'this runtime has no WebCrypto (crypto.subtle)');
  if (!sigHeader || !sigHeader.startsWith('ed25519=') || !kid) throw new PlatformError(0, 'signature_invalid', 'no signature');
  let sig;
  try { sig = b64uToBytes(sigHeader.slice(8)); } catch (_) { throw new PlatformError(0, 'signature_invalid', 'bad signature encoding'); }
  let ok = false;
  for (const k of trustedKeys) {
    if ((await keyId(k)) !== kid) continue;
    // 3.1.6: WebCrypto's Ed25519, or the vendored verifier where the runtime has none (web/platform/ed25519.js)
    try {
      if (await verifyEd25519(typeof k === 'string' ? hexToBytes(k) : k, sig, body)) { ok = true; break; }
    } catch (e) {
      if (e instanceof Ed25519Unavailable) throw new PlatformError(0, 'runtime_unsupported', e.message);
      throw e;
    }
  }
  if (!ok) throw new PlatformError(0, 'signature_invalid', `the config does not verify with a pinned key (kid ${kid})`);
  const cfg = JSON.parse(new TextDecoder().decode(body));
  if (cfg.v !== 1) throw new PlatformError(0, 'signature_invalid', `config v ${cfg.v}`);
  // 3.1.6: expiry by the server's time when the device clock is off (configNow); never a body the server's own clock
  // calls expired (when the server's time is known from the answer's Date header)
  const at = configNow(now, serverTime(cfg, serverMs), validityOf(cfg));
  if (!(typeof cfg.expires_at === 'number' && cfg.expires_at * 1000 > at && (serverMs === null || cfg.expires_at * 1000 > serverMs))) {
    throw new PlatformError(0, 'config_expired', 'the config has expired');
  }
  return cfg;
}

/** Differences between the device clock and the server's time below this are ignored. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * The time a config's expiry is judged by (3.1.6). The device clock, unless the server's time differs from it by more
 * than CLOCK_SKEW_MS: then the later of the two (a device clock behind the server never shortens a config), and the
 * server's time when the device clock is ahead of it by more than a config lives (a device clock days ahead never
 * expires every fresh config). serverMs null: the device clock.
 */
export function configNow(deviceMs, serverMs, validityMs = 86_400_000) {
  if (serverMs === null || serverMs === undefined || !Number.isFinite(serverMs) || Math.abs(deviceMs - serverMs) <= CLOCK_SKEW_MS) return deviceMs;
  if (deviceMs - serverMs > validityMs) return serverMs;
  return Math.max(deviceMs, serverMs);
}

/** How long a config lives: expires_at - issued_at (24 h), in ms. */
export const validityOf = (cfg) => (cfg && Number.isFinite(cfg.issued_at) && Number.isFinite(cfg.expires_at) && cfg.expires_at > cfg.issued_at
  ? (cfg.expires_at - cfg.issued_at) * 1000 : 86_400_000);

/**
 * The server's time for a config answer: the HTTP Date header, where the runtime can read it (Node; a browser only
 * when the API lists `date` in Access-Control-Expose-Headers: Date is not a CORS-safelisted response header). Never
 * the config's own issued_at: a stale body replayed later carries an old issued_at, and judging it by that would
 * accept it whatever its age. Null when unknown: the device clock alone decides, as before 3.1.6.
 */
export function serverTime(cfg, serverMs) {
  return serverMs !== null && serverMs !== undefined && Number.isFinite(serverMs) ? serverMs : null;
}

/** The Date header of an answer in ms, or null (unreadable, absent or malformed). */
export function dateHeaderMs(r) {
  try { const d = r && r.headers && r.headers.get('date'); const t = d ? Date.parse(d) : NaN; return Number.isFinite(t) ? t : null; } catch (_) { return null; }
}

/**
 * One configured platform client (SDK internals; TajweedClient owns one).
 */
export class QuranLab {
  /**
   * @param {object} o
   * @param {string} o.key  the developer key qlk_v1_... (a web key in browsers; a desktop key in Node)
   * @param {string} [o.appVersion]
   * @param {string} [o.appName]
   * @param {string} [o.platform]  'web' (browsers, default), or 'linux' / 'windows' / 'web' in Node
   * @param {string} [o.bundleId]  web: the page's origin (default location.origin); desktop: the app id
   * @param {string} [o.origin]  Node with a web key: the Origin header to send
   * @param {'on'|'off'} [o.analytics='on']  the one developer opt-out; never a prompt
   * @param {boolean} [o.issues=true]
   * @param {boolean} [o.contributions]  ignored since 2.0.1: every learner is asked and the choice is theirs; the
   *   signed config's flags.contributions is Quran Lab's global incident switch; the SDK asks the learner before
   *   anything is recorded for upload
   * @param {number} [o.sharingBitrate]  Opus bit/s for shared sessions (default 192000, SHARING_BITRATE_DEFAULT)
   * @param {object} [o.state]  persistence (default localStorage; Node: dirState(dir))
   * @param {Array<string|Uint8Array>} [o.trustedKeys]  pinned config keys (default Quran Lab's)
   * @param {string} [o.apiUrl] [o.modelsUrl] [o.cdnUrl] [o.fetch] [o.clock]  o.modelsUrl: model files (default the
   *   signed config's base, else cdn.quranlab.ai/models); o.cdnUrl alone: the old {cdn}/hf/ path
   * @param {boolean} [o.autoSend=true]  telemetry deltas on the SDK's own schedule (every 15 minutes while the page
   *   is visible, when it is hidden or left); false: the app calls ql.foreground() / ql.background() / ql.sendTelemetry()
   * @param {{document?: EventTarget & {visibilityState?: string}, window?: EventTarget}} [o.lifecycle]  where the
   *   page's visibilitychange and pagehide come from (default the page's own)
   * @param {boolean} [o.debug]  a development build: the "newer SDK available" line is logged (default: when
   *   process.env.NODE_ENV is not 'production' where it resolves; a plain browser page stays silent)
   */
  constructor(o) {
    if (!o || typeof o.key !== 'string' || !/^qlk_v1_/.test(o.key)) throw new TypeError('QuranLab: a developer key qlk_v1_... is needed');
    const inBrowser = typeof globalThis.window !== 'undefined' && !!globalThis.location;
    this.key = o.key;
    this.clock = o.clock || Date.now;
    // the endpoint set (28.1): a test build's apiUrl and modelsUrl replace a role's hosts; one set may be shared with
    // the frame's controller (o.endpoints), which asks the models hosts with it
    this.ep = o.endpoints instanceof Endpoints ? o.endpoints
      : Endpoints.fromSeams({ apiUrl: o.apiUrl || null, modelsUrl: o.modelsUrl || o.cdnUrl || null, clock: () => this.clock(),
        headMs: Number.isFinite(o.apiTimeoutMs) && o.apiTimeoutMs > 0 ? Math.min(HEAD_MS, o.apiTimeoutMs) : HEAD_MS });
    // the API's URL as the SDK names it (the first api host): a request to it goes through the api order
    this.apiUrl = this.ep.origin(this.ep.builtIn.api[0]);
    this.cdnUrl = (o.cdnUrl || CDN_URL).replace(/\/$/, '');
    this.modelsUrl = o.modelsUrl ? o.modelsUrl.replace(/\/+$/, '') : null;
    this.legacyCdn = !!o.cdnUrl && !o.modelsUrl;
    this.platform = o.platform || 'web';
    this.bundleId = o.bundleId || (inBrowser ? globalThis.location.origin : null);
    if (!this.bundleId) throw new TypeError('QuranLab: bundleId is needed outside a browser (the origin for a web key, the app id for a desktop key)');
    this.origin = o.origin || null; // Node only: browsers set Origin themselves
    this.appVersion = o.appVersion || '0';
    // 27.1: the app's build (a string, or none); the config request carries both, cleaned, read once here
    this.appBuild = typeof o.appBuild === 'string' ? o.appBuild : null;
    this.appName = o.appName || null;
    // every request to an api host through the api order (28.3), each host bounded by 10 s to its status and the
    // API's 30 s after it; anything else (presigned upload URLs) as it is
    this.rawFetch = o.fetch || globalThis.fetch.bind(globalThis);
    this.fetch = this.ep.wrap(this.rawFetch, { bodyMs: Number.isFinite(o.apiTimeoutMs) && o.apiTimeoutMs > 0 ? o.apiTimeoutMs : API_BODY_MS });
    this.state = o.state || localState();
    this.trustedKeys = o.trustedKeys || [QURANLAB_PUBLIC_KEY_HEX];
    this.analyticsOn = o.analytics !== 'off';
    this.issuesOn = o.issues !== false;
    this.contributions = !!o.contributions;
    this.sharingBitrate = o.sharingBitrate || null;
    this.autoSend = o.autoSend !== false;
    this.debug = typeof o.debug === 'boolean' ? o.debug : undefined;
    this.lifecycle = o.lifecycle || { document: globalThis.document, window: typeof globalThis.window !== 'undefined' ? globalThis.window : null };
    this._lastSend = null;
    this._hidden = false;
    this.stopped = null; // the code that stopped the network this launch
    this.refusedError = null;
    // a refusal that stops the model on this device, remembered across launches until the server accepts the
    // key again (SPEC 15.3). `from` says who refused: 'api', or 'cdn' (a model request). `_cdnRecheck`: the
    // API has accepted the key since the CDN refused, so the next model call asks the CDN again (this launch only)
    this.modelRefusal = null;
    this._cdnRecheck = false;
    let was = null;
    try { was = this.state.get(MODEL_REFUSED_KEY); } catch (_) { was = null; }
    if (was && typeof was.code === 'string' && stopReasonOf(was.reason)) {
      const e = new PlatformError(was.status === 401 ? 401 : 403, was.code, 'the answer of an earlier launch');
      e.reason = was.reason;
      e.from = was.from === 'cdn' ? 'cdn' : 'api';
      if (typeof was.origin === 'string') e.origin = was.origin;
      this.modelRefusal = e;
    }
    this.config = null;
    this._token = null;
    this._timer = null;
    this.telemetry = new Telemetry({ state: this.state, product: productOf(this.platform), platform: this.platform, sdkVersion: SDK_VERSION,
      appVersion: this.appVersion, device: deviceInfo(), clock: this.clock, enabled: this.analyticsOn });
    // error reports (3.1.7, ERRORS_40.md section 24): this page is the install's first launch when no earlier start
    // left its mark (PLATFORM_CLIENT.md 2); the engine's host is known once an engine started
    let installed = null;
    try { installed = this.state.get('installed'); } catch (_) { installed = null; }
    this.firstLaunch = installed === null;
    this.engineInWorker = undefined;
    this._errTimer = null;
    this.errors = new ErrorReports({ state: this.state, clock: this.clock, enabled: () => this.issuesOn && this.flags.issues !== false,
      top: () => ({ platform: this.platform, sdk_version: SDK_VERSION, app_version: this.appVersion, os_version: String(this.telemetry.device.os_major),
        device_class: this.telemetry.device.class }),
      onNew: () => this._errorsSoon() });
    this.telemetry.onExpired = () => this._silent('events', 'expired');
    refreshStorageEstimate(this.clock());
    // the stored signed config, if still valid, until the network answers
    const saved = this.state.get('config');
    if (saved && saved.cfg && saved.cfg.expires_at * 1000 > this.configClock(saved)) this.config = saved.cfg;
    if (this.state.get('bucket') === null) this.state.set('bucket', Math.floor(Math.random() * 100));
    // a request answered on another host after its first host was unreachable: one silent report of its stage (28.7)
    if (!this.ep.onFailover) {
      this.ep.onFailover = (f) => this._silent(f.stage, 'failover', { host_role: f.role, fallback: true,
        ...(f.status ? { http_status: f.status } : {}), error_code: f.reason });
    }
    this._syncEndpoints();
  }

  /** 28.2: the api and models lists of the config in force (its endpoints), else the built-in lists. A config's
   * hosts are kept nowhere but with the config. */
  _syncEndpoints() {
    try {
      const cfg = this.config;
      const inForce = !!cfg && Number.isFinite(cfg.expires_at) && cfg.expires_at * 1000 > this.configClock();
      this.ep.useConfig(cfg && cfg.endpoints, inForce);
    } catch (_) { /* the lists stay */ }
  }

  /** Configure and run the launch sequence (token, register, config, pending telemetry and issues).
   * Never throws for network trouble; check `ql.stopped` and `ql.lastError`. */
  static async configure(o) {
    const ql = new QuranLab(o);
    await ql.launch();
    await ql.launchSent; // the 3.x entry keeps its order: the launch's telemetry sent before it resolves
    return ql;
  }

  get flags() { return (this.config && this.config.flags) || { analytics: true, issues: true, contributions: false }; }

  /** The time a stored config's expiry is judged by: configNow with the server's time estimated from the skew learned
   * when that config was verified (3.1.6). */
  configClock(saved = this.state.get('config')) {
    const device = this.clock();
    const skew = saved && Number.isFinite(saved.skew) ? saved.skew : 0;
    return skew ? configNow(device, device + skew, validityOf(saved && saved.cfg)) : device;
  }

  // ---- the model gate (SPEC 15.3) ----
  // An answer of the server stops the model on this device exactly when its body carries a `reason` of
  // MODEL_STOP_REASONS; it is remembered with where it came from. Anything else changes nothing here.
  _refusal(err, from = 'api') {
    if (!err || !stopReasonOf(err.reason)) return;
    err.from = from;
    this.modelRefusal = err;
    this._cdnRecheck = false;
    try { this.state.set(MODEL_REFUSED_KEY, { status: err.status, code: err.code, reason: err.reason, origin: err.origin || null, from }); } catch (_) { /* in force for this launch */ }
    // a stop also removes the models on this device (SPEC 15.3, contract 1.10.0): the Client does it
    if (typeof this.onModelStop === 'function') { try { this.onModelStop(err); } catch (_) { /* the Client's own problem */ } }
  }

  /** A stop another page of this origin stored since this one was made (the state is shared): it holds here too.
   * A stop in force here is never dropped by this (only an accepting answer ends it). */
  syncRefusal() {
    if (this.modelRefusal) return;
    let was = null;
    try { was = this.state.get(MODEL_REFUSED_KEY); } catch (_) { was = null; }
    if (!was || typeof was.code !== 'string' || !stopReasonOf(was.reason)) return;
    const e = new PlatformError(was.status === 401 ? 401 : 403, was.code, 'the answer to another page');
    e.reason = was.reason;
    e.from = was.from === 'cdn' ? 'cdn' : 'api';
    if (typeof was.origin === 'string') e.origin = was.origin;
    this.modelRefusal = e;
  }

  _clearRefusal() {
    this.modelRefusal = null;
    this._cdnRecheck = false;
    try { this.state.set(MODEL_REFUSED_KEY, null); } catch (_) { /* cleared for this launch */ }
  }

  // The API accepted the key (a register or token answer that succeeded, a config that verified): a stop the
  // API gave ends. A stop the CDN gave is not ended by the API: the next model call asks the CDN again, and
  // the CDN's answer decides (SPEC 15.3).
  _accepted() {
    if (!this.modelRefusal) return;
    if (this.modelRefusal.from === 'cdn') { this._cdnRecheck = true; return; }
    this._clearRefusal();
  }

  /** True while a stop is in force and a model call must fail with it before asking anything of the CDN. */
  get modelStopped() { return !!this.modelRefusal && !(this.modelRefusal.from === 'cdn' && this._cdnRecheck); }

  /** A model request the CDN refused ({ status, error, reason }): the same rule as for the API's answers. */
  noteModelRefusal({ status, error, reason }) {
    const e = new PlatformError(status, error || 'http_' + status, 'a model request');
    if (reason) e.reason = reason;
    this._refusal(e, 'cdn');
  }

  /** The CDN served a model request: a stop the CDN gave ends (one the API gave is never asked of the CDN). */
  noteModelServed() { if (this.modelRefusal && this.modelRefusal.from === 'cdn') this._clearRefusal(); }

  /**
   * The headers of a model request (the model's manifest, every file, every Range request; SPEC 15.4): the
   * install's token and the key (the CDN reads the key first, and a request with a token alone gets its generic
   * 401). THE ONE PLACE where they are made: a change of the server's rule is one edit here. Asked before every
   * request, so a token is there before the first one and is renewed when under an hour is left.
   */
  async modelHeaders() {
    let token;
    try { token = await this.token(); } catch (e) { throw (this.stopped && this.stoppedError) || e; }
    const h = { authorization: `Bearer ${token}`, 'x-qlab-key': this.key };
    if (this.origin) h.origin = this.origin;
    return h;
  }

  /** A new token (the CDN answered 401 invalid_token to a model request). */
  async renewToken() {
    this._token = null;
    this.state.set('token', null);
    return this.token();
  }

  // ---- HTTP ----
  async _call(method, path, { body = null, auth = 'token', headers = {}, raw = false, keepalive = false, accept = undefined } = {}) {
    if (this.stopped) throw new PlatformError(0, this.stopped, 'stopped for this launch');
    const stage = STAGE_OF(path) || 'config';
    const h = { ...headers };
    if (this.origin) h.origin = this.origin;
    if (auth === 'key') h['x-qlab-key'] = this.key;
    else if (auth === 'token') h.authorization = `Bearer ${await this.token()}`;
    if (body !== null) h['content-type'] = 'application/json';
    // no request of the SDK follows a redirect (SPEC 15.4, contract 1.17.0): a redirect answered is a failed
    // request, so neither a header (the developer key of the token request) nor a body goes to another host
    const init = { method, headers: h, body: body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'error' };
    if (keepalive) init.keepalive = true; // a page being hidden or left: the request outlives it
    // the api order (28.3): a 2xx that is not the route's answer (a captive portal's page) is unreachable on that host
    init.qlAccept = accept !== undefined ? accept : raw ? null : acceptJson();
    this._syncEndpoints();
    let r;
    try { r = await this.fetch(this.apiUrl + path, init); } catch (e) {
      // the route's own check could not run here at all (no WebCrypto): that failure, as it is
      if (e && e.name === 'PlatformError') { if (!e.stage) e.stage = stage; throw e; }
      // no HTTP answer from any host. On a page that can be the browser refusing the answer of an origin that is not
      // on the key: the origin check tells (once per page load); else the failure stays what it was (the first host's)
      const refused = await this.originCheck();
      if (refused) { if (!refused.stage) refused.stage = stage; throw refused; }
      throw tag(e, { stage, reason: 'network', host_role: 'api', fallback: !!e.qlFallback });
    }
    const fallback = !!r.qlFallback;
    if (r.status < 400 && auth !== 'none') { this.keyAccepted = true; this.refusedError = null; } // the server answered a call made with this key or its token
    // a register or token answer that succeeds accepts the key (the config does when it has verified)
    if (r.status < 400 && !raw && (path === '/v1/register' || path === '/v1/attest')) this._accepted();
    if (raw) return r;
    if (r.status >= 400) {
      let e = {};
      try { e = await r.json(); } catch (_) { /* no body */ }
      const err = new PlatformError(r.status, e.error || 'http_' + r.status, e.message || '');
      err.stage = stage;
      err.host_role = 'api';
      err.fallback = fallback;
      if (typeof e.min_sdk === 'string') err.minSdk = e.min_sdk; // 403 sdk_too_old: the version this key needs
      // the check that refused (a 401 invalid_key names it: app_not_allowed, origin_not_allowed, key_type_mismatch);
      // the error raised to the app reads it first, what the client does with the network follows `error`
      if (typeof e.reason === 'string') err.reason = e.reason;
      // a 403 lease_integrity_failed names the failed check (18.4.10): why, and for a verdict its check (ERRORS_40 24.3)
      if (typeof e.why === 'string') err.serverWhy = e.why;
      if (typeof e.check === 'string') err.serverCheck = e.check;
      // a reason of the stop list refuses the key or the app, whatever `error` says: a 401 invalid_token that
      // carries one (the key was revoked after the token was issued) is not renewed
      const stop = stopReasonOf(err.reason);
      // the last refusal of this key or app (401 or 403; not a token that ran out), for diagnose()
      if ((r.status === 401 || r.status === 403) && (err.code !== 'invalid_token' || stop)) this.refusedError = err;
      if (STOP_CODES.has(err.code) || stop) { this.stopped = err.code; this.stoppedError = err; }
      this._refusal(err);
      if (err.code === 'invalid_token' && !stop && auth === 'token' && !headers['x-retried']) {
        this._token = null; this.state.set('token', null);
        return this._call(method, path, { body, auth, headers: { ...headers, 'x-retried': '1' }, keepalive, accept }).catch((e2) => { throw e2; });
      }
      throw err;
    }
    if (r.status === 204 || r.status === 304) return null;
    // a 2xx every host gave that is not the route's answer (the first host's, 28.3 item 4): invalid_answer
    try { return await r.json(); } catch (_) {
      throw Object.assign(new PlatformError(r.status, 'invalid_answer', 'the answer is not the route\'s'), { stage, host_role: 'api', fallback });
    }
  }

  /** An unattested app token (24 h), renewed when under 1 h is left. */
  async token() {
    const now = this.clock() / 1000;
    const t = this._token || this.state.get('token');
    if (t && t.exp - now > 3600) { this._token = t; return t.token; }
    const r = await this._call('POST', '/v1/attest', { auth: 'key', body: { platform: this.platform, bundle_id: this.bundleId }, accept: acceptJson('token') });
    this._token = { token: r.token, exp: now + (r.expires_in || 86400), attested: !!r.attested };
    this.state.set('token', this._token);
    return r.token;
  }

  // ---- launch ----
  /**
   * The web's origin check (NAMING section 7): asked when a request to the API got no HTTP answer, once per page
   * load. GET /v1/origin-check?key=<the web key> is a simple request (no custom header) that answers every
   * origin with { origin, allowed, why }. Returns the PlatformError the answer stands for, or null when the
   * origin is allowed or the check could not be reached (no answer, or any status but 200): then the failure
   * is what it would have been. A second failure returns the first answer's error without asking again.
   */
  async originCheck() {
    if (this.platform !== 'web') return null;
    if (this._originAsked) return this._originError;
    this._originAsked = true;
    this._originError = null;
    try {
      const r = await this.fetch(`${this.apiUrl}/v1/origin-check?key=${encodeURIComponent(this.key)}`, { redirect: 'error' });
      if (r.status !== 200) return null;
      const a = await r.json();
      if (!a || a.allowed !== false) return null;
      const why = typeof a.why === 'string' ? a.why : 'refused';
      const known = ORIGIN_CHECK[why];
      const err = known ? new PlatformError(known.status, known.code, `the origin check: ${why}`) : new PlatformError(403, why, 'the origin check');
      if (known && known.reason) err.reason = known.reason;
      if (typeof a.origin === 'string') err.origin = a.origin;
      if (STOP_CODES.has(err.code)) { this.stopped = err.code; this.stoppedError = err; }
      this._refusal(err);
      this._originError = err;
    } catch (_) { /* the check was not reached either */ }
    return this._originError;
  }

  /** The launch sequence: a launch counted, register (once per UTC day), the signed config, the telemetry
   * reports left from earlier runs and this launch's delta, queued issues; then the delta schedule. */
  async launch() {
    this.telemetry.count('launches');
    this.telemetry.launched();
    const steps = [() => this.register(), () => this.refreshConfig()];
    for (const s of steps) {
      try { await s(); } catch (e) { this.lastError = e; this.reportFailure(e, { silent: true }); if (this.stopped) break; }
    }
    // the launch's telemetry and pending reports go in the background: the start never waits for them. A host that
    // keeps no reports (a backup host answers them 503, ENDPOINTS_40.md 28.9) sends the request across every host of
    // the order, which took 20 s or more a request with the first hosts silent (E7, 11-20); the reports stay queued
    // and go with a later send, as before
    this.launchSent = this.stopped ? Promise.resolve() : this.sendTelemetry('launch').catch((e) => { this.lastError = e; this.reportFailure(e, { silent: true }); });
    if (this.autoSend) this._startSchedule();
  }

  /** POST /v1/register, at most once per UTC day per install (the first launch or return to the foreground of
   * the day): the day is stamped only after a 200, so a failed attempt is made again. Returns the answer, or
   * null when this install already registered today. */
  async register() {
    const today = utcDay(this.clock());
    if (this.state.get('register.day') === today) return null;
    if (this._registering) return this._registering;
    this._registering = this._register(today).finally(() => { this._registering = null; });
    return this._registering;
  }

  async _register(today) {
    const first = this.state.get('installed') === null;
    if (first) this.state.set('installed', true);
    const pendingNew = this.state.get('register.pending_new') === true;
    const newInstall = first || pendingNew;
    this.state.set('register.pending_new', newInstall);
    // 27.1: the app's version cleaned as the config request carries it, or the placeholder "0" when unknown
    const body = { platform: this.platform, bundle_id: this.bundleId, app_version: appValue(this.appVersion) || '0', sdk_version: SDK_VERSION, new_install: newInstall };
    if (this.appName) body.app_name = this.appName;
    if (this.modelRevision) body.model_revision = this.modelRevision;
    const r = await this._call('POST', '/v1/register', { body });
    this.state.set('register.pending_new', null);
    this.state.set('register.day', today);
    return r;
  }

  // ---- in use, background, the delta schedule ----
  /** The app came back to the foreground (the page became visible again): a launch counted, register if this
   * is the first foreground of a new UTC day. Called by the SDK's own page listeners; call it yourself with
   * autoSend false. */
  foreground() {
    this._hidden = false;
    this.telemetry.count('launches');
    this._sharingLife('foreground');
    if (!this.stopped) this.register().catch((e) => { this.lastError = e; });
  }

  /** The app goes to the background (the page is hidden or left): the delta since the last send point is
   * sealed and sent with keepalive requests, and the shared recording that takes in a row keep open closes
   * (2.0.3). */
  background() {
    this._hidden = true;
    this._sharingLife('background');
    return this.sendTelemetry('background', { keepalive: true });
  }

  // the sharing controller hears of the app's life (never in the way of the telemetry)
  _sharingLife(what) {
    try {
      const f = this.sharing && this.sharing[what];
      if (typeof f === 'function') Promise.resolve(f.call(this.sharing)).catch(() => {});
    } catch (_) { /* sharing's own problem */ }
  }

  /** A send point: seal what was counted since the last one and send every report due (oldest first). */
  async sendTelemetry(reason = 'manual', { keepalive = false } = {}) {
    this._lastSend = this.clock();
    if (this.telemetry.enabled && this.flags.analytics !== false) this.telemetry.seal();
    return this.flush({ keepalive });
  }

  /** The schedule looks at the clock (every minute): a delta every 15 minutes while the page is visible. */
  _tick() {
    const doc = this.lifecycle.document;
    const visible = !(doc && doc.visibilityState === 'hidden');
    if (!visible || this.stopped) return false;
    if (this._lastSend !== null && this.clock() - this._lastSend < DELTA_INTERVAL_MS) return false;
    this.sendTelemetry('interval').catch(() => {});
    return true;
  }

  _startSchedule() {
    if (this._schedule) return;
    const doc = this.lifecycle.document, win = this.lifecycle.window;
    const onVisibility = () => { if (doc.visibilityState === 'hidden') this.background().catch(() => {}); else if (this._hidden) this.foreground(); };
    const onPageHide = () => { if (!this._hidden) this.background().catch(() => {}); };
    if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility);
    if (win && typeof win.addEventListener === 'function') win.addEventListener('pagehide', onPageHide);
    const timer = setInterval(() => this._tick(), TICK_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    this._schedule = { timer, onVisibility, onPageHide };
  }

  /** Stop the SDK's delta schedule and page listeners (a test, or an app tearing the client down). */
  stopSchedule() {
    const s = this._schedule;
    if (!s) return;
    clearInterval(s.timer);
    const doc = this.lifecycle.document, win = this.lifecycle.window;
    if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', s.onVisibility);
    if (win && typeof win.removeEventListener === 'function') win.removeEventListener('pagehide', s.onPageHide);
    this._schedule = null;
  }

  /**
   * GET /v1/config with If-None-Match; verifies and stores it. A failure keeps the last good config.
   * Returns the config in force (or null).
   */
  async refreshConfig() {
    const saved = this.state.get('config');
    const nearExpiry = saved && saved.cfg && saved.cfg.expires_at * 1000 - this.configClock(saved) < 3600_000;
    const q = new URLSearchParams({ bucket: String(this.state.get('bucket')), sdk: SDK_VERSION });
    // a model pinned by version (SPEC 2a): the server answers that version's build for this SDK, or its
    // normal choice with pin.status "unavailable". A stored config made for another pin is not reused.
    const pin = this.modelVersionPin || null;
    if (pin) q.set('model_version', pin);
    // 27.1: the app's version and build, after the parameters of before, cleaned, a + as %2B; left out when unknown
    const av = appValue(this.appVersion), ab = appValue(this.appBuild);
    if (av) q.set('app_version', av);
    if (ab) q.set('app_build', ab);
    const samePin = saved && (saved.pin || null) === pin;
    const headers = {};
    if (saved && saved.etag && !nearExpiry && samePin) headers['if-none-match'] = saved.etag;
    // 28.3: a 200 is the config's answer only when it verifies: one that does not is unreachable on that host and the
    // next host is asked (a runtime that cannot verify at all ends the request with that failure)
    const r = await this._call('GET', `/v1/config?${q}`, { headers, raw: true, accept: configAccept(this.trustedKeys, () => this.clock()) });
    this.configCheckedAt = this.clock();
    if (r.status === 304 && saved) { this.config = saved.cfg; this.configFresh = true; this._accepted(); this._syncEndpoints(); this._noticeSdkLatest(); return this.config; }
    if (r.status >= 400) {
      let e = {};
      try { e = await r.json(); } catch (_) { /* none */ }
      const err = new PlatformError(r.status, e.error || 'http_' + r.status, e.message);
      err.stage = 'config';
      err.host_role = 'api';
      err.fallback = !!r.qlFallback;
      if (typeof e.min_sdk === 'string') err.minSdk = e.min_sdk;
      if (typeof e.reason === 'string') err.reason = e.reason;
      const stop = stopReasonOf(err.reason);
      if ((r.status === 401 || r.status === 403) && (err.code !== 'invalid_token' || stop)) this.refusedError = err;
      if (STOP_CODES.has(err.code) || stop) { this.stopped = err.code; this.stoppedError = err; }
      this._refusal(err);
      throw err;
    }
    let cfg;
    const device = this.clock();
    let dated = dateHeaderMs(r);
    if (r.qlValue && r.qlValue.cfg) {
      // verified as the host's answer (28.3): the bytes read once
      ({ cfg, dated } = r.qlValue);
      try { if (r.body && typeof r.body.cancel === 'function') r.body.cancel().catch(() => {}); } catch (_) { /* read */ }
    } else {
      const body = new Uint8Array(await r.arrayBuffer());
      try {
        cfg = await verifySignedConfig(body, r.headers.get('x-qlab-signature'), r.headers.get('x-qlab-key-id'), this.trustedKeys, device, dated);
      } catch (e) {
        // a runtime that cannot verify at all is the runtime's limit, not a bad signature (and not offline); either
        // way the launch reports it (3.1.7: an error report, ERRORS_40.md 24.1)
        if (e && e.name === 'PlatformError') { e.stage = 'config'; e.host_role = 'api'; e.fallback = !!r.qlFallback; }
        throw e;
      }
    }
    // the device clock's offset from the server's, kept with the config, so the stored config is judged by the same
    // clock at the next start (configClock)
    const server = serverTime(cfg, dated);
    const skew = server !== null && Math.abs(server - device) > CLOCK_SKEW_MS ? server - device : 0;
    this.config = cfg;
    this.configFresh = true;
    this._accepted(); // a config that verified: the server accepts this key
    this.state.set('config', { cfg, pin, etag: r.headers.get('etag'), sig: r.headers.get('x-qlab-signature'), kid: r.headers.get('x-qlab-key-id'), skew });
    this._syncEndpoints(); // 28.2: its endpoints are the lists in force from the next request
    if (cfg.flags && cfg.flags.analytics === false) this.telemetry.clear();
    this.telemetry.enabled = this.analyticsOn && !(cfg.flags && cfg.flags.analytics === false);
    this._noticeSdkLatest();
    return cfg;
  }

  // the signed config's sdk_latest: one line for the developer per launch, never in production
  // (update-notice.js); unknown or malformed fields of the config are ignored like every other one
  _noticeSdkLatest() { noticeSdkLatest(this.config, SDK_VERSION, { debug: this.debug }); }

  /** Refresh the config every `ms` (60 s) while the app is in use; call stop() when it is not. */
  startRefresh(ms = 60_000) {
    this.stopRefresh();
    this._timer = setInterval(() => { this.refreshConfig().catch(() => {}); }, ms);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }
  stopRefresh() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  /**
   * Where the model for this app lives on the CDN (SPEC 2a): the config names a version and a build; the files
   * are fetched by the build's URL, which never changes content. Returns { url, version, build, modelId, pin }
   * (pin: the config's answer to a pinned version it could not serve, or null). The requests' headers are
   * modelHeaders().
   */
  async modelSource() {
    const pinned = this.modelVersionPin || null;
    const stored = this.state.get('config');
    const usable = this.config && (!stored || (stored.pin || null) === pinned);
    const cfg = usable ? this.config : (await this.refreshConfig().catch((e) => { this.lastError = e; return null; }));
    const rec = cfg && cfg.recommended;
    if (!cfg) {
      // the server refused this client for the launch: that answer, not a network failure
      if (this.stoppedError) throw this.stoppedError;
      if (this.lastError && this.lastError.code === 'runtime_unsupported') throw this.lastError;
      // 3.1.7 (ERRORS_40.md 24.4): a config the server answered but that did not verify or has expired is that
      // failure (download_failed), never needs_connection; only no answer at all is offline
      const last = this.lastError;
      if (last instanceof PlatformError && (last.status || last.code === 'signature_invalid' || last.code === 'config_expired')) throw last;
      // the token gates the config: a token request that got no answer is the cause (ERRORS_40.md 24.4 rule 3a)
      const cause = last && last.qlReport && last.qlReport.stage === 'attest' ? last.qlReport : { stage: 'config', reason: 'network' };
      throw tag(new PlatformError(0, 'offline', 'no signed config could be fetched'), cause);
    }
    // a config with no model entry: Quran Lab has no build for this SDK generation yet (the next config may)
    if (!rec || !rec.revision) throw tag(new PlatformError(0, 'model_unavailable', 'the config offers no model build to this SDK'), { stage: 'config', reason: 'unavailable' });
    const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
    this.modelRevision = typeof rec.version === 'string' ? rec.version : null;
    this.modelBuild = String(rec.revision);
    // the base: the app's modelsUrl, else the signed config's base, else the app's cdnUrl (old /hf/ path), else
    // cdn.quranlab.ai/models. A bare cdn.quranlab.ai base always means the /hf/ path.
    // (a base on a host of the allow-list, ENDPOINTS_40.md 28.4; a test build's own model host too)
    const signed = typeof cfg.base === 'string' && this.ep.baseOf(cfg.base.replace(/\/*$/, '/')) ? cfg.base.replace(/\/+$/, '') : null;
    let base = this.modelsUrl || signed || (this.legacyCdn ? this.cdnUrl + '/hf' : MODELS_URL);
    if (REGIONAL_CDN.test(base)) base += '/hf';
    const pin = cfg.pin && typeof cfg.pin === 'object' && typeof cfg.pin.version === 'string' ? { version: cfg.pin.version, status: String(cfg.pin.status || '') } : null;
    return { url: `${base}/${enc(rec.model)}/${enc(rec.revision)}/${enc(rec.folder || 'sdk/' + rec.model_id)}/`,
      version: this.modelRevision, build: this.modelBuild, modelId: rec.model_id || null, pin };
  }

  /** A model was opened for this client: its load time, and what its delivery downloaded. */
  modelOpened(cohort, { loadMs = 0, delivery = null } = {}) {
    this.modelRevision = cohort.revision;
    this.modelBuild = cohort.build;
    this.telemetry.modelLoaded(cohort, loadMs);
    if (delivery && delivery.bytesDownloaded > 0) {
      this.telemetry.download({ revision: cohort.revision, build: cohort.build, profile: 'web-cpu', bytes: delivery.bytesDownloaded, success: true, resumed: delivery.rangesResumed > 0 });
    }
  }

  /** The sharing controller (web/consent). TajweedClient makes it when the Client is created (3.0.0; 2.x made it
   * here on first use, with a dynamic import that a bundler could not place). */
  wireSharing() { return Promise.resolve(this.sharing); }

  /**
   * A take starts (a Session): the object the Session feeds with the take's audio, so a learner who agreed
   * shares it (web/consent wraps its pushAudio, finish and free). Never in the way of the take.
   */
  takeStarted({ sampleRate }) {
    const tap = { pushAudio() { return 0; }, finish() { return 0; }, free() {} };
    try {
      if (this.sharing && typeof this.sharing.streamStarted === 'function') this.sharing.streamStarted({ sampleRate }, tap);
    } catch (_) { /* sharing's own problem */ }
    return tap;
  }

  /** A take ended ({ end: 'normal' | 'interrupted' | 'error' | 'cancelled', speechMs }): the sharing controller
   * counts a completed session and decides whether this is the moment to ask (SDK 4.0, contract 20.5 take_end). */
  takeFinished(o = {}) {
    try {
      if (this.sharing && typeof this.sharing.takeEnded === 'function') Promise.resolve(this.sharing.takeEnded(o)).catch(() => {});
    } catch (_) { /* sharing's own problem */ }
  }
  // ---- telemetry and issues ----
  /** Send the sealed telemetry reports that are due, oldest first, each with its stored bytes (202 deletes, 400 and
   * 413 drop, 401 renews the token once then keeps, 429 / 5xx / 503 / network keep it with backoff: 1 min, 10 min,
   * the next launch), then the queued issues. Returns the reports accepted. */
  async flush({ keepalive = false } = {}) {
    let sent = 0;
    if (this.stopped) return 0;
    if (this.telemetry.enabled && this.flags.analytics !== false) {
      for (const r of this.telemetry.due()) {
        try {
          await this._call('POST', '/v1/events', { body: r.body, keepalive });
          this.telemetry.dropReport(r.report_id);
          sent++;
        } catch (e) {
          if (e.status === 400 || e.status === 413) {
            this.telemetry.dropReport(r.report_id);
            this._silent('events', 'http', { http_status: e.status, error_code: e.code });
          } else {
            this.telemetry.deferReport(r.report_id);
            break;
          }
        }
      }
    } else if (this.flags.analytics === false) this.telemetry.clear();
    const issues = this.state.get('issues.queue') || [];
    const keep = [];
    for (const i of issues) {
      if (!this.issuesOn || this.flags.issues === false) break;
      try { await this._call('POST', '/v1/issues', { body: i }); } catch (e) { if (!(e.status === 400)) keep.push(i); }
    }
    this.state.set('issues.queue', this.flags.issues === false ? [] : keep);
    await this.flushErrors({ keepalive }).catch(() => 0);
    return sent;
  }

  /** The sharing controller's issues (a take list refused, a recording that could not start): from 3.1.7 error
   * reports of the stage `sharing` (ERRORS_40.md 24.1), never the older kinds. */
  reportIssue(kind, code) {
    const c = String(code || '');
    // 4.0: the hosted engine that did not load stays an issue of kind engine_failed, which the server's engine
    // rollback counts by site (qlab-api src/engineRollback.js); it is also an error report when the app is told
    if (kind === 'engine_failed' && c.startsWith('engine_load_failed:')) return this._engineIssue(c);
    if (c === 'bad_request:takes') return this._silent('sharing', 'http', { http_status: 400, error_code: 'bad_request' });
    const rest = c.includes(':') ? c.slice(c.indexOf(':') + 1) : c;
    return this._silent('sharing', 'other', /^[A-Za-z0-9_.:-]{1,32}$/.test(rest) ? { error_code: rest } : {});
  }

  // the frame's engine_load_failed issue, one per code and UTC day (the 3.x issue body, unchanged)
  _engineIssue(code) {
    if (!this.issuesOn || this.flags.issues === false) return false;
    const c = String(code).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64);
    const day = utcDay(this.clock());
    const seen = this.state.get('issues.seen') || {};
    const sig = `${day}|engine_failed|${c}`;
    if (seen[sig]) return false;
    for (const s of Object.keys(seen)) if (!s.startsWith(day)) delete seen[s];
    seen[sig] = 1;
    this.state.set('issues.seen', seen);
    const q = this.state.get('issues.queue') || [];
    q.push({ day, platform: this.platform, sdk_version: SDK_VERSION, app_version: this.appVersion, os_version: String(this.telemetry.device.os_major),
      device_class: this.telemetry.device.class, backend: 'exact', ...(this.modelRevision ? { revision: this.modelRevision } : {}), kind: 'engine_failed', code: c });
    this.state.set('issues.queue', q.slice(-20));
    return true;
  }

  // ---- error reports (3.1.7, ERRORS_40.md section 24) ----
  /**
   * A failure for the error reports. `err`: what the app was given (a TajweedError: its code is the report's), or
   * with `silent` the internal failure of something the SDK went on without (code "none"). Never throws, never
   * waits; returns whether it made a new report.
   */
  reportFailure(err, { silent = false, extra = {}, code = null } = {}) {
    try {
      const c = classify(err);
      return this._occur({ ...c, ...extra, code: silent ? 'none' : code || (err && err.code) || 'none' });
    } catch (_) { return false; }
  }

  /** A silent failure the SDK names itself: stage, reason and the report's other fields. */
  _silent(stage, reason, extra = {}) {
    try { return this._occur({ ...extra, stage, reason, code: 'none' }); } catch (_) { return false; }
  }

  _occur(o) {
    refreshStorageEstimate(this.clock());
    return this.errors.occur({ ...o, first_launch: this.firstLaunch, revision: this.modelRevision || undefined,
      build: this.modelBuild || undefined, web: webSnapshot({ worker: this.engineInWorker }) });
  }

  // 30 s after a new report while the page is visible; a hidden page sends at its next send point (24.6)
  _errorsSoon() {
    if (this._errTimer || this.stopped) return;
    this._errTimer = setTimeout(() => {
      this._errTimer = null;
      const doc = this.lifecycle && this.lifecycle.document;
      if (doc && doc.visibilityState === 'hidden') return;
      this.flushErrors().catch(() => {});
    }, SEND_AFTER_MS);
    if (this._errTimer && typeof this._errTimer.unref === 'function') this._errTimer.unref();
  }

  /** Send the queued error reports, oldest first (202 sent; 400 and 413 dropped; anything else kept for later). */
  flushErrors({ keepalive = false } = {}) {
    if (this.stopped) return Promise.resolve(0);
    return this.errors.flush((body) => this._call('POST', '/v1/issues', { body, keepalive }));
  }

  /** A model download that failed (24.8): counted in the day's telemetry with its reason. */
  downloadFailed({ revision, build = null, bytes = 0, reason }) {
    try {
      if (!revision) return;
      this.telemetry.download({ revision, build, profile: 'web-cpu', bytes, success: false, reason: telemetryReason(reason) });
    } catch (_) { /* telemetry never stops a call */ }
  }

  // ---- the learner's sharing routes (section 9) ----
  /** The contribution code (32 hex), created on first use, stored per origin. */
  contributor() {
    let c = this.state.get('contributor');
    if (!c) {
      const b = new Uint8Array(16);
      globalThis.crypto.getRandomValues(b);
      c = bytesToHex(b);
      this.state.set('contributor', c);
    }
    return c;
  }
  resetContributor() { this.state.set('contributor', null); }

  /** GET /v1/contributions/summary (real numbers only; null when it fails). */
  async contributionSummary() {
    try { return await this._call('GET', '/v1/contributions/summary', { headers: { 'x-qlab-contributor': this.contributor() } }); } catch (_) { return null; }
  }

  /** Whether sharing can be offered now: Quran Lab's global incident switch in the signed config
   * (flags.contributions) is on and this platform's upload tier allows it (upload_trust). No app is exempt and the
   * app's `contributions` option changes nothing (2.0.1). No signed config in force: no. This never means the learner
   * agreed: the consent state (consent/state.js) does. */
  sharingAllowed() {
    const f = this.config && this.config.flags;
    if (!f || f.contributions !== true) return false;
    // owner decision (11-07): web and desktop upload at the lower trust tier (`capped`, attested=false);
    // an absent upload_trust entry means that tier; `off` or `attested` (which they cannot meet) mean no
    const trust = (f.upload_trust && f.upload_trust[this.platform]) || 'capped';
    return trust === 'capped';
  }
}
