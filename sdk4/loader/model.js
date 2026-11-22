// TajweedModel and TajweedSession of API 4, in the host page. The model itself is in the engine Worker on Quran
// Lab's origin; here are its public facts (version, contexts, tokens, calibration, clips) and the Sessions, which
// are the 3.x Sessions (web/api/session.js: chunks, events, speech, the decoded layer, the bounds) over the port.
// Microphone capture stays in the page: the samples are passed to the Worker, the frame never asks for a permission.
import { TajweedSession as Session3, WASM_BACKEND } from '../../web/api/session.js';
import { selectHeads } from '../../web/api/heads.js';
import { MIN_SILENCE_MS, MAX_SILENCE_MS } from '../../web/api/speech.js';
import { Microphone } from '../../web/api/microphone.js';
import { TajweedError, invalid } from '../../web/api/errors.js';
import { WORD_BOUNDARY } from '../../web/tajweed/decode.js';
import { BLANK } from '../../web/tajweed/heads.js';
import { checkReport, ReportError } from '../shared/recited.js';
import { errorFrom } from './errors.js';

const PACES = ['realTime', 'fast'];
const MADE = Symbol('client.model');

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
};

function makeTokens(names) {
  const ids = new Map(names.map((n, i) => [n, i]));
  return Object.freeze({
    count: names.length, blank: BLANK, wordBar: WORD_BOUNDARY,
    name(id) { return Number.isInteger(id) && id >= 0 && id < names.length ? names[id] : null; },
    id(name) { return ids.has(name) ? ids.get(name) : null; },
  });
}

function makeCalibration(c) {
  if (!c) return null;
  const json = deepFreeze(JSON.parse(c.text));
  const contexts = json && typeof json.contexts === 'object' && json.contexts ? json.contexts : {};
  return Object.freeze({
    format: typeof json.format === 'string' ? json.format : null, sha256: c.sha256, text: c.text, json,
    contexts: Object.freeze(Object.keys(contexts)),
    classes: Object.freeze(Array.isArray(json.classes) ? [...json.classes] : []),
    presets: Object.freeze(json.presets && typeof json.presets === 'object' ? Object.keys(json.presets) : []),
    context(name) { return Object.prototype.hasOwnProperty.call(contexts, name) ? contexts[name] : null; },
    threshold(context, cls, preset) {
      const x = this.context(context);
      const t = x && x.sites && x.sites[cls] && x.sites[cls].thresholds;
      return t && typeof t[preset] === 'number' ? t[preset] : null;
    },
  });
}

/** A 3.x Session whose recited report carries 17.9's outcome and perAyah and goes to the engine Worker with its take. */
export class TajweedSession extends Session3 {
  constructor(model, o, source) {
    super(model, o, source);
    this._takeId = this._q.then(() => model.host.takeId);
    // speech by the learner's local hour, chunk by chunk (17.8 hour_speech_s): only the hour's bucket leaves the page
    this._hourMs = {};
    const sp = this._speech, feed = sp.feed.bind(sp);
    sp.feed = (ids, timing) => {
      const before = sp.counts().speech;
      const r = feed(ids, timing);
      const n = sp.counts().speech - before;
      if (n > 0) { const h = new Date().getHours(); this._hourMs[h] = (this._hourMs[h] || 0) + 40 * n; }
      return r;
    };
  }

  _report() {
    this._m.hourMs = this._hourMs; // read by the platform's take() below, in this same call
    try { super._report(); } finally { this._m.hourMs = null; }
  }

  /**
   * Where the learner recited in this take, and optionally how the app judged it:
   *   session.reportRecited(2, 255, 257, { outcome: { correct: false, mistakes: 2, rules: ['madd'] }, perAyah: { 255: { correct: true } } })
   * The SDK measures the recited ayahs itself; this report is used only where it could not tell, and a take is never
   * counted twice. One report per take (a second replaces the first), accepted until the next take starts.
   */
  reportRecited(surah, ayahFrom, ayahTo, options) {
    let r;
    try { r = checkReport(surah, ayahFrom, ayahTo, options); } catch (e) { if (e instanceof ReportError) throw invalid(e.message); throw e; }
    if (this._state === 'cancelled') return;
    const rpc = this._m.rpc;
    this._takeId.then((takeId) => takeId && rpc.call('reportRecited', { takeId, surah: r.surah, from: r.from, to: r.to, outcome: r.outcome, perAyah: r.perAyah }))
      .catch(() => { /* analytics never stops a take */ });
  }
}

