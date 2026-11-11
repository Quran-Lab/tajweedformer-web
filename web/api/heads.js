// Heads and the decoded layer as the public API gives them (NAMING.md section 3): plain data made from the
// engine's arrays. TajweedHeads holds the selected heads of a span of audio (a chunk, or a whole take);
// the decoded layer is what the model heard, from log_probs and conf alone.
import { HEAD_SPECS, VOCAB, BLANK } from '../tajweed/heads.js';
import { decodeFrames, topKOf, WORD_BOUNDARY, CTC_FRAME_MS } from '../tajweed/decode.js';
import { invalid } from './errors.js';

const SPEC = new Map(HEAD_SPECS.map((s) => [s.name, s]));
/** The twelve head names, in the engine's order. */
export const HEAD_NAMES = Object.freeze(HEAD_SPECS.map((s) => s.name));
/** The heads a Session computes when the app names none. */
export const DEFAULT_HEADS = Object.freeze(['log_probs', 'inter1_log_probs', 'timing_log_probs', 'gem', 'attr_qalqalah', 'conf']);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** The head selection of a Session: a list of names or 'all' -> names in the engine's order (log_probs always). */
export function selectHeads(heads) {
  if (heads === undefined || heads === null) return [...DEFAULT_HEADS];
  if (heads === 'all') return [...HEAD_NAMES];
  if (!Array.isArray(heads)) throw invalid(`heads must be a list of head names or 'all'`);
  for (const n of heads) if (!SPEC.has(n)) throw invalid(`unknown head ${JSON.stringify(n)}; the heads are ${HEAD_NAMES.join(', ')}`);
  const want = new Set(['log_probs', ...heads]);
  return HEAD_NAMES.filter((n) => want.has(n));
}

function greedyOf(values, frames, frameMs) {
  const out = [];
  let prev = BLANK, cur = null, best = -Infinity;
  for (let t = 0; t < frames; t++) {
    const o = t * VOCAB;
    let a = 0;
    for (let i = 1; i < VOCAB; i++) if (values[o + i] > values[o + a]) a = i;
    if (a !== prev) {
      cur = null;
      if (a !== BLANK) { cur = { id: a, firstMs: t * frameMs, peakMs: t * frameMs, lastMs: t * frameMs }; best = values[o + a]; out.push(cur); }
    } else if (cur) {
      cur.lastMs = t * frameMs;
      if (values[o + a] > best) { best = values[o + a]; cur.peakMs = t * frameMs; }
    }
    prev = a;
  }
  return out;
}

/**
 * The decoded layer of `n40` frames of log_probs (and conf, when the take has it).
 * @param {object} o
 * @param {Float32Array} o.logProbs  [n40 x 38]
 * @param {Float32Array|null} [o.conf]  [2 x n40] logits
 * @param {number} o.n40
 * @param {string[]|null} [o.names]  the vocabulary's names by id
 * @param {object[]} [o.frames]  decodeFrames output for these frames, to reuse
 * @param {number} [o.topK]  rank this many tokens per frame (0: none)
 * @param {boolean} [o.isFinal]  the last decoded layer of the take
 */
