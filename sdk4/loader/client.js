// TajweedClient of API 4: the page's handle on Quran Lab's frame. It opens the frame (handshake, frame.js), and
// every call goes over the port to the engine Worker on Quran Lab's origin. One per page.
import { openFrame } from './link.js';
import { makeModel } from './model.js';
import { errorFrom } from './errors.js';
import { TajweedError, invalid } from '../../web/api/errors.js';
import { WASM_BACKEND } from '../../web/api/session.js';
import { microphonePermission } from '../../web/api/microphone.js';
import { RULE_RE } from '../shared/recited.js';
import { MODEL_VERSION_RE } from '../../web/tajweed/manifest.js';
import { refuseRemovedOptions } from '../shared/options.js';
import { ROLES, Endpoints } from '../shared/endpoints.js';
import { tag } from '../../web/platform/error-reports.js';

/* global __QL_FRAME_BASE__, __QL_FRAME_FALLBACK__, __QL_API__, __QL_TEST__, __QL_APP__, __QL_SHARING_SHA384__, __QL_PINS__ */
const APP = typeof __QL_APP__ !== 'undefined' ? __QL_APP__ : null;
const SHARING_SHA384 = typeof __QL_SHARING_SHA384__ !== 'undefined' ? __QL_SHARING_SHA384__ : null;
const PINS = typeof __QL_PINS__ !== 'undefined' ? __QL_PINS__ : undefined;
// test bundles only (scripts/build_web4.py --test): the frame bases, API and timeouts of a test page
const SEAMS = typeof __QL_TEST__ !== 'undefined' && __QL_TEST__ === true;
export const FRAME_BASE = typeof __QL_FRAME_BASE__ !== 'undefined' ? __QL_FRAME_BASE__ : `https://${ROLES.web_frame[0]}`;
/** The same frame on a second hostname and a route of its own, opened when the first gives no hello in 4 s (link.js). */
export const FRAME_FALLBACK = typeof __QL_FRAME_FALLBACK__ !== 'undefined' ? __QL_FRAME_FALLBACK__ : `https://${ROLES.web_frame[1]}`;
/** The frame's hosts in order (ENDPOINTS_40.md 28.6): web, web2, then the backup hosts; a test bundle's two stand-ins. The
 * loader carries this list itself: it is never taken from a config (28.2). */
export const FRAME_BASES = Object.freeze(typeof __QL_FRAME_BASE__ !== 'undefined' ? [FRAME_BASE, FRAME_FALLBACK] : ROLES.web_frame.map((h) => `https://${h}`));
export const API_URL = typeof __QL_API__ !== 'undefined' ? __QL_API__ : 'https://api.quranlab.ai';
export const SDK_VERSION = '4.0.2';
export const API = 4;
const MADE = Symbol('TajweedClient.create');
const MAX_CHECKS = 100_000;
let current = null;

export class TajweedClient {
  /** Use TajweedClient.create(options). */
  constructor(x, made) {
    if (made !== MADE || !x) throw invalid('a TajweedClient is made by TajweedClient.create(options)');
    this._x = x;
    this._closed = false;
    this._model = null;
    this._opening = null;
    this._lastError = null;
    this._droppedChunks = 0;
    this.pin = null;
    const self = this;
    this.analytics = Object.freeze({
      /** The app's own judge checked `rule` `checked` times and flagged `flagged` of them (anonymous daily totals). */
      reportChecks(rule, checked, flagged) {
        if (typeof rule !== 'string' || !RULE_RE.test(rule)) throw invalid(`rule ${JSON.stringify(rule)} is not a rule name (lower-case letters, digits and underscores, at most 24)`);
        if (!Number.isInteger(checked) || !Number.isInteger(flagged) || flagged < 0 || flagged > checked || checked > MAX_CHECKS) {
          throw invalid(`reportChecks needs whole numbers with 0 <= flagged <= checked <= ${MAX_CHECKS}`);
        }
        if (self._closed || !checked) return;
        self._x.rpc.call('reportChecks', { rule, checked, flagged }).catch(() => {});
      },
    });
    this._i = { ctl: x.sharing ? x.sharing.ctl : null, link: x.sharing ? x.sharing.link : null };
    // recitation sharing (sharing.js): the 3.x controller in this page; without its chunk (blocked, offline) the same
    // names, never available
    this.sharing = x.sharing ? x.sharing.sharing : Object.freeze({
      get isAvailable() { return false; },
      get isOn() { return false; },
      async setOn(on) { if (on) throw new TajweedError('sharing_unavailable'); },
      async ask() { throw new TajweedError('sharing_unavailable'); },
      feed() {},
      async items() { return []; },
      async summary() { return null; },
      async delete() { throw new TajweedError('sharing_unavailable'); },
      get recoveryCode() { return null; },
      setWording() { throw new TajweedError('sharing_unavailable'); },
    });
  }

