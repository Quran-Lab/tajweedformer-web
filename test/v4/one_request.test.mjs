// SDK 4.0.2, SPEC 16.7: one request per model file. A full install of the default context against
// the stand-in server, its CDN answering as the real one does (an ETag, Accept-Ranges, 206 for an open-ended Range whose
// If-Range, if any, matches): every model file asked once, whole, with no Range, plus the manifest; then the same with
// the largest file's stream cut once: exactly one more request, an open-ended Range from the cut (with If-Range on the
// Node path, none from the frame, whose CDN CORS does not allow it); then what 4.0.1 left on the device (its kept 4 MiB
// blocks, their record without a host) completed with one request from the first byte not kept, never thrown away.
//
// On the 4.0.1 sources (4effe91) the same counts hold for the frame (9 requests; 10 with the cut; the kept blocks
// completed): web fetched each file whole from 4.0.0. Only the Node path's If-Range is new (4.0.1 sent none).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeServer } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';
import { QLC } from '../../sdk4/frame/core.js';

const engine = await loadEngine();
const dir = testBuild();
const skip = !engine ? 'no packaged engine (python scripts/build_web4.py engine)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;
const BLOCK = 4 * 1024 * 1024;
const LARGEST = 'c16_l64/layers.zfw.qle';

async function load(srv, { kv = new MemoryKV(), files = new MemoryFiles(), ifRange = false } = {}) {
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch, files, kv, engine,
    trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false, download: { pausesMs: [1, 1, 1, 1, 1], stallMs: 5000 }, ...(ifRange ? { ifRange } : {}) });
  await c.init();
  return c;
}

// the model requests (the CDN's): the file each asked for, and its Range and If-Range headers
const modelRequests = (srv) => srv.state.requests.filter((r) => r.host === 'cdn.test').map((r) => ({
  file: r.path.split('/sdk/')[1].split('/').slice(1).join('/'), range: r.headers.range || null, ifRange: r.headers['if-range'] || null }));

test('16.7 item 5: a full install asks each model file once, whole, with no Range: the files plus the manifest', { skip }, async (t) => {
  const srv = await fakeServer({ cdnDir: dir });
  srv.state.ranges = true;
  const c = await load(srv);
  await c.openModel();
  const asked = modelRequests(srv);
  const files = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).files.map((f) => f.path);
  t.diagnostic(`REQUESTS | full install | ${asked.length} model requests (${asked.length - 1} files and the manifest), ${asked.filter((a) => a.range).length} with a Range`);
  assert.deepEqual(asked.map((a) => a.file).sort(), [...files, 'manifest.json'].sort(), 'each file once, and the manifest');
  assert.equal(asked.length, 9);
  assert.ok(asked.every((a) => a.range === null && a.ifRange === null), 'no Range on a fresh install');
  await c.close();
});

for (const [where, ifRange] of [['the frame', false], ['the Node path', true]]) {
  test(`16.7 item 5: the largest file's stream cut once (${where}): one resume, from the cut, ${ifRange ? 'with' : 'without'} If-Range; the install completes`, { skip }, async (t) => {
    const srv = await fakeServer({ cdnDir: dir });
    srv.state.ranges = true;
    const at = 5 * BLOCK + 12345; // 20 MiB and a bit: five blocks kept, the rest held in memory
    srv.state.cut = { file: LARGEST, at };
    const c = await load(srv, { ifRange });
    const info = await c.openModel();
    assert.equal(info.build, srv.build);
    const asked = modelRequests(srv);
    t.diagnostic(`REQUESTS | one cut (${where}) | ${asked.length} model requests, ${asked.filter((a) => a.range).length} with a Range`);
    assert.equal(asked.length, 10, 'one more than the full install');
    const ranged = asked.filter((a) => a.range);
    assert.equal(ranged.length, 1);
    assert.equal(ranged[0].file, LARGEST);
    assert.equal(ranged[0].range, `bytes=${at}-`, 'open-ended, from the byte the cut stopped at');
    const etag = `"${(await import('node:crypto')).createHash('sha256').update(readFileSync(join(dir, LARGEST))).digest('hex').slice(0, 32)}"`;
    assert.equal(ranged[0].ifRange, ifRange ? etag : null, ifRange ? 'If-Range: the ETag of the answer that started it' : 'none from the frame (the CDN\'s CORS)');
    assert.equal(asked.filter((a) => a.file === LARGEST).length, 2);
    await c.close();
  });
}

test('16.7 item 3: what 4.0.1 left on the device (kept 4 MiB blocks, a record without a host) is completed with one request from the first byte not kept', { skip }, async (t) => {
  const srv = await fakeServer({ cdnDir: dir });
  srv.state.ranges = true;
  // 4.0.1's own layout (sdk4/frame/controller.js _keepBlock at 4effe91): `<path>.part.<n>` in the CDN form, and the
  // KV record part:<path> { size, block, n, validator }
  const bytes = readFileSync(join(dir, LARGEST));
  const files = new MemoryFiles();
  const kept = 3;
  for (let i = 0; i < kept; i++) await files.put(QLC.FORM_CDN, `${LARGEST}.part.${i}`, new Uint8Array(bytes.subarray(i * BLOCK, (i + 1) * BLOCK)));
  const kv = new MemoryKV(new Map([[`part:${LARGEST}`, { size: bytes.length, block: BLOCK, n: kept, validator: null }]]));
  const c = await load(srv, { kv, files, ifRange: true });
  const info = await c.openModel();
  assert.equal(info.build, srv.build, 'installed and opened');
  const asked = modelRequests(srv);
  t.diagnostic(`REQUESTS | 4.0.1 blocks kept | ${asked.length} model requests, ${asked.filter((a) => a.range).length} with a Range`);
  assert.equal(asked.length, 9, 'still one request per file');
  const ranged = asked.filter((a) => a.range);
  assert.deepEqual(ranged, [{ file: LARGEST, range: `bytes=${kept * BLOCK}-`, ifRange: null }], 'the blocks kept are used; a record with no host sends no If-Range (the size and SHA-256 decide)');
  assert.equal(c.state.get(`part:${LARGEST}`), null, 'the blocks dropped once the file is whole');
  assert.equal(await files.has(QLC.FORM_CDN, `${LARGEST}.part.0`), false);
  await c.close();
});
