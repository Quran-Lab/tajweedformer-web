// The engine Worker's controller: everything of SDK 4.0 that runs on Quran Lab's origin, behind the frame.
//
//   init      the install keys and the lease kept from an earlier page load (lease-store.js) or new ones, the Core,
//             the platform client (register, signed config, telemetry); with no kept lease, the first lease's
//             challenge and invisible Turnstile start at once (4.0.1), so they run while the engine loads
//   model     config -> lease (attest, challenge, Turnstile at the first lease, POST /v1/model-key), and at the same
//             time the signed manifest and the ciphertext from the build's model folder (4.0.1, _preStart) ->
//             qlc_install per file once the Core holds the lease -> qlc_model_open; the model's public facts out
//   takes     start / push / finish / cancel: audio in, the engine's heads out; the recited detector fed per chunk
//   counts    the take's source (measured or app), the app's judgement, telemetry, all in one KV transaction
//
// It never hands out a model byte, a key, the lease or the certificate: the messages it answers carry public facts,
// heads and counts (protocol.js). Environment-agnostic: the Worker (worker.js) and the Node tests drive it alike.
import { utf8, fromUtf8, hex, unb64u, b64u, sha256, sha256Hex } from '../shared/bytes.js';
import { checkReport, takeCounts } from '../shared/recited.js';
import { createCore, QLC, CoreError, headMask, HEADS } from './core.js';
import { DayMath } from './learner.js';
import { InstallKeys } from './keys.js';
import { LeaseStore } from './lease-store.js';
import { QuranLab4, SDK_VERSION_4, API_TIMEOUT_MS } from './api4.js';
import { Endpoints, HEAD_MS, HOLD_MAX_S, retryAfterOf } from '../shared/endpoints.js';
import { StateStore, WithCoreFiles, MemoryFiles, storeFailure } from './stores.js';
import { PlatformError, MODELS_URL } from '../../web/platform/client.js';
import { MODEL_LIMIT_DETAIL } from '../../web/api/errors.js';
import { tokenAnswer, integrityCode, integrityDetail } from '../../web/platform/error-reports.js';
import { MODEL_VERSION_RE, gunzip } from '../../web/tajweed/manifest.js';

// A plain entry (calibration.json, the self-test set: 18.2.5) is kept on the device at its decoded path: production's
// builds store them gzip (calibration.json.gz, selftest/*.gz) and the Core reads the plain calibration at
// calibration.json (QLC_FORM_PLAIN). Up to this patch the gzip bytes were kept under the stored path: model.calibration
// was null and the sample clips none (developer report fb_f5da03d55e58a8ea, 11-23). As Apple, Android and C do.
const plainPath = (f) => (f.encoding === 'gzip' && f.decoded ? f.decoded.path : f.path);
const plainSha = (f) => String(f.encoding === 'gzip' && f.decoded ? f.decoded.sha256 : f.sha256).toLowerCase();
// an entry's name in the file store: an encrypted entry's decoded path (its CDN and device forms), a plain one's plainPath
const storedPath = (f) => (f.encoding === 'qle1' ? f.decoded.path : plainPath(f));
const canInflate = () => typeof globalThis.DecompressionStream === 'function';

/** R402-4 (c): the hosted frame's app id, from the path its Worker was served from (/4/app/<12 hex>/worker.js), or null. */
export function frameAppOf(pathname) {
  const m = /^\/4\/app\/([0-9a-f]{12})\/[^/]+$/.exec(typeof pathname === 'string' ? pathname : '');
  return m ? m[1] : null;
}

/**
 * R402-4 (c): the frame's app id on each report it makes (error.frame), in the frame alone (the loader and the sharing
 * chunk keep their bytes): a report this page load makes or counts again is kept with the app; one queued by an older
 * frame keeps none. A server that does not take the field yet (its closed schema answers 400) gets the same report once
 * more without it.
 */
export function frameReports(r, app) {
  if (!r || typeof app !== 'string' || !/^[0-9a-f]{12}$/.test(app) || r._frameApp) return;
  r._frameApp = app;
  const occur = r.occur.bind(r), body = r.body.bind(r), flush = r.flush.bind(r);
  r.occur = (o) => {
    let before = null;
    try { before = new Map(r._load().queue.map((q) => [`${q.day}|${q.sig}`, q.count])); } catch (_) { before = null; }
    const made = occur(o);
    if (before) {
      try {
        const s = r._load();
        let changed = false;
        for (const q of s.queue) {
          const k = `${q.day}|${q.sig}`;
          if (before.has(k) && before.get(k) === q.count) continue; // not touched by this occurrence
          q.fields = { ...(q.fields || {}), frame: app };
          changed = true;
        }
        if (changed) r._save(s);
      } catch (_) { /* never in the way */ }
    }
    return made;
  };
  r.body = (q) => {
    const b = body(q);
    const f = q && q.fields && q.fields.frame;
    if (typeof f === 'string' && /^[0-9a-f]{12}$/.test(f) && b && b.error) b.error.frame = f;
    return b;
  };
  r.flush = (send) => flush(async (b) => {
    try { return await send(b); } catch (e) {
      if (!(e && e.status === 400 && b && b.error && b.error.frame !== undefined)) throw e;
      const plain = { ...b, error: { ...b.error } };
      delete plain.error.frame;
      return send(plain);
    }
  });
}

// a file another page of the site holds (the store asked again already: it stays the call's failure)
const LOCKED = new Set(['NoModificationAllowedError', 'InvalidStateError']);
const INSTALL_WRITES = new Set(['opfs_put', 'opfs_write', 'opfs_commit', 'opfs_open']);
/**
 * R402-4 (a): an install's OPFS write that failed for a reason other than another page holding the file (UnknownError
 * at opfs_put on iOS Safari 26/27, QuotaExceededError at opfs_write): { error_code, error_name } of the failure, and
 * the page load goes on in memory as a browser whose OPFS probe fails does. Else null.
 */
export function memoryFallbackOf(e) {
  const raw = e && e.qlReport ? e : e && e.cause && e.cause.qlReport ? e.cause : null;
  const t = raw && raw.qlReport;
  if (!t || t.stage !== 'storage' || t.reason === 'read' || !INSTALL_WRITES.has(t.error_code)) return null;
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (LOCKED.has(name)) return null;
  return { error_code: t.error_code, ...(name && name !== 'Error' ? { error_name: name } : {}) };
}

/** The vocabularies the loader knows by the manifest's tokens_sha256 (the tokens file is encrypted in a protected
 * build, and the Core does not export the names yet: docs/core-requests.md, request 1). */
export const KNOWN_VOCABULARIES = Object.freeze({
  '66fe6eb81b15506270f9e3c6efb0724cda757cd54326f26ca4bcd6be4f3b2aa4': Object.freeze(['<blk>', '|', 'ء', 'ب', 'ت',
    'ث', 'ج', 'ح', 'خ', 'د', 'ذ', 'ر', 'ز', 'س', 'ش', 'ص', 'ض', 'ط',
    'ظ', 'ع', 'غ', 'ف', 'ق', 'ك', 'ل', 'م', 'ن', 'ه', 'و', 'ي', 'ں',
    'a', 'i', 'u', 'aa', 'ii', 'uu', '<foreign>']),
});

const ENGINE_ROLES = new Set(['weights', 'frontend', 'graph', 'graph-data', 'frames', 'tokens', 'layout', 'reference']);
/**
 * 18.4.7.3 (SDK 4.0.2, contract dd76474): the wait in seconds before the next background lease attempt after a failed
 * one (a 5xx, a 429, no answer): uniform in [600, 1800], drawn afresh at each failure (`random`, in [0, 1)), so installs
 * that failed together do not come back together. A Retry-After (seconds) is the floor: the wait is the larger of it and
 * the draw, never shorter. (4.0.1: 1, 5 and 30 minutes, 2 hours, then 6, and a Retry-After replaced the step, so 503
 * lease_unavailable's 30 s made every install past refresh_after ask again every 30 s during an outage.)
 */
export function leaseBackoffS(retryAfter = null, random = Math.random) {
  const draw = 600 + Math.floor(Math.min(Math.max(Number(random()) || 0, 0), 0.999999) * 1201);
  return Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(draw, Math.min(retryAfter, HOLD_MAX_S)) : draw;
}

/**
 * 4.0.2: the server's issue time (seconds) of a binary lease (18.4.6: magic 4, version 2, flags 2, lease_id 16, then
 * iat, exp, refresh_after, 8 bytes each, little-endian), or null; taken only when its exp is the one the Core read.
 */
export function leaseIat(bytes, exp) {
  try {
    if (!bytes || bytes.length < 48) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const iat = Number(dv.getBigInt64(24, true)), e = Number(dv.getBigInt64(32, true));
    return e === exp && Number.isSafeInteger(iat) && iat > 0 ? iat : null;
  } catch (_) { return null; }
}

/** An error the loader turns into a TajweedError with this code (web/api/errors-catalogue.js). */
export class SdkError extends Error {
  constructor(code, detail = '', extra = {}) { super(detail || code); this.name = 'SdkError'; this.code = code; Object.assign(this, extra); }
}

const certField = (cert, field) => {
  try {
    const text = fromUtf8(unb64u(String(cert).split('.')[0]));
    const line = text.split('\n').find((l) => l.startsWith(field + ' '));
    return line ? line.slice(field.length + 1) : null;
  } catch (_) { return null; }
};

export class Controller {
  /**
   * @param {object} o
   * @param {string} o.key  the developer key (a web key)
   * @param {string} o.site  the site origin the frame verified (the handshake of frame.js)
   * @param {object} o.files  the file store (stores.js)
   * @param {object} o.kv  the KV backend (stores.js: IndexedDbKV or MemoryKV)
   * @param {Function} o.coreFactory  the verified Core module's factory; o.coreWasm its verified bytes
   * @param {(q: {action: string, cdata: string}) => Promise<string|null>} [o.turnstile]  a Turnstile token (frame.js)
   * @param {() => void} [o.turnstilePrepare]  the frame loads Turnstile's script now (frame.js), before a token is asked
   */
  constructor(o) {
    this.o = o;
    this.clock = o.clock || (() => Date.now());
    this.timers = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
    this.emit = o.emit || (() => {});
    this.model = null; // the open model's facts and its manifest
    this.take = null;
    this.lastTake = null;
    // the page session's ayah sets (decided 11-14: the session of 17.8 and 17.9 is the page session): judged ayahs
    // for 17.9's first and repeat, measured ayahs for 17.8's repeat_ayahs
    this.session = { seen: new Set(), recited: new Set() };
    this.leaseInfo = null;
    this.turnstilePassed = false;
    this.lastError = null;
    // 18.4.7.3: the lease attempts that failed in a row, and when the next background one may go (ms of this.clock); a
    // lease the Core accepts or a verified stop ends the row. Kept in the SDK's state (28.11 item 3, _setRow; init reads it)
    this.leaseRow = { n: 0, at: 0 };
    // 4.0.2: the count of stops (a verified stop, a stop the API answered on any route) of this client (_purge)
    this._stopGen = 0;
    // the endpoint set of this process (ENDPOINTS_40.md 28.1): the api and models hosts, their sticky hosts, the last
    // failover. o.endpoints: one made by the caller (the Node worker, which also asks the web_frame hosts for the
    // engine), or a test's { hosts, origins }; else the built-in lists, a test build's apiUrl and modelsUrl replacing them
    const head = Number.isFinite(o.apiTimeoutMs) && o.apiTimeoutMs > 0 ? Math.min(HEAD_MS, o.apiTimeoutMs) : HEAD_MS;
    this.ep = o.endpoints instanceof Endpoints ? o.endpoints
      : o.endpoints && typeof o.endpoints === 'object' ? new Endpoints({ headMs: head, ...o.endpoints, clock: () => this.clock() })
        : Endpoints.fromSeams({ apiUrl: o.apiUrl || null, modelsUrl: o.modelsUrl || null, clock: () => this.clock(), headMs: head });
    // one sticky host per role for the page (28.3): when an answer moves this Worker's api or models P, the page's
    // other endpoint set (the host page's sharing link) is told, and it tells this one (adoptEndpoints)
    this.ep.onChange = () => { try { this.emit({ ev: 'endpoints', state: this.ep.share() }); } catch (_) { /* never in the way */ } };
  }

  /** The page's other endpoint set moved its api or models P (Endpoints.share): taken here too. */
  adoptEndpoints(state) { return this.ep.adopt(state); }