  /**
   * Make the page's Client: opens Quran Lab's frame on this page (the origin must be one of the key's), which
   * registers, reads the signed config and loads the engine this site is on. A second Client while one is open is
   * client_exists.
   * @param {{key: string, appVersion?: string, appBuild?: string, storage?: string, threads?: 'auto'|'off'}} options
   *   appVersion and appBuild (27.1, from 4.0.1): the app's version and build, strings; the frame's config requests
   *   carry them, cleaned.
   *   There is no analytics option in 4.0 (owner, 11-16): the anonymous daily counts and durations are always kept;
   *   only Quran Lab's signed config (flags.analytics) turns them off. There is no audience option either (owner,
   *   11-19): every app shows the same sharing sheet. An `analytics` or `audience` key, whatever its value, is
   *   invalid_argument, whose message names the option and points to docs/migrating-to-4.md (ANALYTICS_40 22.2,
   *   ONE_SHEET_40 26.1).
   */
  static async create(options) {
    if (current) throw new TajweedError('client_exists');
    const o = options || {};
    if (typeof o.key !== 'string' || !/^qlk_v1_[A-Za-z0-9_-]+$/.test(o.key)) throw invalid('a web key qlk_v1_... is needed (from sdk.quranlab.ai)');
    for (const k of ['appVersion', 'appBuild', 'storage']) if (o[k] !== undefined && o[k] !== null && typeof o[k] !== 'string') throw invalid(`${k} must be a string`);
    if (o.storage && !/^[A-Za-z0-9._-]{1,40}$/.test(o.storage)) throw invalid('storage must be 1 to 40 letters, digits, dots, dashes or underscores');
    refuseRemovedOptions(o);
    if (o.threads !== undefined && o.threads !== 'auto' && o.threads !== 'off') throw invalid(`threads must be 'off' (the default) or 'auto'`);
    if (typeof globalThis.window === 'undefined' || !globalThis.document) throw new TajweedError('runtime_unsupported');
    const claim = {};
    current = claim;
    let link = null;
    try {
      const t = SEAMS ? o : {};
      // the web_frame hosts in order (28.6); a test page may name its own (_frameBases, or the first two)
      const frameBases = Array.isArray(t._frameBases) && t._frameBases.length ? t._frameBases
        : t._frameBase || t._frameFallback !== undefined ? [t._frameBase || FRAME_BASE, t._frameFallback !== undefined ? t._frameFallback : FRAME_FALLBACK].filter(Boolean)
          : [...FRAME_BASES];
      const apiUrl = t._apiUrl || API_URL;
      const chunk = loadSharingChunk(frameBases[0]).catch(() => null);
      // the origin check, when no frame answers, goes through the api order (28.3)
      link = await openFrame({ key: o.key, frameBases, apiUrl, endpoints: Endpoints.fromSeams({ apiUrl }), storage: o.storage || null, timeoutMs: t._timeoutMs, switchMs: t._switchMs,
        threads: o.threads || 'off', opts: { appVersion: o.appVersion, appBuild: o.appBuild, threads: o.threads || 'off' } });
      // the frame of the fallback host answered: said in the error reports (silent: the page gets no error)
      const pending = [...takePending(), ...(link.fallback ? [{ reason: 'frame_fallback', code: 'none' }] : [])];
      const init = await link.rpc.call('init', { pending });
      // the sharing chunk from the host whose frame answered (the first host's chunk is not waited for when it gave
      // no frame)
      const mod = link.fallback ? await loadSharingChunk(link.base).catch(() => null) : await chunk;
      const frameBase = link.base;
      // one sticky host per role for the page (28.3): the sharing link starts from the api P the frame found, and the
      // two tell each other when an answer moves it (Endpoints.share and adopt; the frame's 'endpoints' event and call)
      const hub = { state: init && init.endpoints ? init.endpoints : null, listeners: new Set() };
      link.rpc.onEvent((d) => { if (d.ev === 'endpoints' && d.state) { hub.state = d.state; for (const f of hub.listeners) { try { f(d.state); } catch (_) { /* never in the way */ } } } });
      const endpoints = { state: () => hub.state, subscribe: (f) => { hub.listeners.add(f); }, tell: (s) => { link.rpc.call('endpoints', s).catch(() => {}); } };
      let sharing = null;
      if (mod) {
        try {
          sharing = await mod.startSharing({ key: o.key, rpc: link.rpc, appVersion: o.appVersion, appBuild: o.appBuild, storage: o.storage || null, apiUrl, trustedKeys: PINS, opusUrl: `${frameBase.replace(/\/$/, '')}/4/app/${APP}/tajweedformer-opus.wasm`, endpoints });
        } catch (_) { sharing = null; }
      }
      const client = new TajweedClient({ rpc: link.rpc, link, init, sharing }, MADE);
      client._life();
      current = client;
      return client;
    } catch (e) {
      if (link) link.close();
      if (current === claim) current = null;
      const err = errorFrom(e, 'needs_connection');
      // no frame answered: nothing here can report it, so the next frame that answers does (ERRORS_40.md section 24),
      // and the error's cause is that report's (24.13: runtime, frame or frame_offline; `needs` model, as nothing of
      // the frame's could be reached)
      if (!link) { tag(err, { stage: 'runtime', reason: frameReason() }); notePending(err); }
      throw err;
    }
  }

