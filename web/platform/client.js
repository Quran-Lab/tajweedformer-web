// The Quran Lab platform client for the web product: the
// developer key, an unattested app token, register, the signed config (Ed25519 over the exact bytes,
// pinned key ids, ETag, 60 s refresh while in use), the tajweed block into the model's settings,
// telemetry v2 (on by default, anonymous), issues, and the learner's sharing routes. Nothing here sits
// in the recognition path: a failing network never stops recognition.
//
//   import { QuranLab } from '@quran-lab/tajweedformer/platform';
//   const ql = await QuranLab.configure({ key: 'qlk_v1_...', appVersion: '1.4.0' });
//   const tf = await TajweedFormer.load({ platform: ql });   // the recommended model, settings, telemetry

import { Telemetry, deviceInfo, utcDay, productOf } from './telemetry.js';
import { localState } from './storage.js';
import { QURANLAB_PUBLIC_KEY_HEX, hexToBytes, bytesToHex } from '../tajweed/manifest.js';
import { decode } from '../tajweed/decode.js';
import { noticeSdkLatest } from './update-notice.js';

export const SDK_VERSION = '2.0.1';
export const API_URL = 'https://api.quranlab.ai';
export const CDN_URL = 'https://cdn.quranlab.ai';
/** Where model files are served: {base}/{owner}/{repo}/{revision}/{path}. The signed config's `base`
 * replaces it when present; a cdnUrl given without modelsUrl keeps the old {cdn}/hf/ path. */
export const MODELS_URL = 'https://cdn.quranlab.ai/models';
const SAFE_BASE = /^(https:\/\/[A-Za-z0-9.-]+(:\d+)?|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/[A-Za-z0-9._~\/-]*)?$/;
const REGIONAL_CDN = /^https:\/\/((weur|eeur|enam|wnam|apac|oc)\.)?cdn\.quranlab\.ai$/;
const ISSUE_KINDS = ['engine_failed', 'model_load', 'checksum_mismatch', 'signature_invalid', 'update_failed', 'fallback',
  'self_test_failed', 'audio_input', 'other'];
/** Codes after which the client stops all network calls until the next launch (error table). */
const STOP_CODES = new Set(['invalid_key', 'unauthorized', 'developer_not_approved', 'not_a_member', 'key_type_mismatch',
  'origin_not_allowed', 'app_not_allowed', 'app_blocked', 'environment_mismatch', 'sdk_too_old']);
/** A telemetry delta every this long while the app is in use (2.0.1: Quran Lab's choice, 15 minutes). */
export const DELTA_INTERVAL_MS = 15 * 60_000;
/** How often the schedule looks at the clock. */
const TICK_MS = 60_000;