  /**
   * The page session: install keys, the platform client's launch (attest with the keys, register, the signed
   * config), then the engine the config names for this site (o.engine, or o.loadEngine(config): a verified module
   * factory and its bytes), then the Core.
   */
  async init(args = {}) {
    const o = this.o;
    const t0 = this.clock();
    this.state = await StateStore.open(o.kv);
    // 18.4.7.3, 28.11 item 3 (4.0.2): the row of failed lease attempts an earlier page load or process left, with its next
    // attempt, so this one waits as that one would have (a time more than 6 h ahead of the clock: one that moved back,
    // read as now)
    const row = this.state.get('lease.row');
    if (row && Number.isInteger(row.n) && row.n > 0 && Number.isFinite(row.at)) {
      const now = this.clock();
      this.leaseRow = { n: row.n, at: row.at - now > HOLD_MAX_S * 1000 ? now : row.at };
    }
    // the lease of an earlier page load of this site (lease-store.js): its install keys, certificate and the Core's
    // saved state; none (or o.leaseStore false): new keys, as a first visit
    const wall = o.coreClock && typeof o.coreClock.wall === 'function' ? () => o.coreClock.wall() : this.clock;
    // (o.leaseStore: a store of the same shape, the Node path's: sdk4/node/store.js)
    this.store = o.leaseStore === false || o.keys ? null : o.leaseStore && typeof o.leaseStore.load === 'function' ? o.leaseStore
      : new LeaseStore(this.state, { key: o.key, site: o.site, clock: wall });
    const kept = this.store ? await this.store.load() : null;
    this.kept = kept ? kept.why : 'off';
    this.keys = o.keys || (kept && kept.keys) || await InstallKeys.create();
    this.ql = new QuranLab4({ key: o.key, site: o.site, apiUrl: o.apiUrl, modelsUrl: o.modelsUrl, endpoints: this.ep, fetch: o.fetch, clock: this.clock, state: this.state,
      trustedKeys: o.trustedKeys, appVersion: o.appVersion, appBuild: o.appBuild, autoSend: o.autoSend, apiTimeoutMs: Number.isFinite(o.apiTimeoutMs) ? o.apiTimeoutMs : API_TIMEOUT_MS,
      debug: o.debug, keys: this.keys, local: o.local, cert: kept ? kept.cert : null, desktop: o.desktop || null });
    // R402-4 (c): the hosted frame's app id on every report this page load makes (the Worker passes it; Node has none)
    frameReports(this.ql.errors, o.frameApp);
    this._watchStores();
    // a certificate of a Turnstile pass still holds: the leases of this page ride on it with no new token (18.4.9)
    this.turnstilePassed = !!(kept && kept.cert && certField(kept.cert, 'att') === 'turnstile' && this.ql.certHolds());
    // 4.0.1: a page with no kept lease and no pass asks for a lease, and Turnstile is the slow part of that (5.4 s of a
    // fresh open in Stage B, with nothing else running). Its script loads from the frame now, during the launch
    const leaseAhead = !o.desktop && typeof o.turnstile === 'function' && !this.turnstilePassed && !(kept && kept.lease);
    if (leaseAhead && typeof o.turnstilePrepare === 'function') { try { o.turnstilePrepare(); } catch (_) { /* never in the way */ } }
    // a stop the API answers on any route (15.3, 18.4.10: "works as in 3.x") removes the model's files and the kept
    // lease, here as in the lease route's signed stop
    this.ql.onModelStop = () => { this._purge({ stop: true }).catch(() => {}); };
    // an analytics session a killed page left open is closed first, into its own day (17.8 session_s)
    this.ql.telemetry.closeSession();
    await this.ql.launch();
    // 4.0.1: and the first lease's challenge and invisible Turnstile start now, while the engine loads and the page
    // gets to its model call; that lease uses them (_leaseOnce) while they are fresh (EARLY_MAX_MS)
    this._early = null;
    if (leaseAhead && !this.ql.modelRefusal && !this.ql.stopped && this.ql.config && this.ql.config.recommended) {
      this._early = this._earlyTurnstile();
      this._early.catch(() => {});
    }
    let engine;
    try { engine = o.engine || await o.loadEngine(this.ql.config); } catch (e) {
      // every engine build failed: reported (the server's rollback reads these), sent now, then the failure
      this._engineFailures(e.failures);
      await this.ql.flush().catch(() => {});
      throw e;
    }
    this._engineFailures(engine.failures);
    this.engine = { id: engine.id || null, variant: engine.variant || 'st', why: engine.why || null };
    this.files = new WithCoreFiles(o.files, this.state);
    // (a stop in force: the kept state is not handed back; the record was cleared when the stop came)
    this.core = await createCore({ factory: engine.factory, wasm: engine.wasm || null, files: this.files, keys: this.keys,
      state: kept && kept.coreState && !this.ql.modelRefusal ? kept.coreState : null, signals: o.signals || 0, clock: o.coreClock || null });
    // the site the frame verified (the handshake's event.origin, checked against ancestorOrigins): a web lease is
    // accepted only for that site (spec fix 15)
    // (a desktop app, the Node path, has no site: its leases are never web leases)
    if (!o.desktop) this.core.setSite(o.site);
    // a stored lease the Core took back with its state (the same release, the same install key): used as this page's
    // lease, never asked for again until its refresh_after (18.4.7) or its end
    let restored = false;
    if (kept && kept.coreState && kept.lease && !this.ql.modelRefusal) {
      let st = null;
      try { st = this.core.tick(); } catch (_) { st = null; }
      if (st && st.hasLease && !st.stopped) {
        const l = kept.lease;
        this.leaseInfo = { exp: st.exp, refreshAfter: st.refreshAfter, iat: Number.isFinite(l.iat) ? l.iat : null, base: l.base, build: l.build, man: null, eph: new Uint8Array(l.eph),
          anchorD: l.anchorD, src: { build: l.src.build, version: l.src.version, modelId: l.src.modelId, keyId: l.src.keyId, pin: null }, restored: true };
        await this.keys.prepareAgree(this.leaseInfo.eph);
        restored = true;
      }
    }
    this.kept = restored ? 'restored' : this.kept === 'restored' ? 'no_lease' : this.kept;
    // The data piece (R9, 18.6.7, spec fix 16 in Core c3): the Core keeps its pieces (in force, pending, last good) in
    // its own saved state, which comes back with the lease (lease-store.js). The frame keeps no piece of its own and
    // hands none at a start: under fix 16 a piece handed at a start would only be pending. (Before c3 the frame
    // mirrored the rule and kept the last good piece under core.piece; that key is dropped.)
    if (this.state.get('core.piece') !== null) this.state.set('core.piece', null);
    // failures the loader saw while no frame answered (ERRORS_40.md section 24): reported from here, once
    this._loaderFailures(args && args.pending);
    await this.state.flush();
    // the keys of a new install are kept at once (no lease yet), so a page closed before its first lease still makes
    // one install
    if (!restored) await this._persist();
    this.initMs = this.clock() - t0;
    return { sdk: SDK_VERSION_4, core: this.core.version, notice: this.core.notice, engine: this.engine,
      config: this.ql.config ? 'fresh' : 'none', stopped: this.ql.stopped || null, initMs: this.initMs, lease: this.kept,
      // the api and models P this start found (28.3): the page's sharing link starts from them
      endpoints: this.ep.share() };
  }

  /**
   * Keep the install keys, the certificate, the Core's saved state and what the frame knows of the lease, for the next
   * page load (lease-store.js). Called after each step that changes them; never throws, never in the way.
   */
  _persist() { return this._bounded(this._save()); }

  // the record's save as it runs (R402-3: never rejects; a failure is said through the store's onFailure)
  _save() {
    if (!this.store || !this.core || !this.core.ptr) return Promise.resolve();
    try {
      let now = null;
      if (!this.take) { try { now = this.core.tick().now; } catch (_) { now = null; } }
      const li = this.leaseInfo;
      const lease = li && li.eph ? { build: li.build, base: li.base, exp: li.exp, refreshAfter: li.refreshAfter, iat: Number.isFinite(li.iat) ? li.iat : null, eph: li.eph, anchorD: li.anchorD,
        src: { build: li.src.build, version: li.src.version, modelId: li.src.modelId, keyId: li.src.keyId } } : null;
      this._persistedSaves = this.core.saves;
      return Promise.resolve(this.store.save({ keys: this.keys, coreState: this.core.state, coreNow: now, cert: this.ql.installCert, lease,
        mirror: null })).catch((e) => this._saveFailed(e));
    } catch (e) { this._saveFailed(e); return Promise.resolve(); }
  }

  _saveFailed(e) { try { if (this._storeTold) this._storeTold(storeFailure(e, 'lease_save')); } catch (_) { /* never in the way */ } }

  // R402-3: a wait for the lease record's save, at most leaseSaveWaitMs (a real timer): the record serves the next page
  // load, so a save that fails or never ends (IndexedDB on iOS) never fails or holds up this call; it goes on behind
  _bounded(p) {
    const ms = Number.isFinite(this.o.leaseSaveWaitMs) ? this.o.leaseSaveWaitMs : LEASE_SAVE_WAIT_MS;
    let t = null;
    return Promise.race([p, new Promise((r) => { t = setTimeout(r, ms); if (t && typeof t.unref === 'function') t.unref(); })]).finally(() => clearTimeout(t));
  }

  // 4.0.2: the lease attempt in flight and the save of a lease it took, waited for at most `ms` (a real timer: close()
  // must end however the page's timers are driven); never throws
  async _settleLease(ms) {
    const pending = [this._attempt, this._leaseSaving].filter((p) => p && typeof p.then === 'function').map((p) => p.catch(() => {}));
    if (!pending.length) return;
    let t = null;
    await Promise.race([Promise.all(pending), new Promise((r) => { t = setTimeout(r, ms); if (t && typeof t.unref === 'function') t.unref(); })]);
    clearTimeout(t);
    if (this._leaseSaving) await Promise.race([this._leaseSaving.catch(() => {}), new Promise((r) => { const u = setTimeout(r, ms); if (u && typeof u.unref === 'function') u.unref(); })]);
  }

  /** ERRORS_40.md section 24: a failure the loader is given, with the code it gets (serve.js). Never throws. */
  reportFailure(err, code) {
    try { if (this.ql && code && code !== 'invalid_argument') this.ql.reportFailure(err, { code }); } catch (_) { /* never in the way */ }
  }

  /**
   * R402-3: the stores' failures that stop no call are silent error reports, stage storage (ERRORS_40.md 24.1): a file
   * store or IndexedDB the browser refused at the start, so this page load keeps them in memory (reason unavailable,
   * error_code the probe that failed, error_name the browser's error), and a write of the SDK's own records that
   * failed and is written again later (the state, the file index, the lease record). Each failure once per page load
   * (a report is itself written to the state: a store that keeps failing must not report each time).
   */
  _watchStores() {
    const seen = new Set();
    const told = (e) => {
      const t = (e && e.qlReport) || {};
      const k = `${t.reason}|${t.error_code}|${e && e.name}`;
      if (seen.has(k)) return;
      seen.add(k);
      try { this.ql.reportFailure(e, { silent: true }); } catch (_) { /* never in the way */ }
    };
    this._storeTold = told;
    for (const s of [this.o.files, this.state, this.store]) { if (s && typeof s === 'object') { try { s.onFailure = told; } catch (_) { /* a store that takes none */ } } }
    for (const x of [this.o.files, this.o.kv]) {
      const u = x && x.unavailable;
      if (u && typeof u.error_code === 'string') { try { this.ql._silent('storage', 'unavailable', { error_code: u.error_code, ...(u.error_name ? { error_name: u.error_name } : {}) }); } catch (_) { /* never in the way */ } }
    }
    if (this.state && this.state.loadFailed) told(this.state.loadFailed);
  }

  // the loader's own failures of earlier page loads (a frame that did not answer): stage, reason, code, error_name
  _loaderFailures(list) {
    for (const f of Array.isArray(list) ? list.slice(0, 8) : []) {
      if (!f || typeof f !== 'object' || typeof f.reason !== 'string' || typeof f.code !== 'string') continue;
      try { this.ql._occur({ stage: 'runtime', reason: f.reason, code: f.code, ...(typeof f.error_name === 'string' ? { error_name: f.error_name } : {}) }); } catch (_) { /* never in the way */ }
    }
  }

  /**
   * An engine build that did not load (docs/server-for-web-4.md 5): one issue per build and cause and UTC day, kind
   * `engine_failed`, code `engine_load_failed:<engine id>:<cause>` (cause: index, signature, sha256, fetch, compile).
   */
  _engineFailures(list) {
    for (const f of Array.isArray(list) ? list : []) {
      if (f && typeof f.id === 'string' && typeof f.cause === 'string') this.ql.reportIssue('engine_failed', `engine_load_failed:${f.id}:${f.cause}`);
    }
  }

  // ------------------------------------------------------------------ the model
  _refused() { if (this.ql.modelRefusal) throw this._stopError(this.ql.modelRefusal); }
  _stopError(e) { return new SdkError(e.code === 'sdk_too_old' ? 'sdk_too_old' : 'invalid_key', e.message, { reason: e.reason || null, status: e.status }); }

  /**
   * What the signed config names for this SDK (the order decided 11-14: config, attest, lease, then the files from
   * the lease answer's base; from 4.0.1 a fresh install fetches the files beside the lease, _preStart):
   * `recommended` = { revision (the build, 40 hex), version, model_id, key_id (the build's encryption key id, 32 hex),
   * model and folder }. The config gives no base URL. A pinned version is asked of the server.
   */
  async _source(version) {
    const ql = this.ql;
    ql.modelVersionPin = version;
    const stored = this.state.get('config');
    const usable = ql.config && (!stored || (stored.pin || null) === (version || null));
    // no config in this page (its start could not fetch one) and a lease held for the build the app asks for (valid,
    // or past its exp within its grace): the open does not wait for the config (18.4.7.1: an open waits at most 10 s,
    // for the lease attempt). It is asked in the background, from the sticky host on (28.3), and a refusal or a stop it
    // brings is handled when it comes; the open goes on with the held build now
    if (!usable && !ql.config) {
      const held = this._heldSource(version);
      if (held) {
        if (!this._configAhead) {
          this._configAhead = ql.refreshConfig().catch((e) => { this.lastError = e; return null; }).finally(() => { this._configAhead = null; });
        }
        ql.modelRevision = held.version;
        ql.modelBuild = held.build;
        return held;
      }
    }
    const cfg = usable ? ql.config : await ql.refreshConfig().catch((e) => { this.lastError = e; return null; });
    this._refused();
    // a runtime that cannot check the config's signature at all is runtime_unsupported, never offline (3.1.6)
    const cannot = !cfg && [this.lastError, ql.lastError].find((e) => e && e.code === 'runtime_unsupported');
    if (cannot) throw new SdkError('runtime_unsupported', cannot.message, { stage: 'runtime', why: 'webcrypto' });
    if (!cfg) {
      // ERRORS_40.md 24.4: a config the server answered (a status, a signature or expiry it failed) is download_failed
      // naming it; only no answer at all is needs_connection
      const last = [this.lastError, ql.lastError].find((e) => e && e.name === 'PlatformError' && (e.status > 0 || e.code === 'signature_invalid' || e.code === 'config_expired'));
      // the build of a lease this page holds (one kept from an earlier page load), while the server cannot be asked:
      // no answer, a 5xx or a 429, never a refusal or a config that did not verify (as the native SDKs open the build
      // already on the device when offline)
      const held = !last || last.status >= 500 || last.status === 429 ? this._heldSource(version) : null;
      if (held) {
        ql.modelRevision = held.version;
        ql.modelBuild = held.build;
        return held;
      }
      // the report names the request that failed, as 3.1.7 does: the token gates the config (24.4 rule 3a), so a token
      // request that failed is stage attest; a 401 invalid_token that names no stop reason is the token's own answer,
      // reason http, never refused (PLATFORM_CLIENT.md 8)
      const failed = this.lastError || ql.lastError;
      const stage = (last ? last.stage : failed && failed.qlReport && failed.qlReport.stage) === 'attest' ? 'attest' : 'config';
      // a token request refused for an integrity check (403 lease_integrity_failed at the attest): server_rejected,
      // naming the check, as at the lease (ERRORS_40.md 24.3, contract 69326fb)
      if (last && last.status === 403 && last.code === 'lease_integrity_failed') {
        throw new SdkError('server_rejected', integrityDetail(last.serverWhy, last.serverCheck),
          { stage, why: 'integrity_failed', http_status: 403, error_code: integrityCode(last.serverWhy, last.serverCheck) || 'lease_integrity_failed' });
      }
      if (last && last.status >= 400) {
        throw new SdkError('download_failed', `Quran Lab's server answered ${last.status}; try again later`,
          { stage, why: last.status === 429 ? 'rate_limited' : tokenAnswer(last.status, last.code, last.reason) ? 'http' : last.status === 401 || last.status === 403 ? 'refused' : 'http', http_status: last.status, error_code: last.code });
      }
      if (last) throw new SdkError('download_failed', last.code === 'config_expired' ? 'the signed config has expired (check the device clock)' : 'the signed config did not verify',
        { stage: 'config', why: last.code === 'config_expired' ? 'expired' : 'signature' });
      throw new SdkError('needs_connection', 'no signed config could be fetched', { stage, why: 'network' });
    }
    const rec = cfg.recommended;
    if (!rec || !/^[0-9a-f]{40}$/.test(String(rec.revision)) || !/^[0-9a-f]{32}$/.test(String(rec.key_id)) || !MODEL_VERSION_RE.test(String(rec.version))
        || typeof rec.model_id !== 'string') {
      throw new SdkError('model_unavailable', 'the config names no protected build for this SDK', { stage: 'config', why: 'unavailable' });
    }
    const pin = cfg.pin && typeof cfg.pin === 'object' && typeof cfg.pin.version === 'string' ? { version: cfg.pin.version, status: String(cfg.pin.status || '') } : null;
    ql.modelRevision = rec.version;
    ql.modelBuild = rec.revision;
    return { build: rec.revision, version: rec.version, modelId: rec.model_id, keyId: rec.key_id, pin };
  }

  // the source of the lease this page holds, when the app asks for its version (or none) and the lease is valid or
  // past its exp within a possible grace (the open decides: _leaseFor, the Core); else null
  _heldSource(version) {
    const held = this.leaseInfo && this.leaseInfo.src;
    if (!held || !(version === null || version === undefined || held.version === version)) return null;
    let usable = false;
    try { const st = this.core.tick(); usable = st.hasLease && !st.stopped && (st.valid || st.now < st.exp + GRACE_S); } catch (_) { usable = false; }
    return usable ? { ...held, pin: null } : null;
  }

