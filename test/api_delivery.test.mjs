// The Client's model delivery in the 3.0 API (SPEC 2a, 13.4, 13.5, 13.7): pinning by version, prefetch (progress in
// bytes, resumed after a cut, on any network), storage and removeModels, a first run without a network
// (needs_connection) and a later one from the cache, the reference data, and diagnose() with no Model open. SDK 4.0.2
// (NO_WAIT_40.md, section 33): nothing waits for Wi-Fi; vectors40/no_wait_40.json's web cases replayed on this path.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TajweedError } from '../web/index.js';
import { createClient, resetClientForTests } from '../web/api/client.js';
import { memoryState } from '../web/platform/storage.js';
import { memoryStore } from '../web/tajweed/delivery.js';
import { memoryDeviceKey } from '../web/tajweed/install.js';
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

test('a first run without a network is needs_connection, not a timeout; after a download the model opens offline', async () => {
  // one device: its state, its cache and its key store (3.1.0: the Client opens only what it downloaded here)
  const state = memoryState(), store = memoryStore(), installKey = memoryDeviceKey();
  resetClientForTests();
  const api = await stubPlatform({ build });
  api.state.offline = true;
  let client = await createClient({ key: KEY }, seamsFor(api, { state, store, installKey }));
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
  client = await createClient({ key: KEY }, seamsFor(api, { state, store, installKey }));
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

test('prefetch: bytes done and total, a no-op when done, resumed after a cut, on any network', async () => {
  let { client, api, seams } = await setup({}, { connection: { saveData: true } });
  // on a metered connection with the data saver on it downloads (4.0.2: no network option); progress never goes back
  // and ends at the total
  const seen = [];
  let r = await client.prefetch({ onProgress: (p) => seen.push(p) });
  assert.equal(r.complete, true);
  assert.equal(r.bytesDone, r.bytesTotal);
  const want = ['tokens.txt', 'calibration.json.gz', 'layers.zfw.gz', 'frontend.zfw', 'c16_l64/frames.zfw', 'c16_l64/model_engine2.onnx.zfg', 'selftest/selftest.json'];
  assert.equal(r.bytesTotal, want.reduce((n, p) => n + build.files[p].length, 0), 'the stored (transport) bytes of the default context\'s set');
  assert.ok(seen.length >= 2 && seen.every((p, i) => p.bytesTotal === r.bytesTotal && (i === 0 || p.bytesDone >= seen[i - 1].bytesDone)));
  assert.deepEqual(seen.at(-1), { bytesDone: r.bytesTotal, bytesTotal: r.bytesTotal });
  assert.ok(!cdnPaths(api).some((p) => /c24_l72|c8_l64|expected_tj3|\.s16|model_engine2\.onnx$/.test(p)), 'no other context, no reference table, no clips, no native-only file');
  // done: a second call fetches nothing but the manifest, and model() downloads nothing
  api.log.length = 0;
  r = await client.prefetch();
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

test('4.0.2: prefetch downloads on every connection the browser reports, and diagnose() reports it; the SDK reads it for diagnose() only', async () => {
  // the network kind from a fake of navigator.connection (the Network Information API: Chrome and Android browsers have
  // it; Safari and Firefox do not). The network itself works in every row: what the browser says never holds a request
  for (const [connection, says] of [[{ saveData: true }, 'metered'], [{ type: 'cellular' }, 'metered'], [{ metered: true }, 'metered'],
    [{ type: 'none' }, 'none'], [{ online: false }, 'none'],
    [{ type: 'wifi', saveData: false }, 'unmetered'], [{ type: 'ethernet' }, 'unmetered'],
    // the browser cannot tell: no Network Information API (null), or the API without a connection type
    [null, 'unknown'], [{ saveData: false, effectiveType: '4g' }, 'unknown']]) {
    const reads = { n: 0 };
    const seen = connection === null ? null : new Proxy(connection, { get(t, k) { reads.n++; return t[k]; } });
    const { client, api } = await setup({}, { connection: seen });
    const what = JSON.stringify(connection);
    // an older app's prefetch({ unmeteredOnly: true }) too: the option is gone and not read
    const r = await client.prefetch({ unmeteredOnly: true });
    assert.equal(r.complete, true, what);
    assert.ok(r.bytesDone > 0 && r.bytesDone === r.bytesTotal, what);
    assert.ok(cdnPaths(api).some((p) => p !== 'manifest.json'), `${what}: the model files were fetched`);
    await (await client.model()).close();
    assert.equal(reads.n, 0, `${what}: the connection was not read by prefetch() or model()`);
    assert.equal((await client.diagnose()).connection, says, what);
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
  client = await createClient({ key: KEY, appVersion: '1.0' }, seamsFor(api, { state: seams.state, store: seams.store, installKey: seams.installKey }));
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

// 4.0.2 (NO_WAIT_40.md 33.4): the cases of vectors40/no_wait_40.json that name web, on this path: the connection as the
// browser reports it (a read of it counted), the stand-in API and CDN, and what each call sends and how it ends.
// sharing_upload_metered is the sharing pipeline's (test/sharing_no_wait.test.mjs).
const NW = JSON.parse(readFileSync(new URL('./vectors40/no_wait_40.json', import.meta.url), 'utf8'));
const OTHER = NW.contexts.other;
const two = await build3({ contexts: [NW.contexts.default, OTHER] });
const newer = await build3({ contexts: [NW.contexts.default, OTHER], version: '4.1.0', salt: 1 });
const browserSays = (c) => (c.connection === 'unknown' ? null : c.connection === 'none' ? { type: 'none' }
  : { type: c.connection === 'metered' ? 'cellular' : 'wifi', effectiveType: '4g', saveData: !!c.data_saver });
for (const c of NW.cases.filter((x) => x.platforms.includes('web'))) {
  // other_context_none: this path (the 3.x Client, which no 4.0 page runs) takes a context whose shared files are cached
  // for a download in part and answers download_failed; the 4.0 frame answers needs_connection (test/v4/no_wait.test.mjs)
  const why = c.call === 'upload' ? 'the sharing pipeline: test/sharing_no_wait.test.mjs'
    : c.name === 'other_context_none' ? 'the 3.x path answers download_failed here; the 4.0 frame is test/v4/no_wait.test.mjs' : false;
  test(`no_wait_40.json ${c.name} (3.x path): ${c.about}`, { skip: why }, async () => {
    const reads = { n: 0 };
    const said = browserSays(c);
    const connection = said === null ? null : new Proxy(said, { get(t, k) { reads.n++; return t[k]; } });
    const { client, api } = await setup({ build: two }, { connection });
    try {
      if (c.on_device && c.on_device[NW.contexts.default] === 'complete') assert.equal((await client.prefetch()).complete, true);
      if (c.connection === 'none') api.state.offline = true;
      if (c.on_device && c.on_device.newer_build_offered) { api.state.build = newer; api.state.configVersion++; await client._ql.refreshConfig(); }
      const from = api.log.length;
      reads.n = 0;
      const sent = () => api.log.slice(from).filter((x) => x.host === 'cdn').map((x) => x.path);
      let err = null;
      try {
        if (c.call === 'model' || c.call === 'update') {
          const m = await client.model();
          assert.equal(m.version, c.call === 'update' ? '4.1.0' : '4.0.0');
          if (c.call === 'update') assert.ok(api.log.slice(from).some((x) => x.host === 'cdn' && x.build === newer.build && x.path !== 'manifest.json'), 'the newer build\'s files were asked for');
        } else if (c.call === 'prefetch') {
          const r = await client.prefetch();
          assert.equal(r.complete, true);
          assert.ok(sent().some((p) => p !== 'manifest.json'));
        } else if (c.call === 'session') {
          const m = await client.model();
          const mark = api.log.length;
          const s = m.session({ context: OTHER });
          s.push(audioFor([4, 4, 0, 0, 0, 0, 0, 0]));
          await s.finish();
          const asked = api.log.slice(mark).filter((x) => x.host === 'cdn').map((x) => x.path);
          assert.ok([`${OTHER}/frames.zfw`, `${OTHER}/model_engine2.onnx.zfg`].every((p) => asked.includes(p)), JSON.stringify(asked));
          assert.ok(!asked.some((p) => p.startsWith(`${NW.contexts.default}/`)), 'nothing of the default context again');
        }
      } catch (e) { err = e; }
      if (c.outcome === 'error') {
        assert.ok(err instanceof TajweedError, String(err && err.stack));
        assert.equal(err.code, c.code, `${err.code}: ${err.message}`);
        assert.equal(err.errorCause && err.errorCause.needs, c.needs);
      } else assert.equal(err, null, err && `${err.code}: ${err.message}`);
      if (c.requests === true) assert.ok(api.log.length > from, 'requests were sent');
      assert.equal(reads.n, 0, 'the connection was never read');
    } finally { await client.close(); }
  });
}