export class TajweedModel {
  /** Use client.model(): a model comes from Quran Lab's server, through the Client. */
  constructor(x, made) {
    if (made !== MADE || !x) throw invalid('a TajweedModel comes from client.model()');
    const i = x.info;
    this._x = x;
    /** "v4.0" */
    this.id = i.id;
    /** "4.1.0" */
    this.version = i.version;
    /** The build id, for diagnostics only. */
    this.build = i.build;
    this.contexts = Object.freeze([...i.contexts]);
    const names = i.tokens || Array.from({ length: 38 }, (_, k) => `#${k}`);
    this.tokens = makeTokens(names);
    this.calibration = makeCalibration(i.calibration);
    // the expected units of each ayah (SPEC 13.7), read by the Core from the build's reference data, downloaded with
    // the model; null for a build without it
    this.reference = i.reference ? Object.freeze({
      get isDownloaded() { return true; },
      async fetch() {},
      async units(surah, ayah) {
        if (!Number.isInteger(surah) || surah < 1 || surah > 114) throw invalid(`surah ${surah} is not 1 to 114`);
        if (!Number.isInteger(ayah) || ayah < 1) throw invalid(`ayah ${ayah} is not a positive whole number`);
        let r;
        try { r = await x.rpc.call('reference', { surah, ayah }); } catch (e) { throw errorFrom(e, 'reference_missing'); }
        if (!r) throw invalid(`surah ${surah} has no ayah ${ayah}`);
        return { units: r.units, words: r.words, wordCount: r.wordCount };
      },
    }) : null;
    this.sampleClips = Object.freeze(i.clips.map((c) => Object.freeze({ name: c.name, kind: c.kind, durationMs: c.durationMs })));
    this.loadMs = i.loadMs;
    this._open = null;
    this._closed = false;
    const self = this;
    const rpc = x.rpc;
    // a take's calls; a failure the Worker answers is the TajweedError it made, with its code and cause (4.0.2: the
    // Session read the crossed message as a failure of its own engine, so a take whose start found no network for
    // another context's files failed with engine_failed)
    const own = (e) => { throw errorFrom(e, 'engine_failed'); };
    const host = {
      takeId: null,
      warm: (a) => rpc.call('warm', a).catch(own),
      start: async (a) => { host.takeId = null; const r = await rpc.call('start', a).catch(own); host.takeId = r.takeId; return r; },
      // a copy crosses (transferred): the Session keeps counting its own array's length
      push: (samples) => { const c = samples.slice(); return rpc.call('push', { samples: c }, [c.buffer]).catch(own); },
      finish: () => rpc.call('finish').catch(own),
      cancel: () => rpc.call('cancel').catch(own),
    };
    // a take's numbers go to the Worker; its audio goes to the sharing controller in this page (as 3.x), which
    // records only for a learner who said yes
    const share = x.share || null;
    const platform = {
      config: null,
      telemetry: { take: (cohort, data) => { rpc.call('takeReport', { cohort, data: { ...data, hourSpeechMs: self._forSession.hourMs || {} } }).catch(() => {}); }, recited() {} },
      takeStarted: (o) => (share ? share.takeStarted(o) : { pushAudio() { return 0; }, finish() { return 0; }, free() {} }),
      takeFinished(o) { if (share) share.takeFinished(o); },
    };
    this._forSession = {
      host, rpc, names, platform, clock: x.clock, limits: x.limits || null, onDrop: x.onDrop || null,
      ensureContext: async () => {},
      sessionEnded: (s) => { if (self._open === s) self._open = null; },
      cohort: (context) => ({ revision: self.version, build: self.build, context, backend: 'cpu' }),
    };
  }

  /** The context a Session uses when the app names none: the config's inference.context, then the manifest's default. */
  get defaultContext() { return this._x.info.defaultContext; }

  /** Audio per chunk of a context, in ms. */
  chunkMs(context = this.defaultContext) {
    if (!this.contexts.includes(context)) throw invalid(`unknown context ${JSON.stringify(context)}; this model has ${this.contexts.join(', ')}`);
    return this._x.info.chunkMs[context];
  }

  /** On the web always the CPU engine in WebAssembly. */
  get backend() { return WASM_BACKEND; }

