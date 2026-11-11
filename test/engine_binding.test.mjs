// The engine binding end to end, against a MOCK engine: src/zft_api.c (the real shim) and
// test/tajweed/mock_engine.c (a stand-in for the engine's zf_tajweed.h, NOT the engine) built
// freestanding for wasm32 with clang, wrapped as the Emscripten module the package binds, and driven
// through the engine host (web/api/engine-host.js), web/tajweed/engine.js and the public Model and Session.
// This checks wasm32's struct layout, string and array marshalling, chunk slicing, head selection, the
// reference table's calls and the error paths; it says nothing about the engine's numbers (the conformance
// test does). Skipped when no clang with a wasm32 target is found (CLANG=path to force one; REQUIRE_MOCK=1
// makes a failed build an error instead of a skip).
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TajweedError } from '../web/index.js';
import { TajweedEngine, EngineStream } from '../web/tajweed/engine.js';
import { joinHeads, HEAD_SPECS } from '../web/tajweed/heads.js';
import { EngineHost, localHost } from '../web/api/engine-host.js';
import { openModel } from '../web/api/model.js';
import { memoryReader } from '../web/tajweed/manifest.js';
import { build3, testKeyHex } from './helpers/model3.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
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
const enc = (s) => new TextEncoder().encode(s);
const ENGINE_FILES = [{ path: 'tokens.txt', bytes: enc('tokens') }, { path: 'c16_l64/frames.zfw', bytes: enc('frames') }];

test('wasm32 struct layout as the shim reports it', { skip }, async () => {
  const eng = new TajweedEngine(await factory());
  const L = eng.layout;
  assert.equal(eng.apiVersion, 4);
  assert.equal(eng.version, '0.0.0-mock');
  // ZfTajweedHeads: three ints then twelve 4-byte pointers
  assert.equal(L.heads.size, 60);
  assert.equal(L.heads.log_probs, 12);
  assert.equal(L.heads.conf, 56);
  // ZfTajweedTop2 (two ints, three floats) and ZfTajweedOpenOptions with no_pin (wasm32: 4-byte size_t and pointers)
  assert.deepEqual([L.top2.size, L.top2.log_prob, L.top2.margin], [20, 8, 16]);
  assert.deepEqual([L.openoptions.size, L.openoptions.context, L.openoptions.batch, L.openoptions.no_pin], [28, 4, 20, 24]);
  assert.deepEqual(Object.keys(L), ['heads', 'top2', 'openoptions'], 'no scorer struct is read');
});

