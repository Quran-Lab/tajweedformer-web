// A Model is one verified model build on this device (NAMING.md section 3): its version, contexts, tokens,
// calibration and reference data, sample clips. It holds the engine (in a Worker in browsers) and makes
// Sessions: model.listen() (the SDK captures) and model.session() (the app pushes).
import { openTajweedFolder, memoryReader, urlReader } from '../tajweed/manifest.js';
import { profilePaths } from '../tajweed/delivery.js';
import { contextChunkMs, BLANK } from '../tajweed/heads.js';
import { WORD_BOUNDARY } from '../tajweed/decode.js';
import { localHost, workerHost } from './engine-host.js';
import { TajweedSession, WASM_BACKEND } from './session.js';
import { selectHeads } from './heads.js';
import { node as nodeParts, wasmArgs } from '../platform/node-hook.js';
import { MIN_SILENCE_MS, MAX_SILENCE_MS } from './speech.js';
import { Microphone } from './microphone.js';
import { TajweedError, toTajweedError, invalid } from './errors.js';

// roles the engine never opens: data the SDK hands over (calibration), data fetched on request (reference,
// the self-test clips) and the 2.x expected table, which 3.0 neither downloads nor reads
const NOT_ENGINE = new Set(['calibration', 'reference', 'selftest', 'expected']);
const PACES = ['realTime', 'fast'];

/**
 * Which context a Session runs on (SPEC section 3): the app's choice (one the build lacks is invalid_argument,
 * never replaced silently), else the config's inference.context when it is one of the build's contexts (anything
 * else there is ignored), else the manifest's default. Returns { context, source: 'app' | 'config' | 'manifest' }.
 */
export function resolveContext(app, config, manifest) {
  if (app !== undefined && app !== null) {
    if (typeof app !== 'string' || !manifest.contexts.includes(app)) {
      throw invalid(`unknown context ${JSON.stringify(app)}; this model has ${manifest.contexts.join(', ')}`);
    }
    return { context: app, source: 'app' };
  }
  const inf = config && typeof config === 'object' ? config.inference : null;
  const c = inf && typeof inf === 'object' && !Array.isArray(inf) ? inf.context : null;
  if (typeof c === 'string' && manifest.contexts.includes(c)) return { context: c, source: 'config' };
  return { context: manifest.default_context, source: 'manifest' };
}

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
};

/** The engine host for this runtime: a module Worker on a page, the calling thread elsewhere (Node, a Worker). */
async function startHost(seams) {
  if (seams.host) return seams.host;
  const local = () => localHost(seams.engine || (async () => (await import('../../dist/tajweedformer.mjs')).default(await wasmArgs('tajweedformer.wasm'))));
  const onPage = typeof globalThis.Worker === 'function' && typeof globalThis.document !== 'undefined' && !seams.engine && seams.worker !== false;
  if (!onPage) return local();
  let host = null;
  try {
    // written exactly so: bundlers (Vite, webpack 5, Parcel) find the Worker's file from `new Worker(new URL(...,
    // import.meta.url), { type: 'module' })` and emit it with the engine's wasm beside it
    host = workerHost(new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'tajweedformer-engine' }));
    await host.init();
    return host;
  } catch (_) {
    // no module Workers here (an old browser, a strict content security policy): the calling thread
    if (host) host.terminate();
    return local();
  }
}

function makeTokens(names) {
  const ids = new Map(names.map((n, i) => [n, i]));
  return Object.freeze({
    count: names.length, blank: BLANK, wordBar: WORD_BOUNDARY,
    name(id) { return Number.isInteger(id) && id >= 0 && id < names.length ? names[id] : null; },
    id(name) { return ids.has(name) ? ids.get(name) : null; },
  });
}

function makeCalibration(bytes, sha256) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const json = deepFreeze(JSON.parse(text));
  const contexts = json && typeof json.contexts === 'object' && json.contexts ? json.contexts : {};
  return Object.freeze({
    format: typeof json.format === 'string' ? json.format : null, sha256, text, json,
    contexts: Object.freeze(Object.keys(contexts)),
    classes: Object.freeze(Array.isArray(json.classes) ? [...json.classes] : []),
    presets: Object.freeze(json.presets && typeof json.presets === 'object' ? Object.keys(json.presets) : []),
    /** One context's block (fusion, sites, madd, qalqalah, gemination, word, ...), or null. */
    context(name) { return Object.prototype.hasOwnProperty.call(contexts, name) ? contexts[name] : null; },
    /** The threshold of a site class at a preset in a context (nats on the fused LLR), or null. */
    threshold(context, cls, preset) {
      const c = this.context(context);
      const t = c && c.sites && c.sites[cls] && c.sites[cls].thresholds;
      return t && typeof t[preset] === 'number' ? t[preset] : null;
    },
  });
}