  // the signed manifest of the build, from the lease answer's base (or this site's storage): its SHA-256 starts with
  // the build the config named, and it names the config's key id, version and model id
  async _manifest(src, base) {
    const key = `manifest:${src.build}`;
    let bytes = this.state.get(key) ? utf8(this.state.get(key)) : null;
    if (!bytes) {
      if (!base) throw new SdkError('needs_connection', 'no lease answer named where the files are', { stage: 'lease', why: 'network' });
      // one request per build and base at a time: the early fetch (_preStart) and the lease's ask for the same file
      const k = `${src.build} ${base}`;
      const inflight = this._manifests || (this._manifests = new Map());
      let p = inflight.get(k);
      if (!p) {
        p = this._get(base + 'manifest.json', { stage: 'manifest' });
        inflight.set(k, p);
        p.then(() => inflight.delete(k), () => inflight.delete(k));
      }
      // (a build whose manifest is not stored is not on the device: no answer is needs_connection, 24.4 rule 1)
      try { bytes = await p; } catch (e) { throw this._noAnswer(e, false); }
    }
    // the build is the first 40 hex of the signed manifest's SHA-256 (SPEC 2a): the bytes are the config's build
    if ((await sha256Hex(bytes)).slice(0, 40) !== src.build) throw new SdkError('signature_invalid', 'the manifest is not the build the config names', { stage: 'manifest', why: 'signature' });
    let m;
    try { m = JSON.parse(fromUtf8(bytes)); } catch (_) { throw new SdkError('model_invalid', 'the manifest is not JSON', { stage: 'manifest', why: 'parse' }); }
    if (!m.encryption || m.encryption.scheme !== 'qle1') throw new SdkError('model_incompatible', 'SDK 4.0 opens protected builds only; the config named a plaintext build', { stage: 'manifest', why: 'incompatible' });
    if (m.version !== src.version || m.model_id !== src.modelId || m.encryption.key_id !== src.keyId) {
      throw new SdkError('signature_invalid', 'the manifest is not the build the config names (version, model id or key id)', { stage: 'manifest', why: 'signature' });
    }
    this.state.set(key, fromUtf8(bytes));
    return { bytes, m };
  }

