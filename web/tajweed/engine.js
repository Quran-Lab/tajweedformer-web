// The JS side of the TajweedFormer engine binding: calls the wasm module's zft_* exports
// (src/zft_api.c, thin wrappers over the engine's zf_tajweed.h) and turns its structs into JS objects.
// Inference only: the model, a stream, its heads, top-2 and top-K, and the reference table lookup.
//
// The module must export, besides the zft_* functions: _malloc, _free, HEAPU8, HEAP32, HEAPF32,
// HEAPF64, UTF8ToString, stringToNewUTF8 and FS (mkdir, writeFile, unlink, rmdir). Heap views are
// read fresh on every access because memory can grow during any call.
//
// Tested against the real engine built by Emscripten (test/conformance.test.mjs, bit-exact) and against a
// mock engine compiled for wasm32 with clang (test/engine_binding.test.mjs: layout and marshalling).

import { HEAD_SPECS, VOCAB } from './heads.js';
import { decode, decodeFrames, topK, RANKED_HEADS } from './decode.js';

// zft_layout(): field names in the order src/zft_api.c lists them, each block led by the struct's size
const LAYOUT = [
  ['heads', ['n40', 'n20', 'vocab', ...HEAD_SPECS.map((s) => s.name)]],
  ['top2', ['token', 'runner_up', 'log_prob', 'runner_up_log_prob', 'margin']],
  ['openoptions', ['context', 'batch', 'no_pin']],
];
const LAYOUT_VERSION = 4;
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
   * Write model files into the module's in-memory file system, under a staging directory: `files` is
   * [{ path, bytes }] with the manifest's paths. The caller hands over only listed files whose size and
   * SHA-256 were checked. Files can be added to the same staging later (another context, the reference
   * table); they stay until unstage.
   * @param {{dir: string, files: string[], dirs: string[]}|null} staged  an earlier staging to add to, or null
   */
  stage(staged, files) {
    const st = staged || { dir: `/tajweedformer/${++stageSeq}`, files: [], dirs: [] };
    const made = new Set(st.dirs);
    const mkdirs = (full) => {
      let cur = '';
      for (const part of full.split('/').filter(Boolean)) {
        cur += '/' + part;
        if (made.has(cur)) continue;
        try { this.m.FS.mkdir(cur); } catch (_) { /* exists */ }
        made.add(cur);
      }
    };
    for (const f of files) {
      const full = `${st.dir}/${f.path}`;
      if (st.files.includes(full)) continue;
      mkdirs(full.slice(0, full.lastIndexOf('/')));
      this.m.FS.writeFile(full, f.bytes);
      st.files.push(full);
    }
    st.dirs = [...made].filter((d) => d.startsWith(st.dir)).sort((a, b) => b.length - a.length);
    return st;
  }

  unstage(staged) {
    if (!staged) return;
    for (const f of staged.files) { try { this.m.FS.unlink(f); } catch (_) { /* gone */ } }
    for (const d of staged.dirs) { try { this.m.FS.rmdir(d); } catch (_) { /* not empty or gone */ } }
  }

  openModel(dir, { context = null, threads = 0, sampleRate = 0 } = {}) {
    const p = this.withStrings([dir, context], (d, c) => this.m._zft_model_open(d, c, threads | 0,
      sampleRate === 16000 ? 0 : sampleRate | 0));
    if (!p) throw new Error(`zf_tajweed_model_open: ${this.error()}`);
    return p;
  }
  closeModel(p) { if (p) this.m._zft_model_close(p); }
  modelContext(p) { return this.str(this.m._zft_model_context(p)); }
  chunkMs(p) { return this.m._zft_model_chunk_ms(p); }

  // -- the reference table (the expected units of each ayah; data, no link to the model) ----------
  /**
   * Open the reference table from its verified bytes (the engine copies them). Returns the SHA-256 (hex) of
   * the tokens.txt the table's ids refer to.
   */
  referenceOpen(bytes) {
    const m = this.m;
    const p = this.alloc(bytes.length);
    let rc;
    try { m.HEAPU8.set(bytes, p); rc = m._zft_reference_open(p, bytes.length); } finally { m._free(p); }
    if (rc !== 0) throw new Error(`zf_tajweed_reference_open_memory: ${this.error()}`);
    this.referenceIsOpen = true;
    const s = m._zft_reference_tokens_sha256();
    return s ? Array.from(m.HEAPU8.subarray(s, s + 32), (b) => b.toString(16).padStart(2, '0')).join('') : null;
  }
  /**
   * One ayah's units from the open table: { units: Int32Array, words: Int32Array (each unit's word), nWords },
   * or null for an ayah the table does not have.
   */
  referenceUnits(surah, ayah) {
    const m = this.m;
    if (!this.referenceIsOpen) throw new Error('the reference table is not open');
    const n = m._zft_reference_units(surah, ayah);
    if (n < 0) return null;
    const u = m._zft_reference_units_ptr() >> 2, w = m._zft_reference_words_ptr() >> 2;
    return { units: Int32Array.from(m.HEAP32.subarray(u, u + n)), words: Int32Array.from(m.HEAP32.subarray(w, w + n)), nWords: m._zft_reference_n_words() };
  }
  referenceClose() {
    if (this.referenceIsOpen) this.m._zft_reference_close();
    this.referenceIsOpen = false;
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

  /** The engine computes only the heads asked for. */
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
