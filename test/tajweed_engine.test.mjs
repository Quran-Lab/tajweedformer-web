// The engine binding end to end, against a MOCK engine: src/zft_api.c (the real shim) and
// test/tajweed/mock_engine.c (a stand-in for the engine's zf_tajweed.h, NOT the engine) built
// freestanding for wasm32 with clang, wrapped as the Emscripten module the package binds, and driven
// through TajweedFormer and web/tajweed/engine.js. This checks wasm32's struct layout, string and
// array marshalling, chunk slicing, the settings sync and the error paths; it says nothing about
// the engine's numbers. Skipped when no clang with a wasm32 target is found (CLANG=path to force one;
// REQUIRE_MOCK=1 makes a failed build an error instead of a skip).
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindTajweed, joinHeads, HEAD_SPECS, EngineNotAvailableError } from '../web/tajweed/index.js';
import { TajweedEngine } from '../web/tajweed/engine.js';
import { v4Folder, opts, TOKENS } from './tajweed/folder.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const tokens = TOKENS.trim().split('\n').map((l) => l.split(' ')[0]);

function buildMock() {
  const cands = [process.env.CLANG, 'clang', 'C:/Program Files/LLVM/bin/clang.exe'].filter(Boolean);
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'tjf-mock-')), 'mock.wasm');
  const errs = [];
  for (const cc of cands) {
    if (cc.includes('/') && !existsSync(cc)) continue;
    const r = spawnSync(cc, ['--target=wasm32-unknown-unknown', '-std=c11', '-O1', '-ffreestanding', '-fno-builtin', '-nostdlib',
      '-Wall', '-Wextra', '-Werror', `-I${path.join(root, 'test/tajweed/include')}`, '-Wl,--no-entry', '-Wl,--export-dynamic',
      '-Wl,-z,stack-size=1048576', '-o', out, path.join(root, 'src/zft_api.c'), path.join(root, 'test/tajweed/mock_engine.c')],
    { encoding: 'utf8' });
    if (r.status === 0) return { wasm: readFileSync(out), cc };
    errs.push(`${cc}: ${r.error ? r.error.message : r.stderr}`);
  }
  return { error: errs.join('\n') || 'no clang found' };
}

// The wasm instance as the Emscripten module surface engine.js uses.
function asModule(instance) {
  const ex = instance.exports, mem = ex.memory;
  const fs = { files: new Map(), dirs: new Set() };
  const m = {
    get HEAPU8() { return new Uint8Array(mem.buffer); },
    get HEAP32() { return new Int32Array(mem.buffer); },
    get HEAPF32() { return new Float32Array(mem.buffer); },
    get HEAPF64() { return new Float64Array(mem.buffer); },
    _malloc: ex.malloc,
    _free: ex.free,
    UTF8ToString(p) { const u = new Uint8Array(mem.buffer); let e = p; while (u[e]) e++; return new TextDecoder().decode(u.subarray(p, e)); },
    stringToNewUTF8(s) {
      const b = new TextEncoder().encode(s), p = ex.malloc(b.length + 1), u = new Uint8Array(mem.buffer);
      u.set(b, p); u[p + b.length] = 0; return p;
    },
    FS: {
      mkdir(d) { if (fs.dirs.has(d)) throw new Error('EEXIST'); fs.dirs.add(d); },
      writeFile(p, d) { if (!fs.dirs.has(p.slice(0, p.lastIndexOf('/')))) throw new Error(`ENOENT ${p}`); fs.files.set(p, Uint8Array.from(d)); },
      unlink(p) { if (!fs.files.delete(p)) throw new Error('ENOENT'); },
      rmdir(d) { fs.dirs.delete(d); },
    },
    _fs: fs,
  };
  for (const [k, v] of Object.entries(ex)) if (k.startsWith('zft_')) m['_' + k] = v;
  return m;
}

const built = buildMock();
if (built.error && process.env.REQUIRE_MOCK === '1') throw new Error(`mock engine build failed:\n${built.error}`);
const skip = built.error ? `no clang with a wasm32 target (${built.error.split('\n')[0].slice(0, 120)})` : false;

let instances = 0;
const factory = async () => { instances++; return asModule((await WebAssembly.instantiate(built.wasm, {})).instance); };
const TF = bindTajweed(factory);
const { files } = await v4Folder();
const load = (o = {}) => TF.load({ files, ...opts, ...o });

