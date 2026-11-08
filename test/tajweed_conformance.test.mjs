// V4 conformance through this SDK's own stream API: the 35 parity clips (16 kHz float32 audio) pushed
// into TajweedFormer.createStream in 20 ms pieces, and every chunk's 12 outputs, as onChunk hands them
// over, fingerprinted with FNV-1a 64 over their float bytes (start 1469598103934665603 as the engine's
// FNV0, prime 1099511628211), plus logp_fnv (one FNV running over every chunk's log_probs), the chunk
// count and the greedy tokens (fields as the engine's bench/v4_conformance_check.py and
// bench/accel/zf_tajweed_check.c). Also: heads() for the whole take equals the chunks joined.
//
// References (test/tajweed/conformance/):
//   c16_l64   v4_c16_l64_audio_expected.jsonl: the engine's conformance file, ONNX Runtime armv7's bits
//   c24_l72, c24_l256   v4_<ctx>_audio_native_x86.jsonl: the native engine (tajweedformer-sdk b6436d7,
//             MinGW GCC 13 release build, zf_tajweed_check, audio in 20 ms pushes). The engine has no
//             audio reference from ONNX Runtime at chunk 24 (its c24 files are the feature path, which
//             gives other bits than audio); that native build reproduces the c16_l64 ORT file 35/35.
//
// Needs dist/tajweedformer.mjs built with the engine (ZF_WASM_TAJWEED=1 npm run build), the V4 engine files
// and the clips, none of which are in this repository (the model is gated):
//   TAJWEED_V4_ENGINE       folder with <context>/ engine files and expected_tj3.zfx (the staging)
//   TAJWEED_V4_CALIBRATION  calibration.json        TAJWEED_V4_TOKENS  tokens.txt
//   TAJWEED_V4_AUDIO        folder of <clip>.pcm (the engine's conformance-data audio)
// Skipped when any is missing (REQUIRE_V4=1 makes that an error).
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bindTajweed, sha256Hex, joinHeads, HEAD_SPECS, topK, RANKED_HEADS } from '../web/tajweed/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = (k, d) => process.env[k] || d;
const ENGINE = env('TAJWEED_V4_ENGINE', '');
const CAL = env('TAJWEED_V4_CALIBRATION', '');
const TOKENS = env('TAJWEED_V4_TOKENS', '');
const AUDIO = env('TAJWEED_V4_AUDIO', '');
const CONTEXTS = [
  { context: 'c16_l64', chunkMs: 320, expected: 'v4_c16_l64_audio_expected.jsonl', ref: 'ONNX Runtime armv7' },
  { context: 'c24_l72', chunkMs: 480, expected: 'v4_c24_l72_audio_native_x86.jsonl', ref: 'the native x86 engine' },
  { context: 'c24_l256', chunkMs: 480, expected: 'v4_c24_l256_audio_native_x86.jsonl', ref: 'the native x86 engine' },
];
const RSS_LIMIT = 16 * 2 ** 30; // the shared PC's guard: stop before 16 GB

// the order of the expected file's out_fnv (bench/v4_conformance_check.py V4_OUTPUTS)
const OUTPUTS = ['attr_face', 'attr_ghunna', 'attr_qalqalah', 'attr_tafkheem', 'boundary', 'conf', 'gem',
  'id_log_probs', 'inter1_log_probs', 'inter4_log_probs', 'log_probs', 'timing_log_probs'];
const KEY = Object.fromEntries(HEAD_SPECS.map((s) => [s.name, s.key]));

// The engine's start value is the decimal 1469598103934665603 (0x14650fb0739d0383, its FNV0), not the
// usual FNV-1a offset basis 14695981039346656037; the fingerprints follow the engine.
const H0 = [0x14650fb0, 0x739d0383];
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
const hex = ([hi, lo]) => hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
const bytesOf = (f) => new Uint8Array(f.buffer, f.byteOffset, f.byteLength);