export class TajweedModel {
  /** Use TajweedModel.open(folder) or client.model(). */
  constructor(x) {
    this._x = x;
    const m = x.folder.manifest;
    /** "v4.0" */
    this.id = m.model_id;
    /** "4.0.0" */
    this.version = x.version;
    /** The build id, for diagnostics only. */
    this.build = x.build;
    this.contexts = Object.freeze([...x.contexts]);
    this.tokens = makeTokens(x.names);
    this.calibration = x.calibration;
    this.reference = x.reference;
    this.sampleClips = x.clips;
    this._open = null;
    this._closed = false;
    this._staged = new Set();
    const self = this;
    // what a Session needs from its Model
    this._forSession = {
      host: x.host, names: x.names, platform: x.platform, clock: x.clock, limits: x.limits, onDrop: x.onDrop,
      ensureContext: (context) => self._ensureContext(context),
      sessionEnded: (s) => { if (self._open === s) self._open = null; },
      cohort: (context) => ({ revision: self.version, build: self.build, context, backend: 'cpu' }),
    };
  }

  /**
   * Open a model folder already at hand, verified as a downloaded one is (signature, sizes, SHA-256): a URL of
   * the folder, a directory path in Node, a reader ({ read(path) }, such as dirReader of the ./node entry), or
   * the files in memory ({ path: bytes }).
   */
  static open(folder) { return openModel({ reader: readerOf(folder) }); }

  /** The context a Session uses when the app names none: the config's inference.context, then the manifest's default. */
  get defaultContext() { return resolveContext(null, this._x.platform ? this._x.platform.config : null, this._x.folder.manifest).context; }

  /** Audio per chunk of a context, in ms. */
  chunkMs(context = this.defaultContext) {
    if (!this.contexts.includes(context)) throw invalid(`unknown context ${JSON.stringify(context)}; this model has ${this.contexts.join(', ')}`);
    return contextChunkMs(context);
  }

  /** The Backend the next Session will use. */
  get backend() { return WASM_BACKEND; }

  // the engine's files of a context, read through the verified folder and staged into the host
  async _ensureContext(context) {
    if (this._staged.has(context)) return;
    const x = this._x;
    const paths = profilePaths(x.folder.manifest, { context, platform: 'web' })
      .filter((p) => !NOT_ENGINE.has(x.folder.entry(p).role) && !this._staged.has('file:' + p));
    if (x.reader.prefetch) await x.reader.prefetch(paths);
    const files = [];
    for (const p of paths) {
      const bytes = await x.folder.read(p);
      files.push({ path: p, bytes: x.reader.fresh || x.host.kind === 'local' ? bytes : bytes.slice() });
    }
    await x.host.stage(files);
    for (const p of paths) this._staged.add('file:' + p);
    this._staged.add(context);
  }

  _options(o = {}) {
    if (o === null || typeof o !== 'object') throw invalid('session options must be an object');
    const { context } = resolveContext(o.context, this._x.platform ? this._x.platform.config : null, this._x.folder.manifest);
    const sampleRate = o.sampleRate === undefined || o.sampleRate === null ? 16000 : o.sampleRate;
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw invalid(`sampleRate ${sampleRate} is not a whole number from 8000 to 192000`);
    const backend = o.backend === undefined || o.backend === null ? 'auto' : o.backend;
    if (backend !== 'auto' && backend !== 'cpu') throw invalid(`backend must be 'auto' or 'cpu'`);
    const topK = o.topK === undefined || o.topK === null ? 0 : o.topK;
    if (!Number.isInteger(topK) || topK < 0 || topK > 38) throw invalid('topK must be 0 to 38');
    const endOnSilenceMs = o.endOnSilenceMs === undefined || o.endOnSilenceMs === null ? 0 : o.endOnSilenceMs;
    if (endOnSilenceMs !== 0 && !(Number.isInteger(endOnSilenceMs) && endOnSilenceMs >= MIN_SILENCE_MS && endOnSilenceMs <= MAX_SILENCE_MS)) {
      throw invalid(`endOnSilenceMs must be off (0 or null) or a whole number of milliseconds from ${MIN_SILENCE_MS} to ${MAX_SILENCE_MS}`);
    }
    for (const k of ['onChunk', 'onEvent']) if (o[k] !== undefined && o[k] !== null && typeof o[k] !== 'function') throw invalid(`${k} must be a function`);
    return { context, sampleRate, heads: selectHeads(o.heads), topK, endOnSilenceMs, onChunk: o.onChunk || null, onEvent: o.onEvent || null };
  }

