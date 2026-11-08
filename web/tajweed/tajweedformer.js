// The TajweedFormer V4 API for browsers and Node: open a verified model folder (sdk/v4.0), resolve
// the tajweed settings (calibration.json < the portal's block < app code), stream audio and keep
// every head the network has, and score a recitation of a known ayah into per-site verdicts.
//
//   import { TajweedFormer } from '@quran-lab/tajweedformer';
//   const tf = await TajweedFormer.load({ url: 'https://.../sdk/v4.0/', settings: { preset: 'balanced' } });
//   tf.setRemoteConfig(configDocument);            // the signed /v1/config, or its tajweed block
//   const s = tf.createStream({ sampleRate: 48000, onChunk: (heads) => {} });
//   s.pushAudio(pcm); s.finish();
//   const result = await tf.score(s.heads(), surah, ayah);
//   for (const v of result.sites) if (v.flagged) console.log(v.class, v.expectedUnit, '->', v.alternativeUnit);
//
// ENGINE STATUS (2.0.0 preview): the engine binding (src/zft_api.c over the engine's zf_tajweed.h,
// web/tajweed/engine.js) is used when the module carries it; a module without it (the 1.x build, or
// the pure-JS entry) makes everything that needs the engine throw EngineNotAvailableError. The
// binding is tested against a mock engine built for wasm32, never yet against the real engine.

import { TajweedSettings, CLASSES, CHECKS, PRESETS, ITEM_CHECK, BACKENDS } from './settings.js';
import { openTajweedFolder, memoryReader, urlReader, ModelFolderError } from './manifest.js';
import { cachedReader, profilePaths } from './delivery.js';

/** The Quran Lab CDN's URL of a model folder: { key, revision, repo?, folder?, url? } ->
 * { url, headers }. */
export function cdnFolderUrl({ key, revision, repo = 'Quran-Lab/tajweedformer-v4', folder = 'sdk/v4.0', url = 'https://cdn.quranlab.ai' }) {
  if (!revision) throw new TypeError('cdn: a revision (commit) is needed; the platform config names it');
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  return { url: `${url.replace(/\/$/, '')}/hf/${enc(repo)}/${enc(revision)}/${enc(folder)}/`, headers: key ? { 'x-qlab-key': key } : {} };
}
import { checkHeads, contextChunkMs, VOCAB, BLANK, HEAD_SPECS, SCORER_HEADS } from './heads.js';
import { decode, wordResults, topK } from './decode.js';
import { TajweedEngine, EngineStream, hasTajweedEngine } from './engine.js';

export { HEAD_SPECS, SCORER_HEADS, VOCAB, BLANK, MADD_CLASSES, contextChunkMs, checkHeads, joinHeads } from './heads.js';
export { decode, decodeFrames, wordResults, sigmoidHead, WORD_BOUNDARY, CTC_FRAME_MS, HEAD_FRAME_MS, topK, topKOf, RANKED_HEADS } from './decode.js';

/** The heads a stream keeps by default: the scorer's, plus conf for the decoded layer's confidence. */
export const DEFAULT_STREAM_HEADS = Object.freeze([...SCORER_HEADS, 'conf']);

/** Thrown by everything that needs the V4 engine while this build does not carry it.
 * code: 'engine_not_available'. */
export class EngineNotAvailableError extends Error {
  constructor(what) {
    super(`${what}: the TajweedFormer engine is not available in this build yet (SDK 2.0.0 preview; ` +
      'folders, settings and types work, streaming and scoring wait for the engine binding)');
    this.name = 'EngineNotAvailableError';
    this.code = 'engine_not_available';
  }
}

const instances = new WeakMap(); // module factory -> instantiated module promise
function engineModule(factory) {
  if (!factory) return Promise.resolve(null);
  if (!instances.has(factory)) instances.set(factory, factory());
  return instances.get(factory);
}

/**
 * Bind the API to an Emscripten module factory (the entry files do this; the pure-JS entry
 * '@quran-lab/tajweedformer/tajweed' binds none). Returns the TajweedFormer class.
 * @param {(() => Promise<object>) | null} factory
 * @param {{ scoreOnly?: boolean }} [defaults]  scoreOnly: the module is the scoring-only build
 *        (dist/tajweedformer-scorer), so load() opens models without the streaming engine
 */