test('wasm32 struct layout as the shim reports it', { skip }, async () => {
  const eng = new TajweedEngine(await factory());
  const L = eng.layout;
  assert.equal(eng.apiVersion, 3);
  assert.equal(eng.version, '0.0.0-mock');
  // ZfTajweedHeads: three ints then twelve 4-byte pointers
  assert.equal(L.heads.size, 60);
  assert.equal(L.heads.log_probs, 12);
  assert.equal(L.heads.conf, 56);
  // doubles are 8-aligned on wasm32
  assert.deepEqual([L.site.size, L.site.llr_final, L.site.threshold, L.site.flagged], [72, 24, 48, 56]);
  assert.deepEqual([L.madd.size, L.madd.ratio, L.madd.count, L.madd.display_count, L.madd.frame_hi], [72, 24, 32, 40, 64]);
  assert.deepEqual([L.letter.size, L.letter.score, L.letter.flagged], [48, 16, 32]);
  assert.deepEqual([L.summary.size, L.summary.short_vowel_frames, L.summary.madd_unit_ok], [48, 32, 40]);
  assert.deepEqual([L.effective.size, L.effective.class_threshold, L.effective.context], [272, 72, 252]);
  // API 3: size_t and six ints, then doubles from 32; the word: four ints, a double, ...
  assert.deepEqual([L.wordsettings.size, L.wordsettings.threshold, L.wordsettings.preset_tau], [88, 32, 64]);
  assert.deepEqual([L.word.size, L.word.score, L.word.flagged, L.word.alt, L.word.llr_final, L.word.llr_inter1], [72, 16, 32, 52, 56, 64]);
  // API 3 final: ZfTajweedTop2 (two ints, three floats) and ZfTajweedOpenOptions with no_pin (wasm32: 4-byte size_t and pointers)
  assert.deepEqual([L.top2.size, L.top2.log_prob, L.top2.margin], [20, 8, 16]);
  assert.deepEqual([L.openoptions.size, L.openoptions.context, L.openoptions.batch, L.openoptions.no_pin], [28, 4, 20, 24]);
});