  _session(o, source) {
    if (this._closed) throw new TajweedError('session_closed');
    if (this._open) throw new TajweedError('session_open');
    const s = new TajweedSession(this._forSession, o, source);
    this._open = s;
    return s;
  }

  /** A Session the app pushes audio into: session.push(samples) at options.sampleRate (16000 by default). */
  session(options = {}) {
    if (options && options.pace !== undefined) throw invalid('pace is for listen({ from })');
    return this._session(this._options(options), null);
  }

  /**
   * A Session the SDK feeds. listen(options): from the microphone, at the device's rate (asks for the
   * permission; microphone_denied when refused). listen({ from: clip }) or listen({ from: samples, sampleRate }):
   * from a sample clip of this model or from samples the app has, at real-time pace or as fast as possible
   * (pace: 'realTime' | 'fast').
   */
  async listen(options = {}) {
    if (options === null || typeof options !== 'object') throw invalid('listen options must be an object');
    if (this._closed) throw new TajweedError('session_closed');
    if (this._open) throw new TajweedError('session_open');
    const { from, pace = 'realTime', ...rest } = options;
    if (from === undefined || from === null) {
      if (options.pace !== undefined) throw invalid('pace is for listen({ from })');
      if (rest.sampleRate !== undefined) throw invalid('listen() takes its sampleRate from the microphone');
      this._options(rest); // refuse bad options before the permission prompt
      return this._listenMicrophone(rest);
    }
    if (!PACES.includes(pace)) throw invalid(`pace must be 'realTime' or 'fast'`);
    let samples, sampleRate;
    if (from instanceof Float32Array) {
      samples = from;
      sampleRate = rest.sampleRate === undefined ? 16000 : rest.sampleRate;
    } else {
      const clip = this._x.clipFiles.get(from && from.name);
      if (!clip || this.sampleClips.indexOf(from) < 0) throw invalid('from must be one of model.sampleClips or a Float32Array of samples');
      if (rest.sampleRate !== undefined) throw invalid('a sample clip has its own sampleRate');
      samples = await this._clipSamples(clip);
      sampleRate = clip.sampleRate;
    }
    const o = this._options({ ...rest, sampleRate });
    if (this._open) throw new TajweedError('session_open');
    const source = { stopped: false, stop() { this.stopped = true; if (this.timer) this.timers.clearTimeout(this.timer); }, timers: this._x.timers };
    const session = this._session(o, source);
    playInto(session, source, samples, sampleRate, pace, this._x.clock);
    return session;
  }

  async _clipSamples(clip) {
    let bytes;
    try { bytes = await this._x.folder.read(clip.path); } catch (e) { throw toTajweedError(e, { fallback: 'download_failed' }); }
    // signed 16-bit little-endian PCM, as the engine's own tools read it
    const n = bytes.length >> 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = view.getInt16(2 * i, true) / 32768;
    return out;
  }

