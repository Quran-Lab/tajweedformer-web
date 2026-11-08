// The evidence the public JS API hands over (web/zipformer.js, or web/zipformer-mt.js with --mt) is
// the native C stream's, bit for bit: every clip is decoded as 16 kHz audio through Zipformer.load
// with an onEvidence callback, and the FNV-1a of every chunk's typed arrays and capture statistics,
// in zf_stream_check --evidence's order, must equal the expected ev_fnv (with the tokens and the
// log-prob fingerprint). With --native DIR (zf_stream_check --evidence-dir's output for the same
// clips), joinEvidence's whole-take arrays must also equal the native dump byte for byte, and every
// capture row its JSON. Also checked: the model info, the shapes, and that a stream loaded without
// evidence hands over nothing.
//
//   node test/evidence_e2e.mjs <model dir> <expected.jsonl> <clip.pcm ...> [--mt] [--chunk-ms MS]
//        [--native DIR]
//
// <model dir> holds a graph with the taps (the SDK's tools/zftaps.py) as model_engine2.onnx.zfg and
// .zfg.bin with its .zfw files, and MODEL.c160 / .c320 graphs with their overlays for --chunk-ms.
// <expected.jsonl> is one of the SDK's *_evidence_expected.jsonl (keyed by clip name).
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
const pos = [];
let mt = false, chunkMs, native = null;
for (let i = 0; i < args.length; ++i) {
  if (args[i] === '--mt') mt = true;
  else if (args[i] === '--chunk-ms') chunkMs = +args[++i];
  else if (args[i] === '--native') native = args[++i];
  else pos.push(args[i]);
}
const [modelDir, expPath, ...clips] = pos;
if (!clips.length) {
  console.error('usage: node test/evidence_e2e.mjs <model dir> <expected.jsonl> <clip.pcm ...> [--mt] [--chunk-ms MS] [--native DIR]');
  process.exit(2);
}
const { Zipformer, joinEvidence, CAPTURE_FIELDS } = await import(mt ? '../internal/v3/zipformer-mt.js' : '../internal/v3/zipformer.js');

let fails = 0;
const check = (cond, msg) => { if (!cond) { console.log(`FAIL ${msg}`); fails++; } return cond; };

// FNV-1a, 64 bits, over bytes, in four 16-bit limbs: h * prime is h * 0x1b3 + (h << 40)
class Fnv {
  // the SDK's start value, 1469598103934665603 (zf_stream_check, src/zfw_api.c), low limb first
  constructor() { this.h = [0x0383, 0x739d, 0x0fb0, 0x1465]; }
  bytes(u8) {
    let [h0, h1, h2, h3] = this.h;
    for (let i = 0; i < u8.length; ++i) {
      h0 ^= u8[i];
      let t0 = h0 * 0x1b3, t1 = h1 * 0x1b3, t2 = h2 * 0x1b3 + (h0 << 8), t3 = h3 * 0x1b3 + (h1 << 8);
      t1 += t0 >>> 16; t2 += t1 >>> 16; t3 += t2 >>> 16;
      h0 = t0 & 0xffff; h1 = t1 & 0xffff; h2 = t2 & 0xffff; h3 = t3 & 0xffff;
    }
    this.h = [h0, h1, h2, h3];
  }
  floats(f32) { if (f32) this.bytes(new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)); }
  hex() { return this.h.slice().reverse().map((x) => x.toString(16).padStart(4, '0')).join(''); }
}

// ZfCaptureStats as the C struct lays it out: int, three floats, three ints, two floats
function captureBytes(c) {
  const v = new DataView(new ArrayBuffer(36));
  v.setInt32(0, c.hasSamples ? 1 : 0, true);
  v.setFloat32(4, c.rms, true); v.setFloat32(8, c.peak, true); v.setFloat32(12, c.dc, true);
  v.setInt32(16, c.clipped, true); v.setInt32(20, c.zeroRuns, true); v.setInt32(24, c.zeroSamples, true);
  v.setFloat32(28, c.noiseFloor, true); v.setFloat32(32, c.bandwidthHz, true);
  return new Uint8Array(v.buffer);
}

const modelFiles = {};
for (const f of readdirSync(modelDir).filter((f) => /\.(zfg|zfg\.bin|zfw)$/.test(f)))
  modelFiles[f] = readFileSync(join(modelDir, f));
let chunks = [];
const zf = await Zipformer.load({
  modelFiles, modelName: 'model_engine2.onnx', threads: mt ? 4 : 1, chunkMs,
  onEvidence: (ev) => chunks.push(ev),
});
const info = zf.info;
console.log(`model ${JSON.stringify(info)}`);
check(info.backend === 'exact-cpu' && info.backendId === 1, 'backend is the exact CPU engine');
check(info.chunkMs === (chunkMs || info.advance * 10) && zf.chunkMs === info.chunkMs, `chunkMs ${info.chunkMs}`);
check(info.vocab > info.blank && info.blank === info.vocab - 1 && /^[0-9a-f]{64}$/.test(info.weightsSha256), 'vocab, blank, weights');

