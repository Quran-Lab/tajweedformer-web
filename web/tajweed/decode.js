// The decoded layer: what the model heard, from log_probs and
// conf alone, no known text needed. Plain JS, no dependencies; the same numbers as the native SDK's
// tf_decode and the reference layers_ref.py (test/tajweed_layers.test.mjs).

import { VOCAB, BLANK, HEAD_SPECS } from './heads.js';

const HEAD_SPECS_BY_NAME = Object.fromEntries(HEAD_SPECS.map((h) => [h.name, h]));

/** The word boundary token "|" of tokens.txt. */
export const WORD_BOUNDARY = 1;
/** Milliseconds per CTC frame (log_probs, inter1, inter4). */
export const CTC_FRAME_MS = 40;
/** Milliseconds per head frame (the 20 ms heads). */
export const HEAD_FRAME_MS = 20;

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Top-1 and runner-up of every 40 ms frame of `logProbs` ([n40 x 38], row major). Ties go to the
 * lowest id. `from`/`to` bound the frames (default: all).
 * @returns {{top1: number, top1LogProb: number, runnerUp: number, runnerUpLogProb: number, margin: number}[]}
 */
export function decodeFrames(logProbs, n40, from = 0, to = n40) {
  const out = new Array(Math.max(0, to - from));
  for (let t = from; t < to; t++) {
    const o = t * VOCAB;
    let a = 0;
    for (let i = 1; i < VOCAB; i++) if (logProbs[o + i] > logProbs[o + a]) a = i;
    let b = a === 0 ? 1 : 0;
    for (let i = 0; i < VOCAB; i++) if (i !== a && logProbs[o + i] > logProbs[o + b]) b = i;
    const la = logProbs[o + a], lb = logProbs[o + b];
    out[t - from] = { top1: a, top1LogProb: la, runnerUp: b, runnerUpLogProb: lb, margin: la - lb };
  }
  return out;
}

/**
 * The decoded layer of a heads object (a take, or any frames with log_probs; conf optional).
 * @param {object} heads  { n40, logProbs: Float32Array, conf?: Float32Array|null }
 * @param {{ tokens?: string[], frames?: object[] }} [opts]  tokens: tokens.txt names (for `unit`);
 *        frames: decodeFrames output to reuse
 * @returns {DecodedTake} see index.d.ts
 */
export function decode(heads, opts = {}) {
  const names = opts.tokens || null;
  const n40 = heads.n40;
  if (!heads.logProbs) throw new TypeError('decode: heads.logProbs is required');
  const frames = opts.frames || decodeFrames(heads.logProbs, n40);
  // P2.16: with k (2 to 38), every frame also lists its k best tokens, ranked
  if (opts.k !== undefined && opts.k !== null) {
    const r = topKOf(heads.logProbs, n40, VOCAB, opts.k);
    for (let t = 0; t < n40; t++) {
      const ranked = [];
      for (let j = 0; j < r.k; j++) {
        const id = r.ids[t * r.k + j];
        ranked.push({ id, unit: names && id < names.length ? names[id] : String(id), logProb: r.values[t * r.k + j], margin: r.margins[t * r.k + j] });
      }
      frames[t] = { ...frames[t], ranked };
    }
  }
  const conf = heads.conf || null;
  const unit = (id) => (names && id < names.length ? names[id] : String(id));
  const tokens = [];
  for (let t = 0; t < n40;) {
    const a = frames[t].top1;
    if (a === BLANK) { t++; continue; }
    let e = t;
    while (e + 1 < n40 && frames[e + 1].top1 === a) e++;
    let pk = t;
    for (let k = t + 1; k <= e; k++) if (frames[k].top1LogProb > frames[pk].top1LogProb) pk = k;
    let confidence = null;
    if (conf) {
      let s = 0;
      for (let k = 2 * t; k < 2 * e + 2; k++) s += sigmoid(conf[k]);
      confidence = s / (2 * (e - t + 1));
    }
    const f = frames[pk];
    tokens.push({
      id: a, unit: unit(a), frame0: t, frame1: e, startMs: CTC_FRAME_MS * t, endMs: CTC_FRAME_MS * (e + 1), peakFrame: pk,
      logProb: f.top1LogProb, runnerUp: f.runnerUp, runnerUpUnit: unit(f.runnerUp), runnerUpLogProb: f.runnerUpLogProb,
      margin: f.margin, confidence,
    });
    t = e + 1;
  }
  const words = [];
  let cur = [];
  const close = () => {
    if (!cur.length) return;
    const ts = cur.map((i) => tokens[i]);
    words.push({
      index: words.length, tokens: cur, units: ts.map((x) => x.unit), startMs: ts[0].startMs, endMs: ts[ts.length - 1].endMs,
      confidence: ts.some((x) => x.confidence === null) ? null : Math.min(...ts.map((x) => x.confidence)),
      margin: Math.min(...ts.map((x) => x.margin)),
    });
  };
  tokens.forEach((tk, i) => {
    if (tk.id === WORD_BOUNDARY) { close(); cur = []; } else cur.push(i);
  });
  close();
  return { frames, tokens, words, transcript: tokens.map((x) => x.unit).join(' '), ids: tokens.map((x) => x.id) };
}