test('fnv1a64: the reference constants', () => {
  assert.equal(hex(H0), BigInt('1469598103934665603').toString(16).padStart(16, '0'));
  // against a BigInt reference on random bytes
  const b = Uint8Array.from({ length: 4099 }, (_, i) => (i * 2654435761) >>> 24);
  let r = 1469598103934665603n;
  for (const x of b) r = ((r ^ BigInt(x)) * 1099511628211n) & 0xffffffffffffffffn;
  assert.equal(hex(fnv1a64(b)), r.toString(16).padStart(16, '0'));
  assert.equal(hex(fnv1a64(new Uint8Array(0))), '14650fb0739d0383');
});

const fullPath = path.join(root, 'dist', 'tajweedformer.mjs');
const missing = [];
if (!existsSync(fullPath)) missing.push('dist/tajweedformer.mjs');
for (const [name, p] of [['engine', path.join(ENGINE, 'c16_l64', 'layers.zfw')], ['calibration', CAL], ['tokens', TOKENS], ['audio', AUDIO]]) {
  if (!existsSync(p)) missing.push(`${name} ${p}`);
}
let factory = null;
if (!missing.length) {
  const { default: f } = await import(pathToFileURL(fullPath).href);
  const m = await f();
  if (typeof m._zft_model_open === 'function') factory = async () => m; else missing.push('the TajweedFormer engine in dist/tajweedformer.mjs');
}
if (missing.length && process.env.REQUIRE_V4 === '1') throw new Error(`V4 conformance needs: ${missing.join(', ')}`);
const skip = missing.length ? `needs ${missing.join(', ')}` : false;

// A V4 folder over the files on disk: an unsigned manifest listing the root files and the context's.
async function v4Reader(context) {
  const paths = { 'calibration.json': CAL, 'tokens.txt': TOKENS, 'expected_tj3.zfx': path.join(ENGINE, 'expected_tj3.zfx') };
  for (const f of readdirSync(path.join(ENGINE, context))) {
    if (f.endsWith('.jsonl')) continue;
    paths[`${context}/${f}`] = path.join(ENGINE, context, f);
  }
  const files = [];
  for (const [p, full] of Object.entries(paths)) files.push({ path: p, size: statSync(full).size, sha256: await sha256Hex(readFileSync(full)) });
  const cal = JSON.parse(readFileSync(CAL, 'utf8'));
  const manifest = { format: 2, model_id: cal.model_id, family: 'tajweedformer', revision: 'v4.0-local', min_sdk_version: '2.0.0',
    engine_format: 2, coreml_format: 9, tokens_sha256: await sha256Hex(readFileSync(TOKENS)), coreml: '-',
    sidecar: `${context}/layers.zfw`, keeps: '-', tokens: 'tokens.txt', files };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  return { async read(p) { if (p === 'manifest.json') return bytes; return paths[p] ? new Uint8Array(readFileSync(paths[p])) : null; } };
}

