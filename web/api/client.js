// The Client is the app's link to Quran Lab (NAMING.md sections 1 to 3): the key, the signed config,
// registration, telemetry, issues, sharing, and the model files on this device. One per process (per page):
// a second one while the first is not closed is the error client_exists.
//
//   const client = await TajweedClient.create({ key: 'qlk_v1_...' });
//   const model = await client.model();
//
// It owns the platform client of 2.x (web/platform/client.js, now internal), the delivery cache
// (web/tajweed/delivery.js) and the sharing controller (web/consent), and puts the five concepts in front.
import { QuranLab, SDK_VERSION } from '../platform/client.js';
import { localState, dirState } from '../platform/storage.js';
import { node as nodeParts, isNode } from '../platform/node-hook.js';
import { sdkLatestOf } from '../platform/update-notice.js';
import { cachedReader, defaultStore, profilePaths } from '../tajweed/delivery.js';
import { ModelFolder, MODEL_VERSION_RE, QURANLAB_PUBLIC_KEY_HEX, sha256Hex, compareModelVersions } from '../tajweed/manifest.js';
import { Installs, defaultDeviceKey, removeAllModels } from '../tajweed/install.js';
import { enableSharing } from '../consent/index.js';
import { openModel, resolveContext } from './model.js';
import { WASM_BACKEND } from './session.js';
import { microphonePermission } from './microphone.js';
import { TajweedError, toTajweedError, invalid, stopReasonOf } from './errors.js';

const RULE_RE = /^[a-z][a-z0-9_]{0,23}$/;
const MAX_CHECKS = 100_000;
// what createClient hands the constructor beside the internals, and nothing else can (it is kept nowhere else):
// a page cannot make a Client from parts of its own (a transport, a store, a trusted key) by calling the
// constructor (SPEC 15.1)
const MADE = Symbol('TajweedClient.create');
/** In the state store: a removal of the models that is owed (it failed, or could not be finished): tried again at
 * every start, every model call, every refusal and when an open Model is closed (SPEC 15.3, contract 1.10.0). */
const PURGE_KEY = 'model.purge';

let current = null; // the process's one Client

export class TajweedClient {
  /** Use TajweedClient.create(options). */
  constructor(internals, made) {
    if (made !== MADE || !internals) throw invalid('a TajweedClient is made by TajweedClient.create(options)');
    this._i = internals;
    this._ql = internals.ql;
    this._closed = false;
    this._model = null;
    this._opening = null;
    this._lastError = null;
    this._droppedChunks = 0; // waiting chunks dropped because the app did not read `chunks`, since this Client was made
    /** The answer to a pinned model version the server could not serve ({ version, status }), or null. */
    this.pin = null;
    const self = this;
    /** App-reported counters (SPEC 6.3). */
    this.analytics = Object.freeze({
      /**
       * The app's own judge checked `rule` `checked` times and flagged `flagged` of them. Counted into the day's
       * anonymous totals; never text, audio, ids or times.
       */
      reportChecks(rule, checked, flagged) {
        if (typeof rule !== 'string' || !RULE_RE.test(rule)) throw invalid(`rule ${JSON.stringify(rule)} is not a rule name (lower-case letters, digits and underscores, at most 24)`);
        if (!Number.isInteger(checked) || !Number.isInteger(flagged) || flagged < 0 || flagged > checked || checked > MAX_CHECKS) {
          throw invalid(`reportChecks needs whole numbers with 0 <= flagged <= checked <= ${MAX_CHECKS}`);
        }
        if (self._closed || !checked) return;
        self._ql.telemetry.checks(rule, checked, flagged);
      },
    });
    this.sharing = makeSharing(this);
  }

  /**
   * Make the process's Client: reads the stored state, starts the launch sequence (register once a day, the
   * signed config, telemetry left from earlier runs) and returns. Network trouble never makes it fail: the
   * Client then works from what the device already has. A second Client while one is open is client_exists.
   * @param {{key: string, appId?: string, appVersion?: string, storage?: string, analytics?: 'on'|'off', audience?: 'general'|'children'}} options
   */
  static create(options) { return createClient(options, {}); }