const expected = new Map(readFileSync(expPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .map((e) => [e.clip, e]));
let same = 0, dumped = 0, chunkCount = 0;
const t0 = performance.now();
for (const path of clips) {
  const clip = basename(path).replace(/\.[^.]+$/, '');
  const e = expected.get(clip);
  if (!check(e, `${clip}: not in ${expPath}`)) continue;
  const buf = readFileSync(path);
  const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
  zf.reset();
  chunks = [];
  const toks = [];
  for (let at = 0; at < pcm.length; at += 1600) toks.push(...zf.pushAudio(pcm.subarray(at, at + 1600)));
  toks.push(...zf.finish());
  chunkCount += chunks.length;
  const fnv = new Fnv();
  for (const c of chunks) {
    fnv.floats(c.logProbs); fnv.floats(c.logitLse); fnv.floats(c.enc); fnv.floats(c.stack0); fnv.floats(c.stack1);
    fnv.floats(c.samples); fnv.bytes(captureBytes(c.capture));
  }
  const take = joinEvidence(chunks);
  const shapes = chunks.length === zf.chunks && chunks.every((c, k) => c.chunk === k && c.samples &&
      c.samples.length === zf.advance * 160 && c.capture.hasSamples) &&
    take.logProbs.length === take.frames * info.vocab && take.vocab === info.vocab &&
    (!take.s0 || take.s0.length === 2 * take.frames * take.s0Dim) && (!take.lse || take.lse.length === take.frames) &&
    take.samples.length === chunks.length * zf.advance * 160 && take.capture.length === chunks.length;
  check(shapes, `${clip}: shapes`);
  const ok = fnv.hex() === e.ev_fnv && zf.logProbFingerprint === e.logp_fnv &&
    JSON.stringify(toks.map((t) => t.token)) === JSON.stringify(e.tokens) && chunks.length === e.chunks;
  if (check(ok, `${clip}: evidence ${fnv.hex()} expected ${e.ev_fnv}, log-probs ${zf.logProbFingerprint} expected ${e.logp_fnv}`))
    ++same;
  if (native) {
    const meta = JSON.parse(readFileSync(join(native, `${clip}.json`), 'utf8'));
    let byteOk = JSON.stringify(meta.capture_fields) === JSON.stringify(CAPTURE_FIELDS);
    const arrays = { lp: take.logProbs, lse: take.lse, enc: take.enc, s0: take.s0, s1: take.s1, pcm: take.samples };
    for (const [ext, arr] of Object.entries(arrays)) {
      const want = readFileSync(join(native, `${clip}.${ext}`));
      const got = arr ? Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength) : Buffer.alloc(0);
      byteOk = check(Buffer.compare(want, got) === 0, `${clip}.${ext}: ${got.length} bytes against the native ${want.length}`) && byteOk;
    }
    // the dump's capture rows are %.9g, which round-trips a float32 exactly
    const rowsOk = meta.capture.length === take.capture.length &&
      meta.capture.every((row, k) => row.every((x, j) => Math.fround(x) === take.capture[k][j]));
    byteOk = check(rowsOk, `${clip}: capture rows`) && byteOk;
    dumped += byteOk;
  }
}
const ms = performance.now() - t0;

// a stream without evidence hands over nothing (one live stream at a time: the first goes first)
zf.free();
const plain = await Zipformer.load({ modelFiles, modelName: 'model_engine2.onnx', threads: mt ? 4 : 1, chunkMs });
const first = readFileSync(clips[0]);
plain.pushAudio(new Float32Array(first.buffer, first.byteOffset, first.byteLength >> 2));
plain.finish();
check(plain.takeEvidence().length === 0 && plain.chunks > 0, 'no evidence without opting in');
check(plain.info.weightsSha256 === '' && plain.info.vocab === info.vocab, 'no weights digest without opting in');
plain.free();
const digested = await Zipformer.load({ modelFiles, modelName: 'model_engine2.onnx', chunkMs, weightsDigest: true });
check(digested.info.weightsSha256 === info.weightsSha256, 'weightsDigest: true gives the same digest');
digested.free();
let threw = false;
try { await Zipformer.load({ modelFiles, modelName: 'model_engine2.onnx', chunkMs: 200 }); } catch (err) { threw = err instanceof RangeError; }
check(threw, 'chunkMs 200 refused');

console.log(`${same}/${clips.length} clips: evidence bit-identical through the JS API (every chunk's log-probs, ` +
  `logit energy, encoder output, stacks 0 and 1, samples, capture statistics), ${chunkCount} chunks, ${ms.toFixed(0)} ms`);
if (native) console.log(`${dumped}/${clips.length} clips byte-identical to the native dump (lp, lse, enc, s0, s1, pcm, capture)`);
console.log(fails ? `${fails} check(s) failed` : 'all evidence checks pass');
process.exit(fails ? 1 : 0);