for (const C of CONTEXTS) test(`V4 ${C.context} conformance through createStream (audio, 20 ms pushes) against ${C.ref}: 35 clips, 12 outputs per chunk`, {
  skip: skip || (existsSync(path.join(ENGINE, C.context, 'layers.zfw')) ? false : `no ${C.context} engine files`), timeout: 1800000,
}, async (t) => {
  const TF = bindTajweed(factory);
  const tf = await TF.load({ reader: await v4Reader(C.context), context: C.context });
  assert.equal(tf.info.engine, 'exact-cpu');
  assert.equal(tf.info.chunkMs, C.chunkMs);
  const expected = readFileSync(path.join(root, 'test/tajweed/conformance', C.expected), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(expected.length, 35);

  let chunks = [];
  const s = tf.createStream({ allHeads: true, onChunk: (h) => chunks.push(h) });
  let decodedOk = 0, topkChecked = 0;
  const bad = [];
  let ok = 0;
  for (const e of expected) {
    const pcmBuf = readFileSync(path.join(AUDIO, `${e.clip}.pcm`));
    const pcm = new Float32Array(pcmBuf.buffer.slice(pcmBuf.byteOffset, pcmBuf.byteOffset + pcmBuf.byteLength));
    s.reset();
    chunks = [];
    for (let at = 0; at < pcm.length; at += 320) s.pushAudio(pcm.subarray(at, Math.min(pcm.length, at + 320)));
    s.finish();
    const outFnv = Object.fromEntries(OUTPUTS.map((k) => [k, []]));
    let logp = H0;
    for (const h of chunks) {
      for (const k of OUTPUTS) outFnv[k].push(h[KEY[k]] ? hex(fnv1a64(bytesOf(h[KEY[k]]))) : '0000000000000000');
      logp = fnv1a64(bytesOf(h.logProbs), logp);
    }
    const tokens = s.greedy();
    let why = null;
    if (chunks.length !== e.chunks) why = `chunks ${chunks.length} != ${e.chunks}`;
    else if (JSON.stringify(tokens) !== JSON.stringify(e.tokens)) why = 'tokens';
    else if (hex(logp) !== e.logp_fnv) why = 'log_probs';
    else {
      for (const k of OUTPUTS) {
        const first = e.out_fnv[k].findIndex((x, i) => outFnv[k][i] !== x);
        if (first >= 0) { why = `${k} from chunk ${first}`; break; }
      }
    }
    // the whole take as heads() hands it over is the chunks joined, bit for bit
    if (!why) {
      const take = s.heads(), joined = joinHeads(chunks);
      for (const spec of HEAD_SPECS) {
        const a = take[spec.key], b = joined[spec.key];
        if (!a || !b || Buffer.compare(Buffer.from(bytesOf(a)), Buffer.from(bytesOf(b))) !== 0) { why = `heads() ${spec.name}`; break; }
      }
    }
    // the decoded layer: its greedy ids are the engine's greedy transcript; per chunk frames line up
    if (!why) {
      const d = tf.decode(s.heads());
      // the engine's top-2 (zf_tajweed_stream_top2) equals the SDK's scan of log_probs, frame by frame
      const eng2 = s.top2(), js2 = d.frames;
      if (!eng2 || eng2.length !== js2.length || eng2.some((f, i) => f.top1 !== js2[i].top1 || f.runnerUp !== js2[i].runnerUp ||
        f.top1LogProb !== js2[i].top1LogProb || f.runnerUpLogProb !== js2[i].runnerUpLogProb || f.margin !== js2[i].margin)) why = 'engine top-2 != SDK top-2';
      else if (JSON.stringify(s.decoded().ids) !== JSON.stringify(tokens)) why = 'stream.decoded() ids';
      // P2.16: the engine's top-K of every kept rankable head equals the SDK's ranking of the same head
      if (!why && e === expected[0] || (!why && expected.indexOf(e) % 7 === 0)) {
        const take = s.heads();
        for (const [name, cols] of Object.entries(RANKED_HEADS)) {
          for (const k of [2, cols]) {
            const a = s.topK(name, k), b = topK(take, name, k);
            if (!a || !b || a.frames !== b.frames || a.ids.some((x, i) => x !== b.ids[i]) || a.values.some((x, i) => x !== b.values[i]) ||
              a.margins.some((x, i) => x !== b.margins[i])) { why = `engine top-K ${name} k ${k}`; break; }
          }
          if (why) break;
        }
        if (!why) topkChecked++;
      }
      if (!why && JSON.stringify(d.ids) !== JSON.stringify(tokens)) why = 'decoded ids != engine greedy';
      else if (chunks.some((h, i) => h.index !== i || h.frames.length !== h.n40 || h.startMs !== i * C.chunkMs)) why = 'chunk frames/index';
      else decodedOk++;
    }
    if (why) bad.push(`${e.clip} (${why})`); else ok++;
    const rss = process.memoryUsage().rss;
    if (rss > RSS_LIMIT) throw new Error(`RSS ${rss} bytes over the 16 GB guard`);
  }
  s.free();
  tf.free();
  t.diagnostic(`${C.context}: decoded layer ids == engine greedy on ${decodedOk}/${expected.length}; engine top-K == SDK top-K (every rankable head, k 2 and all) on ${topkChecked} clips`);
  t.diagnostic(`${C.context}: ${ok}/${expected.length} clips bit-identical to ${C.ref} (tokens, chunks, every value of all 12 outputs of every chunk)`);
  assert.deepEqual(bad, []);
});

test('lazy heads (API 3): the default stream computes the scorer heads and conf only; those are the bits of an allHeads run', {
  skip: skip || (existsSync(path.join(ENGINE, 'c16_l64', 'layers.zfw')) ? false : 'no c16_l64 engine files'), timeout: 600000,
}, async (t) => {
  const TF = bindTajweed(factory);
  const tf = await TF.load({ reader: await v4Reader('c16_l64'), context: 'c16_l64' });
  const expected = readFileSync(path.join(root, 'test/tajweed/conformance', CONTEXTS[0].expected), 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l)).slice(0, 5);
  const run = (opts, e) => {
    const pcmBuf = readFileSync(path.join(AUDIO, `${e.clip}.pcm`));
    const pcm = new Float32Array(pcmBuf.buffer.slice(pcmBuf.byteOffset, pcmBuf.byteOffset + pcmBuf.byteLength));
    const s = tf.createStream(opts);
    for (let at = 0; at < pcm.length; at += 320) s.pushAudio(pcm.subarray(at, at + 320));
    s.finish();
    const h = s.heads(), g = s.greedy();
    s.free();
    return { h, g };
  };
  const kept = ['logProbs', 'inter1LogProbs', 'timingLogProbs', 'gem', 'attrQalqalah', 'conf'];
  const skipped = ['inter4LogProbs', 'idLogProbs', 'attrTafkheem', 'attrGhunna', 'attrFace', 'boundary'];
  let ok = 0;
  const bad = [];
  for (const e of expected) {
    const a = run({}, e), b = run({ allHeads: true }, e), c = run({ heads: ['attr_ghunna'] }, e);
    const same = (x, y) => x && y && Buffer.compare(Buffer.from(bytesOf(x)), Buffer.from(bytesOf(y))) === 0;
    const why = [];
    if (JSON.stringify(a.g) !== JSON.stringify(e.tokens)) why.push('tokens');
    for (const k of kept) if (!same(a.h[k], b.h[k])) why.push(`${k} differs from allHeads`);
    for (const k of skipped) if (a.h[k] !== null) why.push(`${k} computed though not asked for`);
    if (!same(c.h.attrGhunna, b.h.attrGhunna) || c.h.attrFace !== null) why.push('per-head selection');
    if (why.length) bad.push(`${e.clip}: ${why.join(', ')}`); else ok++;
  }
  tf.free();
  t.diagnostic(`lazy heads: ${ok}/${expected.length} clips (default = scorer + conf, the same bits as allHeads; unrequested heads null)`);
  assert.deepEqual(bad, []);
});

