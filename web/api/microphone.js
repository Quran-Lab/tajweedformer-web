// The SDK's optional microphone for browsers (SPEC 13.1, NAMING.md section 5): getUserMedia plus an
// AudioWorklet, mono float samples at the AudioContext's own rate (the device's, usually 48 kHz), never
// resampled here. model.listen() wires it to a Session; apps that want samples only use it directly:
//
//   const mic = await Microphone.open();
//   for await (const block of mic.samples()) use(block, mic.sampleRate);
//   mic.close();
//
// What it handles: a refused permission (microphone_denied), no input device (microphone_unavailable), an
// interruption (the track muted or the audio context suspended by the system: no audio is read until it ends),
// a device change (the input is opened again on the same AudioContext, so the rate does not change).
// Nothing is captured before open() and nothing after close().
import { TajweedError, toTajweedError } from './errors.js';

// The worklet: posts each render quantum's first channel (128 samples) to the page, batched to about 20 ms.
const WORKLET = `
class QuranLabMic extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(Math.max(128, Math.round(sampleRate / 50 / 128) * 128)); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.buf.set(ch, this.n);
      this.n += ch.length;
      if (this.n + 128 > this.buf.length) { this.port.postMessage(this.buf.slice(0, this.n)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('quranlab-mic', QuranLabMic);
`;

const env = (seams = {}) => ({
  mediaDevices: seams.mediaDevices !== undefined ? seams.mediaDevices : (globalThis.navigator && globalThis.navigator.mediaDevices) || null,
  AudioContext: seams.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext || null,
  AudioWorkletNode: seams.AudioWorkletNode || globalThis.AudioWorkletNode || null,
  permissions: seams.permissions !== undefined ? seams.permissions : (globalThis.navigator && globalThis.navigator.permissions) || null,
});

/** The microphone permission as the browser tells it without asking: 'granted', 'denied', 'notAsked', or
 * 'none' where there is no microphone API (Node). */
export async function microphonePermission(seams = {}) {
  const e = env(seams);
  if (!e.mediaDevices || typeof e.mediaDevices.getUserMedia !== 'function') return 'none';
  try {
    const st = await e.permissions.query({ name: 'microphone' });
    return st.state === 'granted' ? 'granted' : st.state === 'denied' ? 'denied' : 'notAsked';
  } catch (_) { return 'notAsked'; }
}

/** The most blocks (about 20 ms each) that wait in samples() when the app does not read them. */
export const MIC_QUEUE_BLOCKS = 1500;

export class Microphone {
  /** Use Microphone.open(). */
  constructor(internals) {
    Object.assign(this, { _e: internals.e, _ctx: internals.ctx, _stream: null, _node: null, _src: null, _closed: false, _paused: false });
    this._queue = [];
    this._waiting = [];
    this._listeners = new Set();
    /** The rate of the samples: the AudioContext's, the device's native rate. */
    this.sampleRate = internals.ctx.sampleRate;
  }

  /**
   * Ask for the microphone and open it. Rejects with TajweedError microphone_denied when the learner or the
   * system refuses, microphone_unavailable when there is no input, no microphone API (Node) or another app
   * holds it.
   */
  static async open(seams = {}) {
    const e = env(seams);
    if (!e.mediaDevices || typeof e.mediaDevices.getUserMedia !== 'function' || !e.AudioContext) {
      throw new TajweedError('microphone_unavailable', { detail: 'this runtime has no microphone (no getUserMedia or AudioContext)' });
    }
    let stream;
    try { stream = await Microphone._capture(e); } catch (err) { throw toTajweedError(err, { fallback: 'microphone_unavailable' }); }
    let ctx = null;
    try {
      ctx = new e.AudioContext({ latencyHint: 'interactive' });
      const mic = new Microphone({ e, ctx });
      await mic._worklet();
      mic._attach(stream);
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') await ctx.resume().catch(() => {});
      mic._watch();
      return mic;
    } catch (err) {
      for (const t of stream.getTracks()) t.stop();
      if (ctx && typeof ctx.close === 'function') ctx.close().catch(() => {});
      throw toTajweedError(err, { fallback: 'microphone_unavailable' });
    }
  }

  // mono, with the browser's speech processing off: the model wants the recitation as the device hears it
  static _capture(e) {
    return e.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
  }