export function decodedOf({ logProbs, conf = null, n40, names = null, frames = null, topK = 0, isFinal = false }) {
  const fr = frames || decodeFrames(logProbs, n40);
  const name = (id) => (names && id < names.length ? names[id] : String(id));
  const tokens = [];
  let open = false; // the last token's run reaches the last frame
  for (let t = 0; t < n40;) {
    const a = fr[t].top1;
    if (a === BLANK) { t++; continue; }
    let e = t;
    while (e + 1 < n40 && fr[e + 1].top1 === a) e++;
    let pk = t;
    for (let k = t + 1; k <= e; k++) if (fr[k].top1LogProb > fr[pk].top1LogProb) pk = k;
    let confidence = null;
    if (conf) {
      let s = 0;
      for (let k = 2 * t; k < 2 * e + 2; k++) s += sigmoid(conf[k]);
      confidence = s / (2 * (e - t + 1));
    }
    tokens.push({ id: a, name: name(a), firstMs: CTC_FRAME_MS * t, peakMs: CTC_FRAME_MS * pk, lastMs: CTC_FRAME_MS * e, confidence });
    open = e === n40 - 1;
    t = e + 1;
  }
  const words = [];
  let cur = [];
  const close = () => {
    if (!cur.length) return;
    words.push({ index: words.length, text: cur.map((x) => x.name).join(' '), tokens: cur, firstMs: cur[0].firstMs, lastMs: cur[cur.length - 1].lastMs,
      confidence: cur.some((x) => x.confidence === null) ? null : Math.min(...cur.map((x) => x.confidence)) });
    cur = [];
  };
  for (const tk of tokens) { if (tk.id === WORD_BOUNDARY) close(); else cur.push(tk); }
  close();
  let ranked = null;
  if (topK > 0) {
    if (!(Number.isInteger(topK) && topK <= VOCAB)) throw invalid(`topK must be 0 to ${VOCAB}`);
    ranked = topKOf(logProbs, n40, VOCAB, topK);
  }
  const outFrames = new Array(n40);
  for (let t = 0; t < n40; t++) {
    const f = fr[t];
    const row = { top1: f.top1, top1LogProb: f.top1LogProb, runnerUp: f.runnerUp, runnerUpLogProb: f.runnerUpLogProb, margin: f.margin };
    if (ranked) {
      row.topK = [];
      for (let j = 0; j < topK; j++) {
        const id = ranked.ids[t * topK + j];
        row.topK.push({ id, name: name(id), logProb: ranked.values[t * topK + j], margin: ranked.margins[t * topK + j] });
      }
    }
    outFrames[t] = row;
  }
  return {
    text: tokens.map((x) => x.name).join(' '),
    tokens, words, frames: outFrames,
    // a token whose run reaches the last frame can still grow with the next chunk; every token before it is settled
    settled: isFinal || !open ? tokens.length : tokens.length - 1,
    isFinal,
  };
}

/** Raw model output for a span of audio: every selected head, and greedy tokens. Plain data. */
export class TajweedHeads {
  /**
   * @param {Record<string, Float32Array>} arrays  the heads by name
   * @param {number} n40  40 ms frames in the span
   * @param {string[]|null} names  the vocabulary's names by id
   * @param {{topK?: number, isFinal?: boolean}} [o]
   */
  constructor(arrays, n40, names = null, o = {}) {
    this._a = arrays;
    this._n40 = n40;
    this._names = names;
    this._o = o;
  }

  /** Names of the heads it holds, in the engine's order. */
  get names() { return HEAD_NAMES.filter((n) => this._a[n]); }

  /** One raw head, or null when this take did not compute it. */
  get(name) {
    const s = SPEC.get(name);
    if (!s) throw invalid(`unknown head ${JSON.stringify(name)}; the heads are ${HEAD_NAMES.join(', ')}`);
    const values = this._a[name];
    if (!values) return null;
    const ctc = s.kind === 'log_softmax';
    return { name, kind: ctc ? 'ctc' : 'attribute', frameMs: s.rate, frames: s.rate === 40 ? this._n40 : 2 * this._n40, classes: s.width, values };
  }

  /** Greedy tokens of a CTC head (collapsed, blank removed) with the times of each token's first, best and last frame. */
  greedy(name = 'log_probs') {
    const h = this.get(name);
    if (!h) throw invalid(`this take did not compute ${name}`);
    if (h.kind !== 'ctc') throw invalid(`${name} is not a CTC head`);
    return greedyOf(h.values, h.frames, h.frameMs);
  }

  /** The decoded layer of exactly these heads. */
  decoded() {
    return decodedOf({ logProbs: this._a.log_probs, conf: this._a.conf || null, n40: this._n40, names: this._names,
      topK: this._o.topK || 0, isFinal: !!this._o.isFinal });
  }
}

/** Join the per-chunk arrays of a take into the take's arrays. */
export function joinArrays(chunks) {
  const out = {};
  for (const n of HEAD_NAMES) {
    if (!chunks.length || chunks.some((c) => !c[n])) continue;
    const a = new Float32Array(chunks.reduce((k, c) => k + c[n].length, 0));
    let at = 0;
    for (const c of chunks) { a.set(c[n], at); at += c[n].length; }
    out[n] = a;
  }
  return out;
}