test('streams made and freed one after another on one thread (engine de88490 pinning fix): every stream gives the same bits', {
  skip: skip || (existsSync(path.join(ENGINE, 'c16_l64', 'layers.zfw')) ? false : 'no c16_l64 engine files'), timeout: 600000,
}, async (t) => {
  // WebAssembly runs single-threaded (no pinning, no thread team); this checks that repeated create/free on
  // the same thread leaves nothing behind that changes a later stream's output
  const TF = bindTajweed(factory);
  const tf = await TF.load({ reader: await v4Reader('c16_l64'), context: 'c16_l64' });
  const lines = readFileSync(path.join(root, 'test/tajweed/conformance', CONTEXTS[0].expected), 'utf8').split(String.fromCharCode(10)).filter(Boolean);
  const e = JSON.parse(lines[0]);
  const pcmBuf = readFileSync(path.join(AUDIO, `${e.clip}.pcm`));
  const pcm = new Float32Array(pcmBuf.buffer.slice(pcmBuf.byteOffset, pcmBuf.byteOffset + pcmBuf.byteLength));
  const fps = [];
  for (let n = 0; n < 6; n++) {
    const s = tf.createStream({ allHeads: n % 2 === 0 });
    for (let at = 0; at < pcm.length; at += 320) s.pushAudio(pcm.subarray(at, at + 320));
    s.finish();
    assert.deepEqual(s.greedy(), e.tokens, `stream ${n}`);
    fps.push(hex(fnv1a64(bytesOf(s.heads().logProbs))));
    s.free();
  }
  tf.free();
  assert.equal(new Set(fps).size, 1);
  t.diagnostic(`6 streams one after another: identical tokens and log_probs (${fps[0]})`);
});
