// Conformance through this SDK's own API, with the real engine (dist/tajweedformer.mjs) and a real 3.0 model
// folder: the 35 parity clips (16 kHz float32 audio) pushed into a Session in 20 ms pieces, and every chunk's
// 12 outputs, as the chunks hand them over, fingerprinted with FNV-1a 64 over their float bytes (start
// 1469598103934665603 as the engine's FNV0, prime 1099511628211), plus logp_fnv (one FNV running over every
// chunk's log_probs), the chunk count and the greedy tokens (fields as the engine's conformance files).
//
// References (test/tajweed/conformance/):
//   c16_l64   v4_c16_l64_audio_expected.jsonl: the engine's conformance file, ONNX Runtime armv7's bits
//   c8_l64    v4_c8_l64_audio_expected.jsonl: the same recipe at 160 ms
//   c24_l72, c24_l256   v4_<ctx>_audio_native_x86.jsonl: the native engine (audio in 20 ms pushes). The engine
//             has no audio reference from ONNX Runtime at chunk 24; that native build reproduces the c16_l64
//             ORT file 35/35.
//
// Also here, on the same folders: the engine's top-2 and top-K against the SDK's own ranking, lazy heads,
// takes one after another, the sample clips through listen() against the self-test file, the calibration byte
// for byte, the reference lookup against the table itself, a folder without calibration and reference data,
// and a folder whose reference file was not fetched.
//
// Needs the built engine and files that are not in this repository (the model is gated):
//   TAJWEED_MODEL_30      the folder that holds the model folders full/, prod/, bare/ and
//                         full-reference-not-fetched/ (each with sdk/v4.0 inside) and local30.json, which names
//                         the throwaway key they are signed with (public_key_hex)
//   TAJWEED_MODEL_VARIANT the folder the tests run on: full (default; the 2.x self-test files and tolerances) or
//                         prod (the production shape: tokens-only self-test files, no tolerance of either kind)
//   TAJWEED_V4_AUDIO      folder of <clip>.pcm (the engine's conformance audio)
// Skipped when any is missing (REQUIRE_V4=1 makes that an error).
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TajweedError } from '../web/index.js';
import { openModel } from '../web/api/model.js';
import { EngineHost } from '../web/api/engine-host.js';
import { EngineStream } from '../web/tajweed/engine.js';
import { HEAD_NAMES } from '../web/api/heads.js';
import { H0, fnv1a64, hex, bytesOf, take, checkClip, CONTEXTS } from './helpers/conformance_core.mjs';
import { wasmArgs } from '../web/platform/node-hook.js';
import { topK, RANKED_HEADS, decodeFrames } from '../web/tajweed/decode.js';
import { HEAD_SPECS } from '../web/tajweed/heads.js';
import { dirReader } from './helpers/readers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// no default: the folders are on one PC only, and the test skips without them
const MODELS = process.env.TAJWEED_MODEL_30 || '';
const AUDIO = process.env.TAJWEED_V4_AUDIO || '';
const VARIANT = process.env.TAJWEED_MODEL_VARIANT || 'full';
// the public key the local model folders are signed with: a throwaway key named by the folders' own index,
// never Quran Lab's, and never written into this repository
const INDEX = MODELS && existsSync(path.join(MODELS, 'local30.json')) ? JSON.parse(readFileSync(path.join(MODELS, 'local30.json'), 'utf8')) : null;
const TEST_KEY = INDEX ? INDEX.public_key_hex : '';
const folder = (variant) => path.join(MODELS, variant, 'sdk', 'v4.0');
const RSS_LIMIT = 16 * 2 ** 30; // the shared PC's guard: stop before 16 GB

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
if (!existsSync(fullPath)) missing.push('dist/tajweedformer.mjs (npm run build)');
if (!TEST_KEY || !existsSync(path.join(folder(VARIANT), 'manifest.json'))) missing.push('the 3.0 model folders with their local30.json (TAJWEED_MODEL_30)');
if (!existsSync(AUDIO)) missing.push('the conformance audio (TAJWEED_V4_AUDIO)');
if (missing.length && process.env.REQUIRE_V4 === '1') throw new Error(`conformance needs: ${missing.join(', ')}`);
const skip = missing.length ? `needs ${missing.join(', ')}` : false;
const skipModel = missing.filter((m) => !m.includes('audio')).length ? skip : false;