test('load with the engine: verified files staged (root and the context only), model open', { skip }, async () => {
  const tf = await load();
  const fs = tf._eng.m._fs;
  const staged = [...fs.files.keys()].map((p) => p.replace(/^\/tajweedformer\/\d+\//, '')).sort();
  assert.deepEqual(staged, ['c16_l64/layers.zfw', 'c16_l64/model_engine2.onnx.zfg', 'calibration.json', 'expected_tj3.zfx', 'tokens.txt']);
  for (const [p, d] of fs.files) assert.deepEqual(d, files[p.replace(/^\/tajweedformer\/\d+\//, '')]);
  assert.equal(tf.info.engine, 'exact-cpu');
  assert.equal(tf.info.chunkMs, 320);
  assert.equal(tf.info.engineVersion, '0.0.0-mock');
  assert.equal(tf.ayahCount(1), 7);
  assert.equal(tf.ayahCount(2), 0);
  const e = tf.expected(1, 1);
  assert.deepEqual(Array.from(e.tokens), [5, 31, 1, 6, 34]);
  assert.deepEqual(Array.from(e.wordOfToken), [0, 0, 0, 1, 1]);
  assert.equal(e.words, 2);
  assert.throws(() => tf.expected(1, 2), RangeError);
  tf.free();
  assert.equal(fs.files.size, 0, 'free() removes the staged files');
  assert.throws(() => tf.ayahCount(1), EngineNotAvailableError);
  assert.equal((await load({ context: 'c24_l72' })).info.chunkMs, 480);
});

test('stream: chunks sliced for onChunk, the take joined, greedy, one live stream, errors', { skip }, async () => {
  const tf = await load();
  const chunks = [];
  const s = tf.createStream({ onChunk: (h) => chunks.push(h) });
  assert.throws(() => tf.createStream(), /one TajweedFormer stream at a time/);
  assert.throws(() => tf.createStream({ sampleRate: 48000 }), RangeError);
  assert.equal(s.pushAudio(new Float32Array(5120 * 2 + 100)), 2);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].n40, 8);
  assert.equal(chunks[1].n20, 16);
  assert.equal(chunks[1].logProbs[0], 8 * 100);                // log_probs (head 0), take row 8, column 0
  assert.equal(chunks[1].gem[1], 5 * 100000 + 16 * 100 + 1);   // gem (head 5), take row 16 at 20 ms, column 1
  assert.equal(chunks[1].conf[15], 11 * 100000 + 31 * 100);    // conf (head 11), take row 31
  assert.equal(chunks[0].inter4LogProbs, null);                 // a head the source lacks stays null
  const fin = s.finish();
  assert.ok(fin >= 3, `finish ran ${fin} chunks`);
  const take = s.heads();
  assert.equal(take.n40, 8 * (2 + fin));
  assert.equal(chunks.length, 2 + fin);
  const joined = joinHeads(chunks);
  for (const spec of HEAD_SPECS) assert.deepEqual(joined[spec.key], take[spec.key], spec.name);
  assert.deepEqual(s.greedy(), [5, 31]);
  assert.throws(() => s.pushAudio(new Float32Array([NaN])), /mock: bad audio/);
  s.reset();
  assert.equal(s.heads().n40, 0);
  s.free();
  const s2 = tf.createStream();
  assert.equal(s2.pushAudio(new Float32Array(5120)), 1);
  s2.free();
  assert.throws(() => s2.pushAudio(new Float32Array(1)), /freed/);
  tf.free();
});

test('score: heads marshalled in, verdicts out with names, JSON passthrough, settings agree', { skip }, async () => {
  const tf = await load();
  const s = tf.createStream();
  s.pushAudio(new Float32Array(5120 * 3));
  const h = s.heads();
  s.free();
  const r = await tf.score(h, 1, 1);
  assert.equal(r.settingsCheck.agree, true, r.settingsCheck.differences.join('; '));
  assert.equal(r.sites.length, 2);
  const [a, b] = r.sites;
  assert.equal(a.class, 'vowel_sub');
  assert.equal(a.check, 'vowels');
  assert.equal(a.status, 'validated');
  assert.equal(a.expectedUnit, tokens[31]);
  assert.equal(a.alternativeUnit, tokens[32]);
  assert.equal(a.llr.final, h.logProbs[0] / 1e5);
  assert.equal(a.llr.inter1, h.inter1LogProbs[1] / 1e5);
  assert.ok(Math.abs(a.fusedLlr - (0.8 * a.llr.final + 0.2 * a.llr.inter1)) < 1e-12);
  assert.equal(a.threshold, r.settings.sites.vowel_sub.threshold);
  assert.equal(a.flagged, a.fusedLlr > a.threshold);
  assert.equal(b.class, 'cons_del');
  assert.equal(b.alternative, -1);
  assert.equal(b.alternativeUnit, null);
  assert.equal(b.llr.final, h.logProbs[h.n40 * 38 - 1] / 1e5);  // the last value: the whole array went in
  assert.equal(b.flagged, false);                                  // experimental, off by default
  assert.deepEqual([r.madd[0].maddClass, r.madd[0].count, r.madd[0].ratio, r.madd[0].unit], ['fixed2', 2, h.n20 / 8, tokens[34]]);
  assert.equal(r.qalqalah[0].score, h.attrQalqalah[1]);
  assert.deepEqual(r.gemination, []);
  assert.deepEqual(r.summary, { sites: 2, flagged: 0, madd: 1, maddFlagged: 0, qalqalah: 1, qalqalahFlagged: 0,
    gemination: 0, geminationFlagged: 0, shortVowelFrames: 4.5, maddUnitOk: true, words: r.words.length, wordsFlagged: 0 });
  assert.ok(r.words.length >= 1 && r.words.every((w) => w.flagged === null), 'no word block in this calibration: scores only');
  assert.equal(r.raw.format, 'mock');
  // heads from elsewhere without inter1: the engine's error comes back as an exception
  await assert.rejects(tf.score({ ...h, inter1LogProbs: null }, 1, 1), /mock: log_probs and inter1_log_probs/);
  await assert.rejects(tf.score(h, 2, 1), /mock: no such ayah/);
  tf.free();
});

test('settings sync: app layer into the engine; disagreements are reported, not hidden', { skip }, async () => {
  const tf = await load({ settings: { preset: 'sensitive', overrides: { cons_sub: { threshold: -1.5 } }, checks: { letters: true } } });
  let c = tf.engineSettings();
  assert.deepEqual(c.differences, []);
  assert.equal(c.engine.preset, 'sensitive');
  assert.equal(c.engine.classes.cons_sub.threshold, -1.5);
  assert.equal(c.engine.classes.cons_del.enabled, true);
  assert.equal(c.engine.classes.insertion.enabled, false); // off, release build: refused by both
  // the mock ignores the remote block: a remote preset shows up as a disagreement
  tf.settings.setPreset(null);
  tf.setRemoteConfig({ v: 1, preset: 'strict' });
  c = tf.engineSettings();
  assert.ok(c.differences.includes('preset: engine balanced, sdk strict'), c.differences.join('; '));
  // an app setting API version 1 has no setter for (a madd preset)
  tf.setRemoteConfig(null);
  tf.settings.setClassPreset('madd', 'strict');
  c = tf.engineSettings();
  assert.deepEqual(c.differences, ['engine did not take app overrides.madd.preset']);
  tf.free();
  // debug build: app code turns on an "off" check in both
  const dbg = await load({ debug: true, settings: { checks: { lazim: true, letters: true } } });
  c = dbg.engineSettings();
  assert.deepEqual(c.differences, []);
  assert.equal(c.engine.checks.lazim.enabled, true);
  assert.equal(c.engine.classes.insertion.enabled, true);
  dbg.free();
  assert.ok(instances >= 1);
});
