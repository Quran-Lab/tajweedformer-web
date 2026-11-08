// The JS side of the TajweedFormer engine binding: calls the wasm module's zft_* exports
// (src/zft_api.c, thin wrappers over the engine's zf_tajweed.h) and turns its structs into JS objects.
//
// The module must export, besides the zft_* functions: _malloc, _free, HEAPU8, HEAP32, HEAPF32,
// HEAPF64, UTF8ToString, stringToNewUTF8 and FS (mkdir, writeFile, unlink, rmdir). Heap views are
// read fresh on every access because memory can grow during any call.
//
// STATUS: scoring is checked against the reference verdicts with the engine's real scorer built
// by Emscripten (dist/tajweedformer-scorer, test/tajweed_vectors.test.mjs); streams only against a
// mock engine compiled for wasm32 with clang (test/tajweed_engine.test.mjs), since the full engine
// build with the V4 streaming engine does not exist yet.

import { HEAD_SPECS, VOCAB, MADD_CLASSES } from './heads.js';
import { decode, decodeFrames, topK, RANKED_HEADS } from './decode.js';
import { CLASSES, CHECKS, PRESETS, ITEM_CHECK } from './settings.js';

const STATUSES = ['off', 'experimental', 'validated'];
const SOURCES = ['calibration', 'remote', 'app'];

// zft_layout(): field names in the order src/zft_api.c lists them, each block led by the struct's size
const LAYOUT = [
  ['heads', ['n40', 'n20', 'vocab', ...HEAD_SPECS.map((s) => s.name)]],
  ['site', ['cls', 'status', 'pos', 'word', 'expected', 'alt', 'llr_final', 'llr_inter1', 'llr', 'threshold', 'flagged',
    'frame_lo', 'frame_hi']],
  ['madd', ['pos', 'word', 'token', 'madd_class', 'status', 'ratio', 'count', 'display_count', 'allowed_lo', 'allowed_hi',
    'flagged', 'frame_lo', 'frame_hi']],
  ['letter', ['pos', 'word', 'token', 'status', 'score', 'threshold', 'flagged', 'frame_lo', 'frame_hi']],
  ['summary', ['n_sites', 'n_flagged', 'n_madd', 'n_madd_flagged', 'n_qalqalah', 'n_qalqalah_flagged', 'n_gemination',
    'n_gemination_flagged', 'short_vowel_frames', 'madd_unit_ok']],
  ['effective', ['preset', 'preset_source', 'class_enabled', 'class_status', 'class_threshold', 'class_source',
    'check_enabled', 'check_status', 'check_source', 'context', 'context_source']],
  ['wordsettings', ['struct_size', 'available', 'status', 'enabled', 'enabled_source', 'preset', 'preset_source', 'threshold',
    'floor', 'custom_lo', 'custom_hi', 'preset_tau']],
  ['word', ['word', 'tok_lo', 'tok_hi', 'has_score', 'score', 'threshold', 'flagged', 'cls', 'edit', 'edit_pos', 'expected', 'alt',
    'llr_final', 'llr_inter1']],
  ['top2', ['token', 'runner_up', 'log_prob', 'runner_up_log_prob', 'margin']],
  ['openoptions', ['context', 'batch', 'no_pin']],
];
const LAYOUT_VERSION = 3;
/** ZF_TAJWEED_HEAD_* bits by graph name (zf_tajweed.h API 3): the heads a stream computes. */
export const HEAD_BITS = Object.freeze({ log_probs: 1, inter1_log_probs: 2, inter4_log_probs: 4, id_log_probs: 8, timing_log_probs: 16,
  gem: 32, attr_tafkheem: 64, attr_ghunna: 128, attr_qalqalah: 256, attr_face: 512, boundary: 1024, conf: 2048 });
export const HEADS_ALL = 4095;
/** The heads mask of a set of names (null: all twelve). log_probs is always computed. */
export function headsMask(keep) {
  if (!keep) return HEADS_ALL;
  let m = HEAD_BITS.log_probs;
  for (const n of keep) m |= HEAD_BITS[n] || 0;
  return m;
}
const WORD_PRESET_NAMES = ['strict', 'general', 'beginner'];
const EDITS = ['sub', 'del', 'ins'];