  _guard() { if (this._closed) throw new TajweedError('invalid_argument', { detail: 'this client is closed' }); }
  _fail(e, fallback) { const t = errorFrom(e, fallback); this._lastError = t.code; return t; }

  // the page's life: hidden or left seals the day's totals (keepalive requests from the Worker); visible again
  _life() {
    const doc = globalThis.document, win = globalThis.window;
    const rpc = this._x.rpc;
    const share = this._i.link;
    const hidden = (leaving) => { rpc.call('background', { leaving }).catch(() => {}); if (share) share.background().catch(() => {}); };
    this._onVis = () => {
      if (doc.visibilityState === 'hidden') hidden(false);
      else { rpc.call('foreground').catch(() => {}); if (share) { share._hidden = false; share._sharingLife('foreground'); } }
    };
    this._onHide = () => hidden(true); // pagehide: the page session ends (17.8 session_s)
    doc.addEventListener('visibilitychange', this._onVis);
    win.addEventListener('pagehide', this._onHide);
  }

  /**
   * The Model for this app: the lease for this page session, the model's ciphertext downloaded once per site and
   * kept, installed and opened by the Core in Quran Lab's frame. `version` pins a model version ("4.1.0").
   */
  model(version) {
    this._guard();
    const v = version && typeof version === 'object' ? version.version : version;
    if (v !== undefined && v !== null && (typeof v !== 'string' || !MODEL_VERSION_RE.test(v))) throw invalid(`version ${JSON.stringify(v)} is not a model version (x.y.z)`);
    const pinned = v || null;
    if (this._opening && this._opening.pinned === pinned) return this._opening.promise;
    if (this._model && !this._model._closed && this._modelPinned === pinned) return Promise.resolve(this._model);
    const promise = (async () => {
      if (this._model && !this._model._closed) await this._model.close();
      let info;
      try { info = await this._x.rpc.call('model', { version: pinned }); } catch (e) { throw this._fail(e, 'engine_failed'); }
      this.pin = info.pin;
      if (this._i.link) { this._i.link.modelRevision = info.version; this._i.link.modelBuild = info.build; }
      const model = makeModel({ info, rpc: this._x.rpc, clock: () => Date.now(), share: this._i.link,
        onClose: (m) => { if (this._model === m) this._model = null; }, onDrop: () => { this._droppedChunks++; } });
      this._model = model;
      this._modelPinned = pinned;
      return model;
    })();
    this._opening = { pinned, promise };
    const done = () => { if (this._opening && this._opening.promise === promise) this._opening = null; };
    promise.then(done, done);
    return promise;
  }

  /**
   * Download and install the model ahead of use (a lease is needed: the files are installed as they arrive), on
   * whatever network the device has (4.0.2, NO_WAIT_40.md: there is no network option; an `unmeteredOnly` a page
   * written for 4.0.1 still passes is not read).
   */
  async prefetch({ onProgress = null, version = null } = {}) {
    this._guard();
    if (onProgress !== null && typeof onProgress !== 'function') throw invalid('onProgress must be a function');
    const progressId = Math.random().toString(36).slice(2);
    let total = 0;
    const off = this._x.rpc.onEvent((d) => { if (d.ev === 'progress' && d.id === progressId) { total = d.bytesTotal; if (onProgress) onProgress({ bytesDone: d.bytesDone, bytesTotal: d.bytesTotal }); } });
    try {
      const r = await this._x.rpc.call('prefetch', { version, progressId });
      return { bytesDone: r.bytesDone, bytesTotal: Math.max(total, r.bytesDone), complete: r.complete };
    } catch (e) { throw this._fail(e, 'download_failed'); } finally { off(); }
  }

  /** What the SDK holds for this site, in bytes (ciphertext only). */
  async storage() {
    this._guard();
    let r;
    try { r = await this._x.rpc.call('storage'); } catch (e) { throw this._fail(e, 'storage_failed'); }
    return { ...r, sharingQueueBytes: this._x.sharing ? await this._x.sharing.queueBytes() : 0 };
  }

  /** Remove the model files of this site. An open Model is closed first. */
  async removeModels() {
    this._guard();
    if (this._model && !this._model._closed) await this._model.close();
    try { await this._x.rpc.call('removeModels'); } catch (e) { throw this._fail(e, 'storage_failed'); }
  }