  /**
   * One model request (the manifest, a file, a sample clip) by SPEC section 16's rule, as the native SDKs have it
   * (Android Downloader.kt RetryPlan):
   *   - one GET for the whole file (SPEC 16.7, SDK 4.0.2; web had it from 4.0.0): its answer read as a stream, the
   *     bytes counted as progress as they come; no fixed slices and no ranges in parallel;
   *   - a stall ends a request: no byte for 30 s (the wait for the answer included) and it is aborted; a slow link that
   *     keeps delivering is never cut;
   *   - the request is asked again inside the call, at most 5 times per file, after pauses of 1, 2, 4, 8 and 16 s,
   *     from the bytes already held: an open-ended Range from the last byte held, the only Range the SDK sends. With
   *     If-Range (the validator of the answer that started it, to that host only) where it can be sent: in Node
   *     (o.ifRange). Not from the frame: the CDN's CORS does not allow the header, so there the size and the file's
   *     SHA-256 decide (16.2), as for bytes kept from an earlier call. Asked again: no answer, a connection that
   *     ended, a stall, a 5xx, and an answer that says success and is not what was asked for (a 206 for other bytes, a
   *     2xx that is neither 200 nor the 206 asked for, a body longer than the file);
   *   - asked once and never again in the call: a refusal (401 or 403, after one renewal of the token on a 401
   *     invalid_token; a stop reason stops the model as 15.3 says), a 429, a redirect, and any other status;
   *   - `keep` (a file's decoded path, with `size`): the bytes are also kept, in blocks of 4 MiB as they complete, as
   *     ciphertext in the frame's file store (`<path>.part.<n>`, CDN form), so a call that fails, or a page closed
   *     mid-download, goes on at the next call from the blocks kept (one request, from the first byte not kept; what
   *     4.0.1 kept is read the same way). The blocks are what the store keeps of the one stream, never a request
   *     each: 4 MiB is what a cut can lose. They are dropped once the file is whole.
   * A server that answers a Range request with the whole file (200) is read beside the bytes held, which it replaces
   * once complete.
   * From 4.0.1 (ENDPOINTS_40.md 28.3, 28.4) the request goes to the models hosts with the URL's path: P first (a host
   * of the URL that is not one of the role's before it), each host 10 s to its status; a failure that is unreachable
   * (no answer, a stall, a 5xx, a redirect, a 4xx that is not the CDN's, a 2xx that is not what was asked) resumes on
   * the next host, cycling, from the bytes held, with Range and no If-Range; a refusal (a 4xx with a JSON error) and a
   * 429 end the call on the host that gave them. The host that ends it is P.
   * `cancel` ({ on, hooks: Set of functions }, 4.0.1: an early fetch whose lease did not come): once `on`, the request
   * in flight is aborted, a pause ends, and the call fails at once and is never asked again.
   */
  async _get(url, { onProgress = null, stage = 'download', size = null, keep = null, cancel = null } = {}) {
    const dl = this.dl || (this.dl = { resumes: 0, keptBlocks: 0 });
    const opt = this.o.download || {};
    const pauses = Array.isArray(opt.pausesMs) ? opt.pausesMs : PAUSES_MS;
    const stallMs = Number.isFinite(opt.stallMs) ? opt.stallMs : STALL_MS;
    // 28.3 item 6: a host has 10 s without a byte before the answer's status (the stall time, when that is shorter)
    const headMs = Math.min(this.ep.headMs, stallMs);
    const block = Number.isInteger(opt.blockBytes) && opt.blockBytes > 0 ? opt.blockBytes : BLOCK_BYTES;
    // 28.4: the folder's path through the models order (P first; a base's own host that is not one of the role's
    // before it); after a failure that is unreachable the resume goes to the next host, cycling (28.4)
    const target = this.ep.modelTarget(url);
    if (!target) throw new SdkError('download_failed', 'a model request to a host that is not Quran Lab\'s', { stage, why: 'invalid_answer' });
    const ro = this.ep.roles.models, t0 = this.clock();
    const { order: roleOrder, probe } = ro.order(t0);
    const order = target.first ? [target.first, ...roleOrder] : roleOrder;
    // validator: the ETag (or Last-Modified) of the answer the bytes held came from, and validatorHost its host (an
    // If-Range goes to that host only, 16.7 item 2)
    let chunks = [], have = 0, validator = null, validatorHost = null, resumes = 0, renewed = false, k = 0, firstFail = null;
    const asked = new Set();
    // the blocks a call before this one kept
    if (keep && Number.isInteger(size)) {
      const kb = await this._keptBlocks(keep, size, block);
      if (kb) { chunks = kb.blocks; have = kb.bytes; validator = kb.validator; validatorHost = kb.host; dl.keptBlocks += kb.blocks.length; }
    }
    let saved = Math.floor(have / block); // blocks kept so far
    // a failure that is unreachable (28.3): asked again, on the next host; `reason` is 24.3's for the failover report
    const fail = (why, msg, extra = {}, reason = why) => Object.assign(new SdkError('download_failed', msg, { stage, why, ...extra }), { again: true, hostReason: reason });
    const cancelled = () => new SdkError('download_failed', 'the download was cancelled', { stage, why: 'cancelled' });
    // the request ended on this host (taken, a refusal, a slow down): it is P; a failover when the first host failed
    // (asked false: the request ended on a host's held answer, a 429 kept from an earlier request, with no request to
    // it: no other host answered, so no failover report, 28.7)
    const ended = (host, asked = true) => {
      ro.settle(host, t0, probe);
      if (firstFail && host !== firstFail.host) this.ep.noteFailover('models', firstFail, host, stage, asked);
    };
    for (;;) {
      const host = order[k % order.length];
      let err = null;
      let ac = null, unhook = null;
      // 34.6 (4.0.2): this request's facts on its host (sent, its status time, the bytes and time of its body), counted
      // once it ends (_meterHost)
      const meter = { sent: false, t0: 0, ttfb: null, bodyAt: 0, bytes: 0, done: false };
      try {
        if (cancel && cancel.on) throw cancelled();
        // 28.11 item 2 (4.0.2): a host that answered this file 429, or 503 with a Retry-After, is not asked it again
        // before it: its 429 ends the call there (28.3), its 503 goes on to the next host. Per file path and host
        //: a standby's 503 for a file it does not hold (an accelerator build) holds nothing else there
        const held = this.ep.held('models', target.path, host);
        if (held && held.status === 429) {
          ended(host, false);
          throw new SdkError('download_failed', held.error === 'model_limit' ? MODEL_LIMIT_DETAIL : 'the CDN answered 429',
            { stage, why: 'rate_limited', http_status: 429, ...(held.error ? { error_code: held.error } : {}) });
        }
        if (held) throw Object.assign(fail('http', `the CDN answered ${held.status} (asked again in ${held.left} s)`, { http_status: held.status }), { heldHost: true });
        const headers = await this.ql.modelHeaders().catch((e) => { throw tokenFailure(e); });
        if (have > 0) {
          headers.range = `bytes=${have}-`;
          // 16.7 item 2: a file that changed comes again whole (a 200, read beside the bytes held); a weak validator
          // cannot be sent
          if (this.o.ifRange && validator && validatorHost === host && !/^W\//.test(validator)) headers['if-range'] = validator;
        }
        ac = typeof AbortController === 'function' ? new AbortController() : null;
        if (cancel && ac) { const h = () => ac.abort(); cancel.hooks.add(h); unhook = () => cancel.hooks.delete(h); }
        let r;
        // (4.0.2: a host counts as asked, for the report's `fallback`, only once its request is sent; one passed for its
        // hold was not asked, ERRORS_40 24.3)
        asked.add(host);
        meter.sent = true;
        meter.t0 = this.clock();
        try {
          r = await this._stalls(this.ql.rawFetch(this.ep.origin(host) + target.path, { headers, redirect: 'error', ...(ac ? { signal: ac.signal } : {}) }), headMs, () => ac && ac.abort());
        } catch (e) {
          // no status in time is no answer (24.3: a timeout before any answer is network)
          throw fail(e && e.stall ? 'stall' : 'network', e && e.stall ? `no answer for ${headMs} ms` : String((e && e.message) || e), {},
            !(e && e.stall) && /redirect/i.test(String((e && e.cause && e.cause.message) || '') + String((e && e.message) || '')) ? 'redirect' : 'network');
        }
        meter.ttfb = this.clock() - meter.t0;
        meter.bodyAt = this.clock();
        if (r.status === 429) {
          ended(host);
          // the CDN's error token (`model_limit`, the daily limit) is the report's error_code (24.3), and its cause's
          let b = null;
          try { b = JSON.parse(await r.text()); } catch (_) { b = null; }
          const ec = b && typeof b === 'object' && typeof b.error === 'string' ? { error_code: b.error } : {};
          this.ep.hold('models', target.path, host, retryAfterOf(r, this.clock()), 429, ec.error_code || null);
          throw new SdkError('download_failed', ec.error_code === 'model_limit' ? MODEL_LIMIT_DETAIL : 'the CDN answered 429', { stage, why: 'rate_limited', http_status: 429, ...ec });
        }
        if (r.status >= 500) {
          if (r.status === 503) this.ep.hold('models', target.path, host, retryAfterOf(r, this.clock()), 503);
          throw fail('http', `the CDN answered ${r.status}`, { http_status: r.status });
        }
        if (r.status >= 400) {
          // 28.3: a refusal is a 4xx with a JSON error string; any other 4xx (a proxy's or a firewall's page) is not the
          // CDN's answer, and the next host is asked
          let b = null;
          try { b = JSON.parse(await r.text()); } catch (_) { b = null; }
          if (!b || typeof b !== 'object' || typeof b.error !== 'string' || !b.error) throw fail('http', `the CDN answered ${r.status} with no error of its own`, { http_status: r.status });
          if (r.status === 401 && b.error === 'invalid_token' && !b.reason && !renewed) { renewed = true; this.ql._token = null; continue; }
          ended(host);
          if (r.status === 401 || r.status === 403) {
            this.ql.noteModelRefusal({ status: r.status, error: b.error, reason: b.reason });
            this._refused();
            throw new SdkError('download_failed', `the CDN answered ${r.status}`, { stage, why: 'refused', http_status: r.status, error_code: b.error });
          }
          throw new SdkError('download_failed', `the CDN answered ${r.status}`, { stage, why: 'http', http_status: r.status, error_code: b.error });
        }
        if (r.status >= 300) throw fail('redirect', `the CDN answered ${r.status}`, { http_status: r.status });
        if (r.status !== 200 && r.status !== 206) throw fail('http', `the CDN answered ${r.status}, not the file`, { http_status: r.status }, 'invalid_answer');
        if (r.status === 206) {
          const cr = String(r.headers.get('content-range') || '');
          const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(cr.trim());
          if (have === 0 || !m || Number(m[1]) !== have || (Number.isInteger(size) && m[3] !== '*' && Number(m[3]) !== size)) {
            throw fail('http', `the CDN answered bytes ${JSON.stringify(cr)} where bytes ${have}- were asked for`, { http_status: 206 }, 'invalid_answer');
          }
        }
        this.ql.noteModelServed();
        const v = r.headers.get('etag') || r.headers.get('last-modified');
        if (v) { validator = v; validatorHost = host; }
        // a 200 to a range request brings the whole file: read beside the bytes held, which it replaces only once it is
        // complete (16.1, 28.4); the bytes held stay for the next resume when it is not
        const beside = r.status === 200 && have > 0;
        const buf = beside ? [] : chunks;
        let n = beside ? 0 : have;
        if (!r.body || typeof r.body.getReader !== 'function') {
          const b = new Uint8Array(await r.arrayBuffer());
          buf.push(b); n += b.length; meter.bytes += b.length;
          if (!beside) have = n;
        } else {
          const rd = r.body.getReader();
          for (;;) {
            let x;
            try { x = await this._stalls(rd.read(), stallMs, () => { if (ac) ac.abort(); rd.cancel().catch(() => {}); }); } catch (e) {
              throw fail(e && e.stall ? 'stall' : 'network', e && e.stall ? 'no byte for 30 s' : `the connection ended (${(e && e.message) || e})`, {}, e && e.stall ? 'timeout' : 'network');
            }
            if (x.done) break;
            buf.push(x.value); n += x.value.length; meter.bytes += x.value.length;
            if (!beside) have = n;
            if (Number.isInteger(size) && n > size) throw fail('http', 'the answer is longer than the file', {}, 'invalid_answer');
            if (onProgress) onProgress(Math.max(n, have));
            // whole blocks kept as they complete (ciphertext, the CDN form)
            if (keep && !beside && Number.isInteger(size)) {
              while ((saved + 1) * block <= have) { await this._keepBlock(keep, size, block, saved, chunks, validator, validatorHost); saved++; }
            }
          }
        }
        if (Number.isInteger(size) && n !== size) throw fail('network', `the connection ended at ${n} of ${size} bytes`);
        if (beside) { chunks = buf; have = n; }
        ended(host);
        meter.done = true;
        return join(chunks, have);
      } catch (e) { err = e; } finally {
        if (unhook) unhook();
        if (meter.sent) this._meterHost(host, meter, cancel && cancel.on ? null : err);
      }
      if (cancel && cancel.on) throw cancelled();
      // (asked false: a host passed for its hold, never asked; it makes no failover report, 28.7 with 28.11 item 2)
      if (err.again && !firstFail) firstFail = { host, reason: err.hostReason || 'network', status: Number.isInteger(err.http_status) ? err.http_status : null, asked: !err.heldHost };
      if (!err.again || resumes >= pauses.length) {
        if (err.again) {
          err.message = `${err.message} (asked ${resumes + 1} times)`;
          this.ep.noteFailover('models', firstFail, null, stage); // every host asked failed (diagnose's lastFailover)
        }
        // 28.7: the role of the request and whether it was asked of more than one host
        if (err instanceof SdkError && err.stage === stage && !err.host_role) { err.host_role = 'models'; err.fallback = asked.size > 1; }
        throw err;
      }
      k++; // 28.4: the resume goes to the next host of the order
      await new Promise((res) => {
        let t = null;
        const done = () => { if (cancel) cancel.hooks.delete(stop); res(); };
        const stop = () => { this.timers.clearTimeout(t); done(); };
        t = this.timers.setTimeout(done, pauses[resumes]);
        if (cancel) cancel.hooks.add(stop);
      });
      if (cancel && cancel.on) throw cancelled();
      resumes++;
      dl.resumes++;
    }
  }

  // 34.6 (4.0.2, contract ec46782 "How each count is read"): one model request into the day's per-host counts
  // (Telemetry4.recordHost): every request sent counts, a cancelled one too; unreachable at most once, as 28.3 item 3
  // reads it (err.again: no answer, a cut or stalled body, a 5xx, a 2xx that is not the file), never a refusal, a
  // 429, a cancel (`err` null) or a write that failed on the device (the store's own, after the request)
  _meterHost(host, m, err) {
    try {
      const t = this.ql && this.ql.telemetry;
      if (!t || typeof t.recordHost !== 'function') return;
      t.recordHost(host, { requests: 1, unreachable: err && err.again ? 1 : 0, ttfbMs: m.ttfb, bytes: m.bytes,
        transfer: m.ttfb !== null ? { bytes: m.bytes, ms: this.clock() - m.bodyAt } : null, files: m.done ? 1 : 0 });
    } catch (_) { /* never in the way of the download */ }
  }

  // a promise that fails `{ stall: true }` when it has not settled in `ms` (onStall runs then)
  _stalls(p, ms, onStall) {
    return new Promise((resolve, reject) => {
      const t = this.timers.setTimeout(() => { try { onStall(); } catch (_) { /* gone */ } reject(Object.assign(new Error('stall'), { stall: true })); }, ms);
      p.then((v) => { this.timers.clearTimeout(t); resolve(v); }, (e) => { this.timers.clearTimeout(t); reject(e); });
    });
  }

  // the n-th block of a file being downloaded, kept as ciphertext beside its validator (one KV record per file)
  async _keepBlock(path, size, block, n, chunks, validator, host = null) {
    try {
      await this._serial(() => this.o.files.put(QLC.FORM_CDN, `${path}.part.${n}`, sliceOf(chunks, n * block, (n + 1) * block)));
      // (4.0.2: and its host, for an If-Range to that host only; a record of 4.0.1 has none, and sends none)
      this.state.set(`part:${path}`, { size, block, n: n + 1, validator: validator || null, ...(host ? { host } : {}) });
    } catch (_) { /* a store that is full or blocked: the download goes on, nothing kept */ }
  }

  // the blocks a call before this one kept for `path` (the same size and block), or null
  async _keptBlocks(path, size, block) {
    const rec = this.state.get(`part:${path}`);
    if (!rec || rec.size !== size || rec.block !== block || !Number.isInteger(rec.n) || rec.n < 1) { if (rec) await this._dropBlocks(path); return null; }
    const blocks = [];
    for (let i = 0; i < rec.n; i++) {
      const b = await this.o.files.get(QLC.FORM_CDN, `${path}.part.${i}`).catch(() => null);
      if (!b || b.length !== block) break;
      blocks.push(b);
    }
    if (!blocks.length) { await this._dropBlocks(path); return null; }
    return { blocks, bytes: blocks.length * block, validator: typeof rec.validator === 'string' ? rec.validator : null, host: typeof rec.host === 'string' ? rec.host : null };
  }

  async _dropBlocks(path) {
    const rec = this.state.get(`part:${path}`);
    const n = rec && Number.isInteger(rec.n) ? rec.n : 0;
    for (let i = 0; i < n; i++) await this._serial(() => this.o.files.drop(QLC.FORM_CDN, `${path}.part.${i}`)).catch(() => {});
    this.state.set(`part:${path}`, null);
  }

  // whether a call before this one kept blocks of any of `files`, or (4.0.2) a whole file an early fetch stored before
  // its lease failed to come (part of a download on the device)
  async _anyKept(files) {
    for (const f of files) {
      const rec = this.state.get(`part:${f.path}`);
      if (rec && Number.isInteger(rec.n) && rec.n > 0) return true;
      if (f.encoding === 'qle1' && await this.o.files.has(QLC.FORM_CDN, f.decoded.path).catch(() => false)) return true;
    }
    return false;
  }

  /**
   * ERRORS_40.md 24.4 rule 1 (4.0.2): a file or the manifest of a build that got no HTTP answer at all, when nothing of
   * what the call downloads is on the device or arrived in it (on_device none: a first install, another context's
   * files), is needs_connection, not download_failed: the call cannot go on without that request. The token request a
   * model request needs (a page holds its token for the page session only) is such a request too (24.4 rule 3a: the
   * token gates the files). `partial`: part of
   * the download is on the device or came in this call (on_device partial): it stays download_failed, which says the
   * download resumes. Anything else is returned as it is.
   */
  _noAnswer(e, partial) {
    if (partial || !(e instanceof SdkError) || e.code !== 'download_failed' || e.why !== 'network' || !['download', 'manifest', 'attest'].includes(e.stage)) return e;
    const out = new SdkError('needs_connection', e.message, { stage: e.stage, why: 'network', needs: 'model' });
    if (e.host_role) { out.host_role = e.host_role; out.fallback = e.fallback; }
    return out;
  }

  /**
   * 24.13 (4.0.2): what a needs_connection of call `op` waits for. 'model': files the call needs are not on the device
   * (a file or manifest request got no answer, a first install, another context's files); 'lease': every file of the
   * call's build and context is on the device and only Quran Lab's answer is missing. Never throws: 'model' when it
   * cannot tell.
   */
  async needsOf(err, op, args = {}) {
    try {
      if (err && (err.needs === 'model' || err.needs === 'lease')) return err.needs;
      if (err && (err.stage === 'download' || err.stage === 'manifest')) return 'model';
      // the build the call opens: the open model's, else the held lease's, else the one the config names (its manifest
      // as stored on the device)
      let man = this.model ? this.model.man : null;
      if (!man) {
        const rec = this.ql && this.ql.config && this.ql.config.recommended;
        const build = this.leaseInfo && this.leaseInfo.src ? this.leaseInfo.src.build : rec && typeof rec.revision === 'string' ? rec.revision : null;
        const text = build ? this.state.get(`manifest:${build}`) : null;
        man = text ? { m: JSON.parse(text) } : null;
      }
      if (!man || !man.m || !Array.isArray(man.m.files)) return 'model';
      const asked = (op === 'start' || op === 'warm') && typeof args.context === 'string' && man.m.contexts.includes(args.context) ? args.context : null;
      // (4.0.2: a file an early fetch kept, its CDN form, is on the device and needs only the lease to install)
      for (const f of await this._missing(man, this._context(man.m, asked))) {
        if (!(f.encoding === 'qle1' && await this.o.files.has(QLC.FORM_CDN, f.decoded.path))) return 'model';
      }
      return 'lease';
    } catch (_) { return 'model'; }
  }

  // 18.4.4 to 18.4.10: one lease for this build, held by the Core (and never anywhere else)
  // one lease request's outcome into the day (17.8 `lease`), in the same flush as the rest of the step. An attempt that
  // brought no lease is told to the Core as unreachable or refused (18.4.7.1, attemptOutcome), which decides the grace;
  // one attempt runs at a time (a model open past exp waits for the one running).
  _lease(src) {
    if (this._attempt) return this._attempt;
    const p = (async () => {
      try {
        const li = await this._leaseOnce(src);
        this.ql.telemetry.recordLease('ok');
        this._setRow(0, 0);
        return li;
      } catch (e) {
        // 4.0.2: an attempt the client's close() gave up on (it ends after the close: its answer, or its failure, is never
        // the learner's) is no failed attempt: nothing told to the Core, no row of failures, no backoff, nothing counted
        if (this._closed) throw e;
        this.ql.telemetry.recordLease(e.leaseCause || (['needs_connection', 'download_failed'].includes(e.code) ? 'offline'
          : ['invalid_key', 'sdk_too_old', 'server_rejected'].includes(e.code) ? 'refused' : 'other'));
        const outcome = attemptOutcome(e);
        e.attempt = outcome;
        // 18.4.7.3: every failed attempt counts in the row, an app's call as well, and sets the next background attempt
        // (a fresh draw, its Retry-After the floor); a verified stop ends it. One failed from a Retry-After hold made no
        // request (28.11 item 2): not an attempt, the next one only not before the hold's end
        const ra = Number.isFinite(e.retryAfter) ? e.retryAfter : null;
        if (outcome === 'stop') this._setRow(0, 0);
        else if (e.held) this._setRow(Math.max(this.leaseRow.n, 1), Math.max(this.leaseRow.at, this.clock() + 1000 * (ra || 1)));
        else this._setRow(this.leaseRow.n + 1, this.clock() + 1000 * leaseBackoffS(ra, this.o.random || Math.random));
        if (outcome !== 'stop' && !this._attemptTold) { try { this.core.leaseAttempt(outcome); } catch (_) { /* no lease held */ } }
        if (outcome !== 'stop') this._persist(); // the Core keeps the outcome in its saved state
        throw e;
      } finally {
        this._attempt = null;
        this._attemptTold = false;
        this._attemptEnded = this.clock();
        this.state.flush().catch(() => {});
      }
    })();
    this._attempt = p;
    return p;
  }

  /**
   * A model open (or prefetch) past the held lease's exp (18.4.7.1): one attempt first (none when one ended less than
   * 60 s ago; the one running is waited for), at most 10 s. No outcome by then: unreachable, told now, and the open goes
   * on; the late answer is used as usual (a lease is taken, a refusal told). Then the Core decides: a new lease, or the
   * held one in its grace (an attempt since the lease unreachable and none refused), else the
   * attempt's error. Each open in grace is a silent error report (lease, grace).
   */
  async _expiredLease(src) {
    const li = this.leaseInfo;
    const wait = Number.isFinite(this.o.attemptWaitMs) ? this.o.attemptWaitMs : ATTEMPT_WAIT_MS;
    let failure = null;
    // no attempt when one ended less than 60 s ago, or (18.4.7.3) while the row of failed attempts waits and the held
    // lease is in its grace: an open in grace never asks before the backoff allows; one with no grace asks at once
    let inGrace = false;
    try { inGrace = this.core.leaseGrace().inGrace; } catch (_) { inGrace = false; }
    const waiting = this.leaseRow.n > 0 && this.clock() < this.leaseRow.at && inGrace;
    const recent = !this._attempt && ((this._attemptEnded && this.clock() - this._attemptEnded < 60_000) || waiting);
    if (!recent) {
      const p = this._lease(src);
      let timer = null;
      const late = new Promise((resolve) => { timer = this.timers.setTimeout(() => resolve({ late: true }), wait); });
      const r = await Promise.race([p.then((x) => ({ li: x }), (e) => ({ e })), late]);
      this.timers.clearTimeout(timer);
      if (r.li) return r.li;
      if (r.late) {
        // no outcome in time: unreachable now (the attempt goes on; its answer is used when it comes)
        this._attemptTold = true;
        try { this.core.leaseAttempt('unreachable'); } catch (_) { /* no lease held */ }
        p.catch(() => {});
        failure = Object.assign(new SdkError('needs_connection', 'no answer to the lease request within 10 s', { stage: 'lease', why: 'timeout' }), { attempt: 'unreachable' });
      } else failure = r.e;
    } else failure = this._lastFailure || null;
    if (failure && failure.attempt) this._lastFailure = failure;
    if (this.ql.modelRefusal) throw this._stopError(this.ql.modelRefusal);
    let g = { inGrace: false, until: 0 };
    try { g = this.core.leaseGrace(); } catch (_) { /* none */ }
    if (g.inGrace && li && li.build === src.build) {
      if (!li.man) li.man = await this._manifest(li.src || src, li.base);
      li.grace = { until: g.until, failure };
      return li;
    }
    throw leaseError(failure);
  }

  // one open in grace: the silent report of ERRORS_40 24.1 (stage lease, reason grace, code none), naming how the
  // attempt that brought no lease ended (24.3: network, timeout, http, rate_limited, redirect, invalid_answer, invalid)
  _reportGrace(li) {
    const f = li && li.grace && li.grace.failure;
    // the answer's status whichever request of the attempt ended it: the lease route's own (http_status) or a token or
    // challenge answer (a PlatformError's status; Stage B 11-18: a 503 on the token route was reported without it)
    const s = f ? Number(f.http_status || f.status) || 0 : 0;
    try {
      this.ql._occur({ stage: 'lease', reason: 'grace', code: 'none', ...(s ? { http_status: s } : {}),
        error_code: graceCause(f) });
    } catch (_) { /* never in the way */ }
  }

  // ERRORS_40 24.1: the silent report of a lease given without a Turnstile pass (18.4.9)
  _turnstileUnverified(a) {
    try {
      const why = typeof a.turnstile_why === 'string' && /^[a-z_]{1,24}$/.test(a.turnstile_why) ? a.turnstile_why : 'unverified';
      this.ql._occur({ stage: 'lease', reason: 'turnstile_unverified', code: 'none', error_code: why });
    } catch (_) { /* never in the way */ }
  }

  /**
   * 4.0.1: the first lease's challenge and its invisible Turnstile token, asked at the page's start (init) instead of at
   * its first lease: { challenge, token (as the frame gives it: a token, false or null), at (when the challenge came) }.
   * The cdata binds the token to that challenge (18.4.9), so the two are only ever used together.
   */
  async _earlyTurnstile() {
    await this.ql.token();
    const challenge = await this.ql.challenge();
    const at = this.clock();
    const cdata = await turnstileCdata(this.keys.installHex, challenge);
    const token = await this.o.turnstile({ action: 'lease', cdata }).catch(() => false);
    return { challenge, token, at };
  }

  // the early pair, once, when it is still fresh (EARLY_MAX_MS: a challenge lives 5 minutes, a token 300 s); else null
  async _takeEarly() {
    const p = this._early;
    if (!p) return null;
    this._early = null;
    const e = await p.catch(() => null);
    return e && this.clock() - e.at < EARLY_MAX_MS ? e : null;
  }

  async _leaseOnce(src) {
    const ql = this.ql, keys = this.keys;
    let renewedCert = false, renewedChallenge = false, freshTurnstile = false, renewedToken = false, proofAgain = false;
    const early = await this._takeEarly();
    for (let attempt = 0; attempt < 5; attempt++) {
      const pair = attempt === 0 ? early : null;
      await ql.token();
      const challenge = pair ? pair.challenge : await ql.challenge();
      const { core, installSig } = await this.core.leaseAsk(challenge, src.build);
      const askedUnder = !!core && Number(core.piece) > 0; // the proof is made under a piece (core.piece, 0 without one)
      const body = { v: 1, platform: ql.platform, install_cert: ql.installCert, install_key: b64u(keys.spki), install_sign_key: b64u(keys.signSpki),
        challenge, install_sig: installSig, model: src.modelId, version: src.version, build: src.build, key_id: src.keyId, core };
      if (!this.turnstilePassed && this.o.turnstile) {
        // null: no widget (no site key: no gate); false: the invisible check gave no token: the lease is asked without
        // one and the server gives the unattested class (18.4.9; owner, 11-18: never a refusal, never a box). The early
        // pair's token was made for its challenge, the one this ask carries
        let token;
        if (pair) token = pair.token;
        else {
          const cdata = await turnstileCdata(keys.installHex, challenge);
          token = await this.o.turnstile({ action: 'lease', cdata }).catch(() => false);
        }
        if (token) body.turnstile = token;
      }
      // 4.0.2: the stops seen so far, as the request goes out: an answer to a request sent before a stop (one that
      // came by another route while it was in flight) is never handed to the Core (the Core takes any verified lease,
      // even after a stop: a revoked key would open again). As Android's Lease.kt
      const stops = this._stopGen;
      const r = await ql.modelKey(body, (res, status) => this._leaseAnswer(res, status, src, stops));
      const a = r.body || {};
      // 28.7: the lease request's role and whether more than one api host was asked
      const hf = { host_role: 'api', fallback: !!r.fallback };
      // 18.4.7.1: the API's refusal is a 4xx other than 429 whose body is JSON with an error string; any other answer
      // that brings no lease is unreachable
      const refusal = r.status >= 400 && r.status < 500 && r.status !== 429 && r.body !== null && typeof a.error === 'string' && a.error !== '' ? 'refused' : 'unreachable';
      if (r.status === 200 && typeof a.lease === 'string') {
        // the server gave the unattested class without a Turnstile pass (no token, a doubtful one, or Turnstile down):
        // no page session certificate, so the next lease asks again; reported, silently (ERRORS_40 24.1)
        if (a.turnstile === 'unverified') this._turnstileUnverified(a);
        else if (body.turnstile) this.turnstilePassed = true;
        // the host's answer as taken (28.3): its base, manifest and the lease the Core accepted (_leaseAnswer); else every
        // host gave an answer that is not one (the first host's is read here, and fails as before 4.0.1)
        let { base, man, got } = r.value || {};
        const leaseBytes = unb64u(a.lease);
        // (taken by the answer's own check, _leaseAnswer, which started its save the moment the Core took it; else here)
        if (!got) {
          base = this.ep.baseOf(a.base) ? a.base : null;
          if (!base) throw new SdkError('server_rejected', 'the lease answer names no base on a host of Quran Lab for the files', { stage: 'lease', ...hf, why: 'invalid' });
          // the manifest (from this base, or stored) before the Core takes the lease: it checks the lease against it
          man = await this._manifest(src, base);
          if (this._closed) throw new SdkError('download_failed', 'the client was closed', { stage: 'lease', why: 'cancelled' });
          if (this._stoppedSince(stops)) throw this._stopNow();
          try { got = await this.core.leaseAccept(leaseBytes, man.bytes, src.build); } catch (e) {
            const err = this._coreError(e, 'the lease was refused by the Core');
            throw Object.assign(err, { leaseCause: err.leaseCause || (e.status === QLC.E_NEEDS_CONNECTION ? 'expired' : 'other') });
          }
          this._tookLease(src, a, base, man, got, leaseBytes);
        }
        await this._bounded(this._leaseSaving);
        return this.leaseInfo;
      }
      // the server cannot answer now (a 5xx, 503 lease_unavailable with Retry-After when a dependency is down, or a
      // 429): never a refusal. Nothing goes to the Core (the piece in force stays: the server checked no proof), the
      // refresh asks again after Retry-After (_scheduleRefresh), and a kept lease or the offline grace goes on
      if (r.status >= 500 || r.status === 429) {
        throw new SdkError('download_failed', `Quran Lab's server answered ${r.status}${a.error ? ` ${a.error}` : ''} for the lease; the SDK tries again`,
          { stage: 'lease', ...hf, why: r.status === 429 ? 'rate_limited' : a.error === 'lease_unavailable' ? 'lease_unavailable' : 'http', http_status: r.status, ...(typeof a.error === 'string' ? { error_code: a.error } : {}),
            retryAfter: retryAfterS(r.retryAfter, a.error), ...(r.held ? { held: true } : {}) });
      }
      // every refusal body goes to the Core: a signed stop it verifies clears its lease and the device-form files
      // (18.4.10); any other refusal while a new data piece is in force sends it back to the last good piece for the
      // next ask (18.6.7)
      let stopped = false;
      if (r.status >= 400 && r.text) {
        try { stopped = this.core.refusalAccept(r.text, certField(ql.installCert, 'key') || ''); } catch (_) { stopped = false; }
        if (!stopped) this._persist(); // the Core went back to its last good piece by its own rule: kept
      }
      if ((r.status === 401 || r.status === 403) && typeof a.signed === 'string') {
        const err = new PlatformError(r.status, a.error || 'invalid_key', a.message || '');
        err.reason = a.reason;
        if (stopped) { ql._refusal(err); await this._purge({ stop: true }); throw Object.assign(this._stopError(err), { attempt: 'stop' }); }
        throw Object.assign(new SdkError('server_rejected', `the lease route refused: ${a.error} (an unsigned or unverified stop changes nothing)`, { stage: 'lease', ...hf, why: 'refused', http_status: r.status, error_code: a.error }), { attempt: refusal });
      }
      if (r.status === 401 && a.error === 'install_cert_invalid' && !renewedCert) { renewedCert = true; await ql.reattest(); continue; }
      if (r.status === 401 && a.error === 'challenge_invalid' && !renewedChallenge) { renewedChallenge = true; continue; }
      if (r.status === 401 && a.error === 'invalid_token' && !renewedToken) { renewedToken = true; ql._token = null; continue; }
      // (a stored certificate the server no longer counts as a pass, too: a token is asked for now)
      if (r.status === 403 && (a.error === 'turnstile_required' || a.error === 'turnstile_failed') && !freshTurnstile && this.o.turnstile) { freshTurnstile = true; this.turnstilePassed = false; continue; }
      // a proof refused (the Core's digest under the piece in force): one more ask, under the piece the Core falls back to
      if (r.status === 403 && a.error === 'lease_integrity_failed' && a.why === 'core' && askedUnder && !proofAgain) { proofAgain = true; continue; }
      if (r.status === 403 && a.error === 'sdk_too_old') throw Object.assign(new SdkError('sdk_too_old', a.min_sdk ? `this key needs SDK ${a.min_sdk}` : 'the Core release is not served', { stage: 'lease', ...hf, why: 'refused', http_status: 403, error_code: 'sdk_too_old' }), { attempt: 'refused' });
      if (r.status === 404 && a.error === 'build_unknown') { await ql.refreshConfig().catch(() => {}); throw Object.assign(new SdkError('model_unavailable', 'the build is not leased; the config is refreshed', { stage: 'lease', ...hf, why: 'http', http_status: 404, error_code: 'build_unknown' }), { attempt: 'refused' }); }
      // 18.4.10: a 403 lease_integrity_failed names the failed check; the developer's message says it, the report's
      // error_code is why:check (ERRORS_40.md 24.3, contract 69326fb); the code stays server_rejected
      if (r.status === 403 && a.error === 'lease_integrity_failed') {
        throw Object.assign(new SdkError('server_rejected', integrityDetail(a.why, a.check),
          { stage: 'lease', ...hf, why: 'integrity_failed', http_status: 403, error_code: integrityCode(a.why, a.check) || 'lease_integrity_failed' }), { leaseCause: 'refused', attempt: refusal });
      }
      // ERRORS_40.md 24.4: no answer is needs_connection; a server's 5xx or 429 is download_failed, naming it
      if (r.status === 0) throw Object.assign(new SdkError('needs_connection', 'no lease now (no answer); the SDK tries again', { stage: 'lease', ...hf, why: 'network' }), { attempt: 'unreachable' });
      throw Object.assign(new SdkError('server_rejected', `the lease route answered ${r.status} ${a.error || ''}`.trim(), { stage: 'lease', ...hf, why: refusal === 'refused' ? 'refused' : 'invalid', http_status: r.status, ...(a.error ? { error_code: String(a.error) } : {}) }),
        { leaseCause: /turnstile|install_cert|attestation/.test(String(a.error)) ? 'attestation' : 'refused', attempt: refusal });
    }
    throw Object.assign(new SdkError('server_rejected', 'no lease after the repeats the contract allows', { stage: 'lease', why: 'invalid' }), { attempt: 'refused' });
  }

  // 28.3 and 28.5: a host's lease answer is taken only when it is one of 18.4.5 (a base on a host of the allow-list,
  // 28.4) and the Core accepts its lease; else that host is unreachable and the next api host is asked the same
  // request. The manifest is read from the base first (the Core checks the lease against it); a manifest that cannot
  // be had ends the attempt with that failure.
  async _leaseAnswer(res, status, src, stops = this._stopGen) {
    if (status !== 200) return null;
    let a;
    try { a = JSON.parse(await res.text()); } catch (_) { return null; }
    if (!a || typeof a !== 'object' || typeof a.lease !== 'string' || !this.ep.baseOf(a.base)) return null;
    const man = await this._manifest(src, a.base);
    if (this._closed) return null; // (4.0.2: the Core is gone with the close)
    // (4.0.2: a stop came while the request was in flight: the answer ends the request here, never asked of another
    // host and never handed to the Core)
    if (this._stoppedSince(stops)) throw this._stopNow();
    const leaseBytes = unb64u(a.lease);
    let got;
    try { got = await this.core.leaseAccept(leaseBytes, man.bytes, src.build); } catch (_) { return null; }
    // 4.0.2: the lease is the Core's from here: kept at once, before anything else waits (a page closed or a close()
    // after this point keeps it)
    this._tookLease(src, a, a.base, man, got, leaseBytes);
    return { base: a.base, man, got };
  }

  /**
   * A lease the Core has just accepted (18.4.5), in the same step, with no wait before the save starts: the answer's
   * install certificate, its data piece (spec fix 16: right after the accept, always; the Core keeps it pending in its
   * saved state and puts it in force at the next model open; one that does not verify changes nothing), the frame's
   * lease facts, the end of the row of failures (18.4.7.3) and the next refresh from this lease's refresh_after; then
   * the save (_persist, as `_leaseSaving`), so a page closed or a close() at any later point keeps this lease (4.0.2:
   * before, the save came after more waits, and a close() between lost it).
   */
  _tookLease(src, a, base, man, got, leaseBytes) {
    if (typeof a.install_cert === 'string') this.ql.installCert = a.install_cert;
    if (typeof a.piece === 'string') {
      try { this.core.piece(unb64u(a.piece)); } catch (_) { /* nothing changes */ }
    }
    // the Core's clock is the lease's anchor now: its offset from the device clock is kept with the lease, for the
    // set-back clock rule of lease-store.js
    let anchorD = null;
    try { anchorD = this.core.tick().now - this._wall() / 1000; } catch (_) { anchorD = null; }
    this.leaseInfo = { exp: got.exp, refreshAfter: got.refreshAfter, iat: leaseIat(leaseBytes, got.exp), base, build: src.build, man, eph: this.core.eph(leaseBytes), anchorD,
      src: { build: src.build, version: src.version, modelId: src.modelId, keyId: src.keyId, pin: null } };
    this._setRow(0, 0);
    this._scheduleRefresh(src);
    this._leaseSaving = this._save();
  }

  // the device's wall clock as the Core reads it (ms)
  _wall() { return this.o.coreClock && typeof this.o.coreClock.wall === 'function' ? this.o.coreClock.wall() : this.clock(); }

  // the lease the Core holds, when it is for this build and still valid: this page's, or one kept from an earlier page
  // load (lease-store.js), which is refreshed in the background from its refresh_after like any other (18.4.7)
  async _heldLease(src) {
    const li = this.leaseInfo;
    if (!li || li.build !== src.build) return null;
    let valid = false;
    try { valid = this.core.tick().valid; } catch (_) { valid = false; }
    if (!valid) return null;
    if (!li.man) li.man = await this._manifest(li.src || src, li.base);
    if (!this._refreshTimer) this._scheduleRefresh(li.src || src);
    return li;
  }

  // the lease an open or a prefetch uses: the held one while valid; past its exp, a new one or its grace
  // (_expiredLease); else a new one
  async _leaseFor(src) {
    const held = await this._heldLease(src);
    if (held) return held;
    const li = this.leaseInfo;
    let st = null;
    try { st = this.core.tick(); } catch (_) { st = null; }
    if (li && li.build === src.build && st && st.hasLease && !st.stopped && !st.valid) return this._expiredLease(src);
    // no lease held: an attempt that got no HTTP answer at all is needs_connection (ERRORS_40.md 24.4 rule 1), never the
    // raw fetch failure (a TypeError, which read as invalid_argument: Stage B 11-18, the Node path offline with its
    // stored config and a device clock set back, so the lease store handed no state back); an answer keeps its code
    return this._lease(src).catch((e) => { throw noAnswer(e) ? leaseError(e, { held: false }) : e; });
  }

  _coreError(e, what) {
    if (!(e instanceof CoreError)) return e;
    if (e.status === QLC.E_LEASE && e.detailName === 'site') {
      return Object.assign(new SdkError('server_rejected', `${what}: the lease names another site than the one this page is on`, { stage: 'lease', why: 'refused', error_code: 'site' }), { leaseCause: 'refused' });
    }
    // the error reports' stage and reason of each Core status (ERRORS_40.md 24.3); error_code is the Core's status
    const at = (stage, reason) => ({ stage, why: reason, error_code: String(e.status) });
    if (e.status === QLC.E_NEEDS_CONNECTION) return new SdkError('needs_connection', `${what}: the lease has expired`, at('lease', 'expired'));
    if (e.status === QLC.E_STOPPED) return new SdkError('invalid_key', `${what}: stopped`, at('lease', 'refused'));
    if (e.status === QLC.E_FILE || e.status === QLC.E_MANIFEST) return new SdkError('model_invalid', `${what} (${e.message})`, at('model_open', 'invalid'));
    if (e.status === QLC.E_STORAGE) {
      // R402-3: the store's failure the Core's guard kept (stores.js tags it): a full store is storage_full, and
      // error_code names the store's call (opfs_write, ...); without one, the Core's status as before
      const t = (e.cause && e.cause.qlReport) || null;
      const full = (t && t.reason === 'quota') || (!!e.cause && e.cause.name === 'QuotaExceededError');
      // R402-4 (b): with none, the Core call and its detail, and the callback that answered a failure without an error
      // (the field's bare "-3" said neither)
      const named = `${e.where || 'qlc'}:${e.detail | 0}${e.hostOp ? `:${e.hostOp}` : ''}`.slice(0, 32);
      return new SdkError(full ? 'storage_full' : 'storage_failed', `${what} (${e.message})`,
        { stage: 'storage', why: full ? 'quota' : 'write', error_code: t && t.error_code ? t.error_code : named, ...(e.cause ? { cause: e.cause } : {}) });
    }
    if (e.status === QLC.E_KEYSTORE) return new SdkError('engine_failed', `${what}: the key store (${e.message})`, at('storage', 'read'));
    // a status the model open fails with, as errors_40.json core_open names it (24.3): busy, no memory, the engine or an
    // argument told apart in the report's reason and error_code (Gate C, 11-20: Android's engine_failed hid which)
    const co = CORE_OPEN[e.status];
    if (co) return new SdkError('engine_failed', `${what} (${e.message})`, { stage: 'model_open', why: co[0], error_code: co[1] });
    return new SdkError('engine_failed', `${what} (${e.message})`, at('model_open', /memory|alloc/i.test(String(e.message)) ? 'memory' : 'engine'));
  }

  /** 18.4.7.3 (4.0.2): the row of failed lease attempts and its next attempt, kept in the SDK's state (28.11 item 3: read
   * back at the next start by init) */
  _setRow(n, at) {
    this.leaseRow = { n, at };
    try { if (this.state) this.state.set('lease.row', n ? { n, at } : null); } catch (_) { /* this process only */ }
  }

  // the lease is refreshed in the background after refresh_after (18.4.7), with the backoff of 18.4.7.3 after failures;
  // a valid lease never waits
  _scheduleRefresh(src) {
    if (this._refreshTimer) this.timers.clearTimeout(this._refreshTimer);
    const li = this.leaseInfo;
    // refresh_after is a time of the Core's clock (anchored at the lease's iat, the server's time, 18.4.7), so it is
    // compared with that clock and never with the device's (with the device's, a clock days ahead asked for a new
    // lease at once and again after every new lease, and one days behind waited days past the time)
    let now;
    try { now = this.core.tick().now; } catch (_) { now = this.clock() / 1000; }
    // after failures: the row's time (18.4.7.3: a fresh draw in [600, 1800] s, a Retry-After only as its floor), however
    // the attempt that failed was made (a refresh, a model open, an app's call with no lease), in this process or before
    const wait = !this.leaseRow.n ? Math.max(0, li.refreshAfter - now) : Math.max(0, (this.leaseRow.at - this.clock()) / 1000);
    this.lastRefreshWaitS = wait;
    this._refreshTimer = this.timers.setTimeout(async () => {
      try { await this._lease(src); } catch (e) {
        if (this.ql.modelRefusal) return;
        this._scheduleRefresh(src);
      }
    }, Math.min(wait, 2 ** 31 / 1000 - 1) * 1000);
    if (this._refreshTimer && typeof this._refreshTimer.unref === 'function') this._refreshTimer.unref();
  }

  // the entries a model of `context` needs, by decoded path
  _needed(m, context, { recited }) {
    return m.files.filter((f) => {
      if (f.context !== '*' && f.context !== context) return false;
      if (f.role === 'calibration') return f.encoding !== 'gzip' || canInflate(); // (data: the model opens without it)
      if (f.role === 'recited') return recited;
      return ENGINE_ROLES.has(f.role);
    });
  }

  _recitedOn() {
    const flags = this.ql.flags || {};
    return this.ql.telemetry.enabled && flags.analytics !== false && flags.recited !== false;
  }

  // the entries of `context` not stored yet: an encrypted entry's device form, a plain entry's file
  async _missing(man, context) {
    const todo = [];
    for (const f of this._needed(man.m, context, { recited: this._recitedOn() })) {
      const dec = storedPath(f);
      const form = f.encoding === 'qle1' ? QLC.FORM_DEVICE : QLC.FORM_PLAIN;
      if (await this.o.files.has(form, dec)) continue;
      todo.push(f);
    }
    return todo;
  }

  /**
   * 4.0.1: a build's files FILE_LANES at a time on the models host the order chose, the largest first, so the small
   * files come while the weights do instead of before them. Each file is one request as before (SPEC 16.2, its
   * resumes and pauses its own; one stream per file: 16.3, ranges in parallel are not faster). After a failure no
   * other file is started; the ones in flight end, then the first failure is the call's.
   */
  async _lanes(files, one) {
    const queue = [...files].sort((a, b) => b.size - a.size);
    let failed = null;
    const lane = async () => {
      while (queue.length && !failed) {
        const f = queue.shift();
        try { await one(f); } catch (e) { if (!failed) failed = e; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FILE_LANES, queue.length) }, lane));
    if (failed) throw failed;
  }