/** Whether an instantiated module carries the V4 engine binding. */
export function hasTajweedEngine(m) {
  return !!(m && typeof m._zft_model_open === 'function' && typeof m._zft_layout === 'function');
}

let stageSeq = 0;

/** One module's binding. Not thread-safe (nor is the module). */
export class TajweedEngine {
  constructor(m) {
    if (!hasTajweedEngine(m)) throw new Error('the module has no zft_* exports');
    this.m = m;
    this.apiVersion = m._zft_api_version();
    this.version = this.str(m._zft_version());
    const n = m._zft_layout_count();
    const at = m._zft_layout() >> 2;
    const t = Array.from(m.HEAP32.subarray(at, at + n));
    if (t[0] !== LAYOUT_VERSION) throw new Error(`zft_layout version ${t[0]}, this SDK reads ${LAYOUT_VERSION}`);
    const want = 2 + LAYOUT.reduce((k, [, f]) => k + 1 + f.length, 0);
    if (n !== want) throw new Error(`zft_layout has ${n} entries, this SDK expects ${want}`);
    this.layout = {};
    let i = 2;
    for (const [name, fields] of LAYOUT) {
      const o = { size: t[i++] };
      for (const f of fields) o[f] = t[i++];
      this.layout[name] = o;
    }
    this.liveStream = null;
  }

  // -- memory ------------------------------------------------------------------------------------
  str(ptr) { return ptr ? this.m.UTF8ToString(ptr) : ''; }
  cstr(s) { return s === null || s === undefined ? 0 : this.m.stringToNewUTF8(String(s)); }
  /** call fn with C strings for `strs` (null -> NULL), freeing them after */
  withStrings(strs, fn) {
    const ptrs = strs.map((s) => this.cstr(s));
    try { return fn(...ptrs); } finally { for (const p of ptrs) if (p) this.m._free(p); }
  }
  alloc(bytes) {
    const p = this.m._malloc(Math.max(8, bytes));
    if (!p) throw new Error('out of wasm memory');
    this.m.HEAPU8.fill(0, p, p + bytes);
    return p;
  }
  i32(p) { return this.m.HEAP32[p >> 2]; }
  f64(p) { return this.m.HEAPF64[p >> 3]; }
  error() { return this.str(this.m._zft_error()) || 'engine error'; }

  // -- the model folder in the module's file system -----------------------------------------------
  /**
   * Write the folder's files the engine reads into the module's in-memory file system: the root
   * files (tokens, calibration, the expected table) and, unless engineFiles is false (a scoring-only
   * model), the chosen context's folder. Every file goes
   * through folder.read, so it is a listed file whose size and SHA-256 were checked. The files stay
   * while the model is open (the engine opens its graph when a stream is made).
   */
  async stage(folder, context, { engineFiles = true, paths: only = null } = {}) {
    const dir = `/tajweedformer/${++stageSeq}`;
    const paths = (only || folder.paths).filter((p) => p !== 'manifest.json' &&
      (!p.includes('/') || (engineFiles && (only ? true : p.startsWith(context + '/')))));
    const made = new Set();
    const mkdirs = (full) => {
      let cur = '';
      for (const part of full.split('/').filter(Boolean)) {
        cur += '/' + part;
        if (made.has(cur)) continue;
        try { this.m.FS.mkdir(cur); } catch (_) { /* exists */ }
        made.add(cur);
      }
    };
    const written = [];
    for (const p of paths) {
      const full = `${dir}/${p}`;
      mkdirs(full.slice(0, full.lastIndexOf('/')));
      this.m.FS.writeFile(full, await folder.read(p));
      written.push(full);
    }
    return { dir, files: written, dirs: [...made].filter((d) => d.startsWith(dir)).sort((a, b) => b.length - a.length) };
  }

  unstage(staged) {
    if (!staged) return;
    for (const f of staged.files) { try { this.m.FS.unlink(f); } catch (_) { /* gone */ } }
    for (const d of staged.dirs) { try { this.m.FS.rmdir(d); } catch (_) { /* not empty or gone */ } }
  }