  /** One structured report, safe to paste into an issue: no audio, text or identifiers. */
  async diagnose() {
    const w = await this._x.rpc.call('diagnose').catch(() => null);
    const m = this._model && !this._model._closed ? this._model : null;
    return {
      sdk: { version: SDK_VERSION, api: API, engine: (this._x.init.engine && this._x.init.engine.id) || null, core: this._x.init.core, latest: null },
      key: w ? { accepted: w.key.accepted, reason: w.key.stopped ? 'server_rejected' : null } : { accepted: null, reason: null },
      config: w ? w.config : 'none',
      model: m ? { version: m.version, build: m.build, verified: true } : (w && w.model) || null,
      context: m ? m.defaultContext : null,
      backend: m ? { ...WASM_BACKEND } : null,
      microphone: await microphonePermission({}),
      storage: await this.storage().catch(() => ({ models: [], sharingQueueBytes: 0 })),
      lastError: this._lastError,
      droppedChunks: this._droppedChunks,
      connection: connection(),
      lease: w ? w.lease : null,
      // 28.7: the host each role asks first, the frame's host the page took, and the last failover of the frame
      ...(w && w.endpoints ? { endpoints: { api: w.endpoints.api, models: w.endpoints.models, webFrame: new URL(this._x.link.base).host,
        lastFailover: w.endpoints.lastFailover || null } } : {}),
    };
  }

  /** Automatic in browsers (a hidden or left page); kept for the API's shape. */
  background() { return this._x.rpc.call('background').then(() => {}, () => {}); }
  foreground() { this._x.rpc.call('foreground').catch(() => {}); }

  /** End: the open Model is closed, the day's totals sent, the frame removed. */
  async close() {
    if (this._closed) return;
    this._closed = true;
    try {
      if (this._opening) await this._opening.promise.catch(() => {});
      if (this._model && !this._model._closed) await this._model.close();
      await this._x.rpc.call('close').catch(() => {});
      if (this._i.link) await this._i.link.sendTelemetry('close', { keepalive: true }).catch(() => {});
    } finally {
      globalThis.document.removeEventListener('visibilitychange', this._onVis);
      globalThis.window.removeEventListener('pagehide', this._onHide);
      this._x.link.close();
      if (current === this) current = null;
    }
  }
}

// The sharing chunk of this loader's build: its bytes must hash to the SHA-384 compiled in, then they are imported
async function loadSharingChunk(frameBase) {
  if (!APP || !SHARING_SHA384) return null;
  const r = await fetch(`${frameBase.replace(/\/$/, '')}/4/app/${APP}/sharing.mjs`, { credentials: 'omit', redirect: 'error' });
  if (r.status !== 200) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  const h = new Uint8Array(await crypto.subtle.digest('SHA-384', bytes));
  if (btoa(String.fromCharCode(...h)) !== SHARING_SHA384) return null;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
  try { return await import(/* @vite-ignore */ url); } finally { URL.revokeObjectURL(url); }
}

// diagnose().connection: the network as far as the browser tells (the Network Information API). It is reported only:
// no request of the SDK waits for, or is held by, the kind of network or the data saver (NO_WAIT_40.md, 33.1)
function connection() {
  const nav = globalThis.navigator, c = nav && nav.connection;
  if ((c && c.type === 'none') || (nav && nav.onLine === false)) return 'none';
  if (!c) return 'unknown';
  if (c.saveData === true || c.type === 'cellular') return 'metered';
  if (c.type === 'wifi' || c.type === 'ethernet') return 'unmetered';
  return 'unknown';
}

// Failures of the frame itself (it did not answer: offline, a Content-Security-Policy that blocks it, a browser that
// cannot start it), kept on this page's origin until a frame answers and reports them: at most 8, the newest kept.
// Only the code and a reason; no message, URL or time finer than the entry's UTC day (the frame reports it today).
const PENDING_KEY = 'quranlab.sdk4.pending_errors';
const frameReason = () => (globalThis.navigator && globalThis.navigator.onLine === false ? 'frame_offline' : 'frame');
function notePending(err) {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return;
    const list = JSON.parse(ls.getItem(PENDING_KEY) || '[]');
    list.push({ reason: frameReason(), code: err && typeof err.code === 'string' ? err.code : 'needs_connection' });
    ls.setItem(PENDING_KEY, JSON.stringify(list.slice(-8)));
  } catch (_) { /* nothing is kept */ }
}
function takePending() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return [];
    const list = JSON.parse(ls.getItem(PENDING_KEY) || '[]');
    ls.removeItem(PENDING_KEY);
    return Array.isArray(list) ? list.slice(-8) : [];
  } catch (_) { return []; }
}