  // the progress of files fetched side by side: the bytes of the files done and of each file in flight (never back)
  _progress(todo, done0, onProgress) {
    const total = todo.reduce((n, f) => n + f.size, 0);
    const inflight = new Map();
    let done = done0, last = 0;
    const tell = () => {
      if (!onProgress) return;
      let n = done;
      for (const v of inflight.values()) n += v;
      if (n < last) return;
      last = n;
      onProgress({ bytesDone: n, bytesTotal: total });
    };
    return {
      of: (f) => (onProgress ? (n) => { inflight.set(f.path, n); tell(); } : null),
      done: (f) => { inflight.delete(f.path); done += f.size; tell(); },
    };
  }

  // One entry downloaded and stored as it came: an encrypted entry's CDN form (ciphertext, installed later by the
  // Core), a plain entry as the file. The bytes stored, or an error. The stores' puts go one at a time (files fetched
  // side by side, _lanes: a store writes its index after each put)
  async _fetchEntry(base, f, { onBytes = null, cancel = null } = {}) {
    // 4.0.2 (SPEC 16.7): the CDN form an early fetch stored before its lease failed to come (_preKeep), checked again
    // against the signed manifest, is used with no request (0 bytes downloaded); one that is not the signed bytes is
    // fetched again and replaced
    if (f.encoding === 'qle1') {
      const had = await this.o.files.get(QLC.FORM_CDN, f.decoded.path).catch(() => null);
      if (had && had.length === f.size && (await sha256Hex(had)) === String(f.sha256).toLowerCase()) return 0;
    }
    const bytes = await this._get(base + f.path.split('/').map(encodeURIComponent).join('/'), { onProgress: onBytes, size: f.size, keep: f.path, cancel });
    // the container as the signed manifest names it (16.1): its size and SHA-256. Kept blocks that made a file that
    // is not the signed bytes are dropped, so the next call downloads it whole
    const good = bytes.length === f.size && (await sha256Hex(bytes)) === String(f.sha256).toLowerCase();
    await this._dropBlocks(f.path);
    if (!good) throw new SdkError('checksum_mismatch', `${f.path}: not the signed bytes`, { stage: 'download', why: 'hash' });
    if (f.encoding === 'qle1') await this._serial(() => this.o.files.put(QLC.FORM_CDN, f.decoded.path, bytes));
    else await this._putPlain(f, bytes);
    return bytes.length;
  }