  openModel(dir, { context = null, loadEngine = true, threads = 0, sampleRate = 0 } = {}) {
    const p = this.withStrings([dir, context], (d, c) => this.m._zft_model_open(d, c, loadEngine ? 1 : 0, threads | 0,
      sampleRate === 16000 ? 0 : sampleRate | 0));
    if (!p) throw new Error(`zf_tajweed_model_open: ${this.error()}`);
    return p;
  }
  closeModel(p) { if (p) this.m._zft_model_close(p); }
  modelContext(p) { return this.str(this.m._zft_model_context(p)); }
  modelId(p) { return this.str(this.m._zft_model_id(p)); }
  chunkMs(p) { return this.m._zft_model_chunk_ms(p); }
  ayahCount(p, surah) { return this.m._zft_ayah_count(p, surah); }

  expected(p, surah, ayah) {
    const n = this.m._zft_expected(p, surah, ayah);
    if (n < 0) throw new RangeError(`${surah}:${ayah}: ${this.error()}`);
    const t = this.m._zft_expected_tokens_ptr() >> 2, w = this.m._zft_expected_words_ptr() >> 2;
    return {
      tokens: Int32Array.from(this.m.HEAP32.subarray(t, t + n)),
      wordOfToken: Int32Array.from(this.m.HEAP32.subarray(w, w + n)),
      words: this.m._zft_expected_n_words(),
    };
  }

  // -- heads <-> ZfTajweedHeads --------------------------------------------------------------------
  /** Copy a ZfTajweedHeads at `p` (frames [from40, from40 + n40) of it, and the matching 20 ms rows). */
  readHeads(p, from40 = 0, n40 = null, keep = null) {
    const L = this.layout.heads;
    const total40 = this.i32(p + L.n40);
    const count = n40 === null ? total40 - from40 : n40;
    const out = { n40: count, n20: 2 * count, vocab: VOCAB };
    for (const s of HEAD_SPECS) {
      const ptr = this.i32(p + L[s.name]) >>> 0;
      if (!ptr || (keep && !keep.has(s.name))) { out[s.key] = null; continue; }
      const per = s.width * (s.rate === 40 ? 1 : 2);
      const a = (ptr >> 2) + from40 * per;
      out[s.key] = this.m.HEAPF32.slice(a, a + count * per);
    }
    return out;
  }

  /** Write heads into the heap as a ZfTajweedHeads; returns { ptr, free() }. */
  writeHeads(h) {
    const L = this.layout.heads;
    const ptrs = [];
    const p = this.alloc(L.size);
    ptrs.push(p);
    this.m.HEAP32[(p + L.n40) >> 2] = h.n40;
    this.m.HEAP32[(p + L.n20) >> 2] = 2 * h.n40;
    this.m.HEAP32[(p + L.vocab) >> 2] = VOCAB;
    for (const s of HEAD_SPECS) {
      const a = h[s.key];
      if (!a) continue;
      const q = this.alloc(a.length * 4);
      ptrs.push(q);
      this.m.HEAPF32.set(a, q >> 2);
      this.m.HEAP32[(p + L[s.name]) >> 2] = q;
    }
    return { ptr: p, free: () => { for (const q of ptrs) this.m._free(q); } };
  }

  // -- config --------------------------------------------------------------------------------------
  configCreate(model) {
    const c = this.m._zft_config_create(model);
    if (!c) throw new Error(`zf_tajweed_config_create: ${this.error()}`);
    return c;
  }
  configDestroy(c) { if (c) this.m._zft_config_destroy(c); }

