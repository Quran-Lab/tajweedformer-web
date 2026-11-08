// The V4 public API without the engine: load a synthetic signed folder, settings through the model,
// heads layout, and the typed engine-not-available error everywhere the engine is needed.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as api from '../web/tajweed/index.js';
import { v4Folder, opts } from './tajweed/folder.mjs';

const { TajweedFormer, bindTajweed, EngineNotAvailableError, TajweedSettingsError, ModelFolderError,
  HEAD_SPECS, checkHeads, joinHeads, contextChunkMs, checkOf } = api;

const { files } = await v4Folder();
const load = (o = {}) => TajweedFormer.load({ files, ...opts, loadEngine: false, ...o });
const notAvailable = (e) => e instanceof EngineNotAvailableError && e.code === 'engine_not_available';

function fakeHeads(n40, drop = []) {
  const h = { n40, n20: 2 * n40, vocab: 38 };
  for (const s of HEAD_SPECS) {
    const n = (s.rate === 40 ? n40 : 2 * n40) * s.width;
    h[s.key] = drop.includes(s.name) ? null : Float32Array.from({ length: n }, (_, i) => i + n40 * 1000);
  }
  return h;
}

test('every name the type declarations promise is exported by the pure-JS entry', () => {
  const dts = readFileSync(fileURLToPath(new URL('../web/tajweed/index.d.ts', import.meta.url)), 'utf8');
  const names = [...dts.matchAll(/export declare (?:const|function|class) (\w+)/g)].map((m) => m[1]);
  assert.ok(names.length > 40, `${names.length} declared names`);
  for (const n of names) assert.ok(n in api, `${n} is declared but not exported`);
});

test('load without the engine: folder verified, info, presets, effective settings', async () => {
  const tf = await load();
  const info = tf.info;
  assert.equal(info.modelId, 'v4.0');
  assert.equal(info.family, 'tajweedformer');
  assert.equal(info.engineFormat, 2);
  assert.equal(info.signed, true);
  assert.equal(info.context, 'c16_l64');
  assert.equal(info.chunkMs, 320);
  assert.equal(info.engine, 'none');
  assert.deepEqual(info.contexts, ['c16_l64', 'c24_l72']);
  assert.deepEqual(tf.presets.map((p) => p.name), ['strict', 'balanced', 'sensitive', 'very_sensitive']);
  assert.equal(tf.presets[1].siteFa, 0.01);
  assert.equal(tf.tokenName(0), '<blk>');
  assert.equal(tf.tokenName(38), null);
  const e = tf.effectiveSettings();
  assert.equal(e.preset, 'balanced');
  assert.equal(e.sites.cons_sub.source, 'calibration');
});

test('load with the engine: EngineNotAvailableError (this build has none), after the folder is verified', async () => {
  await assert.rejects(TajweedFormer.load({ files, ...opts }), notAvailable);
  // a module without the V4 exports (the 1.x build) is not an engine either; the factory runs once
  let made = 0;
  const Bound = bindTajweed(async () => { made++; return { _malloc() {} }; });
  await assert.rejects(Bound.load({ files, ...opts }), notAvailable);
  await assert.rejects(Bound.load({ files, ...opts }), notAvailable);
  assert.equal(made, 1);
  // a bad folder fails as a folder, before the engine is looked at
  const bad = await v4Folder({ edit: (m) => { m.min_sdk_version = '3.0.0'; } });
  await assert.rejects(TajweedFormer.load({ files: bad.files, ...opts }), (e) => e instanceof ModelFolderError && e.code === 'sdk_too_old');
});

test('engine entry points throw EngineNotAvailableError, arguments checked first', async () => {
  const tf = await load();
  assert.throws(() => tf.createStream(), notAvailable);
  assert.throws(() => tf.createStream({ sampleRate: 48000, onChunk() {} }), notAvailable);
  assert.throws(() => tf.ayahCount(1), notAvailable);
  assert.throws(() => tf.expected(1, 1), notAvailable);
  await assert.rejects(tf.score(fakeHeads(8), 1, 1), notAvailable);
  await assert.rejects(tf.score(fakeHeads(8, ['inter4_log_probs', 'conf']), 2, 255), notAvailable);
  await assert.rejects(tf.score(fakeHeads(8), 115, 1), RangeError);
  await assert.rejects(tf.score(fakeHeads(8), 1, 0), RangeError);
  await assert.rejects(tf.score(fakeHeads(8, ['log_probs']), 1, 1), TypeError);
});