  _guard() { if (this._closed) throw new TajweedError('invalid_argument', { detail: 'this client is closed' }); }

  _fail(e, o) {
    // the page's origin, for a refusal that names it
    const origin = this._ql.origin || (globalThis.location && globalThis.location.origin) || this._ql.bundleId || '';
    const err = toTajweedError(e, { sdk: SDK_VERSION, origin, ...o });
    this._lastError = err.code;
    return err;
  }

  // where the model for this app is: from the signed config, else what the last start used (offline)
  async _source(version) {
    const ql = this._ql, state = this._i.state;
    ql.modelVersionPin = version;
    let src = null, failure = null;
    try { src = await ql.modelSource(); } catch (e) { failure = e; }
    if (src && src.version) {
      state.set('model.last', { url: src.url, version: src.version, build: src.build, pinned: version });
      this.pin = src.pin;
      if (src.pin && ql.debug) console.warn(`TajweedFormer: model version ${src.pin.version} is ${src.pin.status}; using ${src.version}`);
      return src;
    }
    const last = state.get('model.last');
    if (last && (!version || last.version === version)) {
      return { url: last.url, version: last.version, build: last.build, pin: null };
    }
    if (src && !src.version) throw new TajweedError('model_incompatible', { detail: 'the config names a model build without a version; this SDK needs a build made for SDK 3.0.0 or later' });
    throw failure;
  }

  // the reader of the Client's own download. Every model request's headers come from one place (SPEC 15.4).
  _reader(src, onProgress) {
    const i = this._i, ql = this._ql;
    return cachedReader({ baseUrl: src.url, fetch: i.fetch, store: i.store, onProgress,
      headers: () => ql.modelHeaders(), renew: () => ql.renewToken(), stops: (reason) => !!stopReasonOf(reason),
      onRefusal: (e) => ql.noteModelRefusal(e), onServed: () => ql.noteModelServed(), stopped: () => !!ql.modelRefusal });
  }

  // A Client the server has refused does not run the model (SPEC 15.3): the refusal, also a remembered one.
  // Before the CDN is asked: a stop in force, unless the CDN gave it and the API has accepted the key since (the
  // CDN is then asked again, and its answer decides).
  _refused() { if (this._ql.modelStopped) throw this._ql.modelRefusal; }
  // After the CDN was asked: any stop still in force.
  _stillRefused() { if (this._ql.modelRefusal) throw this._ql.modelRefusal; }

  // A stop removes the models on this device (SPEC 15.3, contract 1.10.0): every build in every store the SDK
  // wrote, their install records and partial downloads; what removeModels removes, done by the SDK itself. Not
  // the remembered refusal, the device key, the sharing state or the unsent recordings (other stores). Never an
  // error of its own: when it fails it is owed (PURGE_KEY) and tried again. Each request runs after the one
  // before it has ended, so files a download wrote meanwhile go too. Resolves true when nothing is left.
  _purge() {
    const run = async () => {
      const state = this._i.state;
      try { state.set(PURGE_KEY, true); } catch (_) { /* owed in this page */ }
      try {
        await removeAllModels(this._i.store);
        state.set('model.last', null);
        state.set(PURGE_KEY, null);
        return true;
      } catch (_) { return false; }
    };
    const p = (this._purgeChain || Promise.resolve()).then(run, run);
    this._purgeChain = p;
    return p;
  }

  _purgeOwed() { try { return this._i.state.get(PURGE_KEY) === true; } catch (_) { return true; } }

  // Before a model call: a stop another page stored meanwhile holds here too, and a removal that is owed (or a
  // stop in force with files put back) is done first.
  async _beforeModelCall() {
    this._ql.syncRefusal();
    if (this._ql.modelRefusal || this._purgeOwed()) await this._purge();
  }

