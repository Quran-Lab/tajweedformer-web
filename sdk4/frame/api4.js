// The link to Quran Lab's API from the engine Worker, on Quran Lab's frame origin: the 3.x platform client
// (web/platform/client.js: register, the signed config, telemetry, the stop rules of SPEC 15.3) with the 4.0 parts:
//
//   - every request names the site the frame verified (x-qlab-site: <origin>), because the browser sends the
//     frame's own origin as Origin (docs/server-for-web-4.md, "The API and the frame origin");
//   - the app token comes from POST /v1/attest with the install keys (kept across page loads, keys.js and
//     lease-store.js), once per page load; the token is kept in memory only. The install certificate a lease rides on
//     is kept with the lease (lease-store.js): a stored certificate that still has more than 10 minutes is kept over
//     the `att none` one a new attest answers, so a page load within a Turnstile pass's life needs no new pass;
//   - GET /v1/attest/challenge and POST /v1/model-key (18.4.4 to 18.4.10).
import { QuranLab, PlatformError, acceptJson } from '../../web/platform/client.js';
import { b64u } from '../shared/bytes.js';
import { Telemetry4 } from './telemetry4.js';
import { productOf } from '../../web/platform/telemetry.js';
import { certField } from './lease-store.js';

export const SDK_VERSION_4 = '4.0.1';
export const API_VERSION = 4;

/** A state view that keeps some keys in memory only (the token: per page session in 4.0). */
function sessionOnly(state, keys) {
  const mem = new Map();
  return {
    get: (k) => (keys.includes(k) ? (mem.has(k) ? mem.get(k) : null) : state.get(k)),
    set: (k, v) => { if (keys.includes(k)) { if (v === null || v === undefined) mem.delete(k); else mem.set(k, v); } else state.set(k, v); },
    flush: () => state.flush(),
  };
}

// A request to Quran Lab's API (config, register, attest, the challenge, the lease, the origin check, events, reports)
// goes through the api hosts in their failover order (ENDPOINTS_40.md 28.3, sdk4/shared/endpoints.js): each host has
// 10 s without a byte before its status, then the next host is asked; after the status, the answer has API_TIMEOUT_MS
// more, as the C SDK's 30 s. Until 11-18 nothing bounded it: on staging (Stage B) a config route that hung made
// create() wait 82 s and a fresh model call 40 s more, each until the network gave up. boundedFetch is the bound of
// before 4.0.1, kept for a caller of its own: a request that brings its own signal is left to it.
export const API_TIMEOUT_MS = 30_000;
export function boundedFetch(f, ms = API_TIMEOUT_MS) {
  return (url, init = {}) => {
    if (init.signal || typeof AbortController !== 'function' || !(ms > 0)) return f(url, init);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    return Promise.resolve(f(url, { ...init, signal: ac.signal })).finally(() => clearTimeout(t));
  };
}

export class QuranLab4 extends QuranLab {
  /**
   * @param {object} o  QuranLab's options, plus: site (the verified site origin), keys (InstallKeys), fetch;
   *   desktop: { platform ('windows' | 'macos' | 'linux'), appId } for the Node path (sdk4/node): a desktop key's app,
   *   no x-qlab-site, the app id as the bundle id, the desktop platform in attest and lease bodies.
   */
  constructor(o) {
    const desktop = o.desktop && typeof o.desktop === 'object' ? o.desktop : null;
    const site = desktop ? null : o.site;
    const raw = o.fetch || globalThis.fetch.bind(globalThis);
    const fetch = desktop ? raw : (url, init = {}) => raw(url, { ...init, headers: { ...(init.headers || {}), 'x-qlab-site': site } });
    // no analytics option in 4.0 (owner, 11-16): an `analytics` in the options is never read; the signed config's
    // flags.analytics is Quran Lab's only off switch
    const { analytics: _gone, desktop: _d, ...rest } = o;
    const platform = desktop ? desktop.platform : 'web';
    super({ ...rest, fetch, bundleId: desktop ? desktop.appId : site, platform, state: sessionOnly(o.state, ['token']),
      apiTimeoutMs: Number.isFinite(o.apiTimeoutMs) ? o.apiTimeoutMs : API_TIMEOUT_MS, lifecycle: { document: null, window: null } });
    this.analyticsOn = true;
    this.site = site;
    this.keys = o.keys;
    this.installCert = typeof o.cert === 'string' ? o.cert : null; // the certificate the stored lease rides on, or null
    // the groups of 17.8 and 17.9 the signed config switches off (flags.metrics: absent or true is on)
    const metricsOff = () => new Set(Object.entries((this.flags && this.flags.metrics) || {}).filter(([, v]) => v === false).map(([k]) => k));
    this.telemetry = new Telemetry4({ state: this.state, product: productOf(platform), platform, sdkVersion: SDK_VERSION_4,
      appVersion: this.appVersion, device: this.telemetry.device, clock: this.clock, enabled: this.analyticsOn, metricsOff, local: o.local });
    this.sdkVersion = SDK_VERSION_4;
    this.telemetry.onExpired = () => this._silent('events', 'expired');
  }