  // the download's writes to the file store one at a time (files fetched side by side, _lanes): a store writes its
  // index after each put or drop, and two at once could leave one out of the index kept for the next page load
  _serial(op) {
    const p = (this._writes || Promise.resolve()).then(op, op);
    this._writes = p.catch(() => {});
    return p;
  }

  /**
   * The build's model folder, made from the signed config as every lease answer makes it (18.4.5: MODEL_BASE's path
   * /models, then the config's model, the build and its folder), on the first models host (a test build's stand-in),
   * or null when the config does not name them. Its requests go through the models order like every model request
   * (28.4, endpoints_40.json first_manifest). Used only by the early fetch below; the lease answer's base stays the one
   * that counts.
   */
  _predictedBase(src) {
    const rec = this.ql.config && this.ql.config.recommended;
    if (!rec || rec.revision !== src.build) return null;
    const model = String(rec.model || ''), folder = String(rec.folder || '').replace(/^\/+|\/+$/g, '');
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(model)) return null;
    if (!folder || folder.split('/').some((s) => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(s))) return null;
    const base = `${(this.ql.modelsUrl || MODELS_URL).replace(/\/+$/, '')}/${model}/${src.build}/${folder}/`;
    return this.ep.modelTarget(base) ? base : null;
  }

  /**
   * 4.0.1: a fresh install (no lease of this build held) fetches the signed manifest and the ciphertext while its
   * lease is asked and Turnstile runs, instead of after: the lease is needed to install, not to fetch. From the
   * build's model folder (_predictedBase), each file checked against the signed manifest and stored as it came (the
   * CDN form of an encrypted entry); nothing is installed here: the Core turns a CDN form into its device form only
   * once it holds the lease (18.2.1). The bytes are used only when the lease answer names this same base (_preJoin);
   * a lease that names another, that is refused or that stops the model drops everything this fetched (_preDrop).
   * From 4.0.2 (SPEC 16.7) a lease that is only unreachable (no answer, a stall, a 5xx, a 429, 503 lease_unavailable)
   * keeps what verified (_preKeep): ciphertext the page cannot open without a lease, used by the next call with no
   * request (4.0.1 dropped it, and the next call asked every file again). Returns null when nothing is fetched early.
   */
  _preStart(src, onProgress = null) {
    if (this.leaseInfo && this.leaseInfo.build === src.build) return null;
    const base = this._predictedBase(src);
    if (!base) return null;
    const pre = { base, build: src.build, entries: [], inflight: new Set(), bytes: 0, manStored: false, cancel: { on: false, hooks: new Set() },
      dl0: this.dl ? { ...this.dl } : { resumes: 0, keptBlocks: 0 }, arrived: false, kept: false };
    pre.done = (async () => {
      const had = this.state.get(`manifest:${src.build}`) !== null;
      const man = await this._manifest(src, base);
      pre.manStored = !had;
      const todo = await this._missing(man, this._context(man.m, null));
      const progress = this._progress(todo, 0, onProgress);
      pre.kept = await this._anyKept(todo);
      await this._lanes(todo, async (f) => {
        if (pre.cancel.on) return;
        pre.inflight.add(f);
        try {
          // (the count after the await: `x += await` reads x before the lanes beside it add to it, and a slow file
          // put back what they had added; 4.0.1 under-counted prefetch()'s bytesDone that way)
          const n = await this._fetchEntry(base, f, { onBytes: arrived(pre, progress.of(f)), cancel: pre.cancel });
          pre.bytes += n;
        } catch (e) {
          // a file that failed (after its resumes, SPEC 16): the call's error once the lease is in (_preJoin), as if
          // it had been asked after the lease; its kept blocks stay for the next call
          if (!pre.error) pre.error = e;
          throw e;
        } finally { pre.inflight.delete(f); }
        pre.entries.push(f);
        progress.done(f);
      });
    })();
    pre.done.catch(() => {});
    return pre;
  }

  // the early fetch for the lease's base, once it has ended: what it stored is used, and a file it could not get is
  // the call's error (one call asks a file at most six times, SPEC 16, early or not). Another base: nothing of it is
  // kept (null). A manifest it could not get is no error: the lease's own ask for it decided.
  async _preJoin(pre, base) {
    if (!pre) return null;
    // the same folder on any models host is the same files (28.4: the folder is the base's path; every file is held
    // to the signed manifest): a lease from a backup host's API naming its own model host keeps the early bytes
    const folder = (u) => { const t = this.ep.modelTarget(u); return t ? t.path : null; };
    if (folder(pre.base) === null || folder(pre.base) !== folder(base)) { await this._preDrop(pre); return null; }
    await pre.done.catch(() => {});
    this.state.set(`early:${pre.build}`, null); // (4.0.2) what an early fetch kept is this lease's now
    // R402-4 (a): the early fetch's write failed as an install's would: the page load goes on in memory, and the call's
    // install asks for every file again there
    if (pre.error && this._toMemory(pre.error)) return null;
    if (pre.error) throw this._noAnswer(pre.error, pre.arrived || pre.entries.length > 0 || pre.kept);
    return pre;
  }

  // the early fetch stopped and everything it stored dropped: its files (CDN forms, plain files), the blocks of the
  // file it was fetching, and the manifest when it was the one that stored it. 4.0.2: and what an early fetch of this
  // build kept before (_preKeep: every CDN form and kept block of its files, and its manifest)
  async _preDrop(pre) {
    if (!pre) return;
    pre.cancel.on = true;
    for (const h of [...pre.cancel.hooks]) { try { h(); } catch (_) { /* gone */ } }
    await pre.done.catch(() => {});
    for (const f of pre.entries) {
      await this.o.files.drop(f.encoding === 'qle1' ? QLC.FORM_CDN : QLC.FORM_PLAIN, storedPath(f)).catch(() => {});
    }
    for (const f of pre.inflight) await this._dropBlocks(f.path).catch(() => {});
    pre.inflight.clear();
    const keptBefore = this.state.get(`early:${pre.build}`) === true;
    if (keptBefore) {
      let m = null;
      try { m = JSON.parse(this.state.get(`manifest:${pre.build}`)); } catch (_) { m = null; }
      for (const f of (m && Array.isArray(m.files) ? m.files : [])) {
        if (f.encoding === 'qle1') await this.o.files.drop(QLC.FORM_CDN, f.decoded.path).catch(() => {});
        else await this.o.files.drop(QLC.FORM_PLAIN, plainPath(f)).catch(() => {});
        await this._dropBlocks(f.path).catch(() => {});
      }
      this.state.set(`early:${pre.build}`, null);
    }
    if (pre.manStored || keptBefore) this.state.set(`manifest:${pre.build}`, null);
    pre.entries = [];
    await this.state.flush().catch(() => {});
  }

  // 4.0.2 (SPEC 16.7): the lease is only unreachable: the early fetch stops (a file in flight keeps its whole blocks)
  // and what it stored stays: the files that verified against the signed manifest (ciphertext the page cannot open
  // without a lease) and the manifest, marked as an early fetch's (early:<build>) so a refusal, a stop or a lease that
  // names another folder still drops all of it (_preDrop)
  async _preKeep(pre) {
    if (!pre) return;
    pre.cancel.on = true;
    for (const h of [...pre.cancel.hooks]) { try { h(); } catch (_) { /* gone */ } }
    await pre.done.catch(() => {});
    pre.inflight.clear();
    this.state.set(`early:${pre.build}`, true);
    await this.state.flush().catch(() => {});
  }

  async _ensureFiles(base, man, context, onProgress, pre = null) {
    try { return await this._ensureFilesIn(base, man, context, onProgress, pre); } catch (e) {
      if (!this._toMemory(e)) throw e;
      // R402-4 (a): the page load goes on in memory; what OPFS held (an early fetch's files) is not there: asked again
      return this._ensureFilesIn(base, man, context, onProgress, null);
    }
  }

  /**
   * R402-4 (a): an install's OPFS write failed for a reason other than another page holding the file (memoryFallbackOf):
   * the frame's file store is memory for the rest of the page load (the Core's view too), and that is said once,
   * silently, as a failed OPFS probe is (storage/unavailable, error_code the call, error_name its error). False when
   * the failure is not one, or the page load is in memory already.
   */
  _toMemory(e) {
    const why = memoryFallbackOf(e);
    if (!why || !this.o.files || this.o.files.kind !== 'opfs') return false;
    const old = this.o.files;
    const mem = new MemoryFiles();
    mem.onFailure = old.onFailure || null;
    mem.unavailable = why;
    this.o.files = mem;
    if (this.files) this.files.f = mem;
    Promise.resolve().then(() => old.close()).catch(() => {});
    try { this.ql._silent('storage', 'unavailable', why); } catch (_) { /* never in the way */ }
    return true;
  }

  async _ensureFilesIn(base, man, context, onProgress, pre = null) {
    const todo = await this._missing(man, context);
    const stats = { bytesDownloaded: 0, installMs: 0, files: 0 };
    // what the early fetch stored (from this lease's base, already checked) is not asked again
    const ready = new Set(pre ? pre.entries.map((f) => f.path) : []);
    const progress = this._progress(todo, todo.filter((f) => ready.has(f.path)).reduce((n, f) => n + f.size, 0), onProgress);
    if (pre) stats.bytesDownloaded += pre.bytes;
    const dl0 = pre ? pre.dl0 : this.dl ? { ...this.dl } : { resumes: 0, keptBlocks: 0 };
    // 24.4 rule 1 (4.0.2): whether part of these files is on the device (blocks an earlier call kept, a file the early
    // fetch stored) or arrived in this call; a call that has none of it and gets no answer is needs_connection
    const seen = { arrived: !!(pre && (pre.arrived || pre.entries.length)), kept: !!(pre && pre.kept) || await this._anyKept(todo.filter((f) => !ready.has(f.path))) };
    try {
      await this._lanes(todo.filter((f) => !ready.has(f.path)), async (f) => {
        const n = await this._fetchEntry(base, f, { onBytes: arrived(seen, progress.of(f)) });
        stats.bytesDownloaded += n;
        seen.arrived = true;
        progress.done(f);
      });
    } catch (e) { throw this._noAnswer(e, seen.arrived || seen.kept); }
    // CDN form to device form, the plaintext SHA-256 checked once (18.2.4); the CDN form is dropped after
    const t0 = this.clock();
    for (const f of todo.filter((x) => x.encoding === 'qle1')) {
      await this.o.files.open([[QLC.FORM_DEVICE, f.decoded.path]]);
      try { this.core.install(man.bytes, f.decoded.path); } catch (e) { throw this._coreError(e, `install of ${f.decoded.path}`); } finally { await this.o.files.close(); }
      await this.o.files.drop(QLC.FORM_CDN, f.decoded.path);
      stats.files++;
    }
    stats.installMs = this.clock() - t0;
    // the requests asked again inside the call and the blocks an earlier call kept (the day's delivery health)
    const dl = this.dl || dl0;
    stats.rangesResumed = (dl.resumes - dl0.resumes) + (dl.keptBlocks - dl0.keptBlocks);
    return stats;
  }

  _context(m, app) {
    if (app !== undefined && app !== null) {
      if (!m.contexts.includes(app)) throw new SdkError('invalid_argument', `unknown context ${JSON.stringify(app)}; this model has ${m.contexts.join(', ')}`);
      return app;
    }
    const c = this.ql.config && this.ql.config.inference && this.ql.config.inference.context;
    return typeof c === 'string' && m.contexts.includes(c) ? c : m.default_context;
  }

  /** client.model(version): the model's public facts, the engine opened and warmed. */
  async openModel({ version = null } = {}) {
    if (version !== null && !MODEL_VERSION_RE.test(version)) throw new SdkError('invalid_argument', `version ${JSON.stringify(version)} is not a model version (x.y.z)`);
    const t0 = this.clock();
    this._refused();
    const src = await this._source(version);
    if (this.model) this.closeModel();
    const { li, pre } = await this._leaseWithFiles(src, null);
    const man = li.man, base = li.base;
    const context = this._context(man.m, null);
    const stats = await this._ensureFiles(base, man, context, null, pre);
    const recited = this._recitedOn() && man.m.files.some((f) => f.role === 'recited');
    this.recitedReady = false;
    if (recited) {
      await this.o.files.open();
      try { this.core.recitedIndex(man.bytes); this.recitedReady = true; } catch (_) { this.recitedReady = false; } finally { await this.o.files.close(); }
    }
    this.model = { src, man, base, context: null, rate: 0, pin: src.pin || null };
    await this._open(context, 16000);
    // an open in the lease's grace: said once per open (ERRORS_40 24.1, silent: the page gets no error)
    const graceUntil = li.grace ? li.grace.until : null;
    if (li.grace) { this._reportGrace(li); li.grace = null; }
    this._warm();
    const cal = this.core.calibration();
    const calEntry = man.m.files.find((f) => f.role === 'calibration');
    const loadMs = this.clock() - t0;
    this.ql.modelOpened({ revision: man.m.version, build: src.build, context, backend: 'cpu' }, { loadMs, delivery: { bytesDownloaded: stats.bytesDownloaded, rangesResumed: stats.rangesResumed || 0 } });
    await this._recover();
    await this.state.flush();
    await this._persist(); // the open moved the piece rule on (a pending piece in force): the Core's state, kept
    // the vocabulary from the Core (R4), else the known V4 one by the manifest's tokens_sha256
    const tokens = this.core.tokenNames() || KNOWN_VOCABULARIES[String(man.m.tokens_sha256).toLowerCase()] || null;
    const clips = await this._clipList(man);
    return {
      id: man.m.model_id, version: man.m.version, build: src.build, contexts: [...man.m.contexts], defaultContext: context,
      chunkMs: Object.fromEntries(man.m.contexts.map((c) => [c, contextChunk(c)])), tokens, tokensSha256: man.m.tokens_sha256,
      calibration: cal ? { text: fromUtf8(cal), sha256: calEntry ? plainSha(calEntry) : await sha256Hex(cal) } : null,
      clips, pin: src.pin || null, loadMs, installMs: stats.installMs, bytesDownloaded: stats.bytesDownloaded,
      lease: { exp: li.exp, refreshAfter: li.refreshAfter, kept: li.restored === true, graceUntil }, engine: this.core.version, recited: this.recitedReady,
      reference: man.m.files.some((f) => f.role === 'reference'),
    };
  }

  async _open(context, rate) {
    const md = this.model;
    if (this.core.model && md.context === context && md.rate === rate) return;
    if (this.core.model) this.core.closeModel();
    if (md.context !== context) await this._ensureFiles(md.base, md.man, context, null);
    await this.o.files.open();
    try { this.core.openModel(md.man.bytes, { context, sampleRate: rate, threads: this.o.threads || 0 }); } catch (e) {
      throw this._coreError(e, 'the model could not be opened');
    } finally { await this.o.files.close(); }
    md.context = context;
    md.rate = rate;
  }

  // one chunk of silence through the engine, so the first take starts at once
  _warm() {
    this.core.startStream(1, () => {});
    try { this.core.push(new Float32Array(Math.ceil((this.model.rate * Math.max(320, this.core.chunkMs())) / 1000) * 2)); } finally { this.core.endStream(); }
  }

  /**
   * A plain entry's bytes as downloaded (checked against its signed size and SHA-256 already) kept on the device: a
   * gzip one inflated and checked against its signed `decoded` size and SHA-256, at its decoded path (plainPath); a copy
   * an older version kept under the stored path is dropped. Returns the plain bytes.
   */
  async _putPlain(f, bytes) {
    let plain = bytes;
    if (f.encoding === 'gzip' && f.decoded) {
      try { plain = await gunzip(bytes); } catch (e) { throw new SdkError('checksum_mismatch', `${f.path}: not a gzip file (${(e && e.message) || e})`, { stage: 'download', why: 'hash' }); }
      if (plain.length !== f.decoded.size || (await sha256Hex(plain)) !== plainSha(f)) {
        throw new SdkError('checksum_mismatch', `${f.path}: its plain bytes are not the signed ones`, { stage: 'download', why: 'hash' });
      }
    }
    await this._serial(async () => {
      await this.o.files.put(QLC.FORM_PLAIN, plainPath(f), plain);
      if (plainPath(f) !== f.path) await this.o.files.drop(QLC.FORM_PLAIN, f.path).catch(() => {});
    });
    return plain;
  }

  /** A plain entry's plain bytes: the device's copy, else downloaded from the open model's base and kept (_putPlain). */
  async _plainFile(f) {
    const had = await this.o.files.get(QLC.FORM_PLAIN, plainPath(f)).catch(() => null);
    if (had) return had;
    const b = await this._get(this.model.base + f.path.split('/').map(encodeURIComponent).join('/'));
    if (b.length !== f.size || (await sha256Hex(b)) !== String(f.sha256).toLowerCase()) {
      throw new SdkError('checksum_mismatch', `${f.path}: not the signed bytes`, { stage: 'download', why: 'hash' });
    }
    return this._putPlain(f, b);
  }

  async _clipList(man) {
    const entry = man.m.files.find((f) => f.encoding !== 'qle1' && plainPath(f) === 'selftest/selftest.json');
    if (!entry) return [];
    try {
      const st = JSON.parse(fromUtf8(await this._plainFile(entry)));
      return (Array.isArray(st.clips) ? st.clips : []).filter((c) => typeof c.id === 'string' && c.sample_rate > 0 && man.m.files.some((f) => f.encoding !== 'qle1' && plainPath(f) === `selftest/${c.file}`))
        .map((c) => ({ name: c.id, kind: String(c.kind || 'clean'), durationMs: Math.round((1000 * c.samples) / c.sample_rate), file: c.file, sampleRate: c.sample_rate }));
    } catch (_) { return []; }
  }

  /**
   * One ayah's expected units (R3, SPEC 13.7): { units, words, wordCount }, or null for an ayah the table does not have.
   * The Core reads the build's reference file at the first call after each open of its model, so the files are open
   * around the call as around the install and the model open: with them closed OPFS reads nothing, and the Core marks
   * the reference failed for the life of that model (web 4.0.0: reference_missing in every browser with OPFS; Gate C, 11-20).
   * Once the table is in the Core's memory (core.referenceLoaded) a call reads no file, so the files stay closed: in
   * OPFS each open takes every committed file's handle, which costs 30 to 55 ms a call and locks the files against
   * another page of the site. A file another page holds past the store's wait is never handed to the Core: the call
   * fails now (reference_missing, the files busy) and the next one reads the table, where the Core would have kept
   * the failed read for the life of the model.
   */
  async reference({ surah, ayah }) {
    if (!this.model) throw new SdkError('model_missing', 'no model is open');
    if (!Number.isInteger(surah) || surah < 1 || surah > 114 || !Number.isInteger(ayah) || ayah < 1) throw new SdkError('invalid_argument', 'surah and ayah are positive whole numbers');
    const read = !this.core.referenceLoaded;
    if (read) {
      await this.o.files.open();
      if (this.o.files.busy && this.o.files.busy.length) {
        await this.o.files.close();
        throw new SdkError('reference_missing', 'the reference data is in use by another page of this site; ask again');
      }
    }
    try { return this.core.referenceExpected(surah, ayah); } catch (e) {
      if (e instanceof CoreError && e.status === QLC.E_FILE) throw new SdkError('reference_missing', e.message);
      throw this._coreError(e, 'the reference data');
    } finally { if (read) await this.o.files.close(); }
  }

  /** A sample clip's samples (a plain self-test file, public data). */
  async clipSamples(name) {
    const md = this.model;
    const clips = await this._clipList(md.man);
    const c = clips.find((x) => x.name === name);
    if (!c) throw new SdkError('invalid_argument', 'not a sample clip of this model');
    const path = `selftest/${c.file}`, e = md.man.m.files.find((f) => f.encoding !== 'qle1' && plainPath(f) === path);
    const b = await this._plainFile(e);
    const n = b.length >> 1, dv = new DataView(b.buffer, b.byteOffset, b.byteLength), out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getInt16(2 * i, true) / 32768;
    return { samples: out, sampleRate: c.sampleRate };
  }

  closeModel() {
    if (this.take) this.cancel();
    this._settleLast();
    this.state.flush().catch(() => {});
    if (this._refreshTimer) this.timers.clearTimeout(this._refreshTimer);
    this._refreshTimer = null; // the next open of the held lease schedules its refresh again (_heldLease)
    if (this.core.model) this.core.closeModel();
    this.model = null;
    this._persist();
  }

  // ------------------------------------------------------------------ takes (the 3.x engine host's calls)
  async warm({ context, sampleRate = 16000 }) { await this._open(context, sampleRate); return { chunkMs: this.core.chunkMs() }; }

  /** Start a take on `context` at `sampleRate`, computing `heads` (names). */
  async start({ context, sampleRate = 16000, heads = null }) {
    if (!this.model) throw new SdkError('model_missing', 'no model is open');
    if (this.take) this.cancel();
    await this._open(this._context(this.model.man.m, context), sampleRate);
    // the lease must still be valid at a take's start (18.4.7: a model open keeps running until it is closed)
    const names = heads || HEADS.map((h) => h[0]);
    const take = { id: this._nextTakeId(), out: [], report: null, recited: this.recitedReady && this._recitedOn(), samples: 0, rate: sampleRate,
      day: DayMath.utc(this.clock()) };
    this.core.startStream(headMask(names), (h) => take.out.push(h));
    if (take.recited) {
      // the take's record before the Core's: a kill at any later point finds it and counts the take once (17.6)
      this.state.set(`take:${take.id}`, { day: DayMath.utc(this.clock()), report: null });
      await this.state.flush();
      try { if (this.core.recitedBegin(take.id) === 1) take.recited = false; } catch (_) { take.recited = false; }
    }
    this.take = take;
    this._settleLast(); // a report after the next take starts is too late: the last take counts as it is
    await this.state.flush();
    return { chunkMs: this.core.chunkMs(), takeId: take.id };
  }

  _settleLast() {
    const t = this.lastTake;
    this.lastTake = null;
    if (t && !t.counted) this._count(t);
  }

  _nextTakeId() { const n = (this.state.get('take.next') || 1); this.state.set('take.next', n + 1); return n; }

  _takeOut(take) {
    const out = take.out;
    take.out = [];
    let frame0 = take.frames || 0;
    const chunks = out.map((h) => { const c = { index: 0, firstFrame: frame0, n40: h.n40, heads: h.heads }; frame0 += h.n40; return c; });
    take.frames = frame0;
    return chunks;
  }

  /** Audio in (mono float at the take's rate); the chunks it completed and the compute time. */
  async push(samples) {
    const take = this.take;
    if (!take) throw new SdkError('session_closed', 'no take is open');
    const t = now();
    this.core.push(samples);
    const computeMs = now() - t;
    take.samples += samples.length;
    if (take.recited && take.out.length) { try { this.core.recitedFeedStream(); } catch (_) { /* never in the way of a take */ } }
    return { chunks: this._takeOut(take), computeMs };
  }

  /** The end of the take: the last chunks; the take's recited range counted (17.1). */
  async finish() {
    const take = this.take;
    if (!take) throw new SdkError('session_closed', 'no take is open');
    const t = now();
    this.core.finish();
    const computeMs = now() - t;
    const chunks = this._takeOut(take);
    let measured = null;
    if (take.recited) {
      try { this.core.recitedFeedStream(); measured = this.core.recitedFinish(take.id); } catch (_) { measured = null; }
    }
    this.core.endStream();
    this.take = null;
    take.measured = measured;
    take.ended = true;
    take.counted = false;
    this._settleLast();
    this.lastTake = take;
    // with the app's report in hand the take counts now; without one it waits for a report until the next take
    // starts or the model or the client closes (17.1), its record kept for a kill meanwhile (17.6)
    if (take.report) this._count(take);
    await this.state.flush();
    return { chunks, computeMs, recited: measured ? { source: measured.found ? 'measured' : 'none' } : null };
  }

  async cancel() {
    if (this.take) {
      this.core.endStream();
      if (this.take.recited) this.state.set(`take:${this.take.id}`, null); // a cancelled take counts nothing
      this.take = null;
      await this.state.flush();
    }
    return {};
  }

  /** session.reportRecited: held with its take (before or after the take ends), counted once at finalise. */
  reportRecited({ takeId, surah, from, to, outcome = null, perAyah = null }) {
    const report = checkReport(surah, from, to, { outcome, perAyah });
    const take = this.take && this.take.id === takeId ? this.take : this.lastTake && this.lastTake.id === takeId ? this.lastTake : null;
    if (!take) return { counted: false };
    if (!take.ended) {
      take.report = report;
      if (take.recited) { const rec = this.state.get(`take:${take.id}`) || {}; this.state.set(`take:${take.id}`, { ...rec, report }); }
      return { held: true };
    }
    if (take.counted) return { counted: false };
    take.report = report;
    this._count(take);
    return { counted: true };
  }

  // one take into the day's totals and out of the take journal: one KV transaction (the caller flushes)
  _count(take) {
    if (take.counted) return;
    take.counted = true;
    const c = takeCounts(take.measured, take.report, this.session.seen);
    if (c.source === 'measured') {
      c.range = { surah: take.measured.surah, first: take.measured.first, last: take.measured.last };
      c.context = !!take.measured.context; // R5: the session context decided this take (recited_takes.context)
    }
    if (!take.day && take.measured && take.measured.day > 0) take.day = DayMath.utc(take.measured.day * 86_400_000);
    this.ql.telemetry.countTake(c, { repeatSeen: this.session.recited, detectorRan: !!take.recited, recovered: !!take.recovered, day: take.day || null });
    this.state.set(`take:${take.id}`, null);
    take.source = c.source;
  }

  // takes the page left open or finished but uncounted (a closed tab, a kill): finalised once (17.6)
  async _recover() {
    if (!this.recitedReady) return;
    const open = (() => { try { return this.core.recitedOpen(); } catch (_) { return null; } })();
    for (const k of [...this.state.m.keys()].filter((x) => x.startsWith('take:'))) {
      const id = Number(k.slice(5));
      const rec = this.state.get(k);
      let measured = null;
      try { measured = this.core.recitedFinish(id); } catch (_) { measured = null; }
      if (open !== null && open !== id) { /* another take is open: the Core finishes the one it holds below */ }
      this._count({ id, measured, report: rec && rec.report ? rec.report : null, counted: false, recovered: true, recited: true, day: rec && rec.day });
    }
    if (open !== null && !this.state.get(`take:${open}`)) { try { this.core.recitedFinish(open); } catch (_) { /* counted by the Core */ } }
    await this.state.flush();
  }

  /** The sharing sheet's counters, from the host page (share_asked, share_yes, share_no). */
  telemetryCount({ field, n = 1 }) {
    if (!['share_asked', 'share_yes', 'share_no'].includes(field) || !Number.isInteger(n) || n < 1 || n > 10) throw new SdkError('invalid_argument', `counter ${field}`);
    this.ql.telemetry.count(field, n);
    this.state.flush();
    return {};
  }

  /** analytics.reportChecks (validated by the loader). */
  reportChecks({ rule, checked, flagged }) { this.ql.telemetry.checks(rule, checked, flagged); this.state.flush(); return {}; }

  /** A take's numbers for the day's telemetry (the 3.x session's _report). */
  takeReport({ cohort, data }) {
    this.ql.telemetry.take(cohort, data);
    this.ql.telemetry.recordTake(data);
    this.state.flush();
    return {};
  }

  // ------------------------------------------------------------------ device and app life
  // the model's files gone (removeModels), and with a verified stop also the kept lease: its keys, certificate and the
  // Core's state (the stop itself is remembered by the platform client, SPEC 15.3)
  /** 4.0.2: whether a stop came since `stops` (this._stopGen when a lease request went out), or one is in force. */
  _stoppedSince(stops) { return this._stopGen !== stops || !!(this.ql && this.ql.modelRefusal); }
  // the stop in force, as the error of the lease attempt it ended (an attempt that ends on a stop: 18.4.7.3's row ends)
  _stopNow() {
    const e = this.ql && this.ql.modelRefusal ? this.ql.modelRefusal : { code: 'invalid_key', message: 'the model was stopped', reason: null, status: 401 };
    return Object.assign(this._stopError(e), { stage: 'lease', attempt: 'stop' });
  }

  async _purge({ stop = false } = {}) {
    if (stop) this._stopGen += 1; // (4.0.2: a lease answer to a request sent before this stop is never taken)
    try { this.core.closeModel(); } catch (_) { /* closed */ }
    this.model = null;
    await this.o.files.clear();
    for (const k of [...this.state.m.keys()]) if (k.startsWith('manifest:')) this.state.set(k, null);
    await this.state.flush();
    if (stop) {
      if (this._refreshTimer) this.timers.clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
      this.leaseInfo = null;
      if (this.store) await this.store.clear();
    } else if (this.leaseInfo) this.leaseInfo.man = null; // read again (from the base) at the next open
  }

  async storage() {
    const list = await this.o.files.list();
    const models = [];
    for (const k of [...this.state.m.keys()].filter((x) => x.startsWith('manifest:'))) {
      let m;
      try { m = JSON.parse(this.state.get(k)); } catch (_) { continue; }
      let bytes = 0;
      for (const f of m.files || []) {
        const dec = storedPath(f);
        for (const x of list) if (x.path === dec) bytes += x.size;
      }
      models.push({ version: m.version, build: k.slice(9), bytes });
    }
    return { models, sharingQueueBytes: 0 };
  }

  async removeModels() { await this._purge(); return {}; }

  async prefetch({ version = null } = {}, onProgress = null) {
    this._refused();
    const src = await this._source(version);
    const progress = monotonic(onProgress);
    const { li, pre } = await this._leaseWithFiles(src, progress);
    const stats = await this._ensureFiles(li.base, li.man, this._context(li.man.m, null), progress, pre);
    return { bytesDone: stats.bytesDownloaded, complete: true };
  }

  // the lease of an open or a prefetch, and on a fresh install the early fetch of its files beside it (_preStart):
  // { li, pre } with pre the early fetch to use (null: none, or none usable). A lease refused or stopped drops what the
  // early fetch stored before its error goes on; one only unreachable keeps it (4.0.2, _preKeep)
  async _leaseWithFiles(src, onProgress) {
    const pre = this._preStart(src, onProgress);
    let li;
    try { li = await this._leaseFor(src); } catch (e) {
      if (leaseUnreachable(e)) await this._preKeep(pre); else await this._preDrop(pre);
      throw e;
    }
    return { li, pre: await this._preJoin(pre, li.base) };
  }

  diagnose() {
    const ql = this.ql;
    const st = this.core.tick();
    return { key: { accepted: ql.stopped ? false : ql.keyAccepted ? true : null, stopped: ql.stopped || null }, config: ql.config ? 'fresh' : 'none',
      model: this.model ? { version: this.model.man.m.version, build: this.model.src.build, verified: true } : null,
      context: this.model ? this.model.context : null, lease: { valid: st.valid, refreshDue: st.refreshDue, kept: this.kept }, engine: this.core.version,
      storage: this.o.files.kind,
      // 28.7: the host each role asks first and the last failover (the page adds the frame's host; Node, the engine's P)
      endpoints: this.ep.diagnose(this.o.desktop ? this.ep.roles.web_frame.p : undefined) };
  }

  /** The background timer of the Core (18.6.3 checks, the journal of the units fed, the day's audio). */
  tick() {
    try { return this.core.tick(); } finally {
      this.state.flush().catch(() => {});
      // the Core saved its state since the last keep (its clock, the day's audio): kept for the next page load
      if (this.core.saves !== this._persistedSaves) this._persist();
    }
  }

  /** The page went to the background; `leaving`: it is being left (pagehide), which ends the page session. */
  async background({ leaving = false } = {}) {
    this._settleLast();
    if (leaving) this.ql.telemetry.closeSession();
    this.tick();
    await this._persist();
    await this.ql.background().catch(() => {}); await this.state.flush(); return {}; }
  foreground() { this.ql.foreground(); return {}; }

  async close() {
    if (this._refreshTimer) this.timers.clearTimeout(this._refreshTimer);
    this._refreshTimer = null;
    // 4.0.2: a lease attempt in flight (a refresh, a renewal past exp in its grace) and the save of a lease it took are
    // waited for, at most CLOSE_WAIT_MS, before this close saves and destroys the Core: the lease and the attempt's
    // outcome are kept for the next start (a renewal lost here left an offline start without its lease)
    await this._settleLease(CLOSE_WAIT_MS);
    this._closed = true; // an attempt still in flight now is given up: it counts as nothing (_lease)
    this._settleLast();
    this.ql.telemetry.closeSession();
    try { await this.ql.sendTelemetry('close', { keepalive: true }); } catch (_) { /* kept */ }
    this.ql.stopSchedule();
    this.ql.stopRefresh();
    await this.state.flush();
    await this._persist();
    this.core.destroy();
    this.keys.forget();
    return {};
  }
}