/** A platform failure: { status, code } from the API's {"error","message"} body. */
export class PlatformError extends Error {
  constructor(status, code, message) { super(`${status} ${code}${message ? ': ' + message : ''}`); this.name = 'PlatformError'; this.status = status; this.code = code; }
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
export async function verifySignedConfig(body, sigHeader, kid, trustedKeys, now = Date.now()) {
  if (!sigHeader || !sigHeader.startsWith('ed25519=') || !kid) throw new PlatformError(0, 'signature_invalid', 'no signature');
  let sig;
  try { sig = b64uToBytes(sigHeader.slice(8)); } catch (_) { throw new PlatformError(0, 'signature_invalid', 'bad signature encoding'); }
  let ok = false;
  for (const k of trustedKeys) {
    if ((await keyId(k)) !== kid) continue;
    const key = await subtle().importKey('raw', typeof k === 'string' ? hexToBytes(k) : k, { name: 'Ed25519' }, false, ['verify']);
    if (await subtle().verify({ name: 'Ed25519' }, key, sig, body)) { ok = true; break; }
  }
  if (!ok) throw new PlatformError(0, 'signature_invalid', `the config does not verify with a pinned key (kid ${kid})`);
  const cfg = JSON.parse(new TextDecoder().decode(body));
  if (cfg.v !== 1) throw new PlatformError(0, 'signature_invalid', `config v ${cfg.v}`);
  if (!(typeof cfg.expires_at === 'number' && cfg.expires_at * 1000 > now)) throw new PlatformError(0, 'config_expired', 'the config has expired');
  return cfg;
}

/**
 * One configured client. Use QuranLab.configure(...).
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
   * @param {boolean} [o.contributions]  ignored since 2.0.1: whether the sharing sheet is offered is Quran Lab's
   *   decision, in the signed config (flags.contributions); the SDK still asks the learner before anything is
   *   recorded for upload
   * @param {'general'|'children'} [o.audience]
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
    this.apiUrl = (o.apiUrl || API_URL).replace(/\/$/, '');
    this.cdnUrl = (o.cdnUrl || CDN_URL).replace(/\/$/, '');
    this.modelsUrl = o.modelsUrl ? o.modelsUrl.replace(/\/+$/, '') : null;
    this.legacyCdn = !!o.cdnUrl && !o.modelsUrl;
    this.platform = o.platform || 'web';
    this.bundleId = o.bundleId || (inBrowser ? globalThis.location.origin : null);
    if (!this.bundleId) throw new TypeError('QuranLab: bundleId is needed outside a browser (the origin for a web key, the app id for a desktop key)');
    this.origin = o.origin || null; // Node only: browsers set Origin themselves
    this.appVersion = o.appVersion || '0';
    this.appName = o.appName || null;
    this.fetch = o.fetch || globalThis.fetch.bind(globalThis);
    this.clock = o.clock || Date.now;
    this.state = o.state || localState();
    this.trustedKeys = o.trustedKeys || [QURANLAB_PUBLIC_KEY_HEX];
    this.analyticsOn = o.analytics !== 'off';
    this.issuesOn = o.issues !== false;
    this.contributions = !!o.contributions;
    this.audience = o.audience || 'general';
    this.sharingBitrate = o.sharingBitrate || null;
    this.autoSend = o.autoSend !== false;
    this.debug = typeof o.debug === 'boolean' ? o.debug : undefined;
    this.lifecycle = o.lifecycle || { document: globalThis.document, window: typeof globalThis.window !== 'undefined' ? globalThis.window : null };
    this._lastSend = null;
    this._hidden = false;
    this.stopped = null; // the code that stopped the network this launch
    this.config = null;
    this._token = null;
    this._timer = null;
    this.telemetry = new Telemetry({ state: this.state, product: productOf(this.platform), platform: this.platform, sdkVersion: SDK_VERSION,
      appVersion: this.appVersion, device: deviceInfo(), clock: this.clock, enabled: this.analyticsOn });
    // the stored signed config, if still valid, until the network answers
    const saved = this.state.get('config');
    if (saved && saved.cfg && saved.cfg.expires_at * 1000 > this.clock()) this.config = saved.cfg;
    if (this.state.get('bucket') === null) this.state.set('bucket', Math.floor(Math.random() * 100));
  }

  /** Configure and run the launch sequence (token, register, config, pending telemetry and issues).
   * Never throws for network trouble; check `ql.stopped` and `ql.lastError`. */
  static async configure(o) {
    const ql = new QuranLab(o);
    await ql.launch();
    return ql;
  }

  get flags() { return (this.config && this.config.flags) || { analytics: true, issues: true, contributions: false }; }