  async _listenMicrophone(rest) {
    const x = this._x;
    const mic = await Microphone.open(x.microphone || {});
    let o, session;
    const life = x.lifecycle || { document: globalThis.document, window: typeof globalThis.window !== 'undefined' ? globalThis.window : null };
    const doc = life.document, win = life.window;
    const source = {
      live: true,
      stop() {
        off();
        if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onHidden);
        if (win && typeof win.removeEventListener === 'function') win.removeEventListener('pagehide', onLeave);
        mic.close();
      },
    };
    const onHidden = () => { if (doc.visibilityState === 'hidden') session._end('hidden'); };
    const onLeave = () => session._end('hidden');
    let off = () => {};
    try {
      o = this._options({ ...rest, sampleRate: Math.round(mic.sampleRate) });
      session = this._session(o, source);
    } catch (e) { mic.close(); throw e; }
    off = mic._on((ev) => {
      if (session._state !== 'open') return;
      if (ev.type === 'samples') session._push(ev.samples);
      else if (ev.type === 'interrupted') session._emit({ type: 'interrupted', cause: ev.cause });
      else if (ev.type === 'resumed') session._emit({ type: 'resumed' });
      else if (ev.type === 'lost') session._end('interrupted', ev.error);
    });
    // a page that is hidden or left ends the take: the SDK never holds the microphone in the background
    if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onHidden);
    if (win && typeof win.addEventListener === 'function') win.addEventListener('pagehide', onLeave);
    if (doc && doc.visibilityState === 'hidden') session._end('hidden');
    return session;
  }

  /** Release the engine. An open Session is cancelled. */
  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._open) await this._open.cancel().catch(() => {});
    const host = this._x.host;
    await host.close().catch(() => {});
    if (typeof host.terminate === 'function') host.terminate();
    if (this._x.onClose) this._x.onClose(this);
  }
}

// a clip or samples into a listen Session: blocks of 100 ms, at the wall clock's pace or one after another
function playInto(session, source, samples, sampleRate, pace, clock) {
  const block = Math.max(1, Math.round(sampleRate / 10));
  const timers = source.timers;
  let at = 0;
  const t0 = clock();
  const step = () => {
    if (source.stopped || session._state !== 'open') return;
    if (pace === 'fast') {
      // one block per turn of the Session's queue, so a long array never waits in memory twice
      session._push(samples.subarray(at, at + block));
      at += block;
      if (at >= samples.length) { session._end('sourceEnd'); return; }
      session._q.then(step);
      return;
    }
    const due = Math.min(samples.length, Math.floor(((clock() - t0) / 1000) * sampleRate) + block);
    while (at < due && session._state === 'open') { session._push(samples.subarray(at, Math.min(due, at + block))); at = Math.min(due, at + block); }
    if (at >= samples.length) { session._end('sourceEnd'); return; }
    source.timer = timers.setTimeout(step, 100);
  };
  // after the caller has the Session (so its first events and chunks are not missed by a late reader)
  Promise.resolve().then(step);
}

function readerOf(folder) {
  if (folder && typeof folder.read === 'function') return folder;
  if (typeof folder === 'string') {
    if (/^https?:\/\//.test(folder) || typeof globalThis.document !== 'undefined') {
      const base = typeof globalThis.document !== 'undefined' ? new URL(folder, globalThis.document.baseURI).href : folder;
      return Object.assign(urlReader(base), { fresh: true });
    }
    // Node: a directory
    let inner = null;
    return { fresh: true, async read(p) { inner = inner || nodeParts().dirReader(folder); return inner.read(p); } };
  }
  if (folder && typeof folder === 'object') return memoryReader(folder);
  throw invalid('open takes a folder: a URL, a directory path (Node), a reader or the files in memory');
}

/**
 * Open, verify and warm a model from a reader. SDK internals (client.model() and TajweedModel.open()).
 * @param {object} o
 * @param {{read(path: string): Promise<Uint8Array|null>}} o.reader
 * @param {object} [o.folder]  options of openTajweedFolder: trustedKeys, expect { version, build }
 * @param {object|null} [o.platform]  the Client's platform side (telemetry, the signed config, sharing)
 * @param {object} [o.seams]  tests: { engine (a module factory), host, worker: false, clock, timers, microphone, lifecycle }
 * @param {(model: TajweedModel) => void} [o.onClose]
 */