  /**
   * Put the JS settings' layers into an engine config: the debug flag, the remote block exactly as
   * the portal sent it, then the app layer. Returns what the engine would not take (an app setting
   * API version 1 has no setter for, such as a madd/qalqalah/gemination preset), as strings.
   */
  configSync(c, settings) {
    const m = this.m;
    const refused = [];
    m._zft_config_clear_app(c);
    m._zft_config_set_debug_build(c, settings.debug ? 1 : 0);
    // API 2: the heads' backend picks calibration's backend_overrides
    if (typeof m._zft_config_set_backend === 'function' && this.apiVersion >= 2) {
      this.withStrings([settings.backend], (p) => { if (m._zft_config_set_backend(c, p) !== 0) refused.push(`backend ${settings.backend}`); });
    } else if (settings.backend !== 'int8') {
      refused.push(`backend ${settings.backend} (an API 1 engine has no backend)`);
    }
    const remote = settings.remote;
    const rj = remote === null || remote === undefined ? null : JSON.stringify(remote);
    this.withStrings([rj], (p) => m._zft_config_set_remote(c, p));
    const app = settings.app;
    const call = (what, rc) => { if (rc !== 0) refused.push(what); };
    if (app.context) this.withStrings([app.context], (p) => call(`context ${app.context}`, m._zft_config_set_context(c, p)));
    if (app.preset) this.withStrings([app.preset], (p) => call(`preset ${app.preset}`, m._zft_config_set_preset(c, p)));
    for (const [cls, o] of Object.entries(app.overrides || {})) {
      if (Object.prototype.hasOwnProperty.call(o, 'threshold')) {
        this.withStrings([cls], (k) => call(`overrides.${cls}.threshold`, m._zft_config_set_class_threshold(c, k, o.threshold)));
      } else {
        this.withStrings([cls, o.preset], (k, v) => call(`overrides.${cls}.preset`, m._zft_config_set_class_preset(c, k, v)));
      }
    }
    for (const [check, on] of Object.entries(app.checks || {})) {
      this.withStrings([check], (k) => call(`checks.${check}`, m._zft_config_set_check(c, k, on ? 1 : 0)));
    }
    // API 3: the word level
    if (app.word) {
      if (typeof m._zft_config_set_word_preset !== 'function') refused.push('word (the engine has no API 3)');
      else if (Object.prototype.hasOwnProperty.call(app.word, 'threshold')) call('word.threshold', m._zft_config_set_word_threshold(c, app.word.threshold));
      else this.withStrings([app.word.preset], (p) => call('word.preset', m._zft_config_set_word_preset(c, p)));
    }
    return refused;
  }

  /** The engine's resolved settings as its zf_tajweed_config_json (API 2: TAJWEED_SETTINGS.md rev 2's
   * layout), parsed; null when it is not JSON. */
  configJson(c) {
    const t = this.str(this.m._zft_config_json(c));
    try { return t ? JSON.parse(t) : null; } catch (_) { return null; }
  }

  /** The engine's resolved settings (ZfTajweedEffective) with names spelled out. */
  configEffective(c) {
    const L = this.layout.effective;
    const p = this.alloc(L.size);
    try {
      if (this.m._zft_config_effective(c, p) !== 0) throw new Error(`zf_tajweed_config_effective: ${this.error()}`);
      const ints = (off, n) => Array.from(this.m.HEAP32.subarray((p + off) >> 2, ((p + off) >> 2) + n));
      const dbl = (off, n) => Array.from(this.m.HEAPF64.subarray((p + off) >> 3, ((p + off) >> 3) + n));
      const nc = CLASSES.length, nk = CHECKS.length;
      const en = ints(L.class_enabled, nc), st = ints(L.class_status, nc), th = dbl(L.class_threshold, nc), so = ints(L.class_source, nc);
      const ce = ints(L.check_enabled, nk), cs = ints(L.check_status, nk), cso = ints(L.check_source, nk);
      const ctxBytes = this.m.HEAPU8.subarray(p + L.context, p + L.context + 16);
      const z = ctxBytes.indexOf(0);
      return {
        preset: PRESETS[this.i32(p + L.preset)] || null,
        presetSource: SOURCES[this.i32(p + L.preset_source)] || null,
        classes: Object.fromEntries(CLASSES.map((cls, i) => [cls, { enabled: en[i] !== 0, status: STATUSES[st[i]] || null,
          threshold: th[i], source: SOURCES[so[i]] || null }])),
        checks: Object.fromEntries(CHECKS.map((k, i) => [k, { enabled: ce[i] !== 0, status: STATUSES[cs[i]] || null,
          source: SOURCES[cso[i]] || null }])),
        context: new TextDecoder().decode(ctxBytes.subarray(0, z < 0 ? 16 : z)),
        contextSource: SOURCES[this.i32(p + L.context_source)] || null,
      };
    } finally {
      this.m._free(p);
    }
  }