export function bindTajweed(factory, defaults = {}) {
  const scoreOnly = !!defaults.scoreOnly;
  return class TajweedFormer extends TajweedFormerBase {
    static get _factory() { return factory; }
    static get _scoreOnly() { return scoreOnly; }
  };
}

const sameNumber = (a, b) => Math.abs(a - b) <= 1e-9;

// Every key of the SDK's resolution, compared with the engine's JSON (numbers within 1e-9).
function sameSettings(eng, sdk, at, out) {
  if (sdk !== null && typeof sdk === 'object' && !Array.isArray(sdk)) {
    if (eng === null || typeof eng !== 'object' || Array.isArray(eng)) { out.push(`${at || '.'}: engine ${JSON.stringify(eng)}, sdk ${JSON.stringify(sdk)}`); return; }
    for (const k of Object.keys(sdk)) sameSettings(eng[k], sdk[k], at ? `${at}.${k}` : k, out);
    return;
  }
  if (Array.isArray(sdk)) {
    if (!Array.isArray(eng) || eng.length !== sdk.length || sdk.some((x, i) => x !== eng[i])) out.push(`${at}: engine ${JSON.stringify(eng)}, sdk ${JSON.stringify(sdk)}`);
    return;
  }
  if (typeof sdk === 'number' && typeof eng === 'number') { if (!sameNumber(eng, sdk)) out.push(`${at}: engine ${eng}, sdk ${sdk}`); return; }
  if (eng !== sdk) out.push(`${at}: engine ${JSON.stringify(eng)}, sdk ${JSON.stringify(sdk)}`);
}

class TajweedFormerBase {
  static get _factory() { return null; }
  static get _scoreOnly() { return false; }