  // A call fails while a stop is in force: the models go before it rejects with the stop's error.
  async _failRefused(e, o) {
    if (this._ql.modelRefusal) { await this._purge(); throw this._fail(this._ql.modelRefusal, o); }
    throw this._fail(e, o);
  }

  // where the model is, or the refusal when the server has refused this app
  async _allowedSource(version) {
    let src;
    try { src = await this._source(version); } catch (e) { this._refused(); throw e; }
    this._refused();
    return src;
  }

  // The install record (SPEC 15.2): the Client opens only a build it downloaded itself. Returns the state of
  // the build's record before this call: 'installed', 'downloading' (a download to resume), or null: nothing
  // here was the Client's; what was in the cache without a valid record is deleted, and the record of the
  // download that starts now is written before the first request for a file. A key store that fails: nothing
  // is opened, deleted or downloaded, and the call is storage_failed.
  async _gate(src) {
    const inst = this._i.installs;
    try {
      const had = await inst.state(src.build);
      if (had) return had;
      await inst.sweep();
      await inst.write(src.build, 'downloading');
      return null;
    } catch (e) {
      throw new TajweedError('storage_failed', { detail: String((e && e.message) || e) }, { cause: e });
    }
  }

  // every file of the download profile is verified: the build is this Client's
  async _installed(src, had) {
    if (had === 'installed') return;
    try { await this._i.installs.write(src.build, 'installed'); } catch (_) { /* it stays `downloading`: the next start finds every file and writes it */ }
  }

  /**
   * The Model for this app: downloads on first use, verifies, opens and warms the engine. Call it early for a
   * warm start. `version` pins a model version ("4.0.0"); without it Quran Lab's config chooses.
   * @param {string|{version?: string}} [version]
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
      let src, reader;
      try {
        await this._beforeModelCall();
        src = await this._allowedSource(pinned);
        const had = await this._gate(src);
        reader = this._reader(src);
        const model = await openModel({
          reader, platform: this._ql, seams: this._i.seams,
          folder: { trustedKeys: this._i.modelKeys, expect: { version: src.version, build: src.build } },
          onClose: (m) => { if (this._model === m) this._model = null; if (this._purgeOwed()) this._purge(); },
          onDrop: () => { this._droppedChunks++; },
        });
        // a refusal that arrived while the model was opened (the token's answer, the CDN's), or one the CDN did
        // not end when it was asked again: the model is not handed out
        if (this._ql.modelRefusal) { await model.close().catch(() => {}); await this._purge(); throw this._ql.modelRefusal; }
        await this._installed(src, had);
        this._model = model;
        this._modelPinned = pinned;
        this._ql.modelOpened({ revision: model.version, build: model.build, context: model.defaultContext, backend: 'cpu' },
          { loadMs: model.loadMs, delivery: reader.stats });
        return model;
      } catch (e) {
        // while a stop is in force the call fails with it, whatever else went wrong (the CDN not reached again),
        // and the models are removed first
        await this._failRefused(e, { fallback: 'engine_failed' });
      }
    })();
    this._opening = { pinned, promise };
    const done = () => { if (this._opening && this._opening.promise === promise) this._opening = null; };
    promise.then(done, done);
    return promise;
  }

  /**
   * Download and verify the model ahead of use (SPEC 13.4): resumable, a no-op when done. `onProgress` gets
   * { bytesDone, bytesTotal }. With `unmeteredOnly`, nothing is downloaded on a connection the browser reports
   * as metered or data-saving, or with no connection; where the browser cannot tell (diagnose().connection is
   * 'unknown') it downloads. Resolves with { bytesDone, bytesTotal, complete }.
   */
  async prefetch({ unmeteredOnly = false, onProgress = null, version = null } = {}) {
    this._guard();
    if (onProgress !== null && typeof onProgress !== 'function') throw invalid('onProgress must be a function');
    try {
      await this._beforeModelCall();
      const src = await this._allowedSource(version);
      const had = await this._gate(src);
      const loaded = new Map();
      let total = 0;
      const report = () => { if (onProgress) onProgress({ bytesDone: [...loaded.values()].reduce((a, b) => a + b, 0), bytesTotal: total }); };
      const reader = this._reader(src, (p) => { if (loaded.has(p.path)) { loaded.set(p.path, Math.min(sizes.get(p.path), Math.round((p.loaded / (p.total || 1)) * sizes.get(p.path)))); report(); } });
      const sizes = new Map();
      const folder = await ModelFolder.open(reader, { verify: 'on-read', requireSignature: true, requireVersion: true, engineFormats: [3], trustedKeys: this._i.modelKeys,
        expect: { version: src.version, build: src.build } });
      const paths = this._prefetchPaths(folder);
      for (const p of paths) { const e = folder.entry(p); const n = e.stored ? e.stored.size : e.size; sizes.set(p, n); total += n; loaded.set(p, 0); }
      const have = [];
      for (const p of paths) { if (await reader.cached(p)) { loaded.set(p, sizes.get(p)); have.push(p); } }
      report();
      const done = () => ({ bytesDone: [...loaded.values()].reduce((a, b) => a + b, 0), bytesTotal: total, complete: have.length === paths.length });
      if (have.length === paths.length) { this._stillRefused(); await this._installed(src, had); return done(); }
      // waits on a metered connection and with none; downloads on an unmetered one and where the browser cannot tell
      if (unmeteredOnly && ['metered', 'none'].includes(this._connection())) return done();
      for (const p of paths) {
        if (have.includes(p)) continue;
        await folder.read(p);
        loaded.set(p, sizes.get(p));
        have.push(p);
        report();
      }
      if (reader.stats.bytesDownloaded > 0) {
        this._ql.telemetry.download({ revision: src.version, build: src.build, profile: 'web-cpu', bytes: reader.stats.bytesDownloaded, success: true, resumed: reader.stats.rangesResumed > 0 });
      }
      this._stillRefused();
      await this._installed(src, had);
      return done();
    } catch (e) {
      await this._failRefused(e, { fallback: 'download_failed' });
    }
  }