  // ---- HTTP ----
  async _call(method, path, { body = null, auth = 'token', headers = {}, raw = false, keepalive = false } = {}) {
    if (this.stopped) throw new PlatformError(0, this.stopped, 'stopped for this launch');
    const h = { ...headers };
    if (this.origin) h.origin = this.origin;
    if (auth === 'key') h['x-qlab-key'] = this.key;
    else if (auth === 'token') h.authorization = `Bearer ${await this.token()}`;
    if (body !== null) h['content-type'] = 'application/json';
    const init = { method, headers: h, body: body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body) };
    if (keepalive) init.keepalive = true; // a page being hidden or left: the request outlives it
    const r = await this.fetch(this.apiUrl + path, init);
    if (raw) return r;
    if (r.status >= 400) {
      let e = {};
      try { e = await r.json(); } catch (_) { /* no body */ }
      const err = new PlatformError(r.status, e.error || 'http_' + r.status, e.message || '');
      if (STOP_CODES.has(err.code)) this.stopped = err.code;
      if (err.code === 'invalid_token' && auth === 'token' && !headers['x-retried']) {
        this._token = null; this.state.set('token', null);
        return this._call(method, path, { body, auth, headers: { ...headers, 'x-retried': '1' }, keepalive }).catch((e2) => { throw e2; });
      }
      throw err;
    }
    return r.status === 204 || r.status === 304 ? null : r.json();
  }

  /** An unattested app token (24 h), renewed when under 1 h is left. */
  async token() {
    const now = this.clock() / 1000;
    const t = this._token || this.state.get('token');
    if (t && t.exp - now > 3600) { this._token = t; return t.token; }
    const r = await this._call('POST', '/v1/attest', { auth: 'key', body: { platform: this.platform, bundle_id: this.bundleId } });
    this._token = { token: r.token, exp: now + (r.expires_in || 86400), attested: !!r.attested };
    this.state.set('token', this._token);
    return r.token;
  }

  // ---- launch ----
  /** The launch sequence: a launch counted, register (once per UTC day), the signed config, the telemetry
   * reports left from earlier runs and this launch's delta, queued issues; then the delta schedule. */
  async launch() {
    this.telemetry.count('launches');
    this.telemetry.launched();
    const steps = [() => this.register(), () => this.refreshConfig(), () => this.sendTelemetry('launch')];
    for (const s of steps) {
      try { await s(); } catch (e) { this.lastError = e; if (this.stopped) break; }
    }
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
    const body = { platform: this.platform, bundle_id: this.bundleId, app_version: this.appVersion, sdk_version: SDK_VERSION, new_install: newInstall };
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
    if (!this.stopped) this.register().catch((e) => { this.lastError = e; });
  }

  /** The app goes to the background (the page is hidden or left): the delta since the last send point is
   * sealed and sent with keepalive requests. */
  background() {
    this._hidden = true;
    return this.sendTelemetry('background', { keepalive: true });
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
    const nearExpiry = saved && saved.cfg && saved.cfg.expires_at * 1000 - this.clock() < 3600_000;
    const q = new URLSearchParams({ bucket: String(this.state.get('bucket')), sdk: SDK_VERSION });
    const headers = {};
    if (saved && saved.etag && !nearExpiry) headers['if-none-match'] = saved.etag;
    const r = await this._call('GET', `/v1/config?${q}`, { headers, raw: true });
    if (r.status === 304 && saved) { this.config = saved.cfg; this._noticeSdkLatest(); return this.config; }
    if (r.status >= 400) {
      let e = {};
      try { e = await r.json(); } catch (_) { /* none */ }
      const err = new PlatformError(r.status, e.error || 'http_' + r.status, e.message);
      if (STOP_CODES.has(err.code)) this.stopped = err.code;
      throw err;
    }
    const body = new Uint8Array(await r.arrayBuffer());
    let cfg;
    try {
      cfg = await verifySignedConfig(body, r.headers.get('x-qlab-signature'), r.headers.get('x-qlab-key-id'), this.trustedKeys, this.clock());
    } catch (e) {
      this.reportIssue('signature_invalid', 'config:' + e.code);
      throw e;
    }
    this.config = cfg;
    this.state.set('config', { cfg, etag: r.headers.get('etag'), sig: r.headers.get('x-qlab-signature'), kid: r.headers.get('x-qlab-key-id') });
    if (cfg.flags && cfg.flags.analytics === false) this.telemetry.clear();
    this.telemetry.enabled = this.analyticsOn && !(cfg.flags && cfg.flags.analytics === false);
    for (const tf of this._models || []) tf.setRemoteConfig(cfg);
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

  /** Where the recommended model lives on the CDN: { url, headers } for TajweedFormer.load. */
  async modelSource() {
    const cfg = this.config || (await this.refreshConfig().catch(() => null));
    const rec = cfg && cfg.recommended;
    if (!rec || !rec.revision) throw new PlatformError(0, 'no_model', 'the config recommends no model for this app and SDK');
    const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
    this.modelRevision = `${rec.model_id || 'v4.0'}+${rec.revision}`.slice(0, 64);
    // the base: the app's modelsUrl, else the signed config's base, else the app's cdnUrl (old /hf/ path), else
    // cdn.quranlab.ai/models. A bare cdn.quranlab.ai base always means the /hf/ path.
    const signed = typeof cfg.base === 'string' && SAFE_BASE.test(cfg.base) ? cfg.base.replace(/\/+$/, '') : null;
    let base = this.modelsUrl || signed || (this.legacyCdn ? this.cdnUrl + '/hf' : MODELS_URL);
    if (REGIONAL_CDN.test(base)) base += '/hf';
    return { url: `${base}/${enc(rec.model)}/${enc(rec.revision)}/${enc(rec.folder || 'sdk/' + rec.model_id)}/`,
      headers: { 'x-qlab-key': this.key, ...(this.origin ? { origin: this.origin } : {}) } };
  }

  /** Called by TajweedFormer.load({ platform }): the portal's settings and the telemetry hooks. */
  attach(tf) {
    this._models = (this._models || []).filter((x) => x._eng);
    this._models.push(tf);
    if (this.config) tf.setRemoteConfig(this.config);
    tf._telemetry = this;
    // the sharing sheet is offered where the signed config says so, whether or not the app called
    // enableSharing (2.0.0 needed that call and the contributions option): in a page, the SDK wires its own
    // sheet here. Nothing is captured before the learner answers "Share" on it.
    if (!this.sharing && !this._sharingWiring && typeof globalThis.document !== 'undefined') {
      this._sharingWiring = import('../consent/index.js').then((m) => { if (!this.sharing) m.enableSharing(this); }).catch(() => {});
    }
    this.telemetry.modelLoaded(tf, tf.loadMs || 0);
    if (tf.delivery) {
      this.telemetry.download({ revision: this.modelRevision || 'unknown', profile: 'web-cpu', bytes: tf.delivery.bytesDownloaded,
        success: true, resumed: tf.delivery.rangesResumed > 0 });
    }
  }

  // hooks the model calls (tajweedformer.js)
  streamStarted(tf, s) {
    const self = this;
    const timings = [];
    let samples = 0, firstAt = null;
    const t0 = this.clock();
    const push = s.pushAudio.bind(s), finish = s.finish.bind(s), reset = s.reset.bind(s), free = s.free.bind(s);
    const timed = (fn, n) => { const a = performance.now(); const k = fn(); const ms = performance.now() - a; if (k > 0) for (let i = 0; i < k; i++) timings.push(ms / k); return k; };
    const end = (aborted) => {
      if (!samples) return;
      self.telemetry.session(tf, { seconds: samples / tf.sampleRate, chunkMs: timings.splice(0), aborted, firstMs: firstAt });
      try { self.telemetry.decoded(tf, decode(s.heads(), {})); } catch (_) { /* freed */ }
      samples = 0;
    };
    s.pushAudio = (pcm) => { if (firstAt === null) firstAt = self.clock() - t0; samples += pcm.length; return timed(() => push(pcm)); };
    s.finish = () => { const k = timed(finish); end(false); return k; };
    s.reset = () => { end(true); return reset(); };
    s.free = () => { end(true); return free(); };
    if (this.sharing && typeof this.sharing.streamStarted === 'function') this.sharing.streamStarted(tf, s);
  }
  scored(tf, result) { this.telemetry.scored(tf, result); }

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
            if (e.status === 400) this.reportIssue('other', `telemetry:${e.code || 'bad_request'}`);
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
    return sent;
  }

  /** Queue an issue report (no free text, no paths); one per kind+code per day. */
  reportIssue(kind, code, frames = []) {
    if (!this.issuesOn) return false;
    const k = ISSUE_KINDS.includes(kind) ? kind : 'other';
    const c = String(code).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64) || 'unknown';
    const day = utcDay(this.clock());
    const seen = this.state.get('issues.seen') || {};
    const sig = `${day}|${k}|${c}`;
    if (seen[sig]) return false;
    for (const s of Object.keys(seen)) if (!s.startsWith(day)) delete seen[s];
    seen[sig] = 1;
    this.state.set('issues.seen', seen);
    const ua = (globalThis.navigator && globalThis.navigator.userAgent) || '';
    const q = this.state.get('issues.queue') || [];
    q.push({ day, platform: this.platform, sdk_version: SDK_VERSION, app_version: this.appVersion,
      os_version: String(this.telemetry.device.os_major), device_class: this.telemetry.device.class, backend: 'exact',
      ...(this.modelRevision ? { revision: this.modelRevision } : {}), kind: k, code: c,
      ...(frames.length ? { frames: frames.slice(0, 16).map((f) => String(f).slice(0, 80)) } : {}) });
    this.state.set('issues.queue', q.slice(-20));
    void ua;
    return true;
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

  /** Whether the signed config offers sharing to this app (flags.contributions and upload_trust). Quran Lab
   * decides this per app; the app's `contributions` option no longer does (2.0.1). No signed config in force:
   * no. This never means the learner agreed: the consent state (consent/state.js) does. */
  sharingAllowed() {
    const f = this.config && this.config.flags;
    if (!f || f.contributions !== true) return false;
    // owner decision (11-07): web and desktop upload at the lower trust tier (`capped`, attested=false);
    // an absent upload_trust entry means that tier; `off` or `attested` (which they cannot meet) mean no
    const trust = (f.upload_trust && f.upload_trust[this.platform]) || 'capped';
    return trust === 'capped';
  }
}