/** close(): the longest it waits for a lease attempt in flight and its save (4.0.2). */
export const CLOSE_WAIT_MS = 3_000;
/** R402-3: the longest a call waits for the lease record's save (it goes on behind). */
export const LEASE_SAVE_WAIT_MS = 5_000;

// A model request's token that could not be had (ql.modelHeaders): a stop or an answer of the API stays as the platform
// client made it (its code is read from its status and reason); no answer at all is the request's failure, at the
// token's stage (24.4 rule 3a), never a TypeError that the page would take for its own invalid argument (4.0.1)
function tokenFailure(e) {
  if (!e || e.name === 'PlatformError' || e instanceof SdkError) return e;
  const out = new SdkError('download_failed', `no answer to the token request (${(e && e.message) || e})`, { stage: 'attest', why: 'network', host_role: 'api' });
  if (typeof e.qlFallback === 'boolean') out.fallback = e.qlFallback;
  return out;
}

// an onBytes for _fetchEntry that marks `seen.arrived` once a byte of the call came, then calls `of` (or nothing)
const arrived = (seen, of) => (n) => { if (n > 0) seen.arrived = true; if (of) of(n); };
const contextChunk = (c) => { const m = /^c(\d+)_l(\d+)$/.exec(String(c)); return m ? Number(m[1]) * 20 : 0; };

