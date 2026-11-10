// What holds the shared recording between takes (SDK 2.0.3): a take (one model session) and the recording (one Ogg stream,
// one outbox item, one session id) are two things. Takes in a row join the open recording by the rules of
// takes.js; everything else closes it as a 2.0.2 session ended. The pipeline's startSession() asks the recorder
// for a take; the take's push(), finish() and abort() are the app's calls, as before.
//
// Every decision reads the clock (the window is wall time). The timer only makes the window's end prompt: when it
// fires, the clock decides whether the window has passed. Both are seams (tests never sleep).

import { joinWindowMs, takeStartMs, roundGap, RECORDING_CAP_MS, MAX_TAKES, HOLD_MS } from './takes.js';

const defaultTimers = {
  setTimeout: (f, ms) => globalThis.setTimeout(f, ms),
  clearTimeout: (t) => globalThis.clearTimeout(t),
};

/**
 * One take being shared: what startSession() returns. Its audio goes into the recording it joined or started.
 * push() is synchronous; finish() resolves once the take's audio is in storage (and, when the recording closes
 * with it, once the recording is closed).
 */
export class ShareTake {
  constructor(recorder, opts) {
    this.recorder = recorder;
    this.opts = opts;
    this.rate = Math.round(opts.inputSampleRate);
    const d = opts.decode || {};
    // what the session JSON (written once, at the first take) says about every take of the recording
    this.key = [opts.contributor, opts.consentVersion ?? '', opts.consentTextSha256 ?? '', d.modelRevision ?? ''].join('\n');
    this.enabled = typeof opts.enabled === 'function' ? opts.enabled : () => true;
    this.rec = null; // the recording this take's audio goes into
    this.joining = false; // joined an open recording and has no boundary yet (it gets one at its first audio)
    this.gapMs = 0;
    this.held = null; // near the cap: the take's audio so far, kept until the take ends
    this.heldSamples = 0;
    this.samples = 0;
    this.ended = false;
    this._done = null;
  }

  /** The capture of the take's recording (null once sharing went off). */
  get capture() { return this.rec ? this.rec.cap : null; }
  /** The recording's id (the outbox item's): the same for every take that joined it. */
  get id() { return this.rec ? this.rec.cap.id : null; }
  /** Seconds of this take's audio so far. */
  get duration() { return this.samples / this.rate; }
  /** The recording's storage writes so far (awaited by finish()). */
  get io() { return this.rec ? this.rec.cap.io : Promise.resolve(); }
  get settings() { return this.rec ? this.rec.cap.settings : this.opts.settings; }
  get segments() { return this.rec ? this.rec.cap.segments : 0; }
  get error() { return this.rec ? this.rec.cap.error : null; }
  get failed() { return !this.rec || !!this.rec.cap.failed; }
  set failed(v) { if (this.rec) this.rec.cap.failed = !!v; }

  /** Mono float samples at the take's input rate. */
  push(pcm) { this.recorder._push(this, pcm); }

  /** The end of the take (completed false: a cancelled one). Resolves to the take's audio in ms that went into
   * its recording, 0 when nothing is shared. The recording stays open for the join window. */
  finish({ completed = true, endedAt } = {}) {
    if (!this._done) this._done = this.recorder._end(this, { completed, at: endedAt });
    return this._done;
  }

  /** A failed take: its recording ends here as a failed capture (segments already closed stay with the outbox
   * while sharing is on). */
  abort() { return this.recorder._abort(this); }
}

/**
 * The recordings of one sharing pipeline.
 * @param {object} o
 * @param {(opts: object) => object} o.make  the capture of a new recording (ShareCapture; tests pass their own):
 *        { id, failed, io, settings, push(pcm), setTakes(takes), finish({completed}), abort(), discard() }
 * @param {() => object|null} [o.flags]  the signed config's flags (share_join_ms)
 * @param {() => number} [o.clock]  wall ms
 * @param {{setTimeout: Function, clearTimeout: Function}} [o.timers]
 * @param {(r: object) => void} [o.onClosed]  a recording closed: { id, rate, samples, audioMs, takes (null for one
 *        take), completed, sharedMs (0: nothing shared) }
 */
export class ShareRecorder {
  constructor({ make, flags = () => null, clock = () => Date.now(), timers = null, onClosed = null }) {
    this.make = make;
    this.flags = flags;
    this.clock = clock;
    this.timers = timers || defaultTimers;
    this.onClosed = onClosed;
    /** The open recording (between takes too), or null: { cap, rate, samples, takes, completed, key }. */
    this.recording = null;
    /** The take that is running, or null. */
    this.current = null;
    /** Wall ms when the last take with audio ended. */
    this.lastEnd = 0;
    this.backgrounded = false;
    this._timer = null;
    this._gen = 0;
    this._closes = new Set();
  }