  // what a start needs: the engine's files of the context in force, the calibration, the clip list
  _prefetchPaths(folder) {
    const m = folder.manifest;
    const cfg = this._ql.config;
    const c = cfg && cfg.inference && cfg.inference.context;
    const context = typeof c === 'string' && m.contexts.includes(c) ? c : m.default_context;
    const paths = profilePaths(m, { context, platform: 'web' }).filter((p) => !['expected', 'reference', 'selftest'].includes(folder.entry(p).role));
    if (folder.has('selftest/selftest.json')) paths.push('selftest/selftest.json');
    return paths;
  }

  // The connection as far as this runtime can tell: 'unmetered' (wifi, ethernet), 'metered' (cellular, or the
  // browser's data saver or metered flag), 'none' (offline), 'unknown' (no Network Information API: Safari,
  // Firefox, Node; or a browser that gives no connection type, as Chrome on a desktop).
  _connection() {
    const nav = globalThis.navigator;
    const c = this._i.connection !== undefined ? this._i.connection : nav && nav.connection;
    if ((c && (c.type === 'none' || c.online === false)) || (this._i.connection === undefined && nav && nav.onLine === false)) return 'none';
    if (!c) return 'unknown';
    if (c.saveData === true || c.metered === true || c.type === 'cellular') return 'metered';
    if (c.type === 'wifi' || c.type === 'ethernet') return 'unmetered';
    return 'unknown';
  }

  /**
   * What the SDK holds on this device: { models: [{ version, build, bytes }], sharingQueueBytes }, one entry per
   * model build with the bytes of its files here, ordered by version then build. A method (browser storage is
   * asynchronous): `await client.storage()`.
   */
  storage() { this._guard(); return this._storage(); }

