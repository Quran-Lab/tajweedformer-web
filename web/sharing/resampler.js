// Mono float PCM at any whole rate to 48 kHz for the sharing encoder: a streaming rational polyphase
// resampler with a Kaiser-windowed sinc (32 zero crossings a side, beta 9, about 90 dB stop band).
// It keeps the Swift ShareResampler's contract (AVAudioConverter, mastering quality, prime .normal):
// silence is assumed before the first sample, so the output is aligned with the input (no leading
// delay), and once flushed the whole output is ceil(input * 48000 / rate) samples. Only the shared
// copy goes through it; recognition resamples with the engine's own resampler. The bytes differ
// from Apple's converter (a different filter), so cross-SDK byte vectors use 48 kHz input.

const OUT_RATE = 48000;
const ZEROS = 32;
const BETA = 9;

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

function besselI0(x) {
  let s = 1, t = 1;
  for (let k = 1; k < 60; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; if (t < 1e-21 * s) break; }
  return s;
}

const filters = new Map();
// taps[p][j] for phase p (0..L-1) and input offset j - (H - 1) (j = 0..2H-1)
function design(L, M) {
  const key = `${L}/${M}`;
  if (filters.has(key)) return filters.get(key);
  // cutoff in input samples: the lower of the two Nyquists, a little inside it
  const fc = Math.min(1, L / M) * 0.97;
  const H = Math.ceil(ZEROS / fc);
  const i0b = besselI0(BETA);
  const taps = new Array(L);
  for (let p = 0; p < L; p++) {
    const frac = p / L; // output time inside the input sample interval
    const row = new Float64Array(2 * H);
    for (let j = 0; j < 2 * H; j++) {
      const t = (j - (H - 1)) - frac; // input sample time relative to the output time
      const x = t * fc;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const r = t / H;
      const w = Math.abs(r) >= 1 ? 0 : besselI0(BETA * Math.sqrt(1 - r * r)) / i0b;
      row[j] = fc * sinc * w;
    }
    taps[p] = row;
  }
  const f = { L, M, H, taps };
  filters.set(key, f);
  return f;
}

export class ShareResampler {
  constructor(inputRate) {
    if (!(inputRate >= 8000 && inputRate <= 384000 && Number.isInteger(inputRate))) throw new RangeError(`cannot resample ${inputRate} Hz to 48 kHz`);
    const g = gcd(OUT_RATE, inputRate);
    this.inputRate = inputRate;
    this.f = design(OUT_RATE / g, inputRate / g);
    const H = this.f.H;
    // history: H - 1 zeros before the first sample (silence assumed), then the input
    this.buf = new Float64Array(4096 + 2 * H);
    this.len = H - 1; // samples in buf
    this.base = -(H - 1); // input index of buf[0]
    this.k = 0; // next output index
    this.inCount = 0;
    this.ended = false;
    this.out = new Float32Array(4096);
  }

  _push(x) {
    if (this.len + x.length > this.buf.length) {
      const nb = new Float64Array(Math.max(this.buf.length * 2, this.len + x.length));
      nb.set(this.buf.subarray(0, this.len));
      this.buf = nb;
    }
    for (let i = 0; i < x.length; i++) this.buf[this.len + i] = x[i];
    this.len += x.length;
  }

  // every output whose window lies inside the buffer (or, with `limit`, up to that many in all)
  _run(sink, limit) {
    const { L, M, H, taps } = this.f;
    let n = 0;
    for (;;) {
      if (limit !== undefined && this.k >= limit) break;
      const num = this.k * M;
      const i = Math.floor(num / L);
      const p = num - i * L;
      const lo = i - (H - 1) - this.base; // buf index of the first tap
      if (lo + 2 * H > this.len) break;
      const row = taps[p];
      let s = 0;
      for (let j = 0; j < 2 * H; j++) s += this.buf[lo + j] * row[j];
      if (n === this.out.length) { sink(this.out); n = 0; }
      this.out[n++] = s;
      this.k++;
    }
    if (n) sink(this.out.subarray(0, n));
    // drop what no later output needs
    const need = Math.floor((this.k * M) / L) - (H - 1) - this.base;
    if (need > 4096) {
      this.buf.copyWithin(0, need, this.len);
      this.len -= need;
      this.base += need;
    }
  }

  /** Resamples `x` and hands the 48 kHz output to `sink` in one or more pieces (each valid only
   * during the call). */
  process(x, sink) {
    if (this.ended || !x.length) return;
    this.inCount += x.length;
    this._push(x);
    this._run(sink);
  }

  /** The tail: zeros after the last sample, until the output is the input's length at 48 kHz. */
  flush(sink) {
    if (this.ended) return;
    this.ended = true;
    const { L, M, H } = this.f;
    const total = Math.ceil((this.inCount * L) / M);
    this._push(new Float64Array(2 * H + 1));
    this._run(sink, total);
  }
}
