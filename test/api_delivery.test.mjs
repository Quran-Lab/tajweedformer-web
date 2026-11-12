// The Client's model delivery in the 3.0 API (SPEC 2a, 13.4, 13.5, 13.7): download by the build's URL and report
// of the version, pinning by version, the manifest's acceptance checks as catalogue codes, prefetch (progress in
// bytes, resumed after a cut, unmetered only), storage and removeModels, a first run without a network
// (needs_connection) and a later one from the cache, no model build for this SDK (model_unavailable), the
// reference data, and diagnose() for each failure it names (checked against the shared schema).
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TajweedError, TajweedModel } from '../web/index.js';
import { createClient, resetClientForTests } from '../web/api/client.js';
import { memoryState } from '../web/platform/storage.js';
import { memoryStore } from '../web/tajweed/delivery.js';
import { validate } from './helpers/jsonschema.mjs';
import { build3, stubPlatform, seamsFor, fakeHost, audioFor, KEY, REFERENCE } from './helpers/model3.mjs';

const schema = JSON.parse(readFileSync(new URL('./vectors30/diagnosis.schema.json', import.meta.url), 'utf8'));
const build = await build3();
const code = (c) => (e) => e instanceof TajweedError && e.code === c;
// the shared schema was made before the catalogue gained model_unavailable: that one code is checked here
const valid = (report) => validate(schema, report);

async function setup(o = {}, extra = {}) {
  resetClientForTests();
  const api = await stubPlatform({ build, ...o });
  const seams = seamsFor(api, extra);
  const client = await createClient({ key: KEY, appVersion: '1.0' }, seams);
  return { api, seams, client };
}
const cdnPaths = (api) => api.log.filter((x) => x.host === 'cdn').map((x) => x.path);

test('model(): the version and the build; telemetry and register carry them; a second start comes from the cache', async () => {
  const { client, api, seams } = await setup();
  const model = await client.model();
  assert.equal(model.version, '4.0.0');
  assert.equal(model.build, build.build);
  const cfg = api.log.find((x) => x.path === '/v1/config');
  assert.match(cfg.query, /sdk=3\.0\.1/);
  assert.ok(!/model_version/.test(cfg.query), 'no pin, no model_version');
  // a take, then the day's delta: the cohort is (version, build, context, backend); the download names both
  const s = model.session();
  s.push(audioFor([3, 3, 0, 0, 0, 0, 0, 0]));
  await s.finish();
  client._ql.telemetry.seal();
  const p = client._ql.telemetry.pending().at(-1);
  assert.deepEqual([p.cohorts[0].revision, p.cohorts[0].build, p.cohorts[0].context, p.cohorts[0].backend], ['4.0.0', build.build, 'c16_l64', 'cpu']);
  assert.deepEqual([p.cohorts[0].sessions, p.cohorts[0].takes, p.cohorts[0].audio_s, p.cohorts[0].tokens], [1, 1, 0.32, { log_probs: 1, timing_log_probs: 1 }]); // the fake engine's timing head holds the same sound
  assert.deepEqual([p.downloads[0].revision, p.downloads[0].build, p.downloads[0].profile, p.downloads[0].success], ['4.0.0', build.build, 'web-cpu', 1]);
  assert.ok(p.downloads[0].bytes > 3000);
  assert.equal(p.reported, undefined);
  await client.close();
  // the same storage, a new start: only the manifest is asked for again
  resetClientForTests();
  api.log.length = 0;
  const again = await createClient({ key: KEY }, { ...seams, host: fakeHost() });
  const m2 = await again.model();
  assert.deepEqual(cdnPaths(api), ['manifest.json']);
  assert.equal(m2.build, build.build);
  await again.close();
});

test('pinning by version: model_version goes with the config request; an unavailable pin is exposed; a string that is not a version is refused', async () => {
  const other = await build3({ version: '4.1.0' });
  const { client, api } = await setup({ builds: { [other.build]: other } });
  let model = await client.model('4.1.0');
  assert.equal(model.version, '4.1.0');
  assert.equal(model.build, other.build);
  assert.match(api.log.filter((x) => x.path === '/v1/config').pop().query, /model_version=4\.1\.0/);
  assert.equal(client.pin, null);
  // the object form, and a version the server cannot serve: its normal choice, with the pin's answer exposed
  model = await client.model({ version: '9.9.9' });
  assert.equal(model.version, '4.0.0');
  assert.deepEqual(client.pin, { version: '9.9.9', status: 'unavailable' });
  model = await client.model();
  assert.equal(model.version, '4.0.0');
  assert.equal(client.pin, null);
  for (const bad of ['4.0', 'v4.0.0', '4.0.0-rc1', 'latest', 4, '04.0.0']) {
    const n = api.log.length;
    assert.throws(() => client.model(bad), code('invalid_argument'), String(bad));
    assert.equal(api.log.length, n, 'never sent');
  }
  await client.close();
});