  /**
   * Open and verify a V4 model folder, resolve the settings, and (unless loadEngine is false) load
   * the exact engine for the context: the folder's verified files are staged into the module's
   * file system and the engine opens them there.
   * @param {object} opts  see TajweedFormerLoadOptions in index.d.ts
   */
  static async load(opts = {}) {
    let reader = opts.reader || (opts.files ? memoryReader(opts.files) : null);
    let requireSignature = opts.requireSignature;
    if (!reader && (opts.url || opts.cdn || opts.platform)) {
      // over HTTP: only the profile's files, resumable ranges, the SHA-256-keyed cache
      const src = opts.platform ? await opts.platform.modelSource() : opts.cdn ? cdnFolderUrl(opts.cdn) : { url: opts.url, headers: opts.headers };
      reader = cachedReader({ baseUrl: src.url, headers: src.headers, fetch: opts.fetch || (opts.platform && opts.platform.fetch), store: opts.cache === undefined ? undefined : opts.cache,
        onProgress: opts.onProgress, signal: opts.signal, parallel: opts.parallelDownloads });
      // a folder from the Quran Lab CDN must carry Quran Lab's signature
      if (requireSignature === undefined && (opts.cdn || opts.platform)) requireSignature = true;
    }
    if (!reader) throw new TypeError('TajweedFormer.load: give reader, files, url, cdn or platform');
    const t0 = Date.now();
    const { folder, calibration, tokens, contexts } = await openTajweedFolder(reader, {
      trustedKeys: opts.trustedKeys, requireSignature, verify: opts.verify || 'on-read', sdkVersion: opts.sdkVersion,
    });
    const scoreOnly = opts.scoreOnly === undefined ? this._scoreOnly : !!opts.scoreOnly;
    // whose thresholds (calibration's backend_overrides): the exact engine's heads are int8; a scoring-only
    // model scores heads from elsewhere (the Neural Engine, an NPU, a server): fp32, as the engine defaults
    const settings = new TajweedSettings(calibration, { debug: !!opts.debug,
      backend: opts.backend || (scoreOnly && opts.loadEngine !== false ? 'fp32' : 'int8') });
    if (opts.settings) {
      const { word, ...rest } = opts.settings;
      settings.setApp(rest);
      if (word !== undefined) settings.setWord(word);
    }
    if (opts.context !== undefined && opts.context !== null) settings.setContext(opts.context);
    if (opts.remote !== undefined) settings.setRemote(opts.remote);
    const rate = opts.sampleRate == null ? 16000 : opts.sampleRate | 0;

    const tf = new this();
    tf.folder = folder;
    tf.calibration = calibration;
    tf.tokens = tokens;
    tf.settings = settings;
    tf.sampleRate = rate;
    tf._contexts = contexts;
    // The engine runs one context, fixed at load: app > remote > calibration's default.
    tf.context = settings.effective().context;
    tf._eng = null;
    tf._model = 0;
    tf._config = 0;
    tf._staged = null;
    // scoreOnly: the scorer without the streaming engine (zf_tajweed_model_open with load_engine 0):
    // score() and expected() work, streams do not
    tf._scoreOnly = scoreOnly;
    // the download profile: root files and this context's folder (never CoreML, NPU or other contexts)
    tf.profile = profilePaths(folder.manifest, { context: tf.context, platform: 'web' })
      .filter((p) => !tf._scoreOnly || !p.includes('/'));
    if (opts.loadEngine !== false) {
      const [m] = await Promise.all([engineModule(this._factory), reader.prefetch ? reader.prefetch(tf.profile) : null]);
      if (!hasTajweedEngine(m)) throw new EngineNotAvailableError('TajweedFormer.load (loadEngine)');
      const eng = new TajweedEngine(m);
      tf._eng = eng;
      try {
        tf._staged = await eng.stage(folder, tf.context, { engineFiles: !tf._scoreOnly, paths: tf.profile });
        tf._model = eng.openModel(tf._staged.dir, { context: tf.context, loadEngine: !tf._scoreOnly, threads: opts.threads | 0, sampleRate: rate });
        tf._config = eng.configCreate(tf._model);
      } catch (e) {
        tf.free();
        throw e;
      }
    }
    tf.loadMs = Date.now() - t0;
    tf.delivery = reader.stats ? { ...reader.stats, store: reader.store ? reader.store.kind : null } : null;
    if (opts.platform && typeof opts.platform.attach === 'function') opts.platform.attach(tf);
    return tf;
  }

  /** What was loaded. */
  get info() {
    const m = this.folder.manifest;
    return {
      modelId: m.model_id, family: m.family, revision: m.revision, engineFormat: m.engine_format,
      minSdkVersion: m.min_sdk_version, signed: typeof m.signature === 'string',
      contexts: [...this._contexts], defaultContext: this.calibration.default_context, context: this.context,
      chunkMs: this._model ? this._eng.chunkMs(this._model) : contextChunkMs(this.context), vocab: VOCAB, blank: BLANK,
      engine: this._model ? (this._scoreOnly ? 'scorer' : 'exact-cpu') : 'none',
      engineVersion: this._model ? this._eng.version : null,
      sampleRate: this.sampleRate,
    };
  }

  /** The four presets with calibration's labels and target false-flag rates, strictest first. */
  get presets() {
    return PRESETS.map((name) => {
      const p = (this.calibration.presets || {})[name] || {};
      return { name, label: p.label || name, siteFa: typeof p.site_fa === 'number' ? p.site_fa : null };
    });
  }

  /** The portal's /v1/config document (or its tajweed block, as JSON text or parsed). Never throws;
   * returns the dropped fields. Takes effect for the next score; the context is fixed at load. */
  setRemoteConfig(doc) { return this.settings.setRemote(doc); }

  /** The effective settings (app > remote > calibration), with their sources and what was dropped
   * or refused. */
  effectiveSettings() { return this.settings.effective(); }

  /** tokens.txt's name for an id ("<blk>", "|", ...), or null. */
  tokenName(id) { return Number.isInteger(id) && id >= 0 && id < this.tokens.length ? this.tokens[id] : null; }

  /** Ayahs in a surah, from the expected table (0 for an unknown surah). */
  ayahCount(surah) {
    this._needEngine('ayahCount');
    return this._eng.ayahCount(this._model, surah);
  }