  /** The join window in force (ms; 0: never join). */
  get window() { return joinWindowMs(this.flags()); }

  /** The open recording's takes so far ([] when none is open). */
  get takes() { return this.recording ? this.recording.takes.map((t) => ({ ...t })) : []; }

  /**
   * A take starts: it joins the open recording, or closes it and starts a new one.
   * @param {object} opts  what a capture needs (ShareCapture's options), with inputSampleRate, and optionally
   *        startedAt (wall ms of the take's start; default: now)
   */
  take(opts) {
    const now = Number.isFinite(opts.startedAt) ? opts.startedAt : this.clock();
    // a take that never ended (2.0.2 ended its session as not completed)
    if (this.current) this._end(this.current, { completed: false, at: now });
    const t = new ShareTake(this, opts);
    const r = this.recording;
    if (r) {
      this._disarm();
      const w = this.window;
      const gap = now - this.lastEnd;
      const ms = takeStartMs(r.samples, r.rate);
      if (w > 0 && gap <= w && !this.backgrounded && !r.closeAfterTake && !r.cap.failed && t.enabled() && r.rate === t.rate
        && r.key === t.key && ms < RECORDING_CAP_MS && r.takes.length < MAX_TAKES) {
        t.rec = r;
        t.joining = true;
        t.gapMs = roundGap(gap);
        // little room under the cap: whether the take fits is known only when it ends
        if (RECORDING_CAP_MS - ms <= HOLD_MS) t.held = [];
        this.current = t;
        return t;
      }
      this._close(r);
    }
    t.rec = this._new(t);
    this.current = t;
    return t;
  }

  _new(t) {
    const r = { cap: this.make(t.opts), rate: t.rate, samples: 0, takes: [{ start_ms: 0, gap_ms: 0 }], completed: false, key: t.key,
      closeAfterTake: false, closed: null };
    this.recording = r;
    return r;
  }

  _forget(r) {
    if (this.recording !== r) return;
    this._disarm();
    this.recording = null;
  }

  // a joining take's boundary, at its first audio (a take without audio has none)
  _enter(t) {
    const r = t.rec;
    t.joining = false;
    const start = takeStartMs(r.samples, r.rate);
    // strictly increasing: a take that starts in the same millisecond as the last boundary adds none
    if (start > r.takes[r.takes.length - 1].start_ms) {
      r.takes.push({ start_ms: start, gap_ms: t.gapMs });
      r.cap.setTakes(r.takes);
    }
  }

  _append(t, r, pcm) {
    r.cap.push(pcm);
    if (r.cap.failed) { this._forget(r); return false; } // sharing went off, or storage failed
    r.samples += pcm.length;
    return true;
  }

  _push(t, pcm) {
    if (t.ended || !pcm || !pcm.length) return;
    const r = t.rec;
    if (!r || this.recording !== r) return; // its recording is gone (sharing went off, a failure)
    if (r.cap.failed) { this._forget(r); return; }
    if (t.held) {
      t.held.push(pcm instanceof Float32Array ? pcm.slice() : Float32Array.from(pcm));
      t.heldSamples += pcm.length;
      t.samples += pcm.length;
      if (takeStartMs(r.samples, r.rate) + takeStartMs(t.heldSamples, r.rate) > RECORDING_CAP_MS) this._overflow(t);
      return;
    }
    if (t.joining) this._enter(t);
    if (this._append(t, r, pcm)) t.samples += pcm.length;
  }

  // the held take outgrew the room under the cap: the recording closes without it, the take starts a new one
  _overflow(t) {
    const held = t.held;
    t.held = null;
    t.heldSamples = 0;
    t.joining = false;
    t.samples = 0;
    this._close(t.rec);
    t.rec = null;
    let r;
    try { r = this._new(t); } catch (_) { return; }
    t.rec = r;
    for (const c of held) {
      if (!this._append(t, r, c)) return;
      t.samples += c.length;
    }
  }