test('the manifest\'s acceptance checks reach the app as catalogue codes', async () => {
  const cases = [
    [await build3({ version: null }), 'model_incompatible'],              // a 2.x build: no model version
    [await build3({ minSdk: '3.0.2' }), 'model_incompatible'],
    [await build3({ version: '4.0' }), 'model_invalid'],
    [await build3({ signed: false }), 'signature_invalid'],
  ];
  for (const [b, want] of cases) {
    const { client } = await setup({ build: b });
    await assert.rejects(client.model(), code(want), want);
    assert.equal((await client.diagnose()).lastError, want);
    await client.close();
    // opened as a folder, the production key is the only trusted one: the shape is checked first, then the signature
    await assert.rejects(TajweedModel.open(b.files), code(want === 'model_invalid' ? 'model_invalid' : 'signature_invalid'));
  }
  // the config names another version than the manifest signs, or another build than the bytes are
  const lying = await build3();
  let s = await setup({ build: { ...lying, manifest: { ...lying.manifest, version: '4.2.0' } } });
  await assert.rejects(s.client.model(), code('model_invalid'));
  await s.client.close();
  const swapped = await build3({ minSdk: '2.0.1' });
  s = await setup({ build: { ...swapped, build: lying.build, files: swapped.files } });
  await assert.rejects(s.client.model(), code('checksum_mismatch'));
  await s.client.close();
  // a model file changed on the way: checksum_mismatch naming the file
  const bad = await build3();
  bad.files['frontend.zfw'] = bad.files['frontend.zfw'].slice();
  bad.files['frontend.zfw'][2] ^= 1;
  s = await setup({ build: bad });
  await assert.rejects(s.client.model(), (e) => code('checksum_mismatch')(e) && /frontend\.zfw/.test(e.message));
  await s.client.close();
  // a folder with no manifest
  await assert.rejects(TajweedModel.open({}), code('model_missing'));
});

