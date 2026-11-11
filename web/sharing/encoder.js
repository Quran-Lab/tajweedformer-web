// Opus from libopus 1.6.1 compiled to WebAssembly (dist/tajweedformer-opus, scripts/build_opus.sh),
// set up as the Swift SDK's LibOpusEncoder (Sharing/OpusEncoder.swift): the same settings, frame
// size, pre-skip and flush. The module is loaded only when sharing is on (loadOpus), so it never
// touches the first paint.

import { OPUS_SETTINGS } from './oggopus.js';

const RATES = [8000, 12000, 16000, 24000, 48000];
// libopus request codes (opus_defines.h)
export const OPUS_REQUEST = Object.freeze({
  GET_APPLICATION: 4001, GET_BITRATE: 4003, GET_VBR: 4007, GET_BANDWIDTH: 4009, GET_COMPLEXITY: 4011,
  GET_INBAND_FEC: 4013, GET_DTX: 4017, GET_VBR_CONSTRAINT: 4021, GET_SIGNAL: 4025, GET_LOOKAHEAD: 4027,
  GET_SAMPLE_RATE: 4029, GET_LSB_DEPTH: 4037,
  SET_BITRATE: 4002,
});

import { wasmArgs } from '../platform/node-hook.js';

let modulePromise = null;
/**
 * The libopus module, instantiated once per page or process. `factory` replaces the bundled module
 * (tests, or an app that hosts the file elsewhere).
 */
export function loadOpus(factory) {
  if (factory) return factory();
  if (!modulePromise) {
    modulePromise = import('../../dist/tajweedformer-opus.mjs').then(async (m) => m.default(await wasmArgs('tajweedformer-opus.wasm')));
  }
  return modulePromise;
}

/** "libopus 1.6.1". */
export function opusVersion(m) { return m.UTF8ToString(m._ow_version()); }

/** An Opus encoder: float PCM in at `sampleRate`, packets out. Non-finite samples are coded as
 * silence. One instance per session; free() when done. */
export class OpusEncoder {
  constructor(m, { sampleRate = 48000, channels = 1, settings = OPUS_SETTINGS } = {}) {
    if (!RATES.includes(sampleRate)) throw new RangeError(`Opus encodes 8, 12, 16, 24 or 48 kHz, not ${sampleRate} Hz`);
    if (channels !== 1 && channels !== 2) throw new RangeError(`Opus: 1 or 2 channels, not ${channels}`);
    const size = sampleRate * settings.frameMs / 1000;
    if (![2.5, 5, 10, 20, 40, 60].includes(settings.frameMs) || size !== Math.round(size)) {
      throw new RangeError(`Opus frames are 2.5, 5, 10, 20, 40 or 60 ms, not ${settings.frameMs}`);
    }
    this.m = m;
    const errp = m._malloc(4);
    const enc = m._ow_enc_create(sampleRate, channels, settings.application, settings.bitrate, settings.complexity,
      settings.vbr ? 1 : 0, settings.constrainedVbr ? 1 : 0, settings.bandwidth, settings.signal, 24, errp);
    const err = m.HEAP32[errp >> 2];
    m._free(errp);
    if (!enc) throw new Error(`the Opus encoder is not available (${err})`);
    const look = m._ow_enc_get(enc, OPUS_REQUEST.GET_LOOKAHEAD);
    this.enc = enc;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.settings = settings;
    this.frameSize = size;
    this.perFrame = size * channels;
    // OpusHead pre-skip is in 48 kHz samples whatever the input rate (312 at 48 kHz)
    this.preSkip = Math.trunc(look * 48000 / sampleRate);
    this.framePtr = m._malloc(this.perFrame * 4);
    this.outPtr = m._malloc(4000);
    this.filled = 0;
    this.samplesIn = 0;
    this.nonFiniteSamples = 0;
    this.finished = false;
    this.bitrate = settings.bitrate;
    // packets coded so far; beforeFrame(index), when set, runs before each packet is coded (the Ogg writer
    // opens a segment there and sets its bitrate, so a change lands exactly on the segment's first packet)
    this.packetCount = 0;
    this.beforeFrame = null;
  }

