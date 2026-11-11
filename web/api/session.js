// A Session is one take: audio in, chunks and events out, the take's Heads at the end (NAMING.md sections 3
// and 4). The engine runs behind the model's host (a Worker in browsers), so everything here is a queue of
// async calls: push() posts audio and returns at once; chunks and events arrive in order.
//
// A chunk's `decoded` is the decoded layer of the take SO FAR. It is computed when read (and kept), from the
// session's own append-only copy of log_probs and conf, so a take of many minutes does not build one decoded
// layer per chunk unless the app reads them.
import { TajweedError, toTajweedError, invalid } from './errors.js';
import { TajweedHeads, decodedOf, joinArrays } from './heads.js';
import { SpeechTracker, DEFAULT_SILENCE_MS, greedyIds } from './speech.js';
import { ayahsIn } from './surahs.js';
import { decodeFrames } from '../tajweed/decode.js';
import { VOCAB } from '../tajweed/heads.js';

/** The Backend of every web Session: the CPU engine in WebAssembly. Plain data. */
export const WASM_BACKEND = Object.freeze({ kind: 'cpu', name: 'wasm', stage: 'cpu', reason: null });

// The bounds of what one take may hold in memory (the same in every SDK, NAMING.md), so nothing grows for as
// long as audio keeps coming.
/** The longest take (ms of audio at the input rate). At the limit the take ends by itself: `ended` with reason
 * limit, the audio up to the limit decoded, its Heads kept for finish(). */
export const MAX_TAKE_MS = 20 * 60 * 1000;
/** The most chunks and events that wait for the app in `chunks` and `events`; when full the oldest waiting one is
 * dropped. The last chunk and `ended` are the newest, and finish() returns the whole take. */
export const CHUNKS_LIMIT = 256;
export const EVENTS_LIMIT = 64;
/** How far the engine may fall behind a microphone (ms of audio waiting to be decoded); past it the take ends
 * with engine_failed. */
export const MAX_PENDING_MS = 30000;
/** How much audio the app may push ahead of the engine (samples: the longest take at 48 kHz, 230 MB); past it
 * push throws invalid_argument and the take ends with that error. */
export const MAX_PENDING_SAMPLES = 48000 * 1200;