test('the host stages verified files, opens the model for a context and a rate, and reopens it when they change', { skip }, async () => {
  const host = new EngineHost(factory);
  assert.deepEqual(await host.init(), { engineVersion: '0.0.0-mock', apiVersion: 4 });
  await host.stage(ENGINE_FILES);
  const fs = host.eng.m._fs;
  assert.deepEqual([...fs.files.keys()].map((p) => p.replace(/^\/tajweedformer\/\d+\//, '')).sort(), ['c16_l64/frames.zfw', 'tokens.txt']);
  for (const f of ENGINE_FILES) assert.deepEqual(fs.files.get(`${host.staged.dir}/${f.path}`), f.bytes);
  // more files later (another context) go into the same staging
  await host.stage([{ path: 'c24_l72/frames.zfw', bytes: enc('frames 24') }, ENGINE_FILES[0]]);
  assert.equal(fs.files.size, 3);
  assert.deepEqual(await host.warm({ context: 'c16_l64', sampleRate: 16000 }), { chunkMs: 320 });
  const first = host.opened;
  assert.deepEqual(await host.start({ context: 'c16_l64', sampleRate: 16000, heads: ['log_probs'] }), { chunkMs: 320 });
  assert.equal(host.opened, first, 'the same context and rate keep the opened model');
  assert.deepEqual(await host.start({ context: 'c24_l72', sampleRate: 16000, heads: ['log_probs'] }), { chunkMs: 480 });
  assert.deepEqual(host.opened, { context: 'c24_l72', sampleRate: 16000 });
  await assert.rejects(host.start({ context: 'c99_l1', sampleRate: 16000 }), /mock: no such context/);
  await assert.rejects(host.push(new Float32Array(10)), /no take is open/);
  await host.close();
  assert.equal(fs.files.size, 0, 'close() removes the staged files');
});

test('a take: chunks sliced as they complete, only the selected heads, the end flushes, cancel drops', { skip }, async () => {
  const host = new EngineHost(factory);
  await host.stage(ENGINE_FILES);
  await host.start({ context: 'c16_l64', sampleRate: 16000, heads: null });   // all twelve
  let r = await host.push(new Float32Array(5120 * 2 + 100));
  assert.equal(r.chunks.length, 2);
  assert.ok(r.computeMs >= 0);
  const c = r.chunks[1];
  assert.deepEqual([c.index, c.firstFrame, c.n40], [1, 8, 8]);
  assert.equal(c.heads.log_probs.length, 8 * 38);
  assert.equal(c.heads.log_probs[0], 8 * 100);                    // log_probs (head 0), take row 8, column 0
  assert.equal(c.heads.gem[1], 5 * 100000 + 16 * 100 + 1);       // gem (head 5), take row 16 at 20 ms, column 1
  assert.equal(c.heads.conf[15], 11 * 100000 + 31 * 100);        // conf (head 11), take row 31
  assert.ok(!('inter4_log_probs' in c.heads), 'a head the engine did not hand over is absent');
  r = await host.push(new Float32Array(100));
  assert.equal(r.chunks.length, 0);
  const fin = await host.finish();
  assert.ok(fin.chunks.length >= 3, `finish ran ${fin.chunks.length} chunks`);
  assert.deepEqual(fin.chunks.map((x) => x.index), fin.chunks.map((_, i) => 2 + i));
  await assert.rejects(host.push(new Float32Array(10)), /no take is open/);
  // a selection: only those heads come back
  await host.start({ context: 'c16_l64', sampleRate: 16000, heads: ['log_probs', 'gem'] });
  r = await host.push(new Float32Array(5120));
  assert.deepEqual(Object.keys(r.chunks[0].heads), ['log_probs', 'gem']);
  // the engine's error reaches the caller; cancel releases the stream for the next take
  await assert.rejects(host.push(new Float32Array([NaN])), /mock: bad audio/);
  await host.cancel();
  await host.start({ context: 'c16_l64', sampleRate: 16000, heads: ['log_probs'] });
  assert.equal((await host.push(new Float32Array(5120))).chunks.length, 1);
  await host.close();
});

test('the stream at the binding: the whole take is the chunks joined, greedy ids, one live stream, freed', { skip }, async () => {
  const host = new EngineHost(factory);
  await host.stage(ENGINE_FILES);
  host._open('c16_l64', 16000);
  const chunks = [];
  const s = new EngineStream(host.eng, host.model, { keep: null, onChunk: (h) => chunks.push(h) });
  assert.throws(() => new EngineStream(host.eng, host.model, {}), /one TajweedFormer stream at a time/);
  assert.equal(s.pushAudio(new Float32Array(5120 * 2 + 100)), 2);
  const fin = s.finish();
  const take = s.heads();
  assert.equal(take.n40, 8 * (2 + fin));
  const joined = joinHeads(chunks);
  for (const spec of HEAD_SPECS) assert.deepEqual(joined[spec.key], take[spec.key], spec.name);
  assert.deepEqual(s.greedy(), [5, 31]);
  assert.throws(() => s.pushAudio(new Float32Array([NaN])), /mock: bad audio/);
  s.reset();
  assert.equal(s.heads().n40, 0);
  s.free();
  assert.throws(() => s.pushAudio(new Float32Array(1)), /freed/);
  await host.close();
});

test('the reference table: opened from its bytes, units and words of an ayah, the vocabulary hash, a bad table', { skip }, async () => {
  const host = new EngineHost(factory);
  await assert.rejects(host.reference({ surah: 1, ayah: 1 }), /not open/);
  await assert.rejects(host.loadReference(enc('not a table')), /mock: not a reference table/);
  const r = await host.loadReference(enc('MOCKREF table'));
  assert.equal(r.tokensSha256, 'abcd' + '00'.repeat(30));
  const u = await host.reference({ surah: 1, ayah: 1 });
  assert.deepEqual([Array.from(u.units), Array.from(u.words), u.nWords], [[5, 31, 1, 6, 34], [0, 0, 0, 1, 1], 2]);
  assert.equal(await host.reference({ surah: 1, ayah: 2 }), null);
  await host.close();
  await assert.rejects(host.reference({ surah: 1, ayah: 1 }), /not open/);
});

test('through the public Model and Session: the same engine calls, one after another as a Worker runs them', { skip }, async () => {
  // a signed synthetic build whose engine files the mock accepts; its reference file is not a table the mock reads
  const b = await build3({ edit: (m) => {
    m.contexts = ['c16_l64', 'c24_l72'];
    m.files = m.files.filter((f) => !f.path.startsWith('c8_l64/'));
  } });
  const calls = [];
  const inner = localHost(factory);
  const host = { kind: 'local' };
  for (const k of Object.keys(inner)) host[k] = typeof inner[k] === 'function' ? (...a) => { calls.push(k); return inner[k](...a); } : inner[k];
  const model = await openModel({ reader: memoryReader(b.files), folder: { trustedKeys: [testKeyHex] }, seams: { host } });
  assert.deepEqual(calls.slice(0, 2), ['stage', 'warm']);
  const chunks = [];
  const s = model.session({ heads: 'all', onChunk: (c) => chunks.push(c) });
  s.push(new Float32Array(5120 * 2));
  const heads = await s.finish();
  assert.ok(chunks.length >= 5);
  assert.equal(chunks[1].heads.get('gem').values[1], 5 * 100000 + 16 * 100 + 1);
  assert.equal(chunks[1].heads.get('inter4_log_probs'), null);
  assert.equal(heads.get('log_probs').frames, 8 * chunks.length);
  assert.equal(heads.get('conf').values.length, 16 * chunks.length);
  assert.equal(chunks.at(-1).decoded.isFinal, true);
  // another context reopens the engine with its chunk length
  const t = model.session({ context: 'c24_l72' });
  t.push(new Float32Array(7680));
  const h24 = await t.finish();
  assert.equal(h24.get('log_probs').frames % 12, 0);
  // an engine error ends the take with a catalogue error
  const bad = model.session();
  bad.push(new Float32Array([NaN, 0, 0]));
  await assert.rejects(bad.finish(), (e) => e instanceof TajweedError && e.code === 'engine_failed' && /mock: bad audio/.test(e.message));
  await assert.rejects(model.reference.fetch(), (e) => e instanceof TajweedError && e.code === 'reference_missing');
  await model.close();
  assert.ok(instances >= 1);
});