  async _end(t, { completed = true, at } = {}) {
    if (t.ended) return 0;
    t.ended = true;
    if (this.current === t) this.current = null;
    const r = t.rec;
    if (!r || this.recording !== r) return 0;
    if (r.cap.failed) { this._forget(r); return 0; }
    if (t.held) {
      // the held take ended within the room: it joins
      const held = t.held;
      t.held = null;
      if (held.length) {
        this._enter(t);
        for (const c of held) if (!this._append(t, r, c)) return 0;
      }
    }
    const now = Number.isFinite(at) ? at : this.clock();
    if (t.samples > 0) { r.completed = !!completed; this.lastEnd = now; }
    const takeMs = Math.round(t.samples * 1000 / t.rate);
    const w = this.window;
    if (r.samples === 0 || w <= 0 || this.backgrounded || r.closeAfterTake || !t.enabled() || takeStartMs(r.samples, r.rate) >= RECORDING_CAP_MS
      || r.takes.length >= MAX_TAKES || now - this.lastEnd > w) {
      return (await this._close(r)) > 0 ? takeMs : 0;
    }
    this._arm(w - (now - this.lastEnd));
    await Promise.resolve(r.cap.io).catch(() => {});
    return r.cap.failed ? 0 : takeMs;
  }

  async _abort(t) {
    if (t.ended) return;
    t.ended = true;
    t.held = null;
    if (this.current === t) this.current = null;
    const r = t.rec;
    if (!r || this.recording !== r) return;
    this._forget(r);
    await r.cap.abort();
    this._report(r, 0);
  }

  _report(r, sharedMs) {
    if (!this.onClosed) return;
    try {
      this.onClosed({ id: r.cap.id, rate: r.rate, samples: r.samples, audioMs: takeStartMs(r.samples, r.rate),
        takes: r.takes.length > 1 ? r.takes.map((x) => ({ ...x })) : null, completed: r.completed, sharedMs });
    } catch (_) { /* a listener's own problem */ }
  }

  // Closes a recording as a 2.0.2 session ended (the last page with EOS, end.json). Resolves to the ms shared.
  _close(r) {
    this._forget(r);
    if (r.closed) return r.closed;
    r.closed = (async () => {
      let ms = 0;
      try { ms = await r.cap.finish({ completed: r.completed }); } catch (_) { ms = 0; }
      this._report(r, ms);
      return ms;
    })();
    this._closes.add(r.closed);
    r.closed.then(() => this._closes.delete(r.closed));
    return r.closed;
  }

  /** Resolves when every recording being closed is closed. */
  async settled() { while (this._closes.size) await Promise.all([...this._closes]); }

  _arm(ms) {
    this._disarm();
    const gen = this._gen;
    this._timer = this.timers.setTimeout(() => {
      if (gen !== this._gen) return;
      this._timer = null;
      this.checkWindow();
    }, Math.max(0, ms) + 1);
  }

  _disarm() {
    if (this._timer !== null) this.timers.clearTimeout(this._timer);
    this._timer = null;
    this._gen++;
  }

  /** The window's end (the timer calls it; tests too): closes the waiting recording once the clock says the
   * window has passed, else waits for the rest of it. True when it closed one. */
  checkWindow() {
    const r = this.recording;
    if (!r || this.current) return false;
    const w = this.window;
    const waited = this.clock() - this.lastEnd;
    if (w <= 0 || waited > w) { this._close(r); return true; }
    this._arm(w - waited);
    return false;
  }

  /** The app went to the background (the page is hidden): a waiting recording closes now, a running take's when
   * the take ends. */
  background() {
    this.backgrounded = true;
    const r = this.recording;
    return r && !this.current ? this._close(r).then(() => {}) : Promise.resolve();
  }

  /** The app is in the foreground again. */
  foreground() { this.backgrounded = false; }

  /** No take follows: the open recording closes now instead of at the end of its join window (with a take
   * running: when that take ends). */
  closeRecording() {
    const r = this.recording;
    if (!r) return this.settled();
    if (this.current) { r.closeAfterTake = true; return Promise.resolve(); }
    return this._close(r).then(() => {});
  }

  /** Sharing went off (withdrawal, deletion, the signed config): the open recording ends at once and is deleted,
   * whatever the take does; the running take records nothing more. */
  async stop() {
    const r = this.recording;
    this._forget(r);
    const t = this.current;
    if (t) { t.held = null; t.rec = null; }
    await this.settled();
    if (!r) return;
    try { await r.cap.discard(); } catch (_) { /* nothing left to delete */ }
    this._report(r, 0);
  }

  /** Tests: the page is gone mid-recording. Storage stays as it is; nothing more is written. */
  kill() {
    const r = this.recording;
    this._disarm();
    this.recording = null;
    if (this.current) { this.current.ended = true; this.current.rec = null; }
    this.current = null;
    if (r && typeof r.cap.kill === 'function') r.cap.kill();
  }
}
