// The engine host: the one object that owns the WebAssembly module, the staged model files, the opened
// engine model and the live stream. Every method is async and takes and returns plain data (typed arrays,
// numbers, strings), so the same host runs in two places:
//
//   - in a module Worker in browsers (worker.js wraps it; workerHost() below is the page's side), so a chunk of
//     inference never runs on the page's main thread;
//   - in the calling thread in Node, and in a browser without module workers (localHost()).
//
// The engine opens one context at one input rate; a take that asks for another closes the opened model and
// opens it again for that pair (the staged files stay). One stream at a time, the engine's rule.
import { TajweedEngine, EngineStream, hasTajweedEngine } from '../tajweed/engine.js';
import { HEAD_SPECS } from '../tajweed/heads.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class EngineHost {
  /** @param {() => Promise<object>} factory  the Emscripten module factory (dist/tajweedformer.mjs's default export) */
  constructor(factory) {
    this.factory = factory;
    this.eng = null;
    this.staged = null;
    this.model = 0;
    this.opened = null; // { context, sampleRate } of the opened model
    this.stream = null;
    this.out = [];
  }

  async init() {
    if (!this.eng) {
      const m = await this.factory();
      if (!hasTajweedEngine(m)) throw new Error('the WebAssembly module has no TajweedFormer engine');
      this.eng = new TajweedEngine(m);
    }
    return { engineVersion: this.eng.version, apiVersion: this.eng.apiVersion };
  }

  /** Add verified model files ([{ path, bytes }]) to the staging directory. */
  async stage(files) {
    await this.init();
    this.staged = this.eng.stage(this.staged, files);
    return { files: this.staged.files.length };
  }

  _open(context, sampleRate) {
    const o = this.opened;
    if (this.model && o && o.context === context && o.sampleRate === sampleRate) return;
    this._endStream();
    if (this.model) { this.eng.closeModel(this.model); this.model = 0; this.opened = null; }
    this.model = this.eng.openModel(this.staged.dir, { context, sampleRate });
    this.opened = { context, sampleRate };
  }

  _endStream() {
    if (this.stream) { this.stream.free(); this.stream = null; }
    this.out = [];
  }

  /** Open the engine for a context and rate and run one chunk of silence through it, so the first take
   * starts at once. Returns the chunk length. */
  async warm({ context, sampleRate = 16000 }) {
    await this.init();
    this._open(context, sampleRate);
    const chunkMs = this.eng.chunkMs(this.model);
    const s = new EngineStream(this.eng, this.model, { keep: new Set(['log_probs']) });
    try { s.pushAudio(new Float32Array(Math.ceil((sampleRate * chunkMs) / 1000) * 2)); } finally { s.free(); }
    return { chunkMs };
  }

  /**
   * Start a take: one stream on `context` at `sampleRate`, computing `heads` (names; null = all twelve).
   * A take still open is ended first.
   */
  async start({ context, sampleRate = 16000, heads = null }) {
    await this.init();
    this._open(context, sampleRate);
    this._endStream();
    const keep = heads ? new Set(heads) : null;
    this.stream = new EngineStream(this.eng, this.model, { keep, onChunk: (h) => this.out.push(h) });
    return { chunkMs: this.eng.chunkMs(this.model) };
  }

  _take() {
    const chunks = this.out;
    this.out = [];
    return chunks.map((h) => {
      const heads = {};
      for (const s of HEAD_SPECS) if (h[s.key]) heads[s.name] = h[s.key];
      return { index: h.index, firstFrame: h.frame0, n40: h.n40, heads };
    });
  }

  /** Audio in (mono float at the take's rate); the chunks it completed and the compute time. */
  async push(samples) {
    if (!this.stream) throw new Error('no take is open');
    const t = now();
    this.stream.pushAudio(samples);
    return { chunks: this._take(), computeMs: now() - t };
  }

  /** The end of the take: the last chunks. The stream is released. */
  async finish() {
    if (!this.stream) throw new Error('no take is open');
    const t = now();
    this.stream.finish();
    const computeMs = now() - t;
    const chunks = this._take();
    this._endStream();
    return { chunks, computeMs };
  }

  async cancel() { this._endStream(); return {}; }

  /** Open the reference table from its verified bytes; { tokensSha256 } of the vocabulary its ids refer to. */
  async loadReference(bytes) {
    await this.init();
    return { tokensSha256: this.eng.referenceOpen(bytes) };
  }

  /** The expected units of an ayah: { units: Int32Array, words: Int32Array (each unit's word), nWords }, or null
   * for an ayah the table does not have. */
  async reference({ surah, ayah }) {
    await this.init();
    return this.eng.referenceUnits(surah, ayah);
  }

  async close() {
    this._endStream();
    if (this.eng) {
      if (this.model) this.eng.closeModel(this.model);
      this.eng.referenceClose();
      this.eng.unstage(this.staged);
    }
    this.model = 0;
    this.opened = null;
    this.staged = null;
    return {};
  }
}

/** The ArrayBuffers of a host answer or argument, for postMessage's transfer list. */
export function transferables(x, out = []) {
  if (!x || typeof x !== 'object') return out;
  if (ArrayBuffer.isView(x)) { if (!out.includes(x.buffer)) out.push(x.buffer); return out; }
  if (Array.isArray(x)) { for (const v of x) transferables(v, out); return out; }
  for (const v of Object.values(x)) transferables(v, out);
  return out;
}

const METHODS = ['init', 'stage', 'warm', 'start', 'push', 'finish', 'cancel', 'loadReference', 'reference', 'close'];

/** The host in the calling thread. Calls run one after another, as a Worker's message queue runs them. */
export function localHost(factory) {
  const host = new EngineHost(factory);
  let q = Promise.resolve();
  const api = { kind: 'local' };
  for (const m of METHODS) {
    api[m] = (...args) => { const r = q.then(() => host[m](...args)); q = r.catch(() => {}); return r; };
  }
  return api;
}

/**
 * The page's side of a host that runs in a Worker (worker.js). `worker` is the Worker; audio and model files
 * are transferred to it, chunks are transferred back. terminate() ends the Worker.
 */
export function workerHost(worker) {
  let seq = 0;
  const waiting = new Map();
  let dead = null;
  const fail = (e) => { dead = e; for (const w of waiting.values()) w.reject(e); waiting.clear(); };
  worker.onmessage = (ev) => {
    const { id, result, error } = ev.data || {};
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    if (error) w.reject(new Error(error.message)); else w.resolve(result);
  };
  worker.onerror = (ev) => fail(new Error(`the engine worker failed: ${(ev && ev.message) || 'error'}`));
  worker.onmessageerror = () => fail(new Error('the engine worker sent a message that could not be read'));
  const api = { kind: 'worker', terminate() { worker.terminate(); fail(new Error('the engine worker was ended')); } };
  for (const m of METHODS) {
    api[m] = (...args) => new Promise((resolve, reject) => {
      if (dead) { reject(dead); return; }
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, method: m, args }, transferables(args));
    });
  }
  return api;
}
