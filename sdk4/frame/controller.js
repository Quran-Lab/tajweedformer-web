// The engine Worker's controller: everything of SDK 4.0 that runs on Quran Lab's origin, behind the frame.
//
//   init      the install keys and the lease kept from an earlier page load (lease-store.js) or new ones, the Core,
//             the platform client (register, signed config, telemetry)
//   model     config -> signed manifest -> lease (attest, challenge, Turnstile at the first lease, POST /v1/model-key)
//             -> ciphertext downloads -> qlc_install per file -> qlc_model_open; the model's public facts out
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
import { QuranLab4, SDK_VERSION_4 } from './api4.js';
import { StateStore, WithCoreFiles } from './stores.js';
import { PlatformError } from '../../web/platform/client.js';
import { tokenAnswer, integrityCode, integrityDetail } from '../../web/platform/error-reports.js';
import { MODEL_VERSION_RE } from '../../web/tajweed/manifest.js';

/** The vocabularies the loader knows by the manifest's tokens_sha256 (the tokens file is encrypted in a protected
 * build, and the Core does not export the names yet: docs/core-requests.md, request 1). */
export const KNOWN_VOCABULARIES = Object.freeze({
  '66fe6eb81b15506270f9e3c6efb0724cda757cd54326f26ca4bcd6be4f3b2aa4': Object.freeze(['<blk>', '|', 'ء', 'ب', 'ت',
    'ث', 'ج', 'ح', 'خ', 'د', 'ذ', 'ر', 'ز', 'س', 'ش', 'ص', 'ض', 'ط',
    'ظ', 'ع', 'غ', 'ف', 'ق', 'ك', 'ل', 'م', 'ن', 'ه', 'و', 'ي', 'ں',
    'a', 'i', 'u', 'aa', 'ii', 'uu', '<foreign>']),
});