export async function openModel({ reader, folder: folderOpts = {}, platform = null, seams = {}, onClose = null, onDrop = null }) {
  const clock = seams.clock || (() => Date.now());
  const t0 = clock();
  let opened;
  try {
    opened = await openTajweedFolder(reader, { verify: 'on-read', requireSignature: true, ...folderOpts });
  } catch (e) { throw toTajweedError(e, { fallback: 'model_invalid' }); }
  const { folder, tokens: names, contexts, version, build } = opened;
  let host = null;
  try {
    let calibration = null;
    const calPath = folder.withRole('calibration')[0] || (folder.has('calibration.json') ? 'calibration.json' : null);
    if (calPath) calibration = makeCalibration(await folder.read(calPath), folder.entry(calPath).sha256);

    // the self-test clips: their list is a small optional file; a folder or a first offline start without it has none
    const clips = [], clipFiles = new Map();
    if (folder.has('selftest/selftest.json')) {
      let st = null;
      try { st = JSON.parse(await folder.readText('selftest/selftest.json')); } catch (_) { st = null; }
      for (const c of (st && Array.isArray(st.clips) ? st.clips : [])) {
        const path = `selftest/${c.file}`;
        if (typeof c.id !== 'string' || !folder.has(path) || !(c.sample_rate > 0)) continue;
        const clip = Object.freeze({ name: c.id, kind: String(c.kind || 'clean'), durationMs: Math.round((1000 * c.samples) / c.sample_rate) });
        clips.push(clip);
        clipFiles.set(clip.name, { path, sampleRate: c.sample_rate });
      }
    }

    host = await startHost(seams);
    const x = { reader, folder, names, contexts, version, build, calibration, clips: Object.freeze(clips), clipFiles, host, platform, clock,
      timers: seams.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) },
      microphone: seams.microphone || null, lifecycle: seams.lifecycle || null, limits: seams.limits || null, onDrop: onDrop || null, onClose, reference: null };
    x.reference = await makeReference(x);
    const model = new TajweedModel(x);
    const context = model.defaultContext;
    await model._ensureContext(context);
    await host.warm({ context, sampleRate: 16000 });
    model.loadMs = clock() - t0;
    return model;
  } catch (e) {
    if (host) { await host.close().catch(() => {}); if (typeof host.terminate === 'function') host.terminate(); }
    throw toTajweedError(e);
  }
}

// The reference data (SPEC 13.7): the expected units of each ayah, a table the manifest lists with the role
// `reference`. Never part of the engine's set: fetched when the app asks, then looked up through the engine.
async function makeReference(x) {
  const path = x.folder.withRole('reference')[0];
  if (!path) return null;
  let downloaded = false;
  if (typeof x.reader.cached === 'function') downloaded = await x.reader.cached(path).catch(() => false);
  else downloaded = await x.folder.read(path).then(() => true, () => false);
  let staged = null;
  const stage = () => staged || (staged = (async () => {
    const bytes = await x.folder.read(path);
    const r = await x.host.loadReference(x.reader.fresh || x.host.kind === 'local' ? bytes : bytes.slice());
    // the table's unit ids are only meaningful with the vocabulary it was built for
    if (r.tokensSha256 && r.tokensSha256 !== String(x.folder.manifest.tokens_sha256).toLowerCase()) {
      throw new TajweedError('model_invalid', { detail: 'the reference data was built for another vocabulary than this model\'s tokens' });
    }
    downloaded = true;
  })().catch((e) => { staged = null; throw e; }));
  return {
    /** Whether the table is on this device. */
    get isDownloaded() { return downloaded; },
    /** Download and verify the table, once. */
    async fetch() {
      try { await stage(); } catch (e) { if (e instanceof TajweedError && e.code === 'model_invalid') throw e; throw new TajweedError('reference_missing', {}, { cause: e }); }
    },
    /**
     * The expected units of an ayah: { units: number[], words: number[] } (the unit ids, and for each unit the
     * index of its word), or null for an ayah the table does not have. reference_missing before fetch().
     */
    async units(surah, ayah) {
      if (!Number.isInteger(surah) || surah < 1 || surah > 114) throw invalid(`surah ${surah} is not 1 to 114`);
      if (!Number.isInteger(ayah) || ayah < 1) throw invalid(`ayah ${ayah} is not a positive whole number`);
      if (!downloaded) throw new TajweedError('reference_missing');
      try { await stage(); } catch (e) { throw new TajweedError('reference_missing', {}, { cause: e }); }
      let r;
      try { r = await x.host.reference({ surah, ayah }); } catch (e) { throw toTajweedError(e); }
      if (!r) throw invalid(`surah ${surah} has no ayah ${ayah}`);
      return { units: Array.from(r.units), words: Array.from(r.words), wordCount: r.nWords };
    },
  };
}