// An async iterator fed by push(): values wait in a queue until read; close() ends the iteration. The queue
// holds at most `limit` values: past it the oldest waiting value is dropped and counted in `dropped`.
export class Channel {
  constructor(limit, onDrop = null) { this.q = []; this.waiting = []; this.done = false; this.limit = limit; this.dropped = 0; this.onDrop = onDrop; }
  push(v) {
    if (this.done) return;
    const w = this.waiting.shift();
    if (w) { w({ value: v, done: false }); return; }
    this.q.push(v);
    if (this.q.length > this.limit) { this.q.shift(); this.dropped++; if (this.onDrop) this.onDrop(); }
  }
  close() {
    this.done = true;
    for (const w of this.waiting.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    const self = this;
    return {
      next() {
        if (self.q.length) return Promise.resolve({ value: self.q.shift(), done: false });
        if (self.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => self.waiting.push(r));
      },
      return() { return Promise.resolve({ value: undefined, done: true }); },
      [Symbol.asyncIterator]() { return this; },
    };
  }
}

// A Float32Array that grows by doubling; view(n) is its first n values.
class Growable {
  constructor() { this.a = new Float32Array(4096); this.n = 0; }
  append(x) {
    if (this.n + x.length > this.a.length) {
      const b = new Float32Array(Math.max(2 * this.a.length, this.n + x.length));
      b.set(this.a.subarray(0, this.n));
      this.a = b;
    }
    this.a.set(x, this.n);
    this.n += x.length;
  }
  view(n) { return this.a.subarray(0, n); }
}

export class TajweedSession {
  /**
   * Made by TajweedModel.session() and TajweedModel.listen(); not by apps.
   * @param {object} model  the TajweedModel's internals: { host, names, platform, ensureContext(context), sessionEnded(session), cohort }
   * @param {object} o  the checked options: { context, sampleRate, heads (names), topK, endOnSilenceMs, onChunk, onEvent }
   * @param {{stop(): void}|null} source  what feeds a listen Session (a microphone or a clip), or null
   */
  constructor(model, o, source = null) {
    this._m = model;
    this._o = o;
    this._source = source;
    const lim = model.limits || {};
    this._chunks = new Channel(lim.chunks || CHUNKS_LIMIT, model.onDrop || null); // counted for diagnose().droppedChunks
    this._events = new Channel(lim.events || EVENTS_LIMIT);
    this._maxTakeMs = lim.maxTakeMs || MAX_TAKE_MS;
    this._maxSamples = Math.floor((this._maxTakeMs / 1000) * o.sampleRate);
    // a live source (the microphone) delivers at its own pace whatever the engine does
    this._live = !!(source && source.live);
    this._maxPending = this._live ? Math.floor(((lim.maxPendingMs || MAX_PENDING_MS) / 1000) * o.sampleRate) : (lim.maxPendingSamples || MAX_PENDING_SAMPLES);
    this._pending = 0;
    this._state = 'open';
    this._store = { n40: 0, logProbs: new Growable(), conf: o.heads.includes('conf') ? new Growable() : null, frames: [], arrays: [] };
    this._speech = new SpeechTracker(o.endOnSilenceMs || DEFAULT_SILENCE_MS);
    // speech is decided on log_probs and timing_log_probs: the timing head is always computed, and handed to the
    // app (chunks, Heads, the telemetry's token counts) only when the app selected it
    this._timing = o.heads.includes('timing_log_probs');
    this._index = 0;
    this._samples = 0;
    this._chunkUs = [];
    this._counts = false;
    this._recitedCounted = false;
    this._t0 = model.clock();
    this._firstMs = null;
    this._heads = null;
    this._error = null;
    this._recited = null;
    this._done = null;
    this._drop = false;
    this._failed = null;
    this._tap = model.platform ? model.platform.takeStarted({ sampleRate: o.sampleRate }) : null;
    this._q = Promise.resolve()
      .then(() => model.ensureContext(o.context))
      .then(() => model.host.start({ context: o.context, sampleRate: o.sampleRate, heads: this._timing ? o.heads : [...o.heads, 'timing_log_probs'] }))
      .then((r) => { this._chunkMs = r.chunkMs; })
      .catch((e) => this._fail(e));
  }

  /** Each chunk as it is ready; the iteration ends when the take ends. */
  get chunks() { return this._chunks; }
  /** What happened to the take (speechStarted, speechEnded, interrupted, resumed, backendChanged, ended). */
  get events() { return this._events; }
  /** The Backend in force. */
  get backend() { return WASM_BACKEND; }

  /** Audio in: mono float samples at the Session's sampleRate. Only on a Session made with model.session(). */
  push(samples) {
    if (this._source) throw invalid('push() is for a session made with model.session(); a listen session is fed by the SDK');
    this._push(samples);
  }

  _push(samples) {
    if (this._state !== 'open') throw new TajweedError('session_closed');
    let pcm;
    if (samples instanceof Float32Array) pcm = samples.slice();
    else if (Array.isArray(samples) || ArrayBuffer.isView(samples)) pcm = Float32Array.from(samples);
    else throw invalid('push takes mono float samples (a Float32Array)');
    if (!pcm.length) return;
    // the longest take: the audio up to the limit is taken and the take ends by itself
    const room = this._maxSamples - this._samples;
    const limit = pcm.length >= room;
    if (limit) pcm = pcm.subarray(0, room);
    let over = null;
    if (this._pending > 0 && this._pending + pcm.length > this._maxPending) {
      over = this._live
        ? new TajweedError('engine_failed', { detail: 'this device decodes slower than the microphone delivers audio' })
        : invalid('too much audio is waiting to be decoded; push as the chunks arrive');
    }
    if (over) {
      this._close('self', { reason: 'error', error: over, flush: false });
      if (!this._source) throw over;
      return;
    }
    this._pending += pcm.length;
    if (this._firstMs === null) this._firstMs = this._m.clock() - this._t0;
    this._samples += pcm.length;
    if (this._tap) { try { this._tap.pushAudio(pcm); } catch (_) { /* sharing never stops a take */ } }
    this._q = this._q
      .then(() => (this._drop ? null : this._m.host.push(pcm)))
      .then((r) => { this._pending -= pcm.length; if (r && !this._drop) this._deliver(r, false); })
      .catch((e) => this._fail(e));
    if (limit) this._close('self', { reason: 'limit' });
  }

