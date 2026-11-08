// The shared settings vectors (test/tajweed/config_vectors.json, TAJWEED_SETTINGS.md revision 2)
// through the ENGINE's config, as TajweedFormer drives it: for each case the SDK's layers (remote block
// as received, app options, debug flag, backend) go into the engine's ZfTajweedConfig
// (TajweedFormer.engineSettings) and the engine's zf_tajweed_config_json must give the case's expected
// resolution (every key of it; numbers within 1e-9) and agree with the SDK's own resolveSettings
// field by field. Runs on the scorer module, and on the full module when it has the engine.
// Needs the built modules (npm run build:scorer; ZF_WASM_TAJWEED=1 npm run build); skipped without.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bindTajweed, sha256Hex } from '../web/tajweed/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const vectors = JSON.parse(readFileSync(path.join(root, 'test/tajweed/config_vectors.json'), 'utf8'));
const fixtureCal = JSON.parse(readFileSync(path.join(root, 'test/tajweed', vectors.calibration), 'utf8'));

// tokens.txt and a table from the scorer fixture (any valid table will do: no case scores)
function fromTar(name) {
  if (!existsSync(path.join(root, 'test/tajweed/scorer_fixture.tar.gz'))) {
    // no scorer fixture in this repository: the engine's own test model has the same two files
    return new Uint8Array(readFileSync(path.join(root, 'vendor/zipformer-sdk/tajweed/tests/data', name)));
  }
  const buf = gunzipSync(readFileSync(path.join(root, 'test/tajweed/scorer_fixture.tar.gz')));
  for (let at = 0; at + 512 <= buf.length;) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const z = h.indexOf(0);
    const n = new TextDecoder().decode(h.subarray(0, Math.min(z < 0 ? 100 : z, 100))).replace(/^\.\//, '');
    const size = parseInt(new TextDecoder().decode(h.subarray(124, 136)).replace(/\0/g, '').trim() || '0', 8);
    at += 512;
    if (n === name) return buf.slice(at, at + size);
    at += Math.ceil(size / 512) * 512;
  }
  throw new Error(`${name} not in the fixture`);
}

// the engine's run_config_vectors.py same(): every key of the expected value; numbers within 1e-9
function same(a, b, at, bad) {
  if (b !== null && typeof b === 'object' && !Array.isArray(b)) {
    if (a === null || typeof a !== 'object' || Array.isArray(a)) { bad.push(`${at}: engine ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); return; }
    for (const k of Object.keys(b)) {
      if (!(k in a)) bad.push(`${at}.${k}: missing in the engine's JSON`);
      else same(a[k], b[k], `${at}.${k}`, bad);
    }
  } else if (typeof b === 'number' && typeof a === 'number') {
    if (!(Number.isFinite(a) && Math.abs(a - b) <= 1e-9)) bad.push(`${at}: engine ${a} expected ${b}`);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    bad.push(`${at}: engine ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
  }
}

const modules = [];
const scorerPath = path.join(root, 'dist', 'tajweedformer-scorer.mjs');
if (existsSync(scorerPath)) modules.push(['scorer module', (await import(pathToFileURL(scorerPath).href)).default]);
const fullPath = path.join(root, 'dist', 'tajweedformer.mjs');
if (existsSync(fullPath)) {
  const f = (await import(pathToFileURL(fullPath).href)).default;
  const m = await f();
  if (typeof m._zft_model_open === 'function') modules.push(['full module', async () => m]);
}
if (!modules.length && process.env.REQUIRE_SCORER === '1') throw new Error('no built module with the TajweedFormer engine');

async function folder() {
  const tokens = fromTar('model/tokens.txt');
  // the fixture calibration's tokens_sha256 is the placeholder "fixture": the engine wants the real hash
  const cal = { ...fixtureCal, tokens_sha256: await sha256Hex(tokens) };
  const model = {
    'calibration.json': new TextEncoder().encode(JSON.stringify(cal)),
    'tokens.txt': tokens,
    'expected_tj3.zfx': fromTar('model/expected_tj3.zfx'),
  };
  const files = [];
  for (const [p, d] of Object.entries(model)) files.push({ path: p, size: d.length, sha256: await sha256Hex(d) });
  const manifest = { format: 2, model_id: cal.model_id, family: 'tajweedformer', revision: 'settings-vectors', min_sdk_version: '2.0.0',
    engine_format: 2, coreml_format: 9, tokens_sha256: cal.tokens_sha256, coreml: '-', sidecar: '-', keeps: '-', tokens: 'tokens.txt', files };
  return { ...model, 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)) };
}

for (const [label, factory] of modules.length ? modules : [['no module', null]]) {
  test(`settings vectors through the engine's config (${label}): ${vectors.cases.length} cases`, {
    skip: factory ? false : 'no built module with the TajweedFormer engine (npm run build:scorer)',
  }, async (t) => {
    const tf = await bindTajweed(factory, { scoreOnly: true }).load({ files: await folder(), context: fixtureCal.default_context });
    const failures = [];
    for (const c of vectors.cases) {
      tf.settings.clearApp();
      tf.settings.debug = c.debug;
      tf.settings.backend = c.backend;
      tf.setRemoteConfig(c.remote);
      tf.settings.setApp(c.app || {});
      const { engineJson, differences } = tf.engineSettings();
      const bad = [];
      same(engineJson, c.expect, '', bad);
      // and the SDK's own resolution, field by field (what score() checks before every score)
      for (const d of differences) bad.push(`sdk vs engine: ${d}`);
      if (bad.length) failures.push(`${c.name}: ${bad.slice(0, 3).join('; ')}`);
    }
    tf.free();
    t.diagnostic(`${vectors.cases.length - failures.length}/${vectors.cases.length} cases`);
    assert.deepEqual(failures, []);
  });
}
