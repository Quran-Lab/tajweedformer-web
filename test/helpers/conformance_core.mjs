// The comparison of the conformance proof, the same code in Node (test/conformance.test.mjs) and in a browser
// (test/browser/proof.html): one clip through a public Session in 20 ms pushes, every chunk's 12 outputs
// fingerprinted with FNV-1a 64 over their float bytes and compared with the engine's expected row, the take's
// Heads compared with the chunks joined, the decoded layer with the greedy tokens. No Node imports.

/** The order of the expected file's out_fnv. */
export const OUTPUTS = ['attr_face', 'attr_ghunna', 'attr_qalqalah', 'attr_tafkheem', 'boundary', 'conf', 'gem',
  'id_log_probs', 'inter1_log_probs', 'inter4_log_probs', 'log_probs', 'timing_log_probs'];

// The engine's start value is the decimal 1469598103934665603 (0x14650fb0739d0383, its FNV0), not the
// usual FNV-1a offset basis 14695981039346656037; the fingerprints follow the engine.
export const H0 = [0x14650fb0, 0x739d0383];
/** FNV-1a 64 as two 32-bit halves; prime 0x100000001b3 = 2^40 + 0x1b3. Continues from h. */
export function fnv1a64(bytes, h = H0) {
  let hi = h[0], lo = h[1];
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]) >>> 0;
    const t = lo * 0x1b3;                      // < 2^41: exact
    const carry = Math.floor(t / 4294967296);
    hi = (Math.imul(hi, 0x1b3) + ((lo << 8) >>> 0) + carry) >>> 0;
    lo = t >>> 0;
  }
  return [hi, lo];
}
export const hex = ([hi, lo]) => hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
export const bytesOf = (f) => new Uint8Array(f.buffer, f.byteOffset, f.byteLength);

/** One take through the public Session: the chunks (as onChunk hands them over) and the take's Heads. */
export async function take(model, pcm, options) {
  const chunks = [];
  const s = model.session({ ...options, onChunk: (c) => chunks.push(c) });
  for (let at = 0; at < pcm.length; at += 320) s.push(pcm.subarray(at, Math.min(pcm.length, at + 320)));
  const heads = await s.finish();
  return { chunks, heads };
}

// whether `whole` is the parts one after another, byte for byte
function joinedEqual(whole, parts) {
  let at = 0;
  for (const p of parts) {
    if (at + p.length > whole.length) return false;
    for (let i = 0; i < p.length; i++) if (whole[at + i] !== p[i]) return false;
    at += p.length;
  }
  return at === whole.length;
}

/**
 * One clip against its expected row `e` ({ clip, chunks, tokens, logp_fnv, out_fnv }) in context C
 * ({ context, chunkMs }). Returns { why (null when everything is equal), chunks, values (floats compared, the
 * 12 outputs of every chunk), decoded (the decoded layer was checked) }.
 */
export async function checkClip(model, pcm, e, C, headNames) {
  const { chunks, heads } = await take(model, pcm, { context: C.context, heads: 'all' });
  const outFnv = Object.fromEntries(OUTPUTS.map((k) => [k, []]));
  let logp = H0, values = 0;
  for (const c of chunks) {
    for (const k of OUTPUTS) {
      const h = c.heads.get(k);
      if (h) values += h.values.length;
      outFnv[k].push(h ? hex(fnv1a64(bytesOf(h.values))) : '0000000000000000');
    }
    logp = fnv1a64(bytesOf(c.heads.get('log_probs').values), logp);
  }
  const tokens = heads.greedy('log_probs').map((x) => x.id);
  let why = null, decoded = false;
  if (chunks.length !== e.chunks) why = `chunks ${chunks.length} != ${e.chunks}`;
  else if (JSON.stringify(tokens) !== JSON.stringify(e.tokens)) why = 'tokens';
  else if (hex(logp) !== e.logp_fnv) why = 'log_probs';
  else {
    for (const k of OUTPUTS) {
      const first = e.out_fnv[k].findIndex((x, i) => outFnv[k][i] !== x);
      if (first >= 0) { why = `${k} from chunk ${first}`; break; }
    }
  }
  // the take's Heads from finish() are the chunks' joined, bit for bit, for every head
  if (!why) {
    for (const name of headNames) {
      const a = heads.get(name);
      if (!a || !joinedEqual(bytesOf(a.values), chunks.map((c) => bytesOf(c.heads.get(name).values)))) { why = `finish() ${name}`; break; }
    }
  }
  // the decoded layer: its tokens are the engine's greedy transcript; the chunks line up; the last is final
  if (!why) {
    const d = heads.decoded(), last = chunks.at(-1).decoded;
    if (JSON.stringify(d.tokens.map((x) => x.id)) !== JSON.stringify(tokens)) why = 'decoded ids != greedy';
    else if (chunks.some((c, i) => c.index !== i || c.startMs !== i * C.chunkMs || c.endMs !== (i + 1) * C.chunkMs || c.firstFrame !== (i * C.chunkMs) / 40)) why = 'chunk index or times';
    else if (!last.isFinal || last.settled !== d.tokens.length || last.text !== d.text) why = 'the last chunk\'s decoded layer';
    else if (chunks.slice(0, -1).some((c, i) => c.decoded.isFinal || c.decoded.settled > chunks[i + 1].decoded.settled)) why = 'settled went down, or a chunk before the last is final';
    else decoded = true;
  }
  return { why, chunks: chunks.length, values, decoded };
}

/** The contexts the expected rows cover, with the file of each and where its bits come from. */
export const CONTEXTS = [
  { context: 'c16_l64', chunkMs: 320, expected: 'v4_c16_l64_audio_expected.jsonl', ref: 'ONNX Runtime armv7' },
  { context: 'c8_l64', chunkMs: 160, expected: 'v4_c8_l64_audio_expected.jsonl', ref: 'ONNX Runtime armv7' },
  { context: 'c24_l72', chunkMs: 480, expected: 'v4_c24_l72_audio_native_x86.jsonl', ref: 'the native x86 engine' },
  { context: 'c24_l256', chunkMs: 480, expected: 'v4_c24_l256_audio_native_x86.jsonl', ref: 'the native x86 engine' },
];