test('context: app beats remote beats calibration, fixed at load; invalid app context throws', async () => {
  assert.equal((await load({ context: 'c24_l72' })).info.chunkMs, 480);
  assert.equal((await load({ remote: { v: 1, context: 'c24_l72' } })).context, 'c24_l72');
  assert.equal((await load({ remote: { v: 1, context: 'c24_l72' }, context: 'c16_l64' })).context, 'c16_l64');
  assert.equal((await load({ remote: { v: 1, context: 'c16_l256' } })).context, 'c16_l64'); // dropped
  await assert.rejects(load({ context: 'c16_l256' }), (e) => e instanceof TajweedSettingsError && e.code === 'invalid_app_option');
  await assert.rejects(load({ settings: { preset: 'loud' } }), TajweedSettingsError);
});

test('presets, per-class overrides, checks and the remote block through the model', async () => {
  const tf = await load({ settings: { preset: 'strict', overrides: { cons_sub: { threshold: -1.5 } } } });
  let e = tf.effectiveSettings();
  assert.equal(e.preset, 'strict');
  assert.equal(e.sites.cons_sub.threshold, -1.5);
  assert.equal(e.sites.cons_sub.source, 'app');
  assert.equal(e.sites.vowel_sub.source, 'app'); // the app preset beats remote per-class overrides
  const dropped = tf.setRemoteConfig({ tajweed: { v: 1, preset: 'sensitive', checks: { qalqalah: true, lazim: true }, bogus: 1 } });
  assert.deepEqual(dropped, ['remote.bogus']);
  e = tf.effectiveSettings();
  assert.equal(e.preset, 'strict');
  assert.equal(e.qalqalah.enabled, true);
  assert.deepEqual(e.refused, ['remote:lazim']); // the portal can never turn on an "off" item
  tf.settings.setPreset(null);
  assert.equal(tf.effectiveSettings().preset, 'sensitive');
  tf.settings.setClassPreset('vowel_ins', 'very_sensitive').setCheck('vowels', true);
  assert.equal(tf.effectiveSettings().sites.vowel_ins.enabled, true);
  assert.equal(tf.setRemoteConfig('not json').length, 1); // never throws
});

test('"off" checks: refused in a release build, allowed for app code in a debug build', async () => {
  const rel = await load({ settings: { checks: { letters: true, lazim: true } } });
  assert.equal(rel.effectiveSettings().sites.insertion.enabled, false);
  assert.deepEqual(rel.effectiveSettings().refused, ['app:insertion', 'app:lazim']);
  const dbg = await load({ settings: { checks: { letters: true, lazim: true } }, debug: true });
  assert.equal(dbg.effectiveSettings().sites.insertion.enabled, true);
  assert.equal(dbg.effectiveSettings().lazim.enabled, true);
  assert.deepEqual(dbg.effectiveSettings().refused, []);
});

test('heads: the README_heads layout, checkHeads and joinHeads', () => {
  assert.deepEqual(HEAD_SPECS.map((s) => s.name), ['log_probs', 'inter1_log_probs', 'inter4_log_probs', 'id_log_probs',
    'timing_log_probs', 'gem', 'attr_tafkheem', 'attr_ghunna', 'attr_qalqalah', 'attr_face', 'boundary', 'conf']);
  const a = fakeHeads(8), b = fakeHeads(12, ['conf']);
  checkHeads(a);
  const j = joinHeads([a, b]);
  assert.equal(j.n40, 20);
  assert.equal(j.n20, 40);
  assert.equal(j.logProbs.length, 20 * 38);
  assert.equal(j.gem.length, 40 * 2);
  assert.equal(j.boundary.length, 40);
  assert.equal(j.conf, null);
  assert.equal(j.logProbs[8 * 38], b.logProbs[0]);
  checkHeads(j);
  assert.throws(() => checkHeads({ ...a, gem: new Float32Array(3) }), /gem/);
  assert.throws(() => checkHeads({ ...a, n20: 15 }), /n20/);
  assert.throws(() => checkHeads({ ...a, logProbs: Array.from(a.logProbs) }), /Float32Array/);
  assert.equal(contextChunkMs('c16_l64'), 320);
  assert.equal(contextChunkMs('c24_l72'), 480);
  assert.equal(contextChunkMs('x'), 0);
  assert.equal(checkOf('cons_del'), 'letters');
  assert.equal(checkOf('ghunna'), null);
});