  async _worklet() {
    const ctx = this._ctx;
    if (!ctx.audioWorklet || !this._e.AudioWorkletNode) throw new TajweedError('microphone_unavailable', { detail: 'this browser has no AudioWorklet' });
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  _attach(stream) {
    const ctx = this._ctx;
    this._stream = stream;
    this._src = ctx.createMediaStreamSource(stream);
    if (!this._node) {
      this._node = new this._e.AudioWorkletNode(ctx, 'quranlab-mic', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
      this._node.port.onmessage = (ev) => { if (!this._closed && !this._paused) this._block(ev.data); };
    }
    this._src.connect(this._node);
    const track = stream.getAudioTracks()[0];
    this._track = track;
    if (track && typeof track.addEventListener === 'function') {
      track.addEventListener('mute', this._onMute = () => this._pause());
      track.addEventListener('unmute', this._onUnmute = () => this._resume());
      track.addEventListener('ended', this._onEnded = () => { if (!this._closed && this._track === track) this._reopen(); });
    }
  }

  _detach() {
    const t = this._track;
    if (t && typeof t.removeEventListener === 'function') {
      t.removeEventListener('mute', this._onMute);
      t.removeEventListener('unmute', this._onUnmute);
      t.removeEventListener('ended', this._onEnded);
    }
    if (this._src) { try { this._src.disconnect(); } catch (_) { /* gone */ } }
    if (this._stream) for (const x of this._stream.getTracks()) x.stop();
    this._src = this._stream = this._track = null;
  }

  _watch() {
    const md = this._e.mediaDevices, ctx = this._ctx;
    if (typeof md.addEventListener === 'function') md.addEventListener('devicechange', this._onDevice = () => { if (!this._closed) this._reopen(); });
    if (typeof ctx.addEventListener === 'function') {
      ctx.addEventListener('statechange', this._onState = () => {
        if (this._closed) return;
        if (ctx.state === 'running') this._resume(); else if (ctx.state === 'suspended' || ctx.state === 'interrupted') this._pause();
      });
    }
  }

  _notify(ev) { for (const f of this._listeners) { try { f(ev); } catch (_) { /* a listener's own problem */ } } }

  _pause() {
    if (this._paused || this._closed) return;
    this._paused = true;
    this._notify({ type: 'interrupted', cause: 'interruption' });
  }

  _resume() {
    if (!this._paused || this._closed) return;
    this._paused = false;
    this._notify({ type: 'resumed' });
  }

  // a device change (headphones in or out, another input): the input is opened again on the same AudioContext
  async _reopen() {
    if (this._reopening || this._closed) return;
    this._reopening = true;
    try {
      this._detach();
      const stream = await Microphone._capture(this._e);
      if (this._closed) { for (const t of stream.getTracks()) t.stop(); return; }
      this._attach(stream);
      this._notify({ type: 'interrupted', cause: 'routeChange' });
    } catch (err) {
      this._notify({ type: 'lost', error: new TajweedError('interrupted', { detail: 'the input device went away and no other could be opened' }, { cause: err }) });
      this.close();
    } finally {
      this._reopening = false;
    }
  }

  _block(samples) {
    this._notify({ type: 'samples', samples });
    if (!this._iterating) return;
    const w = this._waiting.shift();
    if (w) { w({ value: samples, done: false }); return; }
    // a reader that stopped reading keeps the newest MIC_QUEUE_BLOCKS blocks (about 30 s); older ones are dropped
    this._queue.push(samples);
    if (this._queue.length > MIC_QUEUE_BLOCKS) this._queue.shift();
  }

  /** SDK internals: every block and every change ({type: 'samples' | 'interrupted' | 'resumed' | 'lost'}). */
  _on(listener) { this._listeners.add(listener); return () => this._listeners.delete(listener); }

  /** Mono float samples at `sampleRate`, block by block (about 20 ms each), until close(). */
  samples() {
    this._iterating = true;
    const self = this;
    return {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (self._queue.length) return Promise.resolve({ value: self._queue.shift(), done: false });
        if (self._closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => self._waiting.push(r));
      },
      return() { self._iterating = false; self._queue.length = 0; return Promise.resolve({ value: undefined, done: true }); },
    };
  }

  /** Stop capturing and release the input device. */
  close() {
    if (this._closed) return;
    this._closed = true;
    this._detach();
    const md = this._e.mediaDevices, ctx = this._ctx;
    if (this._onDevice && typeof md.removeEventListener === 'function') md.removeEventListener('devicechange', this._onDevice);
    if (this._onState && typeof ctx.removeEventListener === 'function') ctx.removeEventListener('statechange', this._onState);
    if (this._node) { try { this._node.port.onmessage = null; this._node.disconnect(); } catch (_) { /* gone */ } }
    if (typeof ctx.close === 'function') Promise.resolve(ctx.close()).catch(() => {});
    for (const w of this._waiting.splice(0)) w({ value: undefined, done: true });
  }
}
