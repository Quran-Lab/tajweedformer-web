// A build's plain files as production stores them (developer report fb_f5da03d55e58a8ea, 11-23): the calibration is
// `calibration.json.gz` (encoding gzip, `decoded` calibration.json) and the self-test set is gzip under `selftest/`.
// Up to this patch the frame kept the gzip bytes under the stored path: the Core reads the plain calibration at its decoded
// path, found none, and model.calibration was null; the sample clips were looked up
// by selftest/selftest.json, which such a build does not list, and were none. Apple, Android and C inflate the plain
// gzip files to their decoded paths. Through the real Core, against the fake API and CDN serving the test build so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fakeServer, PLAIN_CLIP } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller } from '../../sdk4/frame/controller.js';
import { QLC } from '../../sdk4/frame/core.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';

const engine = await loadEngine();
const dir = testBuild();
const skip = !engine ? 'no packaged engine (python scripts/build_web4.py engine)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function load(srv, { kv = new MemoryKV(), files = new MemoryFiles() } = {}) {
  const c = (new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch, files, kv, engine,
    trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false }));
  await c.init();
  return c;
}
const asked = (srv, p) => srv.state.requests.filter((r) => r.path.endsWith(`/${p}`)).length;

test('a gzip calibration (production\'s form): model.calibration is the plain calibration.json, its SHA-256 the decoded one; stored at its decoded path', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir, plainGzip: true });
  const entry = srv.manifest.files.find((f) => f.role === 'calibration');
  assert.deepEqual([entry.path, entry.encoding, entry.decoded.path], ['calibration.json.gz', 'gzip', 'calibration.json'], 'the build stores it as production does');
  const files = new MemoryFiles();
  const c = await load(srv, { files });
  const info = await c.openModel();
  assert.ok(info.calibration, 'model.calibration is there');
  assert.equal(sha(info.calibration.text), entry.decoded.sha256, 'the plain calibration.json');
  assert.equal(info.calibration.sha256, entry.decoded.sha256, 'its SHA-256 is the decoded file\'s, as Apple, Android and C give it');
  assert.ok(JSON.parse(info.calibration.text).contexts, 'readable JSON');
  assert.equal(await files.has(QLC.FORM_PLAIN, 'calibration.json'), true, 'kept at its decoded path, where the Core reads it');
  assert.equal(await files.has(QLC.FORM_PLAIN, 'calibration.json.gz'), false, 'no gzip copy kept');
  await c.close();
  // the next start: on the device already, not asked again
  const before = asked(srv, 'calibration.json.gz');
  const d = await load(srv, { files, kv: c.o.kv });
  assert.ok((await d.openModel()).calibration);
  assert.equal(asked(srv, 'calibration.json.gz'), before, 'not downloaded again');
  await d.close();
});

test('a device 4.0.2 to 4.0.5 left with the gzip calibration under its stored path: the next open fetches the plain one and drops the gzip copy', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir, plainGzip: true });
  const files = new MemoryFiles(), kv = new MemoryKV();
  const a = await load(srv, { files, kv });
  await a.openModel();
  await a.close();
  // what those versions kept: the stored (gzip) bytes under the stored path, nothing at the decoded path
  await files.drop(QLC.FORM_PLAIN, 'calibration.json');
  await files.put(QLC.FORM_PLAIN, 'calibration.json.gz', srv.plain.files.get('calibration.json.gz'));
  const b = await load(srv, { files, kv });
  const info = await b.openModel();
  assert.ok(info.calibration, 'model.calibration is there after the update');
  assert.equal(await files.has(QLC.FORM_PLAIN, 'calibration.json.gz'), false, 'the old gzip copy dropped');
  await b.close();
});

test('gzip sample clips (production\'s self-test set): the model lists them and their samples are the decoded PCM', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir, plainGzip: true });
  const c = await load(srv);
  const info = await c.openModel();
  assert.deepEqual(info.clips.map((x) => [x.name, x.kind, x.durationMs, x.sampleRate]), [[PLAIN_CLIP.id, PLAIN_CLIP.kind, 500, 16000]]);
  const s = await c.clipSamples(PLAIN_CLIP.id);
  const pcm = gunzipSync(srv.plain.files.get(`selftest/${PLAIN_CLIP.file}.gz`));
  const samples = s.samples;
  assert.equal(samples.length, PLAIN_CLIP.samples);
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (const i of [0, 1, 100, 7999]) assert.equal(samples[i], dv.getInt16(2 * i, true) / 32768, `sample ${i}`);
  await c.close();
});