  _options(o = {}) {
    if (o === null || typeof o !== 'object') throw invalid('session options must be an object');
    let context = o.context === undefined || o.context === null ? this.defaultContext : o.context;
    if (typeof context !== 'string' || !this.contexts.includes(context)) throw invalid(`unknown context ${JSON.stringify(context)}; this model has ${this.contexts.join(', ')}`);
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
   * A Session the SDK feeds: from the microphone (captured in this page, asks for the permission), or with `from`
   * from a sample clip of this model or from samples, at real-time pace or as fast as possible.
   */
  async listen(options = {}) {
    if (options === null || typeof options !== 'object') throw invalid('listen options must be an object');
    if (this._closed) throw new TajweedError('session_closed');
    if (this._open) throw new TajweedError('session_open');
    const { from, pace = 'realTime', ...rest } = options;
    if (from === undefined || from === null) {
      if (options.pace !== undefined) throw invalid('pace is for listen({ from })');
      if (rest.sampleRate !== undefined) throw invalid('listen() takes its sampleRate from the microphone');
      this._options(rest);
      return this._listenMicrophone(rest);
    }
    if (!PACES.includes(pace)) throw invalid(`pace must be 'realTime' or 'fast'`);
    let samples, sampleRate;
    if (from instanceof Float32Array) {
      samples = from;
      sampleRate = rest.sampleRate === undefined ? 16000 : rest.sampleRate;
    } else {
      if (this.sampleClips.indexOf(from) < 0) throw invalid('from must be one of model.sampleClips or a Float32Array of samples');
      if (rest.sampleRate !== undefined) throw invalid('a sample clip has its own sampleRate');
      let c;
      try { c = await this._x.rpc.call('clip', { name: from.name }); } catch (e) { throw errorFrom(e, 'download_failed'); }
      samples = c.samples; sampleRate = c.sampleRate;
    }
    const o = this._options({ ...rest, sampleRate });
    if (this._open) throw new TajweedError('session_open');
    const source = { stopped: false, stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); } };
    const session = this._session(o, source);
    playInto(session, source, samples, sampleRate, pace, this._x.clock);
    return session;
  }

  async _listenMicrophone(rest) {
    const x = this._x;
    const mic = await Microphone.open(x.microphone || {});
    let session;
    const doc = globalThis.document, win = typeof globalThis.window !== 'undefined' ? globalThis.window : null;
    const onHidden = () => { if (doc.visibilityState === 'hidden') session._end('hidden'); };
    const onLeave = () => session._end('hidden');
    let off = () => {};
    const source = {
      live: true,
      stop() {
        off();
        if (doc) doc.removeEventListener('visibilitychange', onHidden);
        if (win) win.removeEventListener('pagehide', onLeave);
        mic.close();
      },
    };
    try { session = this._session(this._options({ ...rest, sampleRate: Math.round(mic.sampleRate) }), source); } catch (e) { mic.close(); throw e; }
    off = mic._on((ev) => {
      if (session._state !== 'open') return;
      if (ev.type === 'samples') session._push(ev.samples);
      else if (ev.type === 'interrupted') session._emit({ type: 'interrupted', cause: ev.cause });
      else if (ev.type === 'resumed') session._emit({ type: 'resumed' });
      else if (ev.type === 'lost') session._end('interrupted', ev.error);
    });
    if (doc) doc.addEventListener('visibilitychange', onHidden);
    if (win) win.addEventListener('pagehide', onLeave);
    if (doc && doc.visibilityState === 'hidden') session._end('hidden');
    return session;
  }

  /** Release the engine. An open Session is cancelled. */
  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._open) await this._open.cancel().catch(() => {});
    await this._x.rpc.call('closeModel').catch(() => {});
    if (this._x.onClose) this._x.onClose(this);
  }
}

export const makeModel = (x) => new TajweedModel(x, MADE);

// a clip or samples into a listen Session: blocks of 100 ms, at the wall clock's pace or one after another
function playInto(session, source, samples, sampleRate, pace, clock) {
  const block = Math.max(1, Math.round(sampleRate / 10));
  let at = 0;
  const t0 = clock();
  const step = () => {
    if (source.stopped || session._state !== 'open') return;
    if (pace === 'fast') {
      session._push(samples.subarray(at, at + block));
      at += block;
      if (at >= samples.length) { session._end('sourceEnd'); return; }
      session._q.then(step);
      return;
    }
    const due = Math.min(samples.length, Math.floor(((clock() - t0) / 1000) * sampleRate) + block);
    while (at < due && session._state === 'open') { session._push(samples.subarray(at, Math.min(due, at + block))); at = Math.min(due, at + block); }
    if (at >= samples.length) { session._end('sourceEnd'); return; }
    source.timer = setTimeout(step, 100);
  };
  Promise.resolve().then(step);
}