  /** The expected tj3 sequence of an ayah (continuing form) with each token's word index. */
  expected(surah, ayah) {
    this._needEngine('expected');
    return this._eng.expected(this._model, surah, ayah);
  }

  /**
   * A stream over the exact engine: audio in, heads out per chunk. One live stream at a time (the
   * engine's rule). Audio comes at the sampleRate given to load().
   *
   * Heads (the raw layer): by default the stream hands over and keeps the scorer's heads plus conf
   * (DEFAULT_STREAM_HEADS); `heads` adds named heads, `allHeads: true` keeps all twelve. The scorer's
   * heads are always kept, so score() works whatever is selected. The engine computes only the selected
   * heads (zf_tajweed_stream_set_heads, API 3); the others are null and cost nothing.
   * @param {{ sampleRate?: number, onChunk?: (chunk: object) => void, heads?: string[], allHeads?: boolean }} [opts]
   */
  createStream(opts = {}) {
    this._needEngine('createStream');
    if (this._scoreOnly) throw new EngineNotAvailableError('TajweedFormer.createStream (a scoring-only model has no streams)');
    if (opts.sampleRate != null && (opts.sampleRate | 0) !== this.sampleRate) {
      throw new RangeError(`the stream takes audio at ${this.sampleRate} Hz, the rate given to load(); load again for ${opts.sampleRate}`);
    }
    let keep = null;
    if (!opts.allHeads) {
      const names = HEAD_SPECS.map((h) => h.name);
      for (const n of opts.heads || []) if (!names.includes(n)) throw new RangeError(`unknown head ${n}; heads are ${names.join(', ')}`);
      keep = new Set([...DEFAULT_STREAM_HEADS, ...(opts.heads || [])]);
    }
    const s = new EngineStream(this._eng, this._model, { onChunk: opts.onChunk || null, keep, tokens: this.tokens });
    if (this._telemetry) this._telemetry.streamStarted(this, s);
    return s;
  }

  /** The decoded layer of any heads object (top-1 and runner-up per 40 ms frame, greedy tokens with
   * log-probs, margins and confidence, '|' segments, times). Needs no engine. */
  decode(heads, { k } = {}) { return decode(heads, { tokens: this.tokens, k }); }

  /** Top-K of any rankable head of a heads object (P2.16): k 1 to 38 for the token heads, up to the class
   * count for gem and attr_*; ranked highest first, ties to the lower id. */
  topK(heads, head = 'log_probs', k = 2) { return topK(heads, head, k, this.tokens); }

  /** The word level in force (threshold, preset, source), or null when this model's calibration
   * has no word block yet (word scores are then reported without flags). */
  wordLevel() { return this.settings.wordLevel(); }

  /**
   * The engine's view of the settings after the JS layers are put into it, and how it compares with
   * the SDK's own resolution (effectiveSettings): { engine, engineJson, differences[] }. With an API 2
   * engine every field of effectiveSettings() is compared with the engine's zf_tajweed_config_json
   * (numbers within 1e-9); with an API 1 engine, the ZfTajweedEffective struct (preset, each class's
   * enabled and threshold, the features' enabled). A difference means the engine and the SDK disagree
   * on a rule (or the engine has no setter for an app setting); score() reports it in
   * result.settingsCheck, and throws in a debug build.
   */
  engineSettings() {
    this._needEngine('engineSettings');
    const notTaken = this._eng.configSync(this._config, this.settings);
    const engine = this._eng.configEffective(this._config);
    const engineJson = this._eng.configJson(this._config);
    const js = this.settings.effective();
    const differences = notTaken.map((w) => `engine did not take app ${w}`);
    if (engineJson && typeof engineJson === 'object' && engineJson.sites) {
      sameSettings(engineJson, js, '', differences);
      return { engine, engineJson, differences };
    }
    if (engine.preset !== js.preset) differences.push(`preset: engine ${engine.preset}, sdk ${js.preset}`);
    for (const c of CLASSES) {
      const a = engine.classes[c], b = js.sites[c];
      if (!b) continue;
      if (a.enabled !== b.enabled) differences.push(`${c}.enabled: engine ${a.enabled}, sdk ${b.enabled}`);
      if (a.enabled && b.enabled && !sameNumber(a.threshold, b.threshold)) {
        differences.push(`${c}.threshold: engine ${a.threshold}, sdk ${b.threshold}`);
      }
    }
    for (const k of ['madd', 'gemination', 'qalqalah', 'lazim']) {
      if (engine.checks[k].enabled !== js[k].enabled) differences.push(`${k}.enabled: engine ${engine.checks[k].enabled}, sdk ${js[k].enabled}`);
    }
    return { engine, engineJson, differences };
  }

