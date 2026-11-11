// The heads of the V4 network (README_heads.txt, the engine's ZfTajweedHeads): names, layout, and
// helpers to check and join them. Plain JS, no dependencies.

/**
 * Every output of the network after its states (README_heads.txt, the engine's ZfTajweedHeads), in
 * the engine's order. `key` is the property on a heads object, `name` the graph output and the
 * contract's name, `width` the values per frame (1 for the logits), `rate` the frame rate in ms.
 */
export const HEAD_SPECS = Object.freeze([
  { name: 'log_probs', key: 'logProbs', width: 38, rate: 40, kind: 'log_softmax', what: 'final CTC head' },
  { name: 'inter1_log_probs', key: 'inter1LogProbs', width: 38, rate: 40, kind: 'log_softmax', what: 'stack-1 InterCTC (consonants)' },
  { name: 'inter4_log_probs', key: 'inter4LogProbs', width: 38, rate: 40, kind: 'log_softmax', what: 'stack-4 InterCTC (diagnostic)' },
  { name: 'id_log_probs', key: 'idLogProbs', width: 38, rate: 20, kind: 'log_softmax', what: 'identity CTC' },
  { name: 'timing_log_probs', key: 'timingLogProbs', width: 38, rate: 20, kind: 'log_softmax', what: 'H-time chain (durations); 0 = pause' },
  { name: 'gem', key: 'gem', width: 2, rate: 20, kind: 'softmax', classes: ['single', 'held'] },
  { name: 'attr_tafkheem', key: 'attrTafkheem', width: 3, rate: 20, kind: 'softmax', classes: ['thin', 'heavy', 'low_heavy'] },
  { name: 'attr_ghunna', key: 'attrGhunna', width: 5, rate: 20, kind: 'softmax', classes: ['none', 'plain', 'geminate', 'ikhfa', 'idgham'] },
  { name: 'attr_qalqalah', key: 'attrQalqalah', width: 3, rate: 20, kind: 'softmax', classes: ['none', 'sughra', 'kubra'] },
  { name: 'attr_face', key: 'attrFace', width: 4, rate: 20, kind: 'softmax', classes: ['none', 'imala', 'tasheel', 'sakt'] },
  { name: 'boundary', key: 'boundary', width: 1, rate: 20, kind: 'logit', what: 'a unit starts here' },
  { name: 'conf', key: 'conf', width: 1, rate: 20, kind: 'logit', what: 'the frame label is truthful' },
]);

export const VOCAB = 38;
export const BLANK = 0;

/** Audio per engine chunk in ms for a context name ("c16_l64" -> 320: 16 encoder frames of 20 ms). */
export function contextChunkMs(context) {
  const m = /^c(\d+)_l(\d+)$/.exec(String(context));
  return m ? Number(m[1]) * 20 : 0;
}

/**
 * Check a heads object's layout: n20 = 2 x n40, every present array [frames x width], log_probs
 * present. Throws TypeError naming the head at fault. Returns the heads.
 */
export function checkHeads(h) {
  if (!h || !Number.isInteger(h.n40) || h.n40 < 0) throw new TypeError('heads: n40 must be a frame count');
  const n20 = h.n20 === undefined ? 2 * h.n40 : h.n20;
  if (n20 !== 2 * h.n40) throw new TypeError(`heads: n20 (${n20}) must be 2 x n40 (${h.n40})`);
  for (const s of HEAD_SPECS) {
    const a = h[s.key];
    if (a === null || a === undefined) {
      if (s.name === 'log_probs') throw new TypeError('heads: log_probs is required');
      continue;
    }
    if (!(a instanceof Float32Array)) throw new TypeError(`heads: ${s.name} must be a Float32Array`);
    const want = (s.rate === 40 ? h.n40 : n20) * s.width;
    if (a.length !== want) throw new TypeError(`heads: ${s.name} has ${a.length} values, expected ${want}`);
  }
  return h;
}

/** Join a take's per-chunk heads (in order) into one heads object. A head is null unless every chunk
 * has it. */
export function joinHeads(chunks) {
  const n40 = chunks.reduce((n, c) => n + c.n40, 0);
  const out = { n40, n20: 2 * n40, vocab: VOCAB };
  for (const s of HEAD_SPECS) {
    if (!chunks.length || chunks.some((c) => !c[s.key])) { out[s.key] = null; continue; }
    const a = new Float32Array(chunks.reduce((n, c) => n + c[s.key].length, 0));
    let at = 0;
    for (const c of chunks) { a.set(c[s.key], at); at += c[s.key].length; }
    out[s.key] = a;
  }
  return out;
}