  /** API 3: the engine's word level (ZfTajweedWordSettings), names spelled out; null without API 3. */
  configWord(c) {
    if (typeof this.m._zft_config_word !== 'function') return null;
    const L = this.layout.wordsettings;
    const p = this.alloc(L.size);
    try {
      if (this.m._zft_config_word(c, p) !== 0) return null;
      const g = (k) => this.i32(p + L[k]);
      if (!g('available')) return { available: false };
      const pr = g('preset');
      return { available: true, status: STATUSES[g('status')] || null, enabled: g('enabled') !== 0, enabledSource: SOURCES[g('enabled_source')] || null,
        preset: pr < 0 ? 'custom' : WORD_PRESET_NAMES[pr] || null, source: SOURCES[g('preset_source')] || null, tau: this.f64(p + L.threshold),
        floor: this.f64(p + L.floor), customLo: this.f64(p + L.custom_lo), customHi: this.f64(p + L.custom_hi),
        presetTau: Object.fromEntries(WORD_PRESET_NAMES.map((n, i) => [n, this.f64(p + L.preset_tau + 8 * i)])) };
    } finally {
      this.m._free(p);
    }
  }

  /** P2.16: zf_tajweed_stream_topk for a kept head, shaped as decode.js topK (margins as doubles from the
   * float values: the engine is asked one rank deeper than k so the last margin has its partner). */
  streamTopK(stream, head, k, tokens) {
    const m = this.m;
    const cols = RANKED_HEADS[head];
    if (!cols) throw new RangeError(`${head} has no ranking`);
    if (!(Number.isInteger(k) && k >= 1 && k <= cols)) throw new RangeError(`k must be 1..${cols}`);
    const kk = Math.min(cols, k + 1);
    // the frame count first (the engine wants an ids buffer even when it writes no frame)
    const probe = this.alloc(kk * 4);
    let frames;
    try { frames = m._zft_stream_topk(stream.s, HEAD_BITS[head], kk, probe, 0, 0, 0); } finally { m._free(probe); }
    if (frames < 0) return null; // not kept
    const ip = this.alloc(Math.max(1, frames * kk) * 4), vp = this.alloc(Math.max(1, frames * kk) * 4);
    try {
      if (m._zft_stream_topk(stream.s, HEAD_BITS[head], kk, ip, vp, 0, frames) < 0) return null;
      const ids = new Int32Array(frames * k), values = new Float32Array(frames * k), margins = new Float64Array(frames * k);
      const I = m.HEAP32.subarray(ip >> 2, (ip >> 2) + frames * kk), V = m.HEAPF32.subarray(vp >> 2, (vp >> 2) + frames * kk);
      for (let t = 0; t < frames; t++) {
        for (let j = 0; j < k; j++) {
          ids[t * k + j] = I[t * kk + j];
          values[t * k + j] = V[t * kk + j];
          margins[t * k + j] = j + 1 < kk ? V[t * kk + j] - V[t * kk + j + 1] : 0;
        }
      }
      const spec = HEAD_SPECS.find((h) => h.name === head);
      return { head, rate: spec.rate, names: cols === 38 ? tokens || null : spec.classes || null, frames, cols, k, ids, values, margins };
    } finally {
      m._free(ip); m._free(vp);
    }
  }

  // -- scoring -------------------------------------------------------------------------------------
  /** Score; returns the typed result (names spelled out) and the engine's JSON, then frees it. */
  score(model, config, heads, surah, ayah, tokens) {
    const hp = this.writeHeads(heads);
    let r = 0;
    try {
      r = this.m._zft_score(model, config, hp.ptr, surah, ayah);
      if (!r) throw new Error(`zf_tajweed_score ${surah}:${ayah}: ${this.error()}`);
      return this.readResult(r, tokens);
    } finally {
      if (r) this.m._zft_result_free(r);
      hp.free();
    }
  }