/** sigmoid of a 20 ms logit head (boundary, conf) as a new Float32Array. */
export function sigmoidHead(a) {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = sigmoid(a[i]);
  return o;
}

/**
 * Per-word results of a scored take (API_LAYERS.md section 3). The score, threshold and flag are the
 * engine's (zf_tajweed_result_words, API 3: every single edit inside the word, clipped fused LLR, flagged
 * at or above the word tau; the reference's tajweed_ref.word_scores); this adds each word's timing (its sites'
 * 40 ms frames on the best path) and its flagged items. A word the engine did not score (the word check
 * off, or no word block in calibration) has score, threshold and flagged null.
 * @param {{ sites: object[], madd?: object[], qalqalah?: object[], gemination?: object[], engineWords?: object[] }} r
 * @param {number} nWords
 */
export function wordResults({ sites, madd = [], qalqalah = [], gemination = [], engineWords = [] }, nWords) {
  const byWord = new Map(engineWords.map((w) => [w.word, w]));
  const words = [];
  for (let w = 0; w < nWords; w++) {
    const e = byWord.get(w);
    words.push({
      word: w, score: e ? e.score : null, threshold: e ? e.threshold : null, flagged: e ? e.flagged : null,
      best: e && e.hasScore ? { class: e.class, edit: e.edit, pos: e.editPos, expected: e.expected, expectedUnit: e.expectedUnit,
        alternative: e.alternative, alternativeUnit: e.alternativeUnit, llr: e.llr } : null,
      tokens: e ? [e.tokLo, e.tokHi] : null,
      startMs: null, endMs: null, issues: { sites: [], madd: [], qalqalah: [], gemination: [] },
    });
  }
  const at = (w) => (Number.isInteger(w) && w >= 0 && w < words.length ? words[w] : null);
  const lo = new Array(nWords).fill(Infinity), hi = new Array(nWords).fill(-Infinity);
  sites.forEach((s, i) => {
    const W = at(s.word);
    if (!W) return;
    if (s.flagged) W.issues.sites.push(i);
    if (s.frameLo >= 0) lo[s.word] = Math.min(lo[s.word], s.frameLo);
    if (s.frameHi >= 0) hi[s.word] = Math.max(hi[s.word], s.frameHi);
  });
  madd.forEach((x, i) => { const W = at(x.word); if (W && x.flagged) W.issues.madd.push(i); });
  qalqalah.forEach((x, i) => { const W = at(x.word); if (W && x.flagged) W.issues.qalqalah.push(i); });
  gemination.forEach((x, i) => { const W = at(x.word); if (W && x.flagged) W.issues.gemination.push(i); });
  for (const W of words) {
    if (lo[W.word] !== Infinity && hi[W.word] !== -Infinity) {
      W.startMs = CTC_FRAME_MS * lo[W.word];
      W.endMs = CTC_FRAME_MS * (hi[W.word] + 1);
    }
  }
  return words;
}