  /** The bit rate of the packets coded from now on (OPUS_SET_BITRATE; any packet may change it, the
   * stream needs no new header). */
  setBitrate(bps) {
    if (!(Number.isInteger(bps) && bps >= 6000 && bps <= 510000)) throw new RangeError(`Opus bitrate 6000 to 510000 bit/s, not ${bps}`);
    if (bps === this.bitrate) return;
    const e = this.m._ow_enc_set(this.enc, OPUS_REQUEST.SET_BITRATE, bps);
    if (e !== 0) throw new Error(`the Opus encoder refused bitrate ${bps} (${e})`);
    this.bitrate = bps;
  }

  /** The granule position of the last page: pre-skip plus the input in 48 kHz samples. */
  get finalGranulePosition() { return this.preSkip + Math.trunc(this.samplesIn * 48000 / this.sampleRate); }

  /** A GET request read back from libopus (OPUS_REQUEST.GET_*), for the tests. */
  get(request) { const v = this.m._ow_enc_get(this.enc, request); return v === -2147483648 ? null : v; }

  /** Encodes samples; returns the packets completed so far (possibly none), or hands each to `onPacket`
   * as soon as it is coded (then the result is empty). */
  encode(pcm, onPacket = null) {
    if (this.finished) throw new Error('the Opus encoder was flushed');
    const out = [];
    const emit = onPacket || ((p) => out.push(p));
    let i = 0;
    while (i < pcm.length) {
      const n = Math.min(this.perFrame - this.filled, pcm.length - i);
      const f = this.m.HEAPF32.subarray((this.framePtr >> 2) + this.filled, (this.framePtr >> 2) + this.filled + n);
      let bad = 0;
      for (let k = 0; k < n; k++) {
        const v = pcm[i + k];
        if (Number.isFinite(v)) f[k] = v; else { f[k] = 0; bad++; }
      }
      this.nonFiniteSamples += bad;
      this.filled += n;
      i += n;
      if (this.filled === this.perFrame) emit(this._frame());
    }
    this.samplesIn += Math.trunc(pcm.length / this.channels);
    return out;
  }

  /** Encodes what is buffered and the lookahead, padded with silence to whole packets. The encoder
   * cannot be used afterwards. */
  flush(onPacket = null) {
    if (this.finished) throw new Error('the Opus encoder was flushed');
    this.finished = true;
    const out = [];
    const emit = onPacket || ((p) => out.push(p));
    let owed = Math.trunc(this.filled / this.channels) + Math.trunc(this.preSkip * this.sampleRate / 48000);
    while (owed > 0) {
      this.m.HEAPF32.fill(0, (this.framePtr >> 2) + this.filled, (this.framePtr >> 2) + this.perFrame);
      this.filled = this.perFrame;
      emit(this._frame());
      owed -= this.frameSize;
    }
    return out;
  }

  _frame() {
    if (this.beforeFrame) this.beforeFrame(this.packetCount);
    this.packetCount += 1;
    const n = this.m._ow_enc_encode(this.enc, this.framePtr, this.frameSize, this.outPtr, 4000);
    this.filled = 0;
    if (n <= 0) throw new Error(`the Opus encoder failed (${n})`);
    return this.m.HEAPU8.slice(this.outPtr, this.outPtr + n);
  }

  free() {
    if (!this.enc) return;
    this.m._ow_enc_destroy(this.enc);
    this.m._free(this.framePtr);
    this.m._free(this.outPtr);
    this.enc = 0;
  }
}

/** RFC 7845 decode of an Ogg Opus stream with the same libopus (tests): pre-skip dropped, the end
 * trimmed to the last granule position. `pages` from oggopus.readPages. */
export function decodeOggOpus(m, pages) {
  const head = pages[0].packets[0];
  const preSkip = head[10] | (head[11] << 8);
  const d = m._ow_dec_create(48000, 1);
  const inp = m._malloc(8192), pcm = m._malloc(5760 * 4);
  const parts = [];
  let total = 0;
  try {
    for (const page of pages.slice(2)) {
      for (const p of page.packets) {
        m.HEAPU8.set(p, inp);
        const n = m._ow_dec_decode(d, inp, p.length, pcm, 5760);
        if (n <= 0) throw new Error(`decode failed (${n})`);
        parts.push(m.HEAPF32.slice(pcm >> 2, (pcm >> 2) + n));
        total += n;
      }
    }
  } finally {
    m._ow_dec_destroy(d);
    m._free(inp);
    m._free(pcm);
  }
  const all = new Float32Array(total);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const end = pages[pages.length - 1].granule;
  return all.slice(preSkip, Math.min(end, all.length));
}