  readResult(r, tokens) {
    const unit = (id) => (Number.isInteger(id) && id >= 0 && id < tokens.length ? tokens[id] : null);
    const rows = (count, ptr, L, fn) => {
      const out = [];
      for (let i = 0; i < count; i++) out.push(fn(ptr + i * L.size, L));
      return out;
    };
    const S = this.layout.site, M = this.layout.madd, T = this.layout.letter, U = this.layout.summary;
    const ns = this.m._zft_result_sites(r);
    const sites = ns < 0 ? [] : rows(ns, this.m._zft_result_sites_ptr(), S, (p, L) => {
      const cls = CLASSES[this.i32(p + L.cls)] || null;
      const expected = this.i32(p + L.expected), alt = this.i32(p + L.alt);
      return {
        class: cls, check: ITEM_CHECK[cls] || null, status: STATUSES[this.i32(p + L.status)] || null,
        pos: this.i32(p + L.pos), word: this.i32(p + L.word),
        expected, expectedUnit: unit(expected), alternative: alt, alternativeUnit: unit(alt),
        llr: { final: this.f64(p + L.llr_final), inter1: this.f64(p + L.llr_inter1) },
        fusedLlr: this.f64(p + L.llr), threshold: this.f64(p + L.threshold), flagged: this.i32(p + L.flagged) !== 0,
        frameLo: this.i32(p + L.frame_lo), frameHi: this.i32(p + L.frame_hi),
      };
    });
    const nm = this.m._zft_result_madd(r);
    const madd = nm < 0 ? [] : rows(nm, this.m._zft_result_madd_ptr(), M, (p, L) => {
      const token = this.i32(p + L.token);
      return {
        pos: this.i32(p + L.pos), word: this.i32(p + L.word), token, unit: unit(token),
        maddClass: MADD_CLASSES[this.i32(p + L.madd_class)] || null, status: STATUSES[this.i32(p + L.status)] || null,
        ratio: this.f64(p + L.ratio), count: this.i32(p + L.count), displayCount: this.f64(p + L.display_count),
        allowedLo: this.i32(p + L.allowed_lo), allowedHi: this.i32(p + L.allowed_hi), flagged: this.i32(p + L.flagged) !== 0,
        frameLo: this.i32(p + L.frame_lo), frameHi: this.i32(p + L.frame_hi),
      };
    });
    const letters = (n, ptr) => (n < 0 ? [] : rows(n, ptr, T, (p, L) => {
      const token = this.i32(p + L.token);
      return {
        pos: this.i32(p + L.pos), word: this.i32(p + L.word), token, unit: unit(token),
        status: STATUSES[this.i32(p + L.status)] || null, score: this.f64(p + L.score), threshold: this.f64(p + L.threshold),
        flagged: this.i32(p + L.flagged) !== 0, frameLo: this.i32(p + L.frame_lo), frameHi: this.i32(p + L.frame_hi),
      };
    }));
    const nq = this.m._zft_result_qalqalah(r);
    const qalqalah = letters(nq, this.m._zft_result_qalqalah_ptr());
    const ng = this.m._zft_result_gemination(r);
    const gemination = letters(ng, this.m._zft_result_gemination_ptr());
    const sp = this.alloc(U.size);
    let summary;
    try {
      if (this.m._zft_result_summary(r, sp) !== 0) throw new Error(`zf_tajweed_result_summary: ${this.error()}`);
      const g = (k) => this.i32(sp + U[k]);
      summary = {
        sites: g('n_sites'), flagged: g('n_flagged'), madd: g('n_madd'), maddFlagged: g('n_madd_flagged'),
        qalqalah: g('n_qalqalah'), qalqalahFlagged: g('n_qalqalah_flagged'), gemination: g('n_gemination'),
        geminationFlagged: g('n_gemination_flagged'), shortVowelFrames: this.f64(sp + U.short_vowel_frames),
        maddUnitOk: g('madd_unit_ok') !== 0,
      };
    } finally {
      this.m._free(sp);
    }
    // API 3: the scored path and the words (none when the word check is off or calibration has no block)
    let path = null, words = [];
    if (typeof this.m._zft_result_words === 'function') {
      const np = this.m._zft_result_path(r);
      if (np > 0) {
        const t = this.m._zft_result_path_ptr() >> 2, w = this.m._zft_result_path_words_ptr() >> 2;
        path = { tokens: Int32Array.from(this.m.HEAP32.subarray(t, t + np)), wordOfToken: Int32Array.from(this.m.HEAP32.subarray(w, w + np)) };
      }
      const W = this.layout.word;
      const nw = this.m._zft_result_words(r);
      if (nw > 0) words = rows(nw, this.m._zft_result_words_ptr(), W, (p, L) => {
        const cls = this.i32(p + L.cls), has = this.i32(p + L.has_score) !== 0;
        const expected = this.i32(p + L.expected), alt = this.i32(p + L.alt);
        return {
          word: this.i32(p + L.word), tokLo: this.i32(p + L.tok_lo), tokHi: this.i32(p + L.tok_hi), hasScore: has,
          score: has ? this.f64(p + L.score) : null, threshold: this.f64(p + L.threshold), flagged: this.i32(p + L.flagged) !== 0,
          class: has ? CLASSES[cls] || null : null, edit: has ? EDITS[this.i32(p + L.edit)] || null : null, editPos: this.i32(p + L.edit_pos),
          expected, expectedUnit: unit(expected), alternative: alt, alternativeUnit: unit(alt),
          llr: { final: has ? this.f64(p + L.llr_final) : null, inter1: has ? this.f64(p + L.llr_inter1) : null },
        };
      });
    }
    const rawText = this.str(this.m._zft_result_json(r));
    let raw = null;
    try { raw = rawText ? JSON.parse(rawText) : null; } catch (_) { raw = null; }
    return { sites, madd, qalqalah, gemination, summary, raw, rawText, path, engineWords: words };
  }