// ---------------------------------------------------------------------------------------------------
// Top-K: per frame the k best entries of any head with a distribution, ranked: the token
// heads (38 tokens, k 1 to 38, 38 = the whole ranked list) and the class heads (gem, attr_*, k up to their
// class count). Highest value first, equal values by the lower id (a stable argsort of the negated row,
// the engine's zf_tajweed_topk rule); margin[j] = value[j] - the value ranked j + 1 (a double from the
// float32 values; 0 for the last rank of the row). boundary and conf are single logits: no ranking.

const RANKABLE = Object.freeze({ log_probs: 38, inter1_log_probs: 38, inter4_log_probs: 38, id_log_probs: 38, timing_log_probs: 38,
  gem: 2, attr_tafkheem: 3, attr_ghunna: 5, attr_qalqalah: 3, attr_face: 4 });
const KEY = { log_probs: 'logProbs', inter1_log_probs: 'inter1LogProbs', inter4_log_probs: 'inter4LogProbs', id_log_probs: 'idLogProbs',
  timing_log_probs: 'timingLogProbs', gem: 'gem', attr_tafkheem: 'attrTafkheem', attr_ghunna: 'attrGhunna', attr_qalqalah: 'attrQalqalah',
  attr_face: 'attrFace' };

/** The heads top-K can rank, with their entry counts. */
export const RANKED_HEADS = RANKABLE;

/**
 * Rank [frames x cols] values: { frames, cols, k, ids: Int32Array, values: Float32Array, margins: Float64Array },
 * each [frames x k] row major.
 */
export function topKOf(values, frames, cols, k) {
  if (!(Number.isInteger(k) && k >= 1 && k <= cols)) throw new RangeError(`k must be 1..${cols}`);
  const ids = new Int32Array(frames * k), vals = new Float32Array(frames * k), mars = new Float64Array(frames * k);
  const idx = new Array(cols);
  for (let t = 0; t < frames; t++) {
    const o = t * cols;
    for (let i = 0; i < cols; i++) idx[i] = i;
    // a partial selection: k + 1 passes (the (k+1)-th value is the last margin's partner)
    const need = Math.min(cols, k + 1);
    for (let j = 0; j < need; j++) {
      let b = j;
      for (let i = j + 1; i < cols; i++) {
        const vi = values[o + idx[i]], vb = values[o + idx[b]];
        if (vi > vb || (vi === vb && idx[i] < idx[b])) b = i;
      }
      const tmp = idx[j]; idx[j] = idx[b]; idx[b] = tmp;
    }
    for (let j = 0; j < k; j++) {
      ids[t * k + j] = idx[j];
      vals[t * k + j] = values[o + idx[j]];
      mars[t * k + j] = j + 1 < cols ? values[o + idx[j]] - values[o + idx[j + 1]] : 0;
    }
  }
  return { frames, cols, k, ids, values: vals, margins: mars };
}

/**
 * Top-K of one head of a heads object. `names`: tokens.txt names for a token head (default: the ids as
 * strings); class heads get their class names from HEAD_SPECS. Returns topKOf's result with `head`,
 * `names` (one name per id) and `rate` (40 or 20 ms), or null when the head is not in `heads`.
 */
export function topK(heads, head = 'log_probs', k = 2, names = null) {
  const cols = RANKABLE[head];
  if (!cols) throw new RangeError(`${head} has no ranking (the rankable heads: ${Object.keys(RANKABLE).join(', ')})`);
  const a = heads[KEY[head]];
  if (!a) return null;
  const frames = a.length / cols;
  const r = topKOf(a, frames, cols, k);
  const spec = HEAD_SPECS_BY_NAME[head];
  return { head, rate: spec ? spec.rate : (cols === 38 ? 40 : 20), names: cols === 38 ? (names || null) : (spec && spec.classes) || null, ...r };
}