  _emit(ev) {
    this._events.push(ev);
    if (this._o.onEvent) { try { this._o.onEvent(ev); } catch (e) { queueMicrotask(() => { throw e; }); } }
  }

  _deliver({ chunks, computeMs }, last) {
    const st = this._store;
    const names = this._m.names;
    let silence = false;
    const list = chunks.slice();
    // the take's last decoded layer always arrives with a chunk: one with no frames when the end added none
    if (last && !list.length) list.push({ firstFrame: st.n40, n40: 0, heads: {} });
    for (let i = 0; i < list.length && !silence; i++) {
      const c = list[i];
      const lp = c.heads.log_probs;
      const frames = c.n40 ? decodeFrames(lp, c.n40) : [];
      const timing = c.n40 && c.heads.timing_log_probs ? greedyIds(c.heads.timing_log_probs) : [];
      if (!this._timing && c.heads.timing_log_probs) delete c.heads.timing_log_probs;
      if (c.n40) {
        st.arrays.push(c.heads);
        st.logProbs.append(lp);
        if (st.conf && c.heads.conf) st.conf.append(c.heads.conf);
        for (const f of frames) st.frames.push(f);
        st.n40 += c.n40;
        this._chunkUs.push(Math.round((computeMs * 1000) / chunks.length));
      }
      const sp = this._speech.feed(frames.map((f) => f.top1), timing);
      // endOnSilenceMs: the chunk that carries the frame of speechEnded is delivered whole and is the last
      silence = !last && this._o.endOnSilenceMs > 0 && sp.events.some((ev) => ev.type === 'speechEnded');
      for (const ev of sp.events) this._emit(ev);
      const n40 = st.n40, isFinal = silence || (last && i === list.length - 1), topK = this._o.topK;
      const chunk = {
        index: this._index++, startMs: 40 * c.firstFrame, endMs: 40 * (c.firstFrame + c.n40), firstFrame: c.firstFrame,
        backend: WASM_BACKEND, speech: sp.speech, heads: new TajweedHeads(c.heads, c.n40, names, { topK }),
      };
      let decoded = null;
      Object.defineProperty(chunk, 'decoded', {
        enumerable: true,
        get() {
          if (!decoded) {
            decoded = decodedOf({ logProbs: st.logProbs.view(n40 * VOCAB), conf: st.conf ? st.conf.view(2 * n40) : null, n40, names,
              frames: st.frames, topK, isFinal });
          }
          return decoded;
        },
      });
      this._chunks.push(chunk);
      if (this._o.onChunk) { try { this._o.onChunk(chunk); } catch (e) { queueMicrotask(() => { throw e; }); } }
    }
    // later audio is not decoded: the engine's stream is dropped, not flushed
    if (silence && this._state === 'open') this._close('self', { reason: 'silence', flush: false });
  }

  _fail(e) {
    const error = toTajweedError(e);
    if (this._state === 'open') this._close('self', { reason: 'error', error, flush: false });
    // audio queued before finish() failed after it: the take ends as a failed one
    else if (this._state === 'closing' && !this._failed) { this._failed = error; this._drop = true; }
  }

  /** The take ends by itself (SDK internals: the microphone, the clip, the page). */
  _end(reason, error = null) { if (this._state === 'open') this._close('self', { reason, error }); }

  _close(kind, o = {}) {
    let { reason = null, error = null, flush = true } = o;
    if (this._state !== 'open') return this._done;
    this._state = 'closing';
    // audio still queued belongs to the take when the app finished it or its source ran out; not after a cancel,
    // a failure, or the silence that ended it
    this._drop = kind === 'cancel' || !flush;
    if (this._source) { try { this._source.stop(); } catch (_) { /* already stopped */ } }
    const host = this._m.host;
    const run = async () => {
      let final = null;
      if (this._failed && kind !== 'cancel') { kind = 'self'; reason = 'error'; error = this._failed; flush = false; }
      if (kind === 'cancel' || !flush) {
        await host.cancel().catch(() => {});
      } else {
        try { final = await host.finish(); } catch (e) { kind = 'self'; reason = 'error'; error = toTajweedError(e); }
      }
      if (final) { try { this._deliver(final, true); } catch (e) { kind = 'self'; reason = 'error'; error = toTajweedError(e); } }
      this._finalize(kind, reason, error);
    };
    this._done = this._q.then(run, run);
    this._q = this._done.catch(() => {});
    return this._done;
  }