  /**
   * Score a take of surah:ayah (the whole ayah) with the settings in force. The heads may come from
   * a stream or any source with the same layout (checkHeads).
   * @param {object} heads
   * @param {number} surah
   * @param {number} ayah
   * @param {{ backend?: 'int8'|'fp32' }} [opts]  whose thresholds for these heads, for this call only:
   *        int8 for the exact engine's heads, fp32 for heads from the Neural Engine, an NPU or a server
   *        (default: settings.backend)
   * @returns {Promise<object>} a TajweedResult; `raw` is the engine's zf_tajweed_result_json, parsed
   */
  async score(heads, surah, ayah, opts = {}) {
    checkHeads(heads);
    if (!Number.isInteger(surah) || surah < 1 || surah > 114) throw new RangeError(`surah ${surah} is not 1..114`);
    if (!Number.isInteger(ayah) || ayah < 1) throw new RangeError(`ayah ${ayah} is not a positive integer`);
    this._needEngine('score');
    const before = this.settings.backend;
    if (opts.backend !== undefined) {
      if (!BACKENDS.includes(opts.backend)) throw new RangeError(`backend must be one of ${BACKENDS.join(', ')}`);
      this.settings.backend = opts.backend;
    }
    try {
      const check = this.engineSettings();
      if (check.differences.length && this.settings.debug) {
        const e = new Error(`the engine resolved the settings differently from the SDK: ${check.differences.join('; ')}`);
        e.code = 'settings_mismatch';
        e.differences = check.differences;
        throw e;
      }
      const r = this._eng.score(this._model, this._config, heads, surah, ayah, this.tokens);
      const wl = this.settings.wordLevel();
      const nWords = r.path && r.path.wordOfToken.length ? r.path.wordOfToken[r.path.wordOfToken.length - 1] + 1
        : r.raw && Array.isArray(r.raw.path_forms) ? r.raw.path_forms.length : r.sites.reduce((n, x) => Math.max(n, x.word + 1), 0);
      const words = wordResults(r, nWords);
      const { engineWords, ...rest } = r;
      const result = {
        surah, ayah, context: this.context, settings: this.settings.effective(), wordLevel: wl, ...rest, words,
        summary: { ...r.summary, words: words.length, wordsFlagged: words.filter((w) => w.flagged).length },
        settingsCheck: { agree: check.differences.length === 0, differences: check.differences },
      };
      if (opts.decoded) result.decoded = decode(heads, { tokens: this.tokens });
      if (this._telemetry) this._telemetry.scored(this, result);
      return result;
    } finally {
      this.settings.backend = before;
    }
  }

  /** Release the engine, its config and the staged files. */
  free() {
    if (this._eng) {
      this._eng.configDestroy(this._config);
      this._eng.closeModel(this._model);
      this._eng.unstage(this._staged);
    }
    this._config = this._model = 0;
    this._staged = null;
    this._eng = null;
  }

  _needEngine(what) {
    if (!this._model) throw new EngineNotAvailableError(`TajweedFormer.${what}`);
  }
}

/** The check a site class or verdict item belongs to ("cons_sub" -> "letters"). */
export function checkOf(item) { return ITEM_CHECK[item] || null; }

/** Unbound (no engine module): the pure-JS entry's TajweedFormer. */
export const TajweedFormer = bindTajweed(null);

export { CLASSES, CHECKS, PRESETS, ModelFolderError };