  /** The app token and the page session's install certificate: POST /v1/attest with the install keys (18.4.3). */
  async token() {
    const now = this.clock() / 1000;
    const t = this._token;
    if (t && t.exp - now > 3600 && this.installCert) return t.token;
    const body = { platform: this.platform, bundle_id: this.bundleId, install_key: b64u(this.keys.spki), install_sign_key: b64u(this.keys.signSpki),
      install_sig: await this.keys.attestSig(null), install_hw: this.keys.hw };
    const r = await this._call('POST', '/v1/attest', { auth: 'key', body, accept: acceptJson('token') });
    this._token = { token: r.token, exp: now + (r.expires_in || 86400), attested: false };
    if (typeof r.install_cert === 'string' && !this.certHolds()) this.installCert = r.install_cert;
    return r.token;
  }

  /** The certificate held is for these install keys and has more than 10 minutes left (by the device clock; a server
   * that disagrees answers install_cert_invalid, and the certificate is made again). */
  certHolds() {
    const c = this.installCert;
    if (typeof c !== 'string') return false;
    const exp = Number(certField(c, 'exp'));
    return certField(c, 'install') === this.keys.installHex && Number.isFinite(exp) && exp - this.clock() / 1000 > 600;
  }

  /** A fresh certificate (install_cert_invalid): attest again. */
  async reattest() { this._token = null; this.installCert = null; return this.token(); }

  /** GET /v1/attest/challenge with the app token (18.4.1 step 3). */
  async challenge() {
    const r = await this._call('GET', '/v1/attest/challenge', { accept: acceptJson('challenge') });
    if (!r || typeof r.challenge !== 'string') throw new PlatformError(0, 'invalid_answer', 'no challenge in the answer');
    return r.challenge;
  }

  /**
   * POST /v1/model-key through the api order (28.3, 28.5). Returns { status, body, text, retryAfter, fallback, value }:
   * the caller decides on every status (18.4.10), because a stop on this route must reach the Core as the signed text
   * it is. `accept` (the lease answer's own check, 18.4.5: a base of the allow-list and a lease the Core takes): a 200
   * it does not take is unreachable on that host, and the next host is asked; `value` is what it took.
   */
  async modelKey(body, accept = null) {
    const token = await this.token();
    this._syncEndpoints();
    let r;
    try {
      r = await this.fetch(this.apiUrl + '/v1/model-key', { method: 'POST', redirect: 'error', qlAccept: accept, qlStage: 'lease',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      if (e && (e.name === 'SdkError' || e.name === 'PlatformError')) throw e; // the answer's own check failed (the manifest)
      return { status: 0, body: null, text: '', error: e, fallback: !!e.qlFallback };
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = null; }
    if (r.status < 400) this.keyAccepted = true;
    // Retry-After of a 5xx or 429 (503 lease_unavailable: 30 s); a browser shows it only when the API exposes it
    let retryAfter = null;
    try { retryAfter = r.headers && typeof r.headers.get === 'function' ? r.headers.get('retry-after') : null; } catch (_) { retryAfter = null; }
    // 28.5: unreachable on every host, the largest Retry-After any of them gave
    if (Number.isFinite(r.qlRetryAfter) && r.qlRetryAfter !== null) retryAfter = String(r.qlRetryAfter);
    return { status: r.status, body: json, text, retryAfter, fallback: !!r.qlFallback, value: r.qlValue || null };
  }
}