  _finalize(kind, reason, error) {
    const st = this._store;
    const cancelled = kind === 'cancel';
    this._state = cancelled ? 'cancelled' : 'ended';
    // a take counts when it ended with its Heads: finish(), or ended with any reason but error
    this._counts = !cancelled && reason !== 'error';
    if (!cancelled) this._heads = new TajweedHeads(joinArrays(st.arrays), st.n40, this._m.names, { topK: this._o.topK, isFinal: true });
    if (cancelled) this._error = new TajweedError('cancelled');
    else if (reason === 'error') this._error = error || new TajweedError('engine_failed', { detail: 'the take failed' });
    if (kind === 'self') this._emit({ type: 'ended', reason, ...(reason === 'error' ? { error: this._error } : {}) });
    if (this._tap) { try { if (cancelled) this._tap.free(); else this._tap.finish(); } catch (_) { /* sharing never stops a take */ } }
    try { this._report(); } catch (_) { /* telemetry never stops a take */ }
    this._chunks.close();
    this._events.close();
    this._m.sessionEnded(this);
  }

  // the take's numbers for the day's telemetry (SPEC 6.1 and 6.2); nothing without a Client
  _report() {
    const p = this._m.platform;
    if (!p) return;
    const st = this._store;
    const tokens = {}, margins = [], confidences = [];
    const counts = this._speech.counts();
    if (this._counts) {
      for (const n of this._heads.names) { const h = this._heads.get(n); if (h.kind === 'ctc') tokens[n] = this._heads.greedy(n).length; }
      // margin and confidence per emitted token, from the decoded layer (never from a judge)
      for (const t of this._heads.decoded().tokens) {
        margins.push(st.frames[t.peakMs / 40].margin);
        if (t.confidence !== null) confidences.push(t.confidence);
      }
    }
    p.telemetry.take(this._m.cohort(this._o.context), {
      samples: this._samples, sampleRate: this._o.sampleRate, chunkUs: this._chunkUs, chunkLenMs: this._chunkMs || 320, aborted: !this._counts,
      firstMs: this._firstMs, margins, confidences, tokens, speechFrames: counts.speech, silenceFrames: counts.silence,
    });
    if (this._counts && this._recited) { p.telemetry.recited(this._recited.surah, this._recited.ayahs); this._recitedCounted = true; }
    if (this._counts && counts.speech > 0 && typeof p.takeFinished === 'function') p.takeFinished();
  }

  /** End the take; resolves with the take's Heads. On a listen Session it also stops the microphone. */
  finish() {
    if (this._state === 'open') this._close('finish');
    return this._done.then(() => {
      if (this._error) throw this._error;
      return this._heads;
    });
  }

  /** End the take and keep nothing. */
  cancel() {
    if (this._state === 'open') this._close('cancel');
    return this._done.then(() => {});
  }

  /**
   * Where the learner recited in this take (SPEC 6.3): counted into the day's anonymous totals, never sent with
   * a recording. One report per take: before the take ends a second call replaces the first, and the report is
   * counted when the take ends with its Heads; after such a take the first call is counted at once. A cancelled
   * or failed take counts none.
   */
  reportRecited(surah, ayahFrom, ayahTo) {
    if (!Number.isInteger(surah) || surah < 1 || surah > 114) throw invalid(`surah ${surah} is not 1 to 114`);
    const n = ayahsIn(surah);
    if (!Number.isInteger(ayahFrom) || !Number.isInteger(ayahTo) || ayahFrom < 1 || ayahFrom > ayahTo || ayahTo > n) {
      throw invalid(`ayahs ${ayahFrom} to ${ayahTo} are not inside surah ${surah} (1 to ${n})`);
    }
    const report = { surah, ayahs: ayahTo - ayahFrom + 1 };
    const over = this._state === 'ended' || this._state === 'cancelled';
    if (!over) { this._recited = report; return; }
    if (!this._counts || this._recitedCounted) return;
    this._recitedCounted = true;
    const p = this._m.platform;
    if (p) p.telemetry.recited(report.surah, report.ayahs);
  }
}
