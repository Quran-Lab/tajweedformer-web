// The Core binding: one qlc_core (quranlab-core qlcore.h, API version 1) in a WebAssembly instance, driven from
// JavaScript. Runs inside the engine Worker on Quran Lab's origin (and in Node for the tests and measurements).
//
// The Core does no I/O of its own. Its platform table is made of JavaScript callbacks here:
//   storage   size/read/write/commit/remove on a synchronous file store (stores.js: OPFS sync access handles in a
//             browser Worker, memory, or a folder in Node), by form and decoded path;
//   clocks    Date.now() and performance.now() with a random id per page session (the "boot" of 18.4.7 on web);
//   random    crypto.getRandomValues;
//   key store agree (ECDH) and sign (ECDSA) with the session's non-extractable WebCrypto keys (keys.js).
//
// WebCrypto is asynchronous and the Core's callbacks are synchronous. Every input the Core will ask the key store
// about is known before the call: the text it signs (18.4.3 and 18.4.4 name it exactly) and the lease's ephemeral
// key (18.4.6). So before each call that uses the key store the binding prepares that one signature or that one
// agreement, and the callback answers from it; any other request is refused (the call then fails QLC_E_KEYSTORE).
// docs/core-requests.md asks the Core for a two-step form that removes the need.
import { utf8, fromUtf8, hex, randomBytes } from '../shared/bytes.js';

export const QLC = Object.freeze({
  OK: 0, E_ARG: -1, E_NOMEM: -2, E_STORAGE: -3, E_MANIFEST: -4, E_NEEDS_CONNECTION: -5, E_LEASE: -6, E_FILE: -7,
  E_ENGINE: -8, E_STOPPED: -9, E_KEYSTORE: -10, E_BUSY: -11,
  FORM_PLAIN: 0, FORM_CDN: 1, FORM_DEVICE: 2, FORM_CORE: 3,
});
const STATUS_NAME = Object.fromEntries(Object.entries(QLC).filter(([k]) => k === 'OK' || k.startsWith('E_')).map(([k, v]) => [v, k]));

/** The 12 heads in the engine's order (ZfTajweedHeads, qlc_heads): name, values per frame, frame rate in ms. */
export const HEADS = Object.freeze([
  ['log_probs', 38, 40], ['inter1_log_probs', 38, 40], ['inter4_log_probs', 38, 40], ['id_log_probs', 38, 20],
  ['timing_log_probs', 38, 20], ['gem', 2, 20], ['attr_tafkheem', 3, 20], ['attr_ghunna', 5, 20], ['attr_qalqalah', 3, 20],
  ['attr_face', 4, 20], ['boundary', 1, 20], ['conf', 1, 20],
]);
export const headMask = (names) => names.reduce((m, n) => m | (1 << HEADS.findIndex((h) => h[0] === n)), 0) >>> 0;

/** qlc_detail's codes by name (qlcore.h QLC_D_*, quranlab-core 4a5663c): after E_LEASE, and after E_FILE. */
export const QLC_D = Object.freeze({
  LEASE: { 1: 'format', 2: 'signature', 3: 'install', 4: 'release', 5: 'build', 6: 'key_id', 7: 'model', 8: 'expired', 10: 'outer_tag',
    11: 'inner_tag', 12: 'site', 32: 'unwrap', 33: 'no_accel' },
  FILE: { 1: 'magic', 2: 'version', 3: 'header_len', 4: 'form', 5: 'suite', 6: 'payload', 7: 'record_shift', 8: 'reserved', 9: 'variant',
    10: 'size', 11: 'path_hash', 12: 'key_id', 13: 'file_index', 14: 'tag', 15: 'plain_sha256', 16: 'notice' },
});
export const QLC_D_LEASE_SITE = 12;