const open = (variant) => openModel({ reader: Object.assign(dirReader(folder(variant)), { fresh: true }), folder: { trustedKeys: [TEST_KEY] } });
const clipAudio = (clip) => {
  const b = readFileSync(path.join(AUDIO, `${clip}.pcm`));
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const expectedOf = (C) => readFileSync(path.join(root, 'test/tajweed/conformance', C.expected), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// what the conformance tests compared, printed as one line when the file ends (scripts/proof.mjs reads it)
const STATS = { clips: 0, chunks: 0, values: 0, mismatches: 0, sampleClips: 0, sampleClipMismatches: 0, t0: Date.now() };
test.after(() => {
  if (!STATS.clips && !STATS.sampleClips) return;
  const { t0, ...s } = STATS;
  console.log('PROOF node ' + JSON.stringify({ variant: VARIANT, ...s, wallS: Math.round((Date.now() - t0) / 1000), peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024) }));
});
let shared = null; // one open model for the tests on the full folder
const fullModel = async () => shared || (shared = await open(VARIANT));
test.after(async () => { if (shared) await shared.close(); });

for (const C of CONTEXTS) test(`${C.context} conformance through a Session (audio, 20 ms pushes) against ${C.ref}: 35 clips, 12 outputs per chunk`, { skip, timeout: 1800000 }, async (t) => {
  const model = await fullModel();
  assert.equal(model.version, '4.0.0');
  assert.equal(model.chunkMs(C.context), C.chunkMs);
  assert.deepEqual(model.backend, { kind: 'cpu', name: 'wasm', stage: 'cpu', reason: null });
  const expected = expectedOf(C);
  assert.equal(expected.length, 35);
  const bad = [];
  let ok = 0, decodedOk = 0;
  for (const e of expected) {
    const r = await checkClip(model, clipAudio(e.clip), e, C, HEAD_NAMES);
    STATS.clips++;
    STATS.chunks += r.chunks;
    STATS.values += r.values;
    if (r.decoded) decodedOk++;
    if (r.why) { bad.push(`${e.clip} (${r.why})`); STATS.mismatches++; } else ok++;
    const rss = process.memoryUsage().rss;
    if (rss > RSS_LIMIT) throw new Error(`RSS ${rss} bytes over the 16 GB guard`);
  }
  t.diagnostic(`${C.context}: ${ok}/${expected.length} clips bit-identical to ${C.ref} (tokens, chunks, every value of all 12 outputs of every chunk); decoded layer checked on ${decodedOk}`);
  assert.deepEqual(bad, []);
});

test('the engine\'s top-2 and top-K equal the SDK\'s ranking; the stream\'s greedy ids and whole-take heads equal the chunks (c16_l64, 35 clips)', { skip, timeout: 1800000 }, async (t) => {
  // at the engine binding (web/tajweed/engine.js), below the public API
  // (the glue is built for web and worker: in Node it is handed the wasm file's bytes, as the SDK does)
  const { default: glue } = await import(pathToFileURL(fullPath).href);
  const host = new EngineHost(async () => glue(await wasmArgs('tajweedformer.wasm')));
  await host.init();
  const read = (p) => { const f = path.join(folder(VARIANT), p); return existsSync(f) ? new Uint8Array(readFileSync(f)) : new Uint8Array(gunzipSync(readFileSync(f + '.gz'))); };
  await host.stage(['tokens.txt', 'layers.zfw', 'frontend.zfw', 'c16_l64/frames.zfw', 'c16_l64/model_engine2.onnx.zfg', 'c16_l64/model_engine2.onnx.zfg.bin'].map((p) => ({ path: p, bytes: read(p) })));
  host._open('c16_l64', 16000);
  const expected = expectedOf(CONTEXTS[0]);
  const KEY = Object.fromEntries(HEAD_SPECS.map((s) => [s.name, s.key]));
  const bad = [];
  let topkChecked = 0;
  for (const [n, e] of expected.entries()) {
    const chunks = [];
    const s = new EngineStream(host.eng, host.model, { keep: null, onChunk: (h) => chunks.push(h) });
    const pcm = clipAudio(e.clip);
    for (let at = 0; at < pcm.length; at += 320) s.pushAudio(pcm.subarray(at, Math.min(pcm.length, at + 320)));
    s.finish();
    let why = null;
    const takeHeads = s.heads();
    if (JSON.stringify(s.greedy()) !== JSON.stringify(e.tokens)) why = 'engine greedy';
    for (const spec of HEAD_SPECS) {
      if (why) break;
      const joined = Buffer.concat(chunks.map((c) => Buffer.from(bytesOf(c[spec.key]))));
      if (!takeHeads[spec.key] || Buffer.compare(Buffer.from(bytesOf(takeHeads[spec.key])), joined) !== 0) why = `heads() ${spec.name}`;
    }
    if (!why) {
      const eng2 = s.top2(), js2 = decodeFrames(takeHeads.logProbs, takeHeads.n40);
      if (!eng2 || eng2.length !== js2.length || eng2.some((f, i) => f.top1 !== js2[i].top1 || f.runnerUp !== js2[i].runnerUp ||
        f.top1LogProb !== js2[i].top1LogProb || f.runnerUpLogProb !== js2[i].runnerUpLogProb || f.margin !== js2[i].margin)) why = 'engine top-2 != SDK top-2';
      else if (chunks.some((h, i) => h.index !== i || h.frames.length !== h.n40)) why = 'chunk frames/index';
    }
    if (!why && n % 7 === 0) {
      for (const [name, cols] of Object.entries(RANKED_HEADS)) {
        for (const k of [2, cols]) {
          const a = s.topK(name, k), b = topK(takeHeads, name, k);
          if (!a || !b || a.frames !== b.frames || a.ids.some((x, i) => x !== b.ids[i]) || a.values.some((x, i) => x !== b.values[i]) ||
            a.margins.some((x, i) => x !== b.margins[i])) { why = `engine top-K ${name} k ${k}`; break; }
        }
        if (why) break;
      }
      if (!why) topkChecked++;
    }
    s.free();
    if (why) bad.push(`${e.clip} (${why})`);
    void KEY;
  }
  await host.close();
  t.diagnostic(`engine top-2 == SDK top-2 on ${expected.length - bad.length}/${expected.length} clips; engine top-K == SDK top-K (every rankable head, k 2 and all) on ${topkChecked} clips`);
  assert.deepEqual(bad, []);
});

test('lazy heads: the default Session computes the six default heads only; those are the bits of an all-heads run', { skip, timeout: 600000 }, async (t) => {
  const model = await fullModel();
  const expected = expectedOf(CONTEXTS[0]).slice(0, 5);
  const kept = ['log_probs', 'inter1_log_probs', 'timing_log_probs', 'gem', 'attr_qalqalah', 'conf'];
  const skipped = ['inter4_log_probs', 'id_log_probs', 'attr_tafkheem', 'attr_ghunna', 'attr_face', 'boundary'];
  let ok = 0;
  const bad = [];
  for (const e of expected) {
    const pcm = clipAudio(e.clip);
    const a = (await take(model, pcm, {})).heads, b = (await take(model, pcm, { heads: 'all' })).heads, c = (await take(model, pcm, { heads: ['attr_ghunna'] })).heads;
    const same = (x, y) => x && y && Buffer.compare(Buffer.from(bytesOf(x.values)), Buffer.from(bytesOf(y.values))) === 0;
    const why = [];
    if (JSON.stringify(a.greedy().map((x) => x.id)) !== JSON.stringify(e.tokens)) why.push('tokens');
    for (const k of kept) if (!same(a.get(k), b.get(k))) why.push(`${k} differs from all heads`);
    for (const k of skipped) if (a.get(k) !== null) why.push(`${k} computed though not asked for`);
    if (!same(c.get('attr_ghunna'), b.get('attr_ghunna')) || c.get('attr_face') !== null || !same(c.get('log_probs'), b.get('log_probs'))) why.push('per-head selection');
    if (why.length) bad.push(`${e.clip}: ${why.join(', ')}`); else ok++;
  }
  t.diagnostic(`lazy heads: ${ok}/${expected.length} clips (the default six, the same bits as all heads; unrequested heads null)`);
  assert.deepEqual(bad, []);
});

test('takes one after another on one Model, and audio at 48 kHz through the engine\'s resampler: every take gives the same bits', { skip, timeout: 600000 }, async (t) => {
  const model = await fullModel();
  const e = expectedOf(CONTEXTS[0])[0];
  const pcm = clipAudio(e.clip);
  const fps = [];
  for (let n = 0; n < 6; n++) {
    const { heads } = await take(model, pcm, n % 2 === 0 ? { heads: 'all' } : {});
    assert.deepEqual(heads.greedy().map((x) => x.id), e.tokens, `take ${n}`);
    fps.push(hex(fnv1a64(bytesOf(heads.get('log_probs').values))));
  }
  assert.equal(new Set(fps).size, 1);
  t.diagnostic(`6 takes one after another: identical tokens and log_probs (${fps[0]})`);
  // the same clip at 48 kHz (each sample three times): the Session carries the rate to the engine, which resamples
  const up = new Float32Array(pcm.length * 3);
  for (let i = 0; i < pcm.length; i++) up[3 * i] = up[3 * i + 1] = up[3 * i + 2] = pcm[i];
  const chunks = [];
  const s = model.session({ sampleRate: 48000, onChunk: (c) => chunks.push(c) });
  for (let at = 0; at < up.length; at += 960) s.push(up.subarray(at, at + 960));
  const h48 = await s.finish();
  assert.ok(Math.abs(chunks.length - e.chunks) <= 1, `48 kHz: ${chunks.length} chunks for ${e.chunks} at 16 kHz`);
  assert.ok(h48.greedy().length >= e.tokens.length - 3, `48 kHz: ${h48.greedy().length} tokens for ${e.tokens.length} at 16 kHz`);
});

test('the sample clips through listen() give the tokens of the self-test file, in every context of the file', { skip: skipModel, timeout: 600000 }, async (t) => {
  const model = await fullModel();
  assert.equal(model.sampleClips.length, 5);
  assert.deepEqual(model.sampleClips.map((c) => c.kind).sort(), ['clean', 'clean', 'clean', 'clean', 'planted']);
  let checked = 0;
  for (const context of ['c16_l64', 'c8_l64']) {
    const exp = JSON.parse(gunzipSync(readFileSync(path.join(folder(VARIANT), 'selftest', `expected_${context}.json.gz`))).toString('utf8'));
    for (const clip of model.sampleClips) {
      const s = await model.listen({ from: clip, pace: 'fast', context });
      const events = [];
      for await (const ev of s.events) events.push(ev);
      assert.deepEqual(events.at(-1), { type: 'ended', reason: 'sourceEnd' });
      const heads = await s.finish();
      // only the tokens of the expected file are read (a 3.0 build's file holds nothing else)
      STATS.sampleClips++;
      if (JSON.stringify(heads.greedy().map((x) => x.id)) !== JSON.stringify(exp.clips[clip.name].tokens)) STATS.sampleClipMismatches++;
      assert.deepEqual(heads.greedy().map((x) => x.id), exp.clips[clip.name].tokens, `${clip.name} ${context}`);
      assert.ok(Math.abs(clip.durationMs - heads.get('log_probs').frames * 40) <= model.chunkMs(context) + 1050, `${clip.name}: duration`);
      checked++;
    }
  }
  t.diagnostic(`${checked} sample clip takes through listen({ from: clip }) match the self-test file's tokens`);
});

test('the calibration is the shipped file byte for byte; the reference lookup equals the table for every ayah', { skip: skipModel, timeout: 600000 }, async (t) => {
  const model = await fullModel();
  const cal = gunzipSync(readFileSync(path.join(folder(VARIANT), 'calibration.json.gz')));
  assert.equal(model.calibration.text, cal.toString('utf8'));
  assert.equal(model.calibration.sha256, createHash('sha256').update(cal).digest('hex'));
  assert.equal(model.calibration.sha256, '747b7b4cff040efbd46b2ef709f9344c35771b109a4ca1bee1e52b65a5bd991c');
  assert.equal(model.calibration.format, 'quranlab.tajweed-calibration/1');
  assert.deepEqual([...model.calibration.contexts].sort(), [...model.contexts].sort());
  assert.equal(typeof model.calibration.threshold('c16_l64', 'vowel_sub', 'balanced'), 'number');
  // the table read here by its documented layout (header, ayah counts, ayah index, tokens, words), independently of the engine
  const z = gunzipSync(readFileSync(path.join(folder(VARIANT), 'expected_tj3.zfx.gz')));
  assert.equal(z.subarray(0, 8).toString('latin1'), 'ZFTJEXP1');
  const [oCounts, oIndex, oTokens, oWords] = [0, 1, 2, 3].map((i) => z.readUInt32LE(104 + 4 * i));
  const ref = model.reference;
  assert.equal(ref.isDownloaded, true, 'the file is in the folder');
  let ayahs = 0, units = 0, record = 0;
  for (let surah = 1; surah <= 114; surah++) {
    const count = z.readUInt16LE(oCounts + 2 * (surah - 1));
    for (let ayah = 1; ayah <= count; ayah++, record++) {
      const at = oIndex + 20 * record;
      const first = z.readUInt32LE(at), n = z.readUInt16LE(at + 12), words = z.readUInt8(at + 16);
      const got = await ref.units(surah, ayah);
      assert.deepEqual(got.units, [...z.subarray(oTokens + first, oTokens + first + n)], `${surah}:${ayah} units`);
      assert.deepEqual(got.words, [...z.subarray(oWords + first, oWords + first + n)], `${surah}:${ayah} words`);
      assert.equal(got.wordCount, words, `${surah}:${ayah} word count`);
      ayahs++; units += n;
    }
    await assert.rejects(ref.units(surah, count + 1), (e) => e instanceof TajweedError && e.code === 'invalid_argument');
  }
  assert.equal(record, 6236);
  t.diagnostic(`reference lookup equals the table on all ${ayahs} ayahs (${units} units)`);
});

test('the production shape: a folder with tokens-only self-test files and no tolerance opens, its sample clips give the self-test tokens, a clip is bit-exact',
  { skip: skip || (existsSync(path.join(folder('prod'), 'manifest.json')) ? false : 'the folders have no prod variant'), timeout: 600000 }, async (t) => {
    const manifest = JSON.parse(readFileSync(path.join(folder('prod'), 'manifest.json'), 'utf8'));
    assert.equal('golden_tolerance' in manifest || 'golden_raw_tolerance' in manifest, false, 'no tolerance of either kind');
    const model = VARIANT === 'prod' ? await fullModel() : await open('prod');
    try {
      assert.equal(model.version, '4.0.0');
      assert.equal(model.build, INDEX.variants.prod.build);
      let takes = 0;
      for (const context of ['c16_l64', 'c8_l64']) {
        const exp = JSON.parse(gunzipSync(readFileSync(path.join(folder('prod'), 'selftest', `expected_${context}.json.gz`))).toString('utf8'));
        assert.deepEqual(Object.keys(exp).sort(), ['clips', 'context', 'engine', 'format']);
        for (const clip of model.sampleClips) {
          assert.deepEqual(Object.keys(exp.clips[clip.name]).sort(), ['chunks', 'tokens'], 'tokens only');
          const s = await model.listen({ from: clip, pace: 'fast', context });
          for await (const ev of s.events) { if (ev.type === 'ended') break; } // the clip ran out
          const heads = await s.finish();
          assert.deepEqual(heads.greedy().map((x) => x.id), exp.clips[clip.name].tokens, `${clip.name} ${context}`);
          takes++;
        }
      }
      // the engine's files are the same as in the other shape: one conformance clip, every value
      const C = CONTEXTS[0];
      const e = expectedOf(C)[0];
      const r = await checkClip(model, clipAudio(e.clip), e, C, HEAD_NAMES);
      assert.equal(r.why, null, `${e.clip}: ${r.why}`);
      t.diagnostic(`prod (build ${model.build.slice(0, 12)}): ${takes} sample clip takes match the tokens-only self-test files; ${e.clip} bit-exact at ${C.context} (${r.chunks} chunks, ${r.values} values)`);
    } finally { if (VARIANT !== 'prod') await model.close(); }
  });

test('a folder without calibration and reference data opens and decodes; a reference file that was not fetched is reference_missing',
  { skip: skip || (VARIANT === 'full' ? false : 'the bare and reference-not-fetched folders are variants of full'), timeout: 600000 }, async () => {
  const e = expectedOf(CONTEXTS[0])[0];
  const bare = await open('bare');
  try {
    assert.equal(bare.calibration, null);
    assert.equal(bare.reference, null);
    assert.equal(bare.version, '4.0.0');
    const { heads } = await take(bare, clipAudio(e.clip), {});
    assert.deepEqual(heads.greedy().map((x) => x.id), e.tokens);
  } finally { await bare.close(); }
  const partial = await open('full-reference-not-fetched');
  try {
    assert.ok(partial.reference, 'the manifest lists the table');
    assert.equal(partial.reference.isDownloaded, false);
    const missing = (x) => x instanceof TajweedError && x.code === 'reference_missing';
    await assert.rejects(partial.reference.units(1, 1), missing);
    await assert.rejects(partial.reference.fetch(), missing);
    const { heads } = await take(partial, clipAudio(e.clip), {});
    assert.deepEqual(heads.greedy().map((x) => x.id), e.tokens);
  } finally { await partial.close(); }
});