  // The default context of the model last used on this device, read from its stored manifest and the signed
  // config as a Session would resolve it; null when that model's manifest is not on the device.
  async _storedContext(last) {
    if (!last || !last.build) return null;
    try {
      const store = this._i.store;
      for (const k of await store.keys('manifest/')) {
        const raw = await store.get(k);
        if (!raw || (await sha256Hex(raw)).slice(0, 40) !== last.build) continue;
        const manifest = JSON.parse(new TextDecoder().decode(raw));
        return resolveContext(null, this._ql.config, manifest).context || null;
      }
    } catch (_) { /* a store that cannot be read knows no model */ }
    return null;
  }

  async _storage() {
    const store = this._i.store, out = { models: [], sharingQueueBytes: 0 };
    try {
      const have = new Set(await store.keys('sha256/'));
      for (const k of await store.keys('manifest/')) {
        const raw = await store.get(k);
        let m = null;
        try { m = JSON.parse(new TextDecoder().decode(raw)); } catch (_) { m = null; }
        if (!m || !Array.isArray(m.files) || typeof m.version !== 'string' || !MODEL_VERSION_RE.test(m.version)) continue;
        let bytes = raw.length;
        for (const f of m.files) {
          const d = f.encoding === 'gzip' && f.decoded ? f.decoded : f;
          if (have.has(`sha256/${String(d.sha256).toLowerCase()}`)) bytes += d.size;
        }
        out.models.push({ version: m.version, build: (await sha256Hex(raw)).slice(0, 40), bytes });
      }
      out.models.sort((a, b) => compareModelVersions(a.version, b.version) || (a.build < b.build ? -1 : a.build > b.build ? 1 : 0));
    } catch (_) { /* a store that cannot be listed holds nothing we can count */ }
    try {
      const s = await this._sharingStorage();
      if (s) for (const id of await s.sessions()) for (const name of await s.list(id)) { const b = await s.read(id, name); out.sharingQueueBytes += b ? b.length : 0; }
    } catch (_) { /* no queue */ }
    return out;
  }

  async _sharingStorage() {
    if (this._i.sharingStorage) return this._i.sharingStorage;
    const { outbox } = await import('../sharing/index.js');
    const s = await outbox.sharing();
    return s ? s.storage : null;
  }

  /** Remove the model files (never the consent state or the sharing queue). An open Model is closed first. */
  async removeModels() {
    this._guard();
    if (this._model && !this._model._closed) await this._model.close();
    const store = this._i.store;
    try {
      await removeAllModels(store);
      this._i.state.set('model.last', null);
      this._i.state.set(PURGE_KEY, null);
    } catch (e) { throw this._fail(new TajweedError('storage_failed', { detail: String((e && e.message) || e) }, { cause: e })); }
  }

  /** One structured report, safe to paste into an issue (SPEC 13.5): no audio, text or identifiers. */
  async diagnose() {
    const ql = this._ql, i = this._i;
    const latest = sdkLatestOf(ql.config);
    // the key: refused when the server's answer stopped the client; accepted once the server answered a call
    // made with it; null while no answer was seen (offline)
    const stopped = ql.stopped;
    // the reason is the code of the error the app was given for that answer (a 401 whose body names the check
    // that refused is server_rejected, not invalid_key)
    const refusal = ql.stoppedError || ql.refusedError || ql.modelRefusal || null;
    const raised = refusal ? toTajweedError(refusal, { sdk: SDK_VERSION }).code : null;
    const key = stopped || refusal
      ? { accepted: false, reason: raised === 'invalid_key' || raised === 'sdk_too_old' ? raised : raised ? 'server_rejected'
        : stopped === 'invalid_key' || stopped === 'unauthorized' ? 'invalid_key' : stopped === 'sdk_too_old' ? 'sdk_too_old' : 'server_rejected' }
      : { accepted: ql.keyAccepted ? true : null, reason: null };
    const stored = i.state.get('config');
    const now = ql.clock();
    const fresh = ql.config && ql.config.expires_at * 1000 > now;
    const m = this._model && !this._model._closed ? this._model : null;
    const last = i.state.get('model.last');
    const onDevice = m ? null : await this._storedContext(last);
    return {
      sdk: { version: SDK_VERSION, latest: latest && MODEL_VERSION_RE.test(latest.version) ? latest.version : null },
      key,
      config: fresh ? 'fresh' : (ql.config || (stored && stored.cfg) ? 'stale' : 'none'),
      model: m ? { version: m.version, build: m.build, verified: true } : (last && last.version ? { version: last.version, build: last.build, verified: false } : null),
      // what a Session of the default context would run on now, with or without an open Model: without one, from
      // the stored state (the model's manifest on this device and the signed config)
      context: m ? m.defaultContext : onDevice,
      backend: m || onDevice ? { ...WASM_BACKEND } : null,
      microphone: await microphonePermission((i.seams && i.seams.microphone) || {}),
      storage: await this._storage(),
      lastError: this._lastError,
      droppedChunks: this._droppedChunks,
      connection: this._connection(),
    };
  }