export class CoreError extends Error {
  constructor(status, detail, where) {
    const named = status === -6 ? QLC_D.LEASE[detail] : status === -7 ? QLC_D.FILE[detail] : null;
    super(`${where}: ${STATUS_NAME[status] || status}${detail ? ` (detail ${named || detail})` : ''}`);
    this.detailName = named || null;
    this.name = 'CoreError';
    this.status = status;
    this.detail = detail;
    this.where = where;
  }
}

// the offsets of qlcore.h's structs on wasm32 (4-byte pointers and size_t, 8-byte int64)
// through `signals`: no state_seal or counter on web (both are synchronous calls, and WebCrypto is not); the saved
// state is sealed by the Core under its release's key, and sealed again by lease-store.js under a non-extractable
// WebCrypto key before it is stored
const PLATFORM_SIZE = 76;
const OPEN_OPTIONS_SIZE = 28;
const HEADS_SIZE = 60;
const LEASE_STATUS_SIZE = 40;

/**
 * @param {object} o
 * @param {(overrides: object) => Promise<object>} o.factory  the Emscripten module factory (qlcore[-mt].mjs's default)
 * @param {Uint8Array} [o.wasm]  the verified module bytes (instantiated from these, never fetched again)
 * @param {object} o.files  the synchronous file store (stores.js)
 * @param {object} o.keys  the install keys (keys.js): spki, agreeSync(eph), signSync(msg)
 * @param {Uint8Array} [o.state]  the Core's saved state, as its save callback last gave it (lease-store.js)
 * @param {number} [o.signals]  platform risk bits (18.6.4)
 */
export async function createCore({ factory, wasm = null, files, keys, state = null, signals = 0, clock = null }) {
  const overrides = { print() {}, printErr() {} };
  if (wasm) {
    overrides.instantiateWasm = (imports, done) => {
      WebAssembly.instantiate(wasm, imports).then((r) => done(r.instance, r.module), (e) => { throw e; });
      return {};
    };
  }
  const M = await factory(overrides);
  return new Core(M, { files, keys, state, signals, clock });
}