const ENGINE_ROLES = new Set(['weights', 'frontend', 'graph', 'graph-data', 'frames', 'tokens', 'layout', 'reference']);
const REFRESH_RETRY_S = [60, 300, 1800, 7200, 21600]; // 18.4.7: 1, 5 and 30 minutes, then every 2 hours, at most 6

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
  }

  /**
   * The page session: install keys, the platform client's launch (attest with the keys, register, the signed
   * config), then the engine the config names for this site (o.engine, or o.loadEngine(config): a verified module
   * factory and its bytes), then the Core.
   */
  async init(args = {}) {
    const o = this.o;
    const t0 = this.clock();
    this.state = await StateStore.open(o.kv);
    // the lease of an earlier page load of this site (lease-store.js): its install keys, certificate and the Core's
    // saved state; none (or o.leaseStore false): new keys, as a first visit
    const wall = o.coreClock && typeof o.coreClock.wall === 'function' ? () => o.coreClock.wall() : this.clock;
    // (o.leaseStore: a store of the same shape, the Node path's: sdk4/node/store.js)
    this.store = o.leaseStore === false || o.keys ? null : o.leaseStore && typeof o.leaseStore.load === 'function' ? o.leaseStore
      : new LeaseStore(this.state, { key: o.key, site: o.site, clock: wall });
    const kept = this.store ? await this.store.load() : null;
    this.kept = kept ? kept.why : 'off';
    this.keys = o.keys || (kept && kept.keys) || await InstallKeys.create();
    this.ql = new QuranLab4({ key: o.key, site: o.site, apiUrl: o.apiUrl, modelsUrl: o.modelsUrl, fetch: o.fetch, clock: this.clock, state: this.state,
      trustedKeys: o.trustedKeys, appVersion: o.appVersion, autoSend: o.autoSend,
      debug: o.debug, keys: this.keys, local: o.local, cert: kept ? kept.cert : null, desktop: o.desktop || null });
    // a certificate of a Turnstile pass still holds: the leases of this page ride on it with no new token (18.4.9)
    this.turnstilePassed = !!(kept && kept.cert && certField(kept.cert, 'att') === 'turnstile' && this.ql.certHolds());
    // a stop the API answers on any route (15.3, 18.4.10: "works as in 3.x") removes the model's files and the kept
    // lease, here as in the lease route's signed stop
    this.ql.onModelStop = () => { this._purge({ stop: true }).catch(() => {}); };
    // an analytics session a killed page left open is closed first, into its own day (17.8 session_s)
    this.ql.telemetry.closeSession();
    await this.ql.launch();
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
        this.leaseInfo = { exp: st.exp, refreshAfter: st.refreshAfter, base: l.base, failures: 0, build: l.build, man: null, eph: new Uint8Array(l.eph),
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
      config: this.ql.config ? 'fresh' : 'none', stopped: this.ql.stopped || null, initMs: this.initMs, lease: this.kept };
  }

  /**
   * Keep the install keys, the certificate, the Core's saved state and what the frame knows of the lease, for the next
   * page load (lease-store.js). Called after each step that changes them; never throws, never in the way.
   */
  _persist() {
    if (!this.store || !this.core || !this.core.ptr) return Promise.resolve();
    let now = null;
    if (!this.take) { try { now = this.core.tick().now; } catch (_) { now = null; } }
    const li = this.leaseInfo;
    const lease = li && li.eph ? { build: li.build, base: li.base, exp: li.exp, refreshAfter: li.refreshAfter, eph: li.eph, anchorD: li.anchorD,
      src: { build: li.src.build, version: li.src.version, modelId: li.src.modelId, keyId: li.src.keyId } } : null;
    this._persistedSaves = this.core.saves;
    return this.store.save({ keys: this.keys, coreState: this.core.state, coreNow: now, cert: this.ql.installCert, lease,
      mirror: null });
  }

  /** ERRORS_40.md section 24: a failure the loader is given, with the code it gets (serve.js). Never throws. */
  reportFailure(err, code) {
    try { if (this.ql && code && code !== 'invalid_argument') this.ql.reportFailure(err, { code }); } catch (_) { /* never in the way */ }
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
   * the lease answer's base): `recommended` = { revision (the build, 40 hex), version, model_id, key_id (the build's
   * encryption key id, 32 hex) }. The config gives no base URL. A pinned version is asked of the server.
   */
  async _source(version) {
    const ql = this.ql;
    ql.modelVersionPin = version;
    const stored = this.state.get('config');
    const usable = ql.config && (!stored || (stored.pin || null) === (version || null));
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
      const held = this.leaseInfo && this.leaseInfo.src;
      if (held && (version === null || version === undefined || held.version === version) && (!last || last.status >= 500 || last.status === 429)) {
        // valid, or past its exp within the 24 hours of a possible grace (the open decides: _leaseFor, the Core)
        let usable = false;
        try { const st = this.core.tick(); usable = st.hasLease && !st.stopped && (st.valid || st.now < st.exp + GRACE_S); } catch (_) { usable = false; }
        if (usable) {
          ql.modelRevision = held.version;
          ql.modelBuild = held.build;
          return { ...held, pin: null };
        }
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

  // the signed manifest of the build, from the lease answer's base (or this site's storage): its SHA-256 starts with
  // the build the config named, and it names the config's key id, version and model id
  async _manifest(src, base) {
    const key = `manifest:${src.build}`;
    let bytes = this.state.get(key) ? utf8(this.state.get(key)) : null;
    if (!bytes) {
      if (!base) throw new SdkError('needs_connection', 'no lease answer named where the files are', { stage: 'lease', why: 'network' });
      bytes = await this._get(base + 'manifest.json', { stage: 'manifest' });
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
   *   - a stall ends a request: no byte for 30 s (the wait for the answer included) and it is aborted; a slow link that
   *     keeps delivering is never cut;
   *   - the request is asked again inside the call, at most 5 times per file, after pauses of 1, 2, 4, 8 and 16 s,
   *     from the bytes already held (Range; no If-Range: a build's files never change under their URL, the CDN does not
   *     allow the header across origins, and the file's SHA-256 decides): no answer, a connection that
   *     ended, a stall, a 5xx, and an answer that says success and is not what was asked for (a 206 for other bytes, a
   *     2xx that is neither 200 nor the 206 asked for, a body longer than the file);
   *   - asked once and never again in the call: a refusal (401 or 403, after one renewal of the token on a 401
   *     invalid_token; a stop reason stops the model as 15.3 says), a 429, a redirect, and any other status;
   *   - `keep` (a file's decoded path, with `size`): the bytes are also kept, in blocks of 4 MiB as they complete, as
   *     ciphertext in the frame's file store (`<path>.part.<n>`, CDN form), so a call that fails, or a page closed
   *     mid-download, goes on at the next call from the blocks kept. The blocks are dropped once the file is whole.
   * A server that answers a Range request with the whole file (200) is read from the start.
   */
  async _get(url, { onProgress = null, stage = 'download', size = null, keep = null } = {}) {
    const dl = this.dl || (this.dl = { resumes: 0, keptBlocks: 0 });
    const opt = this.o.download || {};
    const pauses = Array.isArray(opt.pausesMs) ? opt.pausesMs : PAUSES_MS;
    const stallMs = Number.isFinite(opt.stallMs) ? opt.stallMs : STALL_MS;
    const block = Number.isInteger(opt.blockBytes) && opt.blockBytes > 0 ? opt.blockBytes : BLOCK_BYTES;
    let chunks = [], have = 0, validator = null, resumes = 0, renewed = false;
    // the blocks a call before this one kept
    if (keep && Number.isInteger(size)) {
      const k = await this._keptBlocks(keep, size, block);
      if (k) { chunks = k.blocks; have = k.bytes; validator = k.validator; dl.keptBlocks += k.blocks.length; }
    }
    let saved = Math.floor(have / block); // blocks kept so far
    const fail = (why, msg, extra = {}) => Object.assign(new SdkError('download_failed', msg, { stage, why, ...extra }), { again: true });
    for (;;) {
      let err = null;
      try {
        const headers = await this.ql.modelHeaders();
        if (have > 0) headers.range = `bytes=${have}-`;
        const ac = typeof AbortController === 'function' ? new AbortController() : null;
        let r;
        try {
          r = await this._stalls(this.ql.fetch(url, { headers, redirect: 'error', ...(ac ? { signal: ac.signal } : {}) }), stallMs, () => ac && ac.abort());
        } catch (e) { throw fail(e && e.stall ? 'stall' : 'network', e && e.stall ? 'no answer for 30 s' : String((e && e.message) || e)); }
        if (r.status === 401 || r.status === 403) {
          let b = {};
          try { b = await r.json(); } catch (_) { /* no body */ }
          if (r.status === 401 && b.error === 'invalid_token' && !b.reason && !renewed) { renewed = true; this.ql._token = null; continue; }
          this.ql.noteModelRefusal({ status: r.status, error: b.error, reason: b.reason });
          this._refused();
          throw new SdkError('download_failed', `the CDN answered ${r.status}`, { stage, why: 'refused', http_status: r.status, ...(typeof b.error === 'string' ? { error_code: b.error } : {}) });
        }
        if (r.status >= 500) throw fail('http', `the CDN answered ${r.status}`, { http_status: r.status });
        if (r.status === 429) throw new SdkError('download_failed', 'the CDN answered 429', { stage, why: 'rate_limited', http_status: 429 });
        if (r.status !== 200 && r.status !== 206) {
          if (r.status > 200 && r.status < 300) throw fail('http', `the CDN answered ${r.status}, not the file`, { http_status: r.status });
          throw new SdkError('download_failed', `the CDN answered ${r.status}`, { stage, why: 'http', http_status: r.status });
        }
        if (r.status === 200 && have > 0) { chunks = []; have = 0; saved = 0; } // the Range was not taken: the whole file
        if (r.status === 206) {
          const cr = String(r.headers.get('content-range') || '');
          const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(cr.trim());
          if (have === 0 || !m || Number(m[1]) !== have || (Number.isInteger(size) && m[3] !== '*' && Number(m[3]) !== size)) {
            throw fail('http', `the CDN answered bytes ${JSON.stringify(cr)} where bytes ${have}- were asked for`, { http_status: 206 });
          }
        }
        this.ql.noteModelServed();
        validator = r.headers.get('etag') || r.headers.get('last-modified') || validator;
        if (!r.body || typeof r.body.getReader !== 'function') {
          const b = new Uint8Array(await r.arrayBuffer());
          chunks.push(b); have += b.length;
        } else {
          const rd = r.body.getReader();
          for (;;) {
            let x;
            try { x = await this._stalls(rd.read(), stallMs, () => { if (ac) ac.abort(); rd.cancel().catch(() => {}); }); } catch (e) {
              throw fail(e && e.stall ? 'stall' : 'network', e && e.stall ? 'no byte for 30 s' : `the connection ended (${(e && e.message) || e})`);
            }
            if (x.done) break;
            chunks.push(x.value); have += x.value.length;
            if (Number.isInteger(size) && have > size) throw fail('http', 'the answer is longer than the file');
            if (onProgress) onProgress(have);
            // whole blocks kept as they complete (ciphertext, the CDN form)
            if (keep && Number.isInteger(size)) {
              while ((saved + 1) * block <= have) { await this._keepBlock(keep, size, block, saved, chunks, validator); saved++; }
            }
          }
        }
        if (Number.isInteger(size) && have !== size) throw fail('network', `the connection ended at ${have} of ${size} bytes`);
        const out = join(chunks, have);
        return out;
      } catch (e) { err = e; }
      if (!err.again || resumes >= pauses.length) {
        if (err.again) err.message = `${err.message} (asked ${resumes + 1} times)`;
        throw err;
      }
      await new Promise((res) => this.timers.setTimeout(res, pauses[resumes]));
      resumes++;
      dl.resumes++;
    }
  }

  // a promise that fails `{ stall: true }` when it has not settled in `ms` (onStall runs then)
  _stalls(p, ms, onStall) {
    return new Promise((resolve, reject) => {
      const t = this.timers.setTimeout(() => { try { onStall(); } catch (_) { /* gone */ } reject(Object.assign(new Error('stall'), { stall: true })); }, ms);
      p.then((v) => { this.timers.clearTimeout(t); resolve(v); }, (e) => { this.timers.clearTimeout(t); reject(e); });
    });
  }

  // the n-th block of a file being downloaded, kept as ciphertext beside its validator (one KV record per file)
  async _keepBlock(path, size, block, n, chunks, validator) {
    try {
      await this.o.files.put(QLC.FORM_CDN, `${path}.part.${n}`, sliceOf(chunks, n * block, (n + 1) * block));
      this.state.set(`part:${path}`, { size, block, n: n + 1, validator: validator || null });
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
    return { blocks, bytes: blocks.length * block, validator: typeof rec.validator === 'string' ? rec.validator : null };
  }

  async _dropBlocks(path) {
    const rec = this.state.get(`part:${path}`);
    const n = rec && Number.isInteger(rec.n) ? rec.n : 0;
    for (let i = 0; i < n; i++) await this.o.files.drop(QLC.FORM_CDN, `${path}.part.${i}`).catch(() => {});
    this.state.set(`part:${path}`, null);
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
        return li;
      } catch (e) {
        this.ql.telemetry.recordLease(e.leaseCause || (['needs_connection', 'download_failed'].includes(e.code) ? 'offline'
          : ['invalid_key', 'sdk_too_old', 'server_rejected'].includes(e.code) ? 'refused' : 'other'));
        const outcome = attemptOutcome(e);
        e.attempt = outcome;
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
   * held one in its grace (until exp + 24 h, an attempt since the lease unreachable and none refused), else the
   * attempt's error. Each open in grace is a silent error report (lease, grace).
   */
  async _expiredLease(src) {
    const li = this.leaseInfo;
    const wait = Number.isFinite(this.o.attemptWaitMs) ? this.o.attemptWaitMs : ATTEMPT_WAIT_MS;
    let failure = null;
    const recent = !this._attempt && this._attemptEnded && this.clock() - this._attemptEnded < 60_000;
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

  async _leaseOnce(src) {
    const ql = this.ql, keys = this.keys;
    let renewedCert = false, renewedChallenge = false, freshTurnstile = false, renewedToken = false, proofAgain = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      await ql.token();
      const challenge = await ql.challenge();
      const { core, installSig } = await this.core.leaseAsk(challenge, src.build);
      const askedUnder = !!core && Number(core.piece) > 0; // the proof is made under a piece (core.piece, 0 without one)
      const body = { v: 1, platform: ql.platform, install_cert: ql.installCert, install_key: b64u(keys.spki), install_sign_key: b64u(keys.signSpki),
        challenge, install_sig: installSig, model: src.modelId, version: src.version, build: src.build, key_id: src.keyId, core };
      if (!this.turnstilePassed && this.o.turnstile) {
        const cdata = await turnstileCdata(keys.installHex, challenge);
        // null: no widget (no site key: no gate); false: the invisible check gave no token: the lease is asked without
        // one and the server gives the 24-hour class (18.4.9; owner, 11-18: never a refusal, never a box)
        const token = await this.o.turnstile({ action: 'lease', cdata }).catch(() => false);
        if (token) body.turnstile = token;
      }
      const r = await ql.modelKey(body);
      const a = r.body || {};
      // 18.4.7.1: the API's refusal is a 4xx other than 429 whose body is JSON with an error string; any other answer
      // that brings no lease is unreachable
      const refusal = r.status >= 400 && r.status < 500 && r.status !== 429 && r.body !== null && typeof a.error === 'string' && a.error !== '' ? 'refused' : 'unreachable';
      if (r.status === 200 && typeof a.lease === 'string') {
        if (typeof a.install_cert === 'string') ql.installCert = a.install_cert;
        // the server gave the 24-hour class without a Turnstile pass (no token, a doubtful one, or Turnstile down):
        // no page session certificate, so the next lease asks again; reported, silently (ERRORS_40 24.1)
        if (a.turnstile === 'unverified') this._turnstileUnverified(a);
        else if (body.turnstile) this.turnstilePassed = true;
        const base = safeBase(a.base);
        if (!base) throw new SdkError('server_rejected', 'the lease answer names no base for the files', { stage: 'lease', why: 'invalid' });
        // the manifest (from this base, or stored) before the Core takes the lease: it checks the lease against it
        const man = await this._manifest(src, base);
        let got;
        const leaseBytes = unb64u(a.lease);
        try { got = await this.core.leaseAccept(leaseBytes, man.bytes, src.build); } catch (e) {
          const err = this._coreError(e, 'the lease was refused by the Core');
          throw Object.assign(err, { leaseCause: err.leaseCause || (e.status === QLC.E_NEEDS_CONNECTION ? 'expired' : 'other') });
        }
        // the answer's data piece right after the accept, always (spec fix 16, quranlab-core f006676): the Core keeps it
        // pending in its saved state and puts it in force at the next model open; one that does not verify changes
        // nothing
        if (typeof a.piece === 'string') {
          try { this.core.piece(unb64u(a.piece)); } catch (_) { /* nothing changes */ }
        }
        // the Core's clock is the lease's anchor now: its offset from the device clock is kept with the lease, for the
        // set-back clock rule of lease-store.js
        let anchorD = null;
        try { anchorD = this.core.tick().now - this._wall() / 1000; } catch (_) { anchorD = null; }
        this.leaseInfo = { exp: got.exp, refreshAfter: got.refreshAfter, base, failures: 0, build: src.build, man, eph: this.core.eph(leaseBytes), anchorD,
          src: { build: src.build, version: src.version, modelId: src.modelId, keyId: src.keyId, pin: null } };
        this._scheduleRefresh(src);
        await this._persist();
        return this.leaseInfo;
      }
      // the server cannot answer now (a 5xx, 503 lease_unavailable with Retry-After when a dependency is down, or a
      // 429): never a refusal. Nothing goes to the Core (the piece in force stays: the server checked no proof), the
      // refresh asks again after Retry-After (_scheduleRefresh), and a kept lease or the offline grace goes on
      if (r.status >= 500 || r.status === 429) {
        throw new SdkError('download_failed', `Quran Lab's server answered ${r.status}${a.error ? ` ${a.error}` : ''} for the lease; the SDK tries again`,
          { stage: 'lease', why: r.status === 429 ? 'rate_limited' : a.error === 'lease_unavailable' ? 'lease_unavailable' : 'http', http_status: r.status, ...(typeof a.error === 'string' ? { error_code: a.error } : {}),
            retryAfter: retryAfterS(r.retryAfter, a.error) });
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
        throw Object.assign(new SdkError('server_rejected', `the lease route refused: ${a.error} (an unsigned or unverified stop changes nothing)`, { stage: 'lease', why: 'refused', http_status: r.status, error_code: a.error }), { attempt: refusal });
      }
      if (r.status === 401 && a.error === 'install_cert_invalid' && !renewedCert) { renewedCert = true; await ql.reattest(); continue; }
      if (r.status === 401 && a.error === 'challenge_invalid' && !renewedChallenge) { renewedChallenge = true; continue; }
      if (r.status === 401 && a.error === 'invalid_token' && !renewedToken) { renewedToken = true; ql._token = null; continue; }
      // (a stored certificate the server no longer counts as a pass, too: a token is asked for now)
      if (r.status === 403 && (a.error === 'turnstile_required' || a.error === 'turnstile_failed') && !freshTurnstile && this.o.turnstile) { freshTurnstile = true; this.turnstilePassed = false; continue; }
      // a proof refused (the Core's digest under the piece in force): one more ask, under the piece the Core falls back to
      if (r.status === 403 && a.error === 'lease_integrity_failed' && a.why === 'core' && askedUnder && !proofAgain) { proofAgain = true; continue; }
      if (r.status === 403 && a.error === 'sdk_too_old') throw Object.assign(new SdkError('sdk_too_old', a.min_sdk ? `this key needs SDK ${a.min_sdk}` : 'the Core release is not served', { stage: 'lease', why: 'refused', http_status: 403, error_code: 'sdk_too_old' }), { attempt: 'refused' });
      if (r.status === 404 && a.error === 'build_unknown') { await ql.refreshConfig().catch(() => {}); throw Object.assign(new SdkError('model_unavailable', 'the build is not leased; the config is refreshed', { stage: 'lease', why: 'http', http_status: 404, error_code: 'build_unknown' }), { attempt: 'refused' }); }
      // 18.4.10: a 403 lease_integrity_failed names the failed check; the developer's message says it, the report's
      // error_code is why:check (ERRORS_40.md 24.3, contract 69326fb); the code stays server_rejected
      if (r.status === 403 && a.error === 'lease_integrity_failed') {
        throw Object.assign(new SdkError('server_rejected', integrityDetail(a.why, a.check),
          { stage: 'lease', why: 'integrity_failed', http_status: 403, error_code: integrityCode(a.why, a.check) || 'lease_integrity_failed' }), { leaseCause: 'refused', attempt: refusal });
      }
      // ERRORS_40.md 24.4: no answer is needs_connection; a server's 5xx or 429 is download_failed, naming it
      if (r.status === 0) throw Object.assign(new SdkError('needs_connection', 'no lease now (no answer); the SDK tries again', { stage: 'lease', why: 'network' }), { attempt: 'unreachable' });
      throw Object.assign(new SdkError('server_rejected', `the lease route answered ${r.status} ${a.error || ''}`.trim(), { stage: 'lease', why: refusal === 'refused' ? 'refused' : 'invalid', http_status: r.status, ...(a.error ? { error_code: String(a.error) } : {}) }),
        { leaseCause: /turnstile|install_cert|attestation/.test(String(a.error)) ? 'attestation' : 'refused', attempt: refusal });
    }
    throw Object.assign(new SdkError('server_rejected', 'no lease after the repeats the contract allows', { stage: 'lease', why: 'invalid' }), { attempt: 'refused' });
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
    if (e.status === QLC.E_STORAGE) return new SdkError('storage_failed', `${what} (${e.message})`, at('storage', 'write'));
    if (e.status === QLC.E_KEYSTORE) return new SdkError('engine_failed', `${what}: the key store (${e.message})`, at('storage', 'read'));
    return new SdkError('engine_failed', `${what} (${e.message})`, at('model_open', /memory|alloc/i.test(String(e.message)) ? 'memory' : 'engine'));
  }

  // the lease is refreshed in the background after refresh_after (18.4.7), with the retry steps; a valid lease never waits
  _scheduleRefresh(src) {
    if (this._refreshTimer) this.timers.clearTimeout(this._refreshTimer);
    const li = this.leaseInfo;
    // refresh_after is a time of the Core's clock (anchored at the lease's iat, the server's time, 18.4.7), so it is
    // compared with that clock and never with the device's (with the device's, a clock days ahead asked for a new
    // lease at once and again after every new lease, and one days behind waited days past the time)
    let now;
    try { now = this.core.tick().now; } catch (_) { now = this.clock() / 1000; }
    // after a failure: the server's Retry-After when it gave one (503 lease_unavailable: 30 s), else the steps
    const wait = !li.failures ? Math.max(0, li.refreshAfter - now)
      : Number.isFinite(li.retryAfter) ? li.retryAfter : REFRESH_RETRY_S[Math.min(li.failures - 1, REFRESH_RETRY_S.length - 1)];
    this._refreshTimer = this.timers.setTimeout(async () => {
      try { await this._lease(src); } catch (e) {
        if (this.ql.modelRefusal) return;
        li.failures++;
        li.retryAfter = e && Number.isFinite(e.retryAfter) ? e.retryAfter : null;
        this._scheduleRefresh(src);
      }
    }, Math.min(wait, 2 ** 31 / 1000 - 1) * 1000);
    if (this._refreshTimer && typeof this._refreshTimer.unref === 'function') this._refreshTimer.unref();
  }

  // the entries a model of `context` needs, by decoded path
  _needed(m, context, { recited }) {
    return m.files.filter((f) => {
      if (f.context !== '*' && f.context !== context) return false;
      if (f.role === 'calibration') return true;
      if (f.role === 'recited') return recited;
      return ENGINE_ROLES.has(f.role);
    });
  }

  _recitedOn() {
    const flags = this.ql.flags || {};
    return this.ql.telemetry.enabled && flags.analytics !== false && flags.recited !== false;
  }

  async _ensureFiles(base, man, context, onProgress) {
    const need = this._needed(man.m, context, { recited: this._recitedOn() });
    const stats = { bytesDownloaded: 0, installMs: 0, files: 0 };
    const todo = [];
    for (const f of need) {
      const dec = f.encoding === 'qle1' ? f.decoded.path : f.path;
      const form = f.encoding === 'qle1' ? QLC.FORM_DEVICE : QLC.FORM_PLAIN;
      if (await this.o.files.has(form, dec)) continue;
      todo.push(f);
    }
    const total = todo.reduce((n, f) => n + f.size, 0);
    let done = 0;
    const dl0 = this.dl ? { ...this.dl } : { resumes: 0, keptBlocks: 0 };
    for (const f of todo) {
      const bytes = await this._get(base + f.path.split('/').map(encodeURIComponent).join('/'),
        { onProgress: onProgress ? (n) => onProgress({ bytesDone: done + n, bytesTotal: total }) : null, size: f.size, keep: f.path });
      // the container as the signed manifest names it (16.1): its size and SHA-256. Kept blocks that made a file that
      // is not the signed bytes are dropped, so the next call downloads it whole
      const good = bytes.length === f.size && (await sha256Hex(bytes)) === String(f.sha256).toLowerCase();
      await this._dropBlocks(f.path);
      if (!good) throw new SdkError('checksum_mismatch', `${f.path}: not the signed bytes`, { stage: 'download', why: 'hash' });
      stats.bytesDownloaded += bytes.length;
      done += f.size;
      if (f.encoding === 'qle1') await this.o.files.put(QLC.FORM_CDN, f.decoded.path, bytes);
      else await this.o.files.put(QLC.FORM_PLAIN, f.path, bytes);
    }
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
    const li = await this._leaseFor(src);
    const man = li.man, base = li.base;
    const context = this._context(man.m, null);
    const stats = await this._ensureFiles(base, man, context, null);
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
      calibration: cal ? { text: fromUtf8(cal), sha256: calEntry ? calEntry.sha256 : await sha256Hex(cal) } : null,
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

  async _clipList(man) {
    const entry = man.m.files.find((f) => f.path === 'selftest/selftest.json');
    if (!entry) return [];
    try {
      if (!(await this.o.files.has(QLC.FORM_PLAIN, entry.path))) {
        const b = await this._get(this.model.base + entry.path);
        if ((await sha256Hex(b)) !== entry.sha256) return [];
        await this.o.files.put(QLC.FORM_PLAIN, entry.path, b);
      }
      const st = JSON.parse(fromUtf8(await this.o.files.get(QLC.FORM_PLAIN, entry.path)));
      return (Array.isArray(st.clips) ? st.clips : []).filter((c) => typeof c.id === 'string' && c.sample_rate > 0 && man.m.files.some((f) => f.path === `selftest/${c.file}`))
        .map((c) => ({ name: c.id, kind: String(c.kind || 'clean'), durationMs: Math.round((1000 * c.samples) / c.sample_rate), file: c.file, sampleRate: c.sample_rate }));
    } catch (_) { return []; }
  }

  /** One ayah's expected units (R3, SPEC 13.7): { units, words, wordCount }, or null for an ayah the table does not have. */
  reference({ surah, ayah }) {
    if (!this.model) throw new SdkError('model_missing', 'no model is open');
    if (!Number.isInteger(surah) || surah < 1 || surah > 114 || !Number.isInteger(ayah) || ayah < 1) throw new SdkError('invalid_argument', 'surah and ayah are positive whole numbers');
    try { return this.core.referenceExpected(surah, ayah); } catch (e) {
      if (e instanceof CoreError && e.status === QLC.E_FILE) throw new SdkError('reference_missing', e.message);
      throw this._coreError(e, 'the reference data');
    }
  }

  /** A sample clip's samples (a plain self-test file, public data). */
  async clipSamples(name) {
    const md = this.model;
    const clips = await this._clipList(md.man);
    const c = clips.find((x) => x.name === name);
    if (!c) throw new SdkError('invalid_argument', 'not a sample clip of this model');
    const path = `selftest/${c.file}`, e = md.man.m.files.find((f) => f.path === path);
    let b = await this.o.files.get(QLC.FORM_PLAIN, path);
    if (!b) {
      b = await this._get(md.base + path);
      if ((await sha256Hex(b)) !== e.sha256) throw new SdkError('checksum_mismatch', `${path}: not the signed bytes`, { stage: 'download', why: 'hash' });
      await this.o.files.put(QLC.FORM_PLAIN, path, b);
    }
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
  async _purge({ stop = false } = {}) {
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
        const dec = f.encoding === 'qle1' ? f.decoded.path : f.path;
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
    const li = await this._leaseFor(src);
    const stats = await this._ensureFiles(li.base, li.man, this._context(li.man.m, null), onProgress);
    return { bytesDone: stats.bytesDownloaded, complete: true };
  }

  diagnose() {
    const ql = this.ql;
    const st = this.core.tick();
    return { key: { accepted: ql.stopped ? false : ql.keyAccepted ? true : null, stopped: ql.stopped || null }, config: ql.config ? 'fresh' : 'none',
      model: this.model ? { version: this.model.man.m.version, build: this.model.src.build, verified: true } : null,
      context: this.model ? this.model.context : null, lease: { valid: st.valid, refreshDue: st.refreshDue, kept: this.kept }, engine: this.core.version,
      storage: this.o.files.kind };
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

// a base for the files: https, or http on this machine (the local browser test)
function safeBase(b) {
  if (typeof b !== 'string' || !b.endsWith('/')) return null;
  try {
    const u = new URL(b);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'))) return b;
  } catch (_) { /* not a URL */ }
  return null;
}

const contextChunk = (c) => { const m = /^c(\d+)_l(\d+)$/.exec(String(c)); return m ? Number(m[1]) * 20 : 0; };

/** How long a model open past exp waits for a lease attempt before it counts as unreachable (18.4.7.1). */
export const ATTEMPT_WAIT_MS = 10_000;
/** The grace after a lease's exp while Quran Lab cannot be reached (18.4.7.1), seconds of the Core's clock. */
export const GRACE_S = 86_400;

/**
 * 18.4.7.1: how a lease attempt that brought no lease ended, from the error that ended it. 'stop': a stop the Core
 * verified (already the Core's). 'refused': the API's refusal, a 4xx other than 429 whose body is JSON with an `error`
 * string (after 18.4.10's retries inside the attempt), signed or not. 'unreachable': everything else (no answer, a
 * stall, no outcome in time, any 5xx, a 429, a redirect, a 4xx that is not the API's, a 2xx that is not a lease the
 * Core accepts, a Turnstile that gave no token).
 */
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
const PAUSES_MS = Object.freeze([1000, 2000, 4000, 8000, 16000]);
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
