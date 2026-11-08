// The Quran Lab platform client for the web product: the
// developer key, an unattested app token, register, the signed config (Ed25519 over the exact bytes,
// pinned key ids, ETag, 60 s refresh while in use), the tajweed block into the model's settings,
// telemetry v2 (on by default, anonymous), issues, and the learner's sharing routes. Nothing here sits
// in the recognition path: a failing network never stops recognition.
//
//   import { QuranLab } from '@quran-lab/tajweedformer/platform';
//   const ql = await QuranLab.configure({ key: 'qlk_v1_...', appVersion: '1.4.0' });
//   const tf = await TajweedFormer.load({ platform: ql });   // the recommended model, settings, telemetry

import { Telemetry, deviceInfo, utcDay } from './telemetry.js';
import { localState } from './storage.js';
import { QURANLAB_PUBLIC_KEY_HEX, hexToBytes, bytesToHex } from '../tajweed/manifest.js';
import { decode } from '../tajweed/decode.js';

export const SDK_VERSION = '2.0.0';
export const API_URL = 'https://api.quranlab.ai';
export const CDN_URL = 'https://cdn.quranlab.ai';
const ISSUE_KINDS = ['engine_failed', 'model_load', 'checksum_mismatch', 'signature_invalid', 'update_failed', 'fallback',
  'self_test_failed', 'audio_input', 'other'];
/** Codes after which the client stops all network calls until the next launch (error table). */
const STOP_CODES = new Set(['invalid_key', 'unauthorized', 'developer_not_approved', 'not_a_member', 'key_type_mismatch',
  'origin_not_allowed', 'app_not_allowed', 'app_blocked', 'environment_mismatch', 'sdk_too_old']);

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
   * @param {boolean} [o.contributions=false]  recitation sharing (asks the learner first)
   * @param {'general'|'children'} [o.audience]
   * @param {number} [o.sharingBitrate]  Opus bit/s for shared sessions (default 192000, SHARING_BITRATE_DEFAULT)
   * @param {object} [o.state]  persistence (default localStorage; Node: dirState(dir))
   * @param {Array<string|Uint8Array>} [o.trustedKeys]  pinned config keys (default Quran Lab's)
   * @param {string} [o.apiUrl] [o.cdnUrl] [o.fetch] [o.clock]
   */
  constructor(o) {
    if (!o || typeof o.key !== 'string' || !/^qlk_v1_/.test(o.key)) throw new TypeError('QuranLab: a developer key qlk_v1_... is needed');
    const inBrowser = typeof globalThis.window !== 'undefined' && !!globalThis.location;
    this.key = o.key;
    this.apiUrl = (o.apiUrl || API_URL).replace(/\/$/, '');
    this.cdnUrl = (o.cdnUrl || CDN_URL).replace(/\/$/, '');
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
    this.stopped = null; // the code that stopped the network this launch
    this.config = null;
    this._token = null;
    this._timer = null;
    this.telemetry = new Telemetry({ state: this.state, product: 'web', platform: this.platform, sdkVersion: SDK_VERSION,
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
  async _call(method, path, { body = null, auth = 'token', headers = {}, raw = false } = {}) {
    if (this.stopped) throw new PlatformError(0, this.stopped, 'stopped for this launch');
    const h = { ...headers };
    if (this.origin) h.origin = this.origin;
    if (auth === 'key') h['x-qlab-key'] = this.key;
    else if (auth === 'token') h.authorization = `Bearer ${await this.token()}`;
    if (body !== null) h['content-type'] = 'application/json';
    const r = await this.fetch(this.apiUrl + path, { method, headers: h, body: body === null ? undefined : JSON.stringify(body) });
    if (raw) return r;
    if (r.status >= 400) {
      let e = {};
      try { e = await r.json(); } catch (_) { /* no body */ }
      const err = new PlatformError(r.status, e.error || 'http_' + r.status, e.message || '');
      if (STOP_CODES.has(err.code)) this.stopped = err.code;
      if (err.code === 'invalid_token' && auth === 'token' && !headers['x-retried']) {
        this._token = null; this.state.set('token', null);
        return this._call(method, path, { body, auth, headers: { ...headers, 'x-retried': '1' } }).catch((e2) => { throw e2; });
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
  async launch() {
    const steps = [() => this.register(), () => this.refreshConfig(), () => this.flush()];
    for (const s of steps) {
      try { await s(); } catch (e) { this.lastError = e; if (this.stopped) break; }
    }
  }

  /** POST /v1/register, once per launch. */
  async register() {
    if (this._registered) return this._registered;
    const first = this.state.get('installed') === null;
    if (first) this.state.set('installed', true);
    const pendingNew = this.state.get('register.pending_new') === true;
    const newInstall = first || pendingNew;
    this.state.set('register.pending_new', newInstall);
    const body = { platform: this.platform, bundle_id: this.bundleId, app_version: this.appVersion, sdk_version: SDK_VERSION, new_install: newInstall };
    if (this.appName) body.app_name = this.appName;
    if (this.modelRevision) body.model_revision = this.modelRevision;
    this._registered = await this._call('POST', '/v1/register', { body });
    this.state.set('register.pending_new', null);
    return this._registered;
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
    if (r.status === 304 && saved) { this.config = saved.cfg; return this.config; }
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
    return cfg;
  }

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
    return { url: `${this.cdnUrl}/hf/${enc(rec.model)}/${enc(rec.revision)}/${enc(rec.folder || 'sdk/' + rec.model_id)}/`,
      headers: { 'x-qlab-key': this.key, ...(this.origin ? { origin: this.origin } : {}) } };
  }

  /** Called by TajweedFormer.load({ platform }): the portal's settings and the telemetry hooks. */
  attach(tf) {
    this._models = (this._models || []).filter((x) => x._eng);
    this._models.push(tf);
    if (this.config) tf.setRemoteConfig(this.config);
    tf._telemetry = this;
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
  /** Send every completed day (202 drop, 400 drop, 401 renew once, else keep) and queued issues. */
  async flush() {
    let sent = 0;
    if (this.telemetry.enabled && this.flags.analytics !== false) {
      for (const p of this.telemetry.pending()) {
        try { await this._call('POST', '/v1/events', { body: p }); this.telemetry.drop(p.day); sent++; } catch (e) {
          if (e.status === 400 || e.status === 413) this.telemetry.drop(p.day); else break;
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

  /** Whether this install may upload under the signed config (flags.contributions and upload_trust). */
  sharingAllowed() {
    const f = this.flags;
    if (!this.contributions || f.contributions !== true) return false;
    // owner decision (11-07): web and desktop upload at the lower trust tier (`capped`, attested=false);
    // an absent upload_trust entry means that tier; `off` or `attested` (which they cannot meet) mean no
    const trust = (f.upload_trust && f.upload_trust[this.platform]) || 'capped';
    return trust === 'capped';
  }
}