export class Core {
  constructor(M, { files, keys, state, signals, clock }) {
    this.M = M;
    this.files = files;
    this.keys = keys;
    this.clock = clock || { wall: () => Date.now(), boot: () => (globalThis.performance ? performance.now() : Date.now()) };
    this.bootId = randomBytes(32);
    this.state = state;
    this.saves = 0; // how many times the Core saved its state (lease-store.js keeps the newest)
    this.fnErr = null; // the first exception a callback swallowed (for the call's error message)
    this._streamCb = new Map();
    const u8 = () => M.HEAPU8;
    const str = (p) => (p ? this.cstr(p) : null);
    const guard = (f, bad) => (...a) => { try { return f(...a); } catch (e) { if (!this.fnErr) this.fnErr = e; return bad; } };
    const fp = {
      size: M.addFunction(guard((u, form, path) => BigInt(this.files.size(form, str(path))), -1n), 'jiii'),
      read: M.addFunction(guard((u, form, path, off, buf, len) => this.files.read(form, str(path), Number(off), u8().subarray(buf, buf + len)) ? 0 : -1, -1), 'iiiijii'),
      write: M.addFunction(guard((u, form, path, off, buf, len) => this.files.write(form, str(path), Number(off), u8().slice(buf, buf + len)) ? 0 : -1, -1), 'iiiijii'),
      commit: M.addFunction(guard((u, form, path) => (this.files.commit(form, str(path)) ? 0 : -1), -1), 'iiii'),
      remove: M.addFunction(guard((u, form, path) => (this.files.remove(form, str(path)) ? 0 : -1), -1), 'iiii'),
      wall: M.addFunction(guard(() => BigInt(Math.floor(this.clock.wall())), 0n), 'ji'),
      boot: M.addFunction(guard((u, bid) => { u8().set(this.bootId, bid); return BigInt(Math.floor(this.clock.boot())); }, 0n), 'jii'),
      random: M.addFunction(guard((u, buf, len) => { u8().set(randomBytes(len), buf); return 0; }, -1), 'iiii'),
      agree: M.addFunction(guard((u, eph, n, z) => {
        const out = this.keys.agreeSync(u8().slice(eph, eph + n));
        if (!out || out.length !== 32) return -1;
        u8().set(out, z);
        return 0;
      }, -1), 'iiiii'),
      sign: M.addFunction(guard((u, msg, n, sig, lenp) => {
        const out = this.keys.signSync(u8().slice(msg, msg + n));
        if (!out || out.length > 72) return -1;
        u8().set(out, sig);
        new DataView(u8().buffer).setUint32(lenp, out.length, true);
        return 0;
      }, -1), 'iiiiii'),
      save: M.addFunction(guard((u, blob, n) => { this.state = u8().slice(blob, blob + n); this.saves++; }, undefined), 'viii'),
    };
    this._fp = fp;
    const spki = keys.spki;
    this._spki = this._alloc(spki.length);
    u8().set(spki, this._spki);
    const p = M._malloc(PLATFORM_SIZE);
    u8().fill(0, p, p + PLATFORM_SIZE);
    const dv = new DataView(u8().buffer);
    const put = (off, v) => dv.setUint32(p + off, v >>> 0, true);
    put(0, PLATFORM_SIZE); put(4, 0);
    put(8, fp.size); put(12, fp.read); put(16, fp.write); put(20, fp.commit); put(24, fp.remove);
    put(28, fp.wall); put(32, fp.boot); put(36, fp.random); put(40, fp.agree); put(44, 0); put(48, fp.sign); put(52, fp.save);
    put(56, this._spki); put(60, spki.length); put(64, 0); put(68, 0); put(72, signals >>> 0);
    this._platform = p;
    const st = state && state.length ? this._bytes(state) : 0;
    const status = this._alloc(4);
    this.ptr = M._qlc_create(p, st, state ? state.length : 0, status);
    const rc = this._i32(status);
    M._free(status);
    if (st) M._free(st);
    if (!this.ptr) throw new CoreError(rc, 0, 'qlc_create');
    this.version = this.cstr(M._qlc_version());
    this.notice = this.cstr(M._qlc_notice());
    this.model = 0;
    this.stream = 0;
  }

  // ---- memory helpers ----
  _alloc(n) { const p = this.M._malloc(Math.max(1, n)); if (!p) throw new CoreError(QLC.E_NOMEM, 0, 'malloc'); return p; }
  _bytes(b) { const p = this._alloc(b.length); this.M.HEAPU8.set(b, p); return p; }
  _cstr(s) { const b = utf8(s); const p = this._alloc(b.length + 1); this.M.HEAPU8.set(b, p); this.M.HEAPU8[p + b.length] = 0; return p; }
  cstr(p) { const h = this.M.HEAPU8; let e = p; while (h[e]) e++; return fromUtf8(h.subarray(p, e)); }
  _dv() { return new DataView(this.M.HEAPU8.buffer); }
  _i32(p) { return this._dv().getInt32(p, true); }
  _i64(p) { return Number(this._dv().getBigInt64(p, true)); }
  _with(ptrs, f) { try { return f(); } finally { for (const p of ptrs) if (p) this.M._free(p); } }
  _check(rc, where) {
    if (rc >= 0) { this.fnErr = null; return rc; }
    const e = new CoreError(rc, this.M._qlc_detail(this.ptr), where);
    if (this.fnErr) { e.cause = this.fnErr; this.fnErr = null; }
    throw e;
  }
  get detail() { return this.M._qlc_detail(this.ptr); }
  get installHex() { return this.keys.installHex; }

  // ---- the lease (18.4.4 to 18.4.10) ----
  /** The `core` object of POST /v1/model-key and install_sig. The signature is prepared first (async). */
  async leaseAsk(challenge, build) {
    await this.keys.prepareSign(utf8(`quranlab-lease-ask 1\n${challenge}\n${build}\n`));
    const c = this._cstr(challenge), b = this._cstr(build), out = this._alloc(512), sig = this._alloc(160);
    return this._with([c, b, out, sig], () => {
      this._check(this.M._qlc_lease_ask(this.ptr, c, b, out, 512, sig, 160), 'qlc_lease_ask');
      return { core: JSON.parse(this.cstr(out)), installSig: this.cstr(sig) };
    });
  }