  // -- streams -------------------------------------------------------------------------------------
  streamCreate(model) {
    if (this.liveStream) throw new Error('one TajweedFormer stream at a time (the engine allows one live stream); free the other first');
    const s = this.m._zft_stream_create(model);
    if (!s) throw new Error(`zf_tajweed_stream_create: ${this.error()}`);
    this.liveStream = s;
    return s;
  }
  streamDestroy(s) {
    if (!s) return;
    this.m._zft_stream_destroy(s);
    if (this.liveStream === s) this.liveStream = null;
  }
}

/** A stream over the engine (TajweedStream in index.d.ts). */
export class EngineStream {
  /**
   * @param {TajweedEngine} eng
   * @param {number} model
   * @param {{ onChunk?: Function|null, keep?: Set<string>|null, tokens?: string[]|null }} [opts]
   *        keep: the head names handed over and kept (null = all twelve); tokens: tokens.txt names
   */
  constructor(eng, model, { onChunk = null, keep = null, tokens = null } = {}) {
    this.eng = eng;
    this.s = eng.streamCreate(model);
    this.onChunk = onChunk;
    this.keep = keep;
    this.tokens = tokens;
    this.chunkMs = eng.chunkMs(model);
    this.per40 = Math.max(1, Math.round(this.chunkMs / 40)); // 40 ms frames a chunk: 8 at c16, 12 at c24
    this.seen40 = 0;
    this.chunkIndex = 0;
    this.inPtr = 0;
    this.inCap = 0;
    this.headsPtr = eng.alloc(eng.layout.heads.size);
    this.mask = headsMask(keep);
    this._applyHeads();
  }

  /** API 3: the engine computes only the heads asked for (a new stream computes the scorer's). */
  _applyHeads() {
    const m = this.eng.m;
    if (typeof m._zft_stream_set_heads === 'function' && m._zft_stream_set_heads(this.s, this.mask) !== 0) {
      throw new Error('zf_tajweed_stream_set_heads refused the selection (the take already has chunks)');
    }
  }

  /** The decoded layer's frames of the take so far, from the engine (zf_tajweed_stream_top2): top-1 and
   * runner-up with their log-probs; margin as the double difference of the two (API_LAYERS.md). */
  top2(from = 0, to = null) {
    const e = this.eng, m = e.m;
    if (typeof m._zft_stream_top2 !== 'function') return null;
    const n = m._zft_stream_top2(this.s);
    if (n < 0) throw new Error(`zf_tajweed_stream_top2: ${this.error()}`);
    const L = e.layout.top2, base = m._zft_stream_top2_ptr();
    const end = to === null ? n : Math.min(n, to);
    const out = new Array(Math.max(0, end - from));
    for (let t = from; t < end; t++) {
      const p = base + t * L.size;
      const la = m.HEAPF32[(p + L.log_prob) >> 2], lb = m.HEAPF32[(p + L.runner_up_log_prob) >> 2];
      out[t - from] = { top1: e.i32(p + L.token), top1LogProb: la, runnerUp: e.i32(p + L.runner_up), runnerUpLogProb: lb, margin: la - lb };
    }
    return out;
  }