  /** The app left the foreground. Automatic in browsers (a hidden or left page); a call in Node. */
  background() { if (!this._closed) return this._ql.background().then(() => {}, () => {}); return Promise.resolve(); }
  /** The app returned to the foreground. Automatic in browsers; a call in Node. */
  foreground() { if (!this._closed) this._ql.foreground(); }

  /** End: the open Model is closed, the day's telemetry is sent, the page listeners are removed. */
  async close() {
    if (this._closed) return;
    this._closed = true;
    try {
      if (this._opening) await this._opening.promise.catch(() => {});
      if (this._model && !this._model._closed) await this._model.close();
      await this._ql.sendTelemetry('close', { keepalive: true }).catch(() => {});
      this._ql.stopSchedule();
      this._ql.stopRefresh();
    } finally {
      if (current === this) current = null;
    }
  }
}

// client.sharing (NAMING.md section 6): the names of the four SDKs in front of the 2.x controller (web/consent)
function makeSharing(client) {
  const ql = client._ql, ctl = client._i.ctl;
  const need = () => { if (!ql.sharingAllowed()) throw new TajweedError('sharing_unavailable'); };
  return Object.freeze({
    /** Quran Lab's config allows sharing for this app. */
    get isAvailable() { return ql.sharingAllowed(); },
    /** The learner said yes. */
    get isOn() { return ctl.state.s.consent === 'granted'; },
    /** The settings switch. Off starts no upload request from the call on, aborts the one in flight (what the
     * browser or the system had already buffered of that segment may still go out) and deletes the unsent queue;
     * the promise resolves when that is done (within 3 s and a few file removals, whatever was in flight). */
    setOn(on) { if (on) need(); return Promise.resolve(ctl.setSharing(!!on)).then(() => {}); },
    /** Ask now, if an ask is still allowed (at most three; a yes is never asked again). Resolves with the answer or null. */
    async ask() { need(); return ctl.askNow(); },
    /** Audio the app already captures outside takes (SPEC 11.2): kept for the pre-roll and tail of shared recordings only. */
    feed(samples, sampleRate) { if (typeof ctl.feed === 'function') ctl.feed(samples, sampleRate); },
    /** The outbox: each recording's status. A promise. */
    async items() { return ctl.outbox ? ctl.outbox.items() : []; },
    /** The learner's summary (the gratitude line), or null. */
    summary() { return ql.contributionSummary(); },
    /** "Delete what I shared". Accepted by Quran Lab: what was shared and the unsent queue are deleted and
     * sharing is off (isOn false) until the learner turns it on again. Not taken: it rejects and nothing changed. */
    delete() { return ctl.deleteShared(); },
    /** The code for deletion when the device is lost, or null before the first shared recording. */
    get recoveryCode() { return ctl.recoveryCode(); },
    /** The app's own wording ({ deck key: text }), validated; null goes back to the deck. */
    setWording(overrides) { try { return ctl.setWording(overrides); } catch (e) { throw toTajweedError(e, { fallback: 'invalid_argument' }); } },
  });
}

/**
 * SDK internals: TajweedClient.create with the test seams ({ fetch, clock, state, store, sharingStorage, apiUrl,
 * modelsUrl, trustedKeys, modelKeys, platform, origin, lifecycle, autoSend, debug, engine, host, timers,
 * microphone, connection, sharing, installKey }). installKey: the device key of the install records.
 */