  /** install_sig of POST /v1/attest (18.4.3): over the challenge, or "-" for a web page session. */
  async attestSig(challenge = null) {
    await this.keys.prepareSign(utf8(`quranlab-attest 1\n${challenge || '-'}\n${this.keys.installHex}\n`));
    const c = challenge ? this._cstr(challenge) : 0, sig = this._alloc(160);
    return this._with([c, sig], () => {
      this._check(this.M._qlc_attest_sig(this.ptr, c, sig, 160), 'qlc_attest_sig');
      return this.cstr(sig);
    });
  }

  /**
   * The site the frame verified (the handshake's event.origin, checked against ancestorOrigins): a web lease (version
   * 2) is accepted only for the site it names (spec fix 15, quranlab-core 88e06c9). A Core without the call (before
   * 4a5663c) takes none.
   */
  setSite(origin) {
    if (typeof this.M._qlc_set_site !== 'function') return false;
    const p = origin ? this._cstr(origin) : 0;
    return this._with([p], () => { this._check(this.M._qlc_set_site(this.ptr, p), 'qlc_set_site'); return true; });
  }

  /** The lease's ephemeral key: the Core's own reader (qlc_lease_eph) where it has one, else this file's. */
  eph(lease) {
    if (typeof this.M._qlc_lease_eph !== 'function') return leaseEph(lease);
    const l = this._bytes(lease), o = this._alloc(65);
    return this._with([l, o], () => { const n = this.M._qlc_lease_eph(l, lease.length, o, 65); return n > 0 ? this.M.HEAPU8.slice(o, o + n) : null; });
  }

  /** The binary lease of the answer, for this build and its signed manifest: { exp, refreshAfter }. */
  async leaseAccept(lease, manifest, build) {
    await this.keys.prepareAgree(this.eph(lease));
    const l = this._bytes(lease), m = this._bytes(manifest), b = this._cstr(build), o = this._alloc(16);
    return this._with([l, m, b, o], () => {
      this._check(this.M._qlc_lease_accept(this.ptr, l, lease.length, m, manifest.length, b, o, o + 8), 'qlc_lease_accept');
      return { exp: this._i64(o), refreshAfter: this._i64(o + 8) };
    });
  }

  /** A refusal body of the lease route: true when it was a verified stop (the lease and the files are gone). */
  refusalAccept(bodyText, apiKeyId) {
    const b = this._bytes(utf8(bodyText)), k = this._cstr(apiKeyId);
    return this._with([b, k], () => {
      const rc = this.M._qlc_refusal_accept(this.ptr, b, utf8(bodyText).length, k);
      if (rc === QLC.E_STOPPED) return true;
      this._check(rc, 'qlc_refusal_accept');
      return false;
    });
  }

  /**
   * A lease attempt that brought no lease (18.4.7.1): QLC_ATTEMPT_UNREACHABLE (1) or QLC_ATTEMPT_REFUSED (2). Returns
   * the Core's status (QLC_OK, QLC_E_NEEDS_CONNECTION without a lease, QLC_E_STOPPED after a verified stop); a Core
   * before c3 (no grace) takes nothing and returns null.
   */
  leaseAttempt(outcome) {
    if (typeof this.M._qlc_lease_attempt !== 'function') return null;
    return this.M._qlc_lease_attempt(this.ptr, outcome === 'refused' || outcome === 2 ? 2 : 1);
  }

  /** { inGrace, until (exp + 86400 while a lease is held, else 0; the Core's clock) } (18.4.7.1); a Core before c3:
   * never in grace. */
  leaseGrace() {
    if (typeof this.M._qlc_lease_grace !== 'function') return { inGrace: false, until: 0 };
    const o = this._alloc(8);
    return this._with([o], () => {
      const rc = this.M._qlc_lease_grace(this.ptr, o);
      return { inGrace: rc === 1, until: this._i64(o) };
    });
  }