  _live() { if (!this.s) throw new Error('the stream was freed'); }

  _emit(chunks) {
    if (!this.onChunk || chunks <= 0) return;
    const e = this.eng;
    if (e.m._zft_stream_heads(this.s, this.headsPtr) < 0) throw new Error(`zf_tajweed_stream_heads: ${this.error()}`);
    const total = e.i32(this.headsPtr + e.layout.heads.n40);
    while (this.seen40 + this.per40 <= total) {
      const h = e.readHeads(this.headsPtr, this.seen40, this.per40, this.keep);
      h.index = this.chunkIndex++;
      h.frame0 = this.seen40;
      h.startMs = 40 * this.seen40;
      h.endMs = 40 * (this.seen40 + this.per40);
      h.frames = this.top2(this.seen40, this.seen40 + this.per40) || (h.logProbs ? decodeFrames(h.logProbs, this.per40) : null);
      this.seen40 += this.per40;
      this.onChunk(h);
    }
  }

  error() { return this.s ? this.eng.str(this.eng.m._zft_stream_error(this.s)) || 'engine error' : 'freed'; }

  pushAudio(samples) {
    this._live();
    const e = this.eng, m = e.m;
    if (!(samples instanceof Float32Array)) throw new TypeError('pushAudio takes a Float32Array');
    if (samples.length > this.inCap) {
      if (this.inPtr) m._free(this.inPtr);
      this.inPtr = e.alloc(samples.length * 4);
      this.inCap = samples.length;
    }
    m.HEAPF32.set(samples, this.inPtr >> 2);
    const n = m._zft_stream_push_audio(this.s, this.inPtr, samples.length);
    if (n < 0) throw new Error(`zf_tajweed_stream_push_audio: ${this.error()}`);
    this._emit(n);
    return n;
  }

  finish() {
    this._live();
    const n = this.eng.m._zft_stream_finish(this.s);
    if (n < 0) throw new Error(`zf_tajweed_stream_finish: ${this.error()}`);
    this._emit(n);
    return n;
  }

  heads() {
    this._live();
    if (this.eng.m._zft_stream_heads(this.s, this.headsPtr) < 0) throw new Error(`zf_tajweed_stream_heads: ${this.error()}`);
    return this.eng.readHeads(this.headsPtr, 0, null, this.keep);
  }

  /** The decoded layer of the take so far (decode.js). */
  decoded({ k } = {}) {
    const h = this.heads();
    const frames = this.top2();
    return decode(h, { tokens: this.tokens, k, frames: frames && frames.length === h.n40 ? frames : undefined });
  }

  /** Top-K of a head the stream keeps (P2.16): the engine's zf_tajweed_stream_topk when the module has it,
   * else ranked here from the kept head; null when the head is not kept. */
  topK(head = 'log_probs', k = 2) {
    const m = this.eng.m;
    if (typeof m._zft_stream_topk === 'function') return this.eng.streamTopK(this, head, k, this.tokens);
    return topK(this.heads(), head, k, this.tokens);
  }

  greedy() {
    this._live();
    const m = this.eng.m;
    const n = m._zft_stream_greedy(this.s, 0, 0);
    if (n <= 0) return [];
    const p = this.eng.alloc(n * 4);
    try {
      m._zft_stream_greedy(this.s, p, n);
      return Array.from(m.HEAP32.subarray(p >> 2, (p >> 2) + n));
    } finally {
      m._free(p);
    }
  }

  reset() {
    this._live();
    this.eng.m._zft_stream_reset(this.s);
    this.seen40 = 0;
    this.chunkIndex = 0;
    this._applyHeads();
  }

  free() {
    if (!this.s) return;
    const m = this.eng.m;
    this.eng.streamDestroy(this.s);
    if (this.inPtr) m._free(this.inPtr);
    m._free(this.headsPtr);
    this.s = 0;
    this.inPtr = this.headsPtr = 0;
  }
}