/** How long a model open past exp waits for a lease attempt before it counts as unreachable (18.4.7.1). */
export const ATTEMPT_WAIT_MS = 10_000;
/** The grace after a lease's exp while Quran Lab cannot be reached (18.4.7.1), seconds of the Core's clock. */
export const GRACE_S = 86_400;
/** 4.0.1: how long the first lease's early challenge and Turnstile token are used after the challenge came (a
 * challenge lives 5 minutes, 18.4.1; a Turnstile token 300 s); older, the lease asks for both again. */
export const EARLY_MAX_MS = 240_000;

// a progress callback that never goes back (the early fetch and the files after the lease report the same total)
function monotonic(f) {
  if (!f) return null;
  let best = -1;
  return (p) => { if (p.bytesDone > best) { best = p.bytesDone; f(p); } };
}

/**
 * 18.4.7.1: how a lease attempt that brought no lease ended, from the error that ended it. 'stop': a stop the Core
 * verified (already the Core's). 'refused': the API's refusal, a 4xx other than 429 whose body is JSON with an `error`
 * string (after 18.4.10's retries inside the attempt), signed or not. 'unreachable': everything else (no answer, a
 * stall, no outcome in time, any 5xx, a 429, a redirect, a 4xx that is not the API's, a 2xx that is not a lease the
 * Core accepts, a Turnstile that gave no token).
 */
/**
 * 4.0.2 (SPEC 16.7): a lease failure that is only the server not answering (no answer, a stall, a 5xx, a 429, 503
 * lease_unavailable), after which an early fetch's verified files stay; a refusal, a verified stop and anything else
 * drop them.
 */
export function leaseUnreachable(e) {
  if (!e || attemptOutcome(e) !== 'unreachable') return false;
  if (e.name === 'PlatformError') { const s = Number(e.status) || 0; return s === 0 || s === 429 || s >= 500; }
  if (e.name === 'SdkError') return (e.code === 'download_failed' || e.code === 'needs_connection') && e.why !== 'refused' && e.why !== 'invalid' && e.why !== 'cancelled';
  return e instanceof TypeError || e.name === 'AbortError' || e.name === 'TimeoutError';
}

export function attemptOutcome(e) {
  if (!e) return 'unreachable';
  if (e.attempt === 'stop' || e.attempt === 'refused' || e.attempt === 'unreachable') return e.attempt;
  if (e.name === 'PlatformError') {
    const s = Number(e.status) || 0;
    // a token or attest route's answer: refused only when the API answered a 4xx (not 429) with its own error string;
    // `http_<status>` is a body without one (a proxy's page, an empty answer)
    if (s >= 400 && s < 500 && s !== 429 && typeof e.code === 'string' && !/^http_\d+$/.test(e.code) && e.code !== 'invalid_answer') return 'refused';
    return 'unreachable';
  }
  return 'unreachable';
}

/** One answer of the lease exchange as grace.json names it ({ status, body: json|html|empty, error, core }), or a
 * missing answer ({ answer: none|stalled|late }): the attempt's outcome when it is the answer that ended it. */
export function answerOutcome(a) {
  if (!a || a.answer) return 'unreachable';
  if (a.core === 'stop') return 'stop';
  if (a.status >= 200 && a.status < 300) return a.core === 'accepted' ? 'lease' : 'unreachable';
  if (a.status >= 400 && a.status < 500 && a.status !== 429 && a.body === 'json' && typeof a.error === 'string' && a.error) return 'refused';
  return 'unreachable';
}

// the error a model open past exp gives when there is no grace: the attempt's own, as the catalogue names it (24.4:
// no answer is needs_connection, an answer of the server download_failed, a refusal server_rejected)
function leaseError(f, { held = true } = {}) {
  if (!f) return new SdkError('needs_connection', 'the lease has expired', { stage: 'lease', why: 'expired' });
  if (f instanceof SdkError) return f;
  const s = Number(f.status) || 0, attempt = attemptOutcome(f);
  const extra = { stage: 'lease', ...(s ? { http_status: s } : {}), ...(typeof f.code === 'string' ? { error_code: f.code } : {}) };
  const what = held ? 'the lease has expired' : 'no lease is held';
  if (!s) return Object.assign(new SdkError('needs_connection', `${what} and Quran Lab gave no answer (${(f && f.message) || f})`, { ...extra, why: 'network' }), { attempt });
  if (attempt === 'refused') return Object.assign(new SdkError('server_rejected', `the lease has expired and Quran Lab refused: ${f.code}`, { ...extra, why: 'refused' }), { attempt });
  return Object.assign(new SdkError('download_failed', `the lease has expired and Quran Lab answered ${s}`, { ...extra, why: s === 429 ? 'rate_limited' : 'http' }), { attempt });
}

// a failure with no HTTP answer behind it: a raw fetch failure (a TypeError), never one of the SDK's own errors or an
// answer of the API (a PlatformError carries its status; status 0 is its own offline reading, already needs_connection)
export function noAnswer(e) {
  return !!e && !(e instanceof SdkError) && e.name !== 'PlatformError' && e.name !== 'TajweedError' && e.name !== 'DeliveryError' && !(Number(e.status) > 0);
}

// 24.3's reason of the failure that ended an attempt, for the grace report's error_code
function graceCause(f) {
  if (!f) return 'network';
  if (f.error_code === 'lease_unavailable') return 'lease_unavailable'; // 18.4.10 (1c971ab): named as such
  const s = Number(f.http_status || f.status) || 0;
  if (f.why === 'timeout' || f.why === 'stall') return 'timeout';
  if (s === 429 || f.why === 'rate_limited') return 'rate_limited';
  if (s >= 300 && s < 400) return 'redirect';
  if (s >= 500 || (s >= 400 && s < 500)) return 'http';
  if (f.why === 'invalid' || f.code === 'server_rejected') return 'invalid_answer';
  if (f.code === 'model_invalid' || f.code === 'engine_failed') return 'invalid';
  return 'network';
}

// The seconds a 5xx or 429 of the lease route asks the SDK to wait: its Retry-After (seconds, or an HTTP date), between
// 1 s and 6 hours; for 503 lease_unavailable without a readable header (an API that does not expose it to the frame),
// 30 s, what the server sends; else null (the refresh steps of 18.4.7).
export function retryAfterS(header, error = null, nowMs = Date.now()) {
  let s = null;
  if (typeof header === 'string' && header.trim()) {
    const t = header.trim();
    if (/^\d+$/.test(t)) s = Number(t);
    else { const d = Date.parse(t); if (Number.isFinite(d)) s = Math.ceil((d - nowMs) / 1000); }
  }
  if (s === null && error === 'lease_unavailable') s = 30;
  return s === null || !Number.isFinite(s) ? null : Math.min(Math.max(s, 1), 21600);
}

// SPEC 16 as the native SDKs have it (Android Downloader.kt RetryPlan): no byte for 30 s ends a request; five resumes
// per file and call, after 1, 2, 4, 8 and 16 s. Blocks of 4 MiB are kept for the next call.
const STALL_MS = 30_000;
export const PAUSES_MS = Object.freeze([1000, 2000, 4000, 8000, 16000]);
/** A build's files fetched at the same time on the chosen models host (_lanes). */
export const FILE_LANES = 2;
/** errors_40.json core_open (ERRORS_40.md 24.3): a Core status the model open fails with, to the report's reason and
 * error_code where the SDK answers engine_failed. */
export const CORE_OPEN = Object.freeze({ [QLC.E_ARG]: ['engine', 'arg'], [QLC.E_NOMEM]: ['memory', 'nomem'], [QLC.E_ENGINE]: ['engine', 'engine'], [QLC.E_BUSY]: ['engine', 'busy'] });
const BLOCK_BYTES = 4 * 1024 * 1024;

// the chunks as one array of `n` bytes
function join(chunks, n) {
  if (chunks.length === 1 && chunks[0].length === n) return chunks[0];
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c.subarray(0, Math.min(c.length, n - at)), at); at += c.length; if (at >= n) break; }
  return out;
}

// bytes [from, to) of the stream the chunks make
function sliceOf(chunks, from, to) {
  const out = new Uint8Array(to - from);
  let at = 0;
  for (const c of chunks) {
    const lo = Math.max(from, at), hi = Math.min(to, at + c.length);
    if (hi > lo) out.set(c.subarray(lo - at, hi - at), lo - from);
    at += c.length;
    if (at >= to) break;
  }
  return out;
}
const now = () => (globalThis.performance ? performance.now() : Date.now());
export { hex };

/** 18.4.9: Turnstile's cdata, base64url(SHA-256(UTF-8 of install hash hex, LF, challenge)), 43 characters (web_lease.json). */
export async function turnstileCdata(installHex, challenge) { return b64u(await sha256(utf8(`${installHex}\n${challenge}`))); }