  piece(bytes) {
    const p = this._bytes(bytes);
    return this._with([p], () => this._check(this.M._qlc_lease_piece(this.ptr, p, bytes.length), 'qlc_lease_piece'));
  }

  tick() {
    const o = this._alloc(LEASE_STATUS_SIZE);
    return this._with([o], () => {
      this._check(this.M._qlc_tick(this.ptr, o), 'qlc_tick');
      const dv = this._dv();
      return { hasLease: !!dv.getInt32(o, true), valid: !!dv.getInt32(o + 4, true), refreshDue: !!dv.getInt32(o + 8, true),
        stopped: !!dv.getInt32(o + 12, true), now: this._i64(o + 16), exp: this._i64(o + 24), refreshAfter: this._i64(o + 32) };
    });
  }

  usage() {
    const o = this._alloc(32);
    return this._with([o], () => {
      this._check(this.M._qlc_usage(this.ptr, o, o + 8, o + 16, o + 24), 'qlc_usage');
      const dv = this._dv();
      return { day: this._i64(o), seconds: dv.getFloat64(o + 8, true), prevDay: this._i64(o + 16), prevSeconds: dv.getFloat64(o + 24, true) };
    });
  }

  // ---- install and model ----
  /** CDN form to device form for one decoded path (the agreement for the held lease is prepared already). */
  install(manifest, decodedPath) {
    const m = this._bytes(manifest), p = this._cstr(decodedPath);
    return this._with([m, p], () => this._check(this.M._qlc_install(this.ptr, m, manifest.length, p), `qlc_install ${decodedPath}`));
  }

  openModel(manifest, { context = null, threads = 0, decryptThreads = 0, sampleRate = 16000 } = {}) {
    if (this.model) throw new CoreError(QLC.E_BUSY, 0, 'qlc_model_open');
    const m = this._bytes(manifest), c = context ? this._cstr(context) : 0, o = this._alloc(OPEN_OPTIONS_SIZE), st = this._alloc(4);
    return this._with([m, c, o, st], () => {
      const dv = this._dv();
      [OPEN_OPTIONS_SIZE, c, threads, decryptThreads, sampleRate, 1, -1].forEach((v, i) => dv.setInt32(o + 4 * i, v, true));
      const h = this.M._qlc_model_open(this.ptr, m, manifest.length, o, st);
      if (!h) this._check(this._i32(st) || QLC.E_ENGINE, 'qlc_model_open');
      this.model = h;
      this.modelRate = sampleRate;
      return h;
    });
  }

  closeModel() {
    this.endStream();
    if (this.model) { this.M._qlc_model_close(this.model); this.model = 0; }
  }

  chunkMs() { return this.model ? this.M._qlc_model_chunk_ms(this.model) : 0; }

  calibration() {
    if (!this.model) return null;
    const n = this._alloc(4);
    return this._with([n], () => {
      const p = this.M._qlc_calibration(this.model, n);
      return p ? this.M.HEAPU8.slice(p, p + this._dv().getUint32(n, true)) : null;
    });
  }

  // ---- streams: outputs only ----
  /** One stream; onChunk gets { n40, n20, vocab, heads: { name: Float32Array } } per engine chunk. */
  startStream(mask, onChunk) {
    this.endStream();
    const st = this._alloc(4);
    const s = this._with([st], () => {
      const h = this.M._qlc_stream_create(this.model, st);
      if (!h) this._check(this._i32(st) || QLC.E_ENGINE, 'qlc_stream_create');
      return h;
    });
    this.stream = s;
    this._check(this.M._qlc_stream_set_heads(s, mask), 'qlc_stream_set_heads');
    if (!this._chunkFn) {
      this._chunkFn = this.M.addFunction((user, hp) => {
        const cb = this._streamCb.get(user);
        if (cb) { try { cb(this._readHeads(hp)); } catch (e) { if (!this.fnErr) this.fnErr = e; } }
      }, 'vii');
    }
    this._streamCb.clear();
    this._streamCb.set(s, onChunk);
    this.M._qlc_stream_set_callback(s, this._chunkFn, s);
    return s;
  }