export async function createClient(options, seams = {}) {
  if (current) throw new TajweedError('client_exists');
  const o = options || {};
  if (typeof o.key !== 'string' || !/^qlk_v1_/.test(o.key)) throw invalid('a developer key qlk_v1_... is needed (from sdk.quranlab.ai)');
  for (const k of ['appId', 'appVersion', 'storage']) if (o[k] !== undefined && o[k] !== null && typeof o[k] !== 'string') throw invalid(`${k} must be a string`);
  if (o.analytics !== undefined && o.analytics !== 'on' && o.analytics !== 'off') throw invalid(`analytics must be 'on' or 'off'`);
  if (o.audience !== undefined && o.audience !== 'general' && o.audience !== 'children') throw invalid(`audience must be 'general' or 'children'`);
  const node = isNode();
  if (node && !o.appId && !seams.origin) throw invalid('appId is needed outside a browser (the app id of your desktop key)');
  // claim the slot before the first await, so two create() calls in a row cannot both pass
  const claim = {};
  current = claim;
  try {
    let state = seams.state, store = seams.store, sharingStorage = seams.sharingStorage || null;
    if (node && (!state || !store)) {
      const { path, os, dirStore } = nodeParts();
      const dir = o.storage || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'quranlab', 'tajweedformer');
      try {
        state = state || await dirState(path.join(dir, 'state'));
        store = store || dirStore(path.join(dir, 'models'));
        if (!sharingStorage) sharingStorage = await (await import('../sharing/outbox.js')).dirStorage(path.join(dir, 'sharing'));
      } catch (e) { throw new TajweedError('storage_failed', { detail: String((e && e.message) || e) }, { cause: e }); }
    }
    state = state || localState(o.storage ? `quranlab.${o.storage}.` : 'quranlab.');
    store = store || defaultStore();
    const platform = seams.platform || (node ? ({ win32: 'windows', darwin: 'macos' }[process.platform] || 'linux') : 'web');
    const ql = new QuranLab({
      key: o.key, appVersion: o.appVersion, bundleId: o.appId || seams.origin || undefined, platform, origin: seams.origin,
      analytics: o.analytics, audience: o.audience, state, fetch: seams.fetch, clock: seams.clock, apiUrl: seams.apiUrl, modelsUrl: seams.modelsUrl,
      trustedKeys: seams.trustedKeys, lifecycle: seams.lifecycle, autoSend: seams.autoSend, debug: seams.debug,
    });
    if (sharingStorage) ql.sharingStorage = sharingStorage;
    if (seams.sharing) ql.sharingSeams = seams.sharing;
    const ctl = enableSharing(ql, seams.sharingOptions || {});
    const installs = new Installs({ store, deviceKey: seams.installKey || defaultDeviceKey() });
    const client = new TajweedClient({ ql, ctl, state, store, installs, sharingStorage, fetch: ql.fetch, seams, modelKeys: seams.modelKeys || [QURANLAB_PUBLIC_KEY_HEX],
      connection: seams.connection }, MADE);
    // a stop removes the models (SPEC 15.3, contract 1.10.0): when one arrives, and first of all at a start that
    // finds a remembered stop or a removal still owed, before the Client does anything else
    ql.onModelStop = () => { client._purge(); };
    if (ql.modelRefusal || client._purgeOwed()) await client._purge();
    await ql.launch();
    if (client._purgeChain) await client._purgeChain; // a stop the launch received: removed before create() returns
    if (ql.lastError) client._lastError = toTajweedError(ql.lastError, { sdk: SDK_VERSION, fallback: 'download_failed' }).code;
    current = client;
    return client;
  } catch (e) {
    if (current === claim) current = null;
    throw toTajweedError(e, { fallback: 'storage_failed' });
  }
}

/** Tests: forget the process's Client without closing it. */
export function resetClientForTests() { current = null; }