test('a first run without a network is needs_connection, not a timeout; after a download the model opens offline', async () => {
  const state = memoryState(), store = memoryStore();
  resetClientForTests();
  const api = await stubPlatform({ build });
  api.state.offline = true;
  let client = await createClient({ key: KEY }, seamsFor(api, { state, store }));
  await assert.rejects(client.model(), code('needs_connection'));
  await assert.rejects(client.prefetch(), code('needs_connection'));
  let d = await client.diagnose();
  assert.deepEqual(valid(d), []);
  assert.deepEqual([d.key, d.config, d.model, d.context, d.backend, d.lastError], [{ accepted: null, reason: null }, 'none', null, null, null, 'needs_connection']);
  // online once: the model downloads
  api.state.offline = false;
  const model = await client.model();
  assert.equal(model.version, '4.0.0');
  await client.close();
  // offline again, a new start on the same storage: the stored config and the cached files are enough
  resetClientForTests();
  api.state.offline = true;
  client = await createClient({ key: KEY }, seamsFor(api, { state, store }));
  const offline = await client.model();
  assert.equal(offline.build, build.build);
  const s = offline.session();
  s.push(audioFor([4, 4, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual((await s.finish()).greedy().map((t) => t.id), [4]);
  d = await client.diagnose();
  assert.deepEqual(valid(d), []);
  assert.deepEqual([d.key.accepted, d.config, d.model], [null, 'fresh', { version: '4.0.0', build: build.build, verified: true }]);
  // a context that was never downloaded cannot be fetched offline: the take ends with an error, typed
  const t = offline.session({ context: 'c24_l72' });
  await assert.rejects(t.finish(), (e) => e instanceof TajweedError && ['needs_connection', 'download_failed'].includes(e.code));
  await client.close();
});

test('no model build for this SDK yet: model() and prefetch() are model_unavailable, diagnose() says so, nothing loops', async () => {
  const { client, api } = await setup({ build: null });
  await assert.rejects(client.model(), (e) => code('model_unavailable')(e) && /3\.0\.1/.test(e.message));
  await assert.rejects(client.prefetch(), code('model_unavailable'));
  const d = await client.diagnose();
  assert.deepEqual(valid(d), []);
  assert.deepEqual([d.model, d.lastError, d.key.accepted, d.config], [null, 'model_unavailable', true, 'fresh']);
  assert.equal(api.log.filter((x) => x.host === 'cdn').length, 0, 'nothing is downloaded');
  assert.ok(api.log.filter((x) => x.path === '/v1/config').length <= 2, 'no retry loop: the next config refresh is the retry');
  // a later config offers a build: the next call gets it
  api.state.build = build;
  api.state.configVersion++;
  await client._ql.refreshConfig();
  assert.equal((await client.model()).version, '4.0.0');
  await client.close();
});

test('prefetch: bytes done and total, a no-op when done, resumed after a cut, unmetered only', async () => {
  let { client, api, seams } = await setup({}, { connection: { saveData: true } });
  // a metered connection and unmeteredOnly: nothing but the manifest is fetched
  let r = await client.prefetch({ unmeteredOnly: true });
  assert.equal(r.complete, false);
  assert.equal(r.bytesDone, 0);
  assert.deepEqual(cdnPaths(api), ['manifest.json']);
  // without the option it downloads; progress never goes back and ends at the total
  const seen = [];
  r = await client.prefetch({ onProgress: (p) => seen.push(p) });
  assert.equal(r.complete, true);
  assert.equal(r.bytesDone, r.bytesTotal);
  const want = ['tokens.txt', 'calibration.json.gz', 'layers.zfw.gz', 'frontend.zfw', 'c16_l64/frames.zfw', 'c16_l64/model_engine2.onnx.zfg', 'selftest/selftest.json'];
  assert.equal(r.bytesTotal, want.reduce((n, p) => n + build.files[p].length, 0), 'the stored (transport) bytes of the default context\'s set');
  assert.ok(seen.length >= 2 && seen.every((p, i) => p.bytesTotal === r.bytesTotal && (i === 0 || p.bytesDone >= seen[i - 1].bytesDone)));
  assert.deepEqual(seen.at(-1), { bytesDone: r.bytesTotal, bytesTotal: r.bytesTotal });
  assert.ok(!cdnPaths(api).some((p) => /c24_l72|c8_l64|expected_tj3|\.s16|model_engine2\.onnx$/.test(p)), 'no other context, no reference table, no clips, no native-only file');
  // done: a second call fetches nothing but the manifest, and model() downloads nothing
  api.log.length = 0;
  r = await client.prefetch({ unmeteredOnly: true });
  assert.equal(r.complete, true);
  await client.model();
  assert.deepEqual([...new Set(cdnPaths(api))], ['manifest.json']);
  // storage: one entry for the build, with the bytes held; removeModels drops them and nothing else
  let st = await client.storage();
  assert.deepEqual(st.models.map((m) => [m.version, m.build]), [['4.0.0', build.build]]);
  assert.ok(st.models[0].bytes > 3000);
  assert.equal(st.sharingQueueBytes, 0);
  seams.state.set('sharing.v1', { v: 1, consent: 'granted', consentVersion: 'x' });
  await client.removeModels();
  st = await client.storage();
  assert.deepEqual(st, { models: [], sharingQueueBytes: 0 });
  assert.equal(seams.state.get('sharing.v1').consent, 'granted', 'the consent state stays');
  await client.close();

  // a download cut in the middle resumes: the bytes already here are not fetched again
  ({ client, api, seams } = await setup());
  api.state.cutAfter = 4;                                   // the manifest and three more requests, then the network dies
  await assert.rejects(client.prefetch(), code('download_failed'));
  const before = cdnPaths(api).filter((p) => p !== 'manifest.json');
  api.state.cutAfter = null;
  api.log.length = 0;
  r = await client.prefetch();
  assert.equal(r.complete, true);
  const after = cdnPaths(api).filter((p) => p !== 'manifest.json');
  assert.ok(before.length >= 1 && after.length >= 1);
  assert.ok(!after.some((p) => before.slice(0, -1).includes(p)), 'files completed before the cut are not downloaded again');
  await client.close();
});

test('the reference data: not in the model\'s set, fetched on request, looked up by surah and ayah; a build without it gives null', async () => {
  const { client, api, seams } = await setup();
  const model = await client.model();
  const ref = model.reference;
  assert.equal(ref.isDownloaded, false);
  assert.ok(!cdnPaths(api).includes('expected_tj3.zfx.gz'), 'opening the model never downloads the table');
  await assert.rejects(ref.units(1, 1), code('reference_missing'));
  await ref.fetch();
  assert.equal(ref.isDownloaded, true);
  assert.equal(cdnPaths(api).filter((p) => p === 'expected_tj3.zfx.gz').length, 1);
  assert.deepEqual(await ref.units(1, 1), { units: REFERENCE['1:1'].units, words: REFERENCE['1:1'].words, wordCount: 2 });
  assert.deepEqual((await ref.units(112, 1)).units, REFERENCE['112:1'].units);
  await ref.fetch();
  assert.equal(cdnPaths(api).filter((p) => p === 'expected_tj3.zfx.gz').length, 1, 'once');
  for (const bad of [[0, 1], [115, 1], [1, 0], [1.5, 1], [1, 999]]) await assert.rejects(ref.units(...bad), code('invalid_argument'), String(bad));
  // the table goes to the engine as data of its own, once; the engine's file set does not hold it
  assert.equal(seams.host.calls.filter((c) => c[0] === 'loadReference').length, 1);
  assert.ok(!seams.host.calls.filter((c) => c[0] === 'stage').some((c) => c[1].includes('expected_tj3.zfx')));
  await client.close();
  // a new start: the table is in the cache, so it is there without a fetch
  resetClientForTests();
  const again = await createClient({ key: KEY }, { ...seams, host: fakeHost() });
  const m2 = await again.model();
  assert.equal(m2.reference.isDownloaded, true);
  assert.deepEqual((await m2.reference.units(1, 1)).units, REFERENCE['1:1'].units);
  await again.close();
  // a download that fails is reference_missing; a build without the table has no reference at all
  const s = await setup();
  const m3 = await s.client.model();
  s.api.state.offline = true;
  await assert.rejects(m3.reference.fetch(), code('reference_missing'));
  await s.client.close();
  const bare = await setup({ build: await build3({ reference: false }) });
  assert.equal((await bare.client.model()).reference, null);
  await bare.client.close();
});

test('diagnose(): the report for a healthy client and for each failure it names, each valid against the shared schema', async () => {
  // healthy, with a newer SDK announced
  let { client, api } = await setup({ sdkLatest: { version: '3.0.2', severity: 'recommended', url: 'https://sdk.quranlab.ai/changelog' } });
  let d = await client.diagnose();
  assert.deepEqual(Object.keys(d), ['sdk', 'key', 'config', 'model', 'context', 'backend', 'microphone', 'storage', 'lastError', 'droppedChunks', 'connection']);
  assert.deepEqual(Object.keys(d), JSON.parse(readFileSync(new URL('./vectors30/names.json', import.meta.url), 'utf8')).diagnosis.fields);
  assert.deepEqual(valid(d), []);
  assert.deepEqual(d, { sdk: { version: '3.0.1', latest: '3.0.2' }, key: { accepted: true, reason: null }, config: 'fresh', model: null, context: null, backend: null,
    microphone: 'none', storage: { models: [], sharingQueueBytes: 0 }, lastError: null, droppedChunks: 0, connection: 'unknown' });
  const model = await client.model();
  d = await client.diagnose();
  assert.deepEqual(valid(d), []);
  assert.deepEqual([d.model, d.context, d.backend], [{ version: '4.0.0', build: build.build, verified: true }, 'c16_l64', { kind: 'cpu', name: 'wasm', stage: 'cpu', reason: null }]);
  assert.equal(d.storage.models.length, 1);
  // the last error raised through the client
  assert.throws(() => client.model('nope'), code('invalid_argument'));
  await model.close();
  d = await client.diagnose();
  // a model on the device that is not open now: what a Session would run on is still known (3.0.1; it was null)
  assert.deepEqual([d.model, d.context, d.backend], [{ version: '4.0.0', build: build.build, verified: false }, 'c16_l64', { kind: 'cpu', name: 'wasm', stage: 'cpu', reason: null }]);
  assert.deepEqual(valid(d), []);
  // nothing in the report names the app, the key or a path
  assert.ok(!/qlk_|app\.example|https?:|[A-Za-z]:[\\/]/.test(JSON.stringify(d)));
  await client.close();

  // the key refused, the SDK too old for the key, the app blocked
  for (const [status, error, body, reason, last] of [[401, 'invalid_key', {}, 'invalid_key', 'invalid_key'], [403, 'sdk_too_old', { min_sdk: '3.2.0' }, 'sdk_too_old', 'sdk_too_old'],
    [403, 'app_blocked', {}, 'server_rejected', 'server_rejected']]) {
    resetClientForTests();
    api = await stubPlatform({ build });
    const json = (s, o) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
    const fetch = async (url, init) => (new URL(url).pathname === (error === 'invalid_key' ? '/v1/attest' : '/v1/register') ? json(status, { error, message: 'refused', ...body }) : api.fetch(url, init));
    client = await createClient({ key: KEY }, seamsFor(api, { fetch }));
    d = await client.diagnose();
    assert.deepEqual(valid(d), [], error);
    assert.deepEqual([d.key, d.lastError], [{ accepted: false, reason }, last], error);
    const failure = await client.model().then(() => null, (e) => e);
    assert.ok(code(last)(failure), `${error}: model() fails with ${failure && failure.code}`);
    if (error === 'sdk_too_old') { assert.match(failure.message, /needs SDK 3\.2\.0 or later; this is 3\.0\.1/); assert.match(failure.fix, /3\.2\.0/); }
    await client.close();
  }
  // a stored config that expired and no network: stale
  resetClientForTests();
  api = await stubPlatform({ build });
  let now = Date.now();
  const state = memoryState();
  client = await createClient({ key: KEY }, seamsFor(api, { state, clock: () => now }));
  await client.close();
  resetClientForTests();
  api.state.offline = true;
  now += 2 * 86400_000;
  client = await createClient({ key: KEY }, seamsFor(api, { state, clock: () => now }));
  d = await client.diagnose();
  assert.deepEqual(valid(d), []);
  assert.deepEqual([d.config, d.key.accepted], ['stale', null]);
  await client.close();
});

test('prefetch({ unmeteredOnly }): waits on a metered connection, downloads on an unmetered one and where the browser says nothing', async () => {
  // the network kind comes from a fake of navigator.connection (the Network Information API: Chrome and Android
  // browsers have it; Safari and Firefox do not, and there the connection counts as unmetered)
  for (const [connection, says, downloads] of [[{ saveData: true }, 'metered', false], [{ type: 'cellular' }, 'metered', false], [{ metered: true }, 'metered', false],
    [{ type: 'none' }, 'none', false], [{ online: false }, 'none', false],
    [{ type: 'wifi', saveData: false }, 'unmetered', true], [{ type: 'ethernet' }, 'unmetered', true],
    // the browser cannot tell: no Network Information API (null), or the API without a connection type
    [null, 'unknown', true], [{ saveData: false, effectiveType: '4g' }, 'unknown', true]]) {
    const { client, api } = await setup({}, { connection });
    assert.equal((await client.diagnose()).connection, says, JSON.stringify(connection));
    const r = await client.prefetch({ unmeteredOnly: true });
    const what = JSON.stringify(connection);
    assert.equal(r.complete, downloads, what);
    assert.equal(r.bytesDone > 0, downloads, what);
    assert.equal(cdnPaths(api).some((p) => p !== 'manifest.json'), downloads, `${what}: ${downloads ? 'the model files were fetched' : 'nothing but the manifest was fetched'}`);
    if (!downloads) assert.equal(r.bytesTotal > 0, true, 'it reports what is still to come');
    await client.close();
  }
});

test('diagnose() with no Model open reports the context and the backend a Session would run on, from the stored state', async () => {
  // a first run downloads the model; the config names the context for this app
  let { client, api, seams } = await setup({ inference: { context: 'c8_l64' } });
  let d = await client.diagnose();
  assert.deepEqual([d.model, d.context, d.backend], [null, null, null], 'nothing on the device yet');
  const model = await client.model();
  assert.equal((await client.diagnose()).context, 'c8_l64');
  await model.close();
  await client.close();
  // a later start, before the app has asked for the model: the stored manifest and the signed config know
  resetClientForTests();
  client = await createClient({ key: KEY, appVersion: '1.0' }, seamsFor(api, { state: seams.state, store: seams.store }));
  d = await client.diagnose();
  assert.deepEqual(valid(d), []);
  assert.deepEqual([d.model, d.context, d.backend], [{ version: '4.0.0', build: build.build, verified: false }, 'c8_l64', { kind: 'cpu', name: 'wasm', stage: 'cpu', reason: null }]);
  // the config no longer names a context: the manifest's default
  api.state.inference = undefined;
  api.state.configVersion++;
  await client._ql.refreshConfig();
  d = await client.diagnose();
  assert.equal(d.context, 'c16_l64');
  // the model files removed: nothing is on the device, and the report says so
  await client.removeModels();
  d = await client.diagnose();
  assert.deepEqual([d.model, d.context, d.backend], [null, null, null]);
  await client.close();
});