  _readHeads(hp) {
    const dv = this._dv();
    const n40 = dv.getInt32(hp, true), n20 = dv.getInt32(hp + 4, true), vocab = dv.getInt32(hp + 8, true);
    const heads = {};
    HEADS.forEach(([name, width, rate], i) => {
      const p = dv.getUint32(hp + 12 + 4 * i, true);
      if (!p) return;
      const n = (rate === 40 ? n40 : n20) * (name.endsWith('log_probs') ? vocab : width);
      heads[name] = new Float32Array(this.M.HEAPU8.buffer.slice(p, p + 4 * n));
    });
    return { n40, n20, vocab, heads };
  }

  /** Mono float audio at the model's rate into the stream; chunks arrive through onChunk during the call. */
  push(samples) {
    if (!this.stream) throw new CoreError(QLC.E_ARG, 0, 'qlc_stream_push');
    const n = samples.length;
    if (!this._pcm || this._pcmN < n) { if (this._pcm) this.M._free(this._pcm); this._pcm = this._alloc(4 * n); this._pcmN = n; }
    this.M.HEAPU8.set(new Uint8Array(samples.buffer, samples.byteOffset, 4 * n), this._pcm);
    return this._check(this.M._qlc_stream_push(this.stream, this._pcm, n), 'qlc_stream_push');
  }

  finish() { return this._check(this.M._qlc_stream_finish(this.stream), 'qlc_stream_finish'); }

  greedy() {
    const n = this.M._qlc_stream_greedy(this.stream, 0, 0);
    if (n <= 0) return [];
    const p = this._alloc(4 * n);
    return this._with([p], () => {
      const k = this.M._qlc_stream_greedy(this.stream, p, n);
      return Array.from(new Int32Array(this.M.HEAPU8.buffer.slice(p, p + 4 * Math.min(n, k))));
    });
  }

  endStream() {
    if (this.stream) { this._streamCb.delete(this.stream); this.M._qlc_stream_destroy(this.stream); this.stream = 0; }
  }

  // ---- the recited range (SDK 3.2, contract draft 17.1 and 17.6): the journal is the Core's ----
  recitedIndex(manifest) {
    const m = this._bytes(manifest);
    return this._with([m], () => this._check(this.M._qlc_recited_index(this.ptr, m, manifest.length), 'qlc_recited_index'));
  }
  /** 1 when that take id is finished already (it counts once). */
  recitedBegin(takeId) { return this._check(this.M._qlc_recited_begin(this.ptr, BigInt(takeId)), 'qlc_recited_begin'); }
  /** The id of a take left open (a page closed or killed mid-take), or null. */
  recitedOpen() {
    const p = this._alloc(8);
    return this._with([p], () => (this._check(this.M._qlc_recited_open(this.ptr, p), 'qlc_recited_open') === 1 ? this._i64(p) : null));
  }
  recitedFeedStream() { return this._check(this.M._qlc_recited_feed_stream(this.ptr, this.stream), 'qlc_recited_feed_stream'); }
  /**
   * { found, surah, first, last, score, day, context, ties, reported }; the same take id again gives the stored result,
   * counted once. qlc_recited_result at 4a5663c: five ints, then the take's UTC day (int64 at 24), context, ties,
   * reported (48 bytes); an older Core writes the first 20 and the rest reads 0.
   */
  recitedFinish(takeId, flags = 0) {
    const o = this._alloc(48);
    this.M.HEAPU8.fill(0, o, o + 48);
    return this._with([o], () => {
      this._check(this.M._qlc_recited_finish(this.ptr, BigInt(takeId), flags, o), 'qlc_recited_finish');
      const dv = this._dv();
      return { found: !!dv.getInt32(o, true), surah: dv.getInt32(o + 4, true), first: dv.getInt32(o + 8, true), last: dv.getInt32(o + 12, true),
        score: dv.getInt32(o + 16, true), day: this._i64(o + 24), context: !!dv.getInt32(o + 32, true), ties: dv.getInt32(o + 36, true),
        reported: !!dv.getInt32(o + 40, true) };
    });
  }

