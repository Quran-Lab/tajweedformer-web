// What holds the shared recording between takes (SDK 2.0.3): a take (one model session) and the recording (one Ogg stream,
// one outbox item, one session id) are two things. Takes in a row join the open recording by the rules of
// takes.js; everything else closes it as a 2.0.2 session ended. The pipeline's startSession() asks the recorder
// for a take; the take's push(), finish() and abort() are the app's calls, as before.
//
// Every decision reads the clock (the window is wall time). The timer only makes the window's end prompt: when it
// fires, the clock decides whether the window has passed. Both are seams (tests never sleep).
//
// SDK 3.0.0 adds the feed (audio the app already captures outside takes; the shared vector sharing_30.json):
//   F1 fed audio is dropped at once unless sharing is available and on with the learner's yes;
//   F2 a buffer fed while a take runs is dropped;
//   F3 the feed continues when a call comes no later than its own duration + 500 ms after the previous audio
//      (the previous feed call, or the end of the take before it); otherwise it paused: the ring is emptied and
//      an open tail ends;
//   F4 tail: after a take ends, the first fed samples that continue from it go into the recording, up to 0.5 s,
//      at the recording's rate only;
//   F5 ring: every other fed sample goes to a ring of the last 1 s, in memory only, at one rate;
//   F6 pre-roll: when a take starts, the ring is put before the take's audio if it has the take's rate and its
//      last feed call is at most 500 ms old; the ring is empty afterwards;
//   F7 the join decision is unchanged, on the takes' own wall times.
// and two numbers of the session JSON: take_seq (this install's count of shared recordings) and gap_ms_prev (wall
// ms from the end of the previous recording's last take to this recording's first take, rounded to 100).

import { joinWindowMs, takeStartMs, roundGap, RECORDING_CAP_MS, MAX_TAKES, HOLD_MS } from './takes.js';