  /** The open model's vocabulary (R4: qlc_model_token_name), or null on a Core without it. */
  tokenNames() {
    if (!this.model || typeof this.M._qlc_model_token_count !== 'function') return null;
    const n = this.M._qlc_model_token_count(this.model);
    if (!(n > 0)) return null;
    const out = [];
    for (let i = 0; i < n; i++) { const p = this.M._qlc_model_token_name(this.model, i); out.push(p ? this.cstr(p) : null); }
    return out;
  }

  /** One ayah's expected units (R3): { units, words (each unit's word index), wordCount }, or null when the table does
   * not have the ayah. The first call reads the reference data (a lease is needed then). */
  referenceExpected(surah, ayah) {
    if (!this.model || typeof this.M._qlc_reference_expected !== 'function') throw new CoreError(QLC.E_FILE, 0, 'qlc_reference_expected');
    const MAXU = 4096, MAXW = 512;
    const u = this._alloc(4 * MAXU), w = this._alloc(4 * MAXW), nw = this._alloc(4);
    return this._with([u, w, nw], () => {
      const n = this.M._qlc_reference_expected(this.model, surah, ayah, u, MAXU, w, MAXW, nw);
      if (n === QLC.E_ARG) return null;
      this._check(n, 'qlc_reference_expected');
      const units = Array.from(new Int32Array(this.M.HEAPU8.buffer.slice(u, u + 4 * Math.min(n, MAXU))));
      const wc = Math.min(this._i32(nw), MAXW);
      const starts = Array.from(new Int32Array(this.M.HEAPU8.buffer.slice(w, w + 4 * wc)));
      const words = units.map((_, k) => { let x = 0; while (x + 1 < starts.length && starts[x + 1] <= k) x++; return x; });
      return { units, words, wordCount: wc };
    });
  }
  recitedTotals() {
    const o = this._alloc(40);
    return this._with([o], () => {
      this._check(this.M._qlc_recited_totals(this.ptr, o, o + 8, o + 12, o + 16, o + 24, o + 28), 'qlc_recited_totals');
      const dv = this._dv();
      return { day: this._i64(o), takes: dv.getInt32(o + 8, true), ayahs: dv.getInt32(o + 12, true), prevDay: this._i64(o + 16),
        prevTakes: dv.getInt32(o + 24, true), prevAyahs: dv.getInt32(o + 28, true) };
    });
  }

  destroy() {
    if (!this.ptr) return;
    this.closeModel();
    this.M._qlc_destroy(this.ptr);
    this.ptr = 0;
    if (this._pcm) this.M._free(this._pcm);
    this.M._free(this._platform);
    this.M._free(this._spki);
    this.state = null;
  }
}

/** The ephemeral public key of a binary lease (18.4.6), read to prepare the one agreement the Core will ask for. */
export function leaseEph(lease) {
  let o = 140; // magic 4, version 2, flags 2, lease_id 16, iat/exp/refresh_after 24, key_id 16, build 20, install 32, mark 24
  const strings = lease.length > 5 && (lease[4] | (lease[5] << 8)) === 2 ? 4 : 3; // version 2: the site after the release
  for (let i = 0; i < strings; i++) { if (o >= lease.length) return null; o += 1 + lease[o]; }
  if (o + 3 > lease.length || lease[o] !== 1) return null; // only wrap 1 (ECDH) on web
  const n = lease[o + 1] | (lease[o + 2] << 8);
  return lease.slice(o + 3, o + 3 + n);
}

export { hex };