/** The feed paused when a call comes later than its own duration plus this (ms); also how old a ring may be. */
export const FEED_STALE_MS = 500;
/** The tail of a take can take fed audio until this long after the take's end (wall ms). */
export const TAIL_WAIT_MS = 1500;
/** gap_ms_prev is left out above this (ms). */
export const GAP_PREV_MAX_MS = 3600000;
const round100 = (ms) => Math.floor((ms + 50) / 100) * 100;
/** The most samples a recording holds: the 20 minute cap at its rate. */
const capSamples = (rate) => (RECORDING_CAP_MS / 1000) * rate;

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
    this.key = [opts.contributor, opts.consentVersion ?? '', opts.consentTextSha256 ?? '', d.modelRevision ?? '', d.modelBuild ?? ''].join('\n');
    this.pre = null; // the pre-roll from the feed's ring (chunks), put before the take's first audio
    this.preSamples = 0;
    this.startedAt = 0;
    this.enabled = typeof opts.enabled === 'function' ? opts.enabled : () => true;
    this.rec = null; // the recording this take's audio goes into
    this.joining = false; // joined an open recording and has no boundary yet (it gets one at its first audio)
    this.gapMs = 0;
    this.held = null; // near the cap: the take's audio so far, kept until the take ends
    this.capped = false; // its recording closed at the cap: the take's next audio starts a new recording
    this.written = 0; // the take's own samples written to recordings so far
    /** Where the take was cut at the cap: the index of its first sample in the recording that continues it. */
    this.cuts = [];
    /** A held take that did not fit and started a new recording. */
    this.moved = false;
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
  constructor({ make, flags = () => null, clock = () => Date.now(), timers = null, onClosed = null, onInstall = null }) {
    this.make = make;
    /** (3.0.0) Called when take_seq or the previous recording's end changes: ({ seq, prevEnd }) to persist. */
    this.onInstall = onInstall;
    /** This install's count of shared recordings so far, and the wall ms its last recorded take ended (or null). */
    this.seq = 0;
    this.prevEnd = null;
    // the feed: a ring of the last second at one rate, the wall ms of its last call, the wall ms of the previous audio
    // (one array of exactly one second, written in a circle: its size never depends on how the app feeds)
    this.ring = { rate: 0, buf: null, start: 0, samples: 0, at: null };
    this.lastAudio = null;
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
    t.startedAt = now;
    // F6: the ring becomes the take's pre-roll when it has the take's rate and is fresh; it is empty afterwards
    const ring = this.ring;
    if (ring.samples > 0 && ring.rate === t.rate && ring.at !== null && now - ring.at <= FEED_STALE_MS) {
      t.pre = [this._ringCopy()];
      t.preSamples = ring.samples;
    }
    this._emptyRing();
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
        if (capSamples(r.rate) - r.samples <= (HOLD_MS / 1000) * r.rate) t.held = [];
        this.current = t;
        return t;
      }
      this._close(r);
    }
    t.rec = this._new(t);
    this.current = t;
    return t;
  }

  _new(t, continues = false) {
    // take_seq counts every recording that starts, whatever becomes of it; gap_ms_prev runs from the end of the
    // previous recording's last take to this take's start (absent for the first, a negative gap, or over an hour)
    const seq = this.seq + 1;
    let gap = continues ? 0 : null; // a recording that continues a take cut at the cap: no gap, said as 0
    if (!continues && this.prevEnd !== null) {
      const g = t.startedAt - this.prevEnd;
      if (g >= 0 && g <= GAP_PREV_MAX_MS) gap = Math.min(round100(g), GAP_PREV_MAX_MS);
    }
    const r = { cap: this.make({ ...t.opts, takeSeq: seq, gapMsPrev: gap }), rate: t.rate, samples: 0, takes: [{ start_ms: 0, gap_ms: 0 }], completed: false,
      key: t.key, closeAfterTake: false, closed: null, tailLeft: 0, takeSeq: seq, gapMsPrev: gap, parts: [] };
    this.seq = seq;
    this._install();
    this.recording = r;
    return r;
  }

  _install() {
    if (!this.onInstall) return;
    try { this.onInstall({ seq: this.seq, prevEnd: this.prevEnd }); } catch (_) { /* storage's own problem */ }
  }

  // nothing of the fed audio stays: the array goes too
  _emptyRing() { this.ring = { rate: 0, buf: null, start: 0, samples: 0, at: null }; }

  // the ring's samples in order, oldest first
  _ringCopy() {
    const g = this.ring, out = new Float32Array(g.samples);
    const first = Math.min(g.samples, g.buf.length - g.start);
    out.set(g.buf.subarray(g.start, g.start + first));
    if (g.samples > first) out.set(g.buf.subarray(0, g.samples - first), first);
    return out;
  }

  /** Samples in the feed's ring now. */
  get ringSamples() { return this.ring.samples; }

  // the take's first audio: its pre-roll goes in first, then its boundary is set (a take without audio has neither)
  _begin(t) {
    const r = t.rec;
    const pre = t.pre;
    t.pre = null;
    r.parts.push({ pre_roll: pre ? t.preSamples : 0, take: 0, tail: 0 });
    if (pre) for (const c of pre) if (!this._append(t, r, c)) return false;
    if (t.joining) this._enter(t);
    else if (pre && r.takes.length === 1) r.takes[0].start_ms = takeStartMs(t.preSamples, r.rate);
    t.begun = true;
    return true;
  }

  /**
   * (3.0.0) Audio the app captures outside takes: mono float samples at `rate`, the call's wall time taken as the
   * end of its audio. `allowed`: sharing is available and on and the learner said yes. Returns what became of
   * the samples: { toTail, toRing, dropped, ringSamples }.
   */
  feed(pcm, rate, at = this.clock(), allowed = true) {
    const n = pcm ? pcm.length : 0;
    const hz = Math.round(rate);
    if (!allowed) { this._emptyRing(); return { toTail: 0, toRing: 0, dropped: n, ringSamples: 0 }; }   // F1
    if (this.current || !n || !(hz >= 8000 && hz <= 192000)) return { toTail: 0, toRing: 0, dropped: n, ringSamples: this.ring.samples };   // F2
    const dur = Math.floor((1000 * n) / hz);
    const r = this.recording;
    // F3: the feed continues from the previous audio, or it paused
    if (!(this.lastAudio !== null && at - this.lastAudio <= dur + FEED_STALE_MS)) {
      this._emptyRing();
      if (r) r.tailLeft = 0;
    }
    // F8: a call later than the tail wait after the take's end never goes to the tail
    if (r && r.tailLeft > 0 && at - this.lastEnd > TAIL_WAIT_MS) r.tailLeft = 0;
    // F4: the tail of the take that just ended
    let toTail = 0;
    if (r && r.tailLeft > 0) {
      if (hz === r.rate && !r.cap.failed) {
        toTail = Math.max(0, Math.min(n, r.tailLeft, capSamples(r.rate) - r.samples));
        r.tailLeft -= toTail;
        if (this._append(null, r, toTail === n && pcm instanceof Float32Array ? pcm : Float32Array.from(pcm.subarray ? pcm.subarray(0, toTail) : pcm.slice(0, toTail)))) {
          if (r.parts.length) r.parts[r.parts.length - 1].tail += toTail;
          // the tail is cut at the cap: the recording closes there, the rest of the buffer goes to the ring
          if (r.samples >= capSamples(r.rate)) { r.atCap = true; this._close(r); }
        } else toTail = 0;
      } else r.tailLeft = 0;
    }
    // F5: the rest goes to the ring of the last second
    const rest = n - toTail;
    if (rest > 0) {
      if (this.ring.rate !== hz || !this.ring.buf) { this._emptyRing(); this.ring.rate = hz; this.ring.buf = new Float32Array(hz); }
      const g = this.ring;
      const sub = (i, j) => (pcm.subarray ? pcm.subarray(i, j) : pcm.slice(i, j));
      if (rest >= hz) {
        // a buffer of a second or more: its last second is the ring
        g.buf.set(sub(n - hz, n));
        g.start = 0;
        g.samples = hz;
      } else {
        const w = (g.start + g.samples) % hz, first = Math.min(rest, hz - w);
        g.buf.set(sub(toTail, toTail + first), w);
        if (rest > first) g.buf.set(sub(toTail + first, n), 0);
        const total = g.samples + rest;
        if (total > hz) { g.start = (g.start + total - hz) % hz; g.samples = hz; } else g.samples = total;
      }
      g.at = at;
    }
    this.lastAudio = at;
    // a recording whose window is over and whose tail can take nothing more closes now
    if (this.recording && !this.current) this.checkWindow();
    return { toTail, toRing: rest, dropped: 0, ringSamples: this.ring.samples };
  }

  /** (3.0.0) "Delete what I shared": the count of recordings starts again, the previous end and the ring are forgotten. */
  forgetInstall() {
    this.seq = 0;
    this.prevEnd = null;
    this.lastEnd = 0;
    this._emptyRing();
    this._install();
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
    if (t.capped && !this._resume(t)) return;
    const r = t.rec;
    if (!r || this.recording !== r) return; // its recording is gone (sharing went off, a failure)
    if (r.cap.failed) { this._forget(r); return; }
    if (t.held) {
      t.held.push(pcm instanceof Float32Array ? pcm.slice() : Float32Array.from(pcm));
      t.heldSamples += pcm.length;
      t.samples += pcm.length;
      // the fit is compared in samples, the pre-roll counted with the take (3.0.0; 2.0.3 compared floored ms)
      if (r.samples + t.heldSamples + (t.pre ? t.preSamples : 0) > capSamples(r.rate)) this._overflow(t);
      return;
    }
    if (!t.begun && !this._begin(t)) return;
    this._take(t, pcm);
  }

  // The take's audio into its recording. A recording never holds more than 20 minutes (3.0.0): where its audio
  // reaches the cap it closes as a whole recording, and the rest of the take goes on in a new one at the next
  // sample (gap_ms_prev 0, the next take_seq, no pre-roll). Each turn takes samples or returns.
  _take(t, pcm, counted = false) {
    let at = 0;
    while (at < pcm.length) {
      const r = t.rec;
      const n = Math.min(pcm.length - at, capSamples(r.rate) - r.samples);
      if (n > 0) {
        if (!this._append(t, r, n === pcm.length ? pcm : pcm.subarray(at, at + n))) return;
        if (!counted) t.samples += n;
        t.written += n;
        r.parts[r.parts.length - 1].take += n;
        at += n;
      }
      if (r.samples >= capSamples(r.rate)) {
        r.completed = true;
        r.atCap = true;
        this._close(r);
        t.rec = null;
        t.capped = true;
        if (at < pcm.length && !this._resume(t)) return;
      }
    }
  }

  // the recording that continues a take whose recording closed at the cap (made when the take's next audio comes)
  _resume(t) {
    t.capped = false;
    if (this.recording || !t.enabled()) return false;
    let r;
    try { r = this._new(t, true); } catch (_) { return false; }
    t.rec = r;
    t.cuts.push(t.written);
    r.parts.push({ pre_roll: 0, take: 0, tail: 0 });
    return true;
  }

  // the held take outgrew the room under the cap: the recording closes without it, the take starts a new one
  _overflow(t) {
    const held = t.held;
    t.held = null;
    t.heldSamples = 0;
    t.joining = false;
    t.moved = true;
    t.samples = 0;
    this._close(t.rec);
    t.rec = null;
    let r;
    try { r = this._new(t); } catch (_) { return; }
    t.rec = r;
    if (!this._begin(t)) return;
    for (const c of held) { this._take(t, c); if (this.recording !== t.rec) return; }
  }

  async _end(t, { completed = true, at } = {}) {
    if (t.ended) return 0;
    t.ended = true;
    if (this.current === t) this.current = null;
    let r = t.rec;
    if (t.held && r && this.recording === r && !r.cap.failed) {
      // the held take ended within the room: it joins (the few samples by which it may pass the cap, which the
      // hold's floored milliseconds do not see, go on in a new recording as for any take)
      const held = t.held;
      t.held = null;
      if (held.length) {
        if (!this._begin(t)) return 0;
        for (const c of held) { this._take(t, c, true); if (!t.capped && this.recording !== t.rec) return 0; }
        r = t.rec;
      }
    }
    if (t.capped) {
      // the take ended where its recording closed at the cap: its end is the previous end of what comes next
      const end = Number.isFinite(at) ? at : this.clock();
      this.lastEnd = end;
      this.lastAudio = end;
      this.prevEnd = end;
      this._install();
      await this.settled();
      return Math.round(t.samples * 1000 / t.rate);
    }
    if (!r || this.recording !== r) return 0;
    if (r.cap.failed) { this._forget(r); return 0; }
    const now = Number.isFinite(at) ? at : this.clock();
    if (t.samples > 0) {
      r.completed = !!completed;
      this.lastEnd = now;
      // the feed may continue from the take's end: a tail of up to 0.5 s, and the next recording's gap_ms_prev
      this.lastAudio = now;
      r.tailLeft = Math.floor(r.rate / 2);
      this.prevEnd = now;
      this._install();
    }
    const takeMs = Math.round(t.samples * 1000 / t.rate);
    const w = this.window;
    const windowOpen = w > 0 && now - this.lastEnd <= w;
    if (r.samples === 0 || this.backgrounded || r.closeAfterTake || !t.enabled() || takeStartMs(r.samples, r.rate) >= RECORDING_CAP_MS
      || r.takes.length >= MAX_TAKES || (!windowOpen && !this._tailOpen(r, now))) {
      return (await this._close(r)) > 0 ? takeMs : 0;
    }
    this._arm(this._wait(r, now));
    await Promise.resolve(r.cap.io).catch(() => {});
    return r.cap.failed ? 0 : takeMs;
  }

  // Whether the open recording still waits for a tail from the feed (F8): while the tail is not complete and
  // the feed has not paused (both leave tailLeft at 0), for TAIL_WAIT_MS of wall time after the take's end.
  // After every take, whether or not the app has fed before: window 0 still keeps the recording open for its tail.
  // Only fed audio is recorded in that time; the SDK never keeps or reopens a microphone for it.
  _tailOpen(r, now) {
    return r.tailLeft > 0 && now - this.lastEnd <= TAIL_WAIT_MS;
  }

  // ms until the waiting recording has to be looked at again: the rest of the join window, or of the tail's wait
  _wait(r, now) {
    const w = this.window;
    const left = w > 0 ? w - (now - this.lastEnd) : -1;
    const tail = this._tailOpen(r, now) ? TAIL_WAIT_MS - (now - this.lastEnd) : -1;
    return Math.max(left, tail, 0);
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
        takes: r.takes.length > 1 ? r.takes.map((x) => ({ ...x })) : null, completed: r.completed, sharedMs,
        takeSeq: r.takeSeq, gapMsPrev: r.gapMsPrev, parts: r.parts.map((x) => ({ ...x })), closedAtCap: !!r.atCap });
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
    const now = this.clock();
    const waited = now - this.lastEnd;
    // closed once the window has passed and the tail can take nothing more (it is full, or the feed paused)
    if ((w <= 0 || waited > w) && !this._tailOpen(r, now)) { this._close(r); return true; }
    this._arm(this._wait(r, now));
    return false;
  }

  /** The app went to the background (the page is hidden): a waiting recording closes now, a running take's when
   * the take ends. */
  background() {
    this.backgrounded = true;
    this._emptyRing(); // nothing fed is kept in the background
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
    this._emptyRing();
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
