// Model delivery (web/tajweed/delivery.js): the web profile (root files + one context, never CoreML,
// NPU or the other contexts), resumable ranges, SHA-256 checks, the content-addressed cache, a
// signed folder from a "CDN" (a local HTTP server with Range support and the x-qlab-key header), and
// the loaded model streaming one conformance clip bit for bit.
//
// The engine part needs the staged V4 files (TAJWEED_V4_ENGINE, as tajweed_conformance.test.mjs);
// the profile and cache parts run on synthetic files everywhere.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import http from 'node:http';
import { cachedReader, memoryStore, profilePaths, pruneCache, DeliveryError } from '../web/tajweed/delivery.js';
import { sha256Hex } from '../web/tajweed/manifest.js';

// A tiny HTTP server: files from a map, Range support, an optional key check, a hook to fail requests.
function serve(files, { key = null, failAfter = Infinity } = {}) {
  const log = [];
  let served = 0;
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/folder\//, ''));
    log.push({ path: p, range: req.headers.range || null });
    if (key && req.headers['x-qlab-key'] !== key) { res.writeHead(401).end(); return; }
    const b = files.get(p);
    if (!b) { res.writeHead(404).end(); return; }
    if (served++ >= failAfter) { req.socket.destroy(); return; }
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (m) {
      const lo = +m[1], hi = Math.min(+m[2], b.length - 1);
      res.writeHead(206, { 'content-range': `bytes ${lo}-${hi}/${b.length}`, 'content-length': hi - lo + 1 });
      res.end(Buffer.from(b.subarray(lo, hi + 1)));
    } else {
      res.writeHead(200, { 'content-length': b.length });
      res.end(Buffer.from(b));
    }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}/folder/`, log, close: () => new Promise((r) => srv.close(r)),
    set failAfter(n) { failAfter = n; served = 0; },
  })));
}

async function manifestFor(files, extra = {}) {
  const list = [];
  for (const [p, b] of files) if (p !== 'manifest.json') list.push({ path: p, size: b.length, sha256: await sha256Hex(b) });
  return { format: 2, model_id: 'v4.0', family: 'tajweedformer', revision: 'test', min_sdk_version: '2.0.0', engine_format: 2,
    coreml_format: 9, tokens_sha256: files.has('tokens.txt') ? await sha256Hex(files.get('tokens.txt')) : '0'.repeat(64), coreml: '-',
    sidecar: '-', keeps: '-', tokens: 'tokens.txt', files: list, ...extra };
}

test('profile: root files and the chosen context only; delivery tags when the manifest has them', async () => {
  const m = { files: ['manifest.json', 'tokens.txt', 'calibration.json', 'expected_tj3.zfx', 'c16_l64/layers.zfw', 'c16_l64/frontend.zfw',
    'c24_l72/layers.zfw', 'coreml/c16_l64/x.mlmodelc/model.mil', 'npu/tensor_g4/c16_l64.bin'].map((p) => ({ path: p })) };
  assert.deepEqual(profilePaths(m, { context: 'c16_l64' }), ['tokens.txt', 'calibration.json', 'expected_tj3.zfx', 'c16_l64/layers.zfw', 'c16_l64/frontend.zfw']);
  assert.deepEqual(profilePaths(m, { context: 'c24_l72' }), ['tokens.txt', 'calibration.json', 'expected_tj3.zfx', 'c24_l72/layers.zfw']);
  const tagged = { files: [
    { path: 'weights/int8.zfw', tags: { platform: ['cpu'], context: '*', role: 'weights' } },
    { path: 'graphs/c16_l64.zfg', tags: { platform: 'cpu', context: 'c16_l64', role: 'graph' } },
    { path: 'graphs/c24_l72.zfg', tags: { platform: 'cpu', context: 'c24_l72', role: 'graph' } },
    { path: 'coreml/model.mlmodelc/w', tags: { platform: 'apple', context: '*', role: 'coreml' } },
    { path: 'tokens.txt', tags: { platform: 'all', role: 'common' } },
  ] };
  assert.deepEqual(profilePaths(tagged, { context: 'c16_l64' }), ['weights/int8.zfw', 'graphs/c16_l64.zfg', 'tokens.txt']);
});

test('cachedReader: ranges, resume after a dropped connection, SHA-256 cache, checksum refusal, prune', async () => {
  const big = new Uint8Array(1_000_003).map((_, i) => (i * 7919) & 255);
  const files = new Map([['tokens.txt', new TextEncoder().encode('a 0\n')], ['c16_l64/layers.zfw', big]]);
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify(await manifestFor(files))));
  const srv = await serve(files, { key: 'qlk_test' });
  try {
    const store = memoryStore();
    const opts = { baseUrl: srv.url, headers: { 'x-qlab-key': 'qlk_test' }, store, rangeSize: 100_000, parallel: 2 };
    // first attempt: the connection drops after a few ranges
    srv.failAfter = 5;
    let r = cachedReader(opts);
    await r.read('manifest.json').catch(() => {});
    srv.failAfter = 6;
    await assert.rejects(() => r.read('c16_l64/layers.zfw'), (e) => e instanceof DeliveryError && e.code === 'offline');
    const partsAfterDrop = (await store.keys('part/')).length;
    assert.ok(partsAfterDrop >= 3, `ranges kept: ${partsAfterDrop}`);
    // second attempt resumes: only the missing ranges are requested
    srv.failAfter = Infinity;
    r = cachedReader(opts);
    await r.read('manifest.json');
    srv.log.length = 0;
    const got = await r.read('c16_l64/layers.zfw');
    assert.deepEqual(Buffer.compare(Buffer.from(got), Buffer.from(big)), 0);
    assert.equal(r.stats.rangesResumed, partsAfterDrop);
    assert.equal(srv.log.length, 11 - partsAfterDrop);
    assert.deepEqual(await store.keys('part/'), []);
    // third: from the cache, no request for the file
    r = cachedReader(opts);
    await r.read('manifest.json');
    srv.log.length = 0;
    await r.read('c16_l64/layers.zfw');
    assert.equal(srv.log.length, 0);
    assert.equal(r.stats.filesFromCache, 1);
    // a file that does not match its hash is refused and its ranges dropped
    files.set('c16_l64/layers.zfw', big.map((x, i) => (i === 500 ? x ^ 1 : x)));
    const r2 = cachedReader({ ...opts, store: memoryStore() });
    await r2.read('manifest.json');
    await assert.rejects(() => r2.read('c16_l64/layers.zfw'), (e) => e.code === 'checksum_mismatch');
    // prune: nothing listed by the kept manifests stays
    assert.equal(await pruneCache(store, [{ files: [] }]) > 0, true);
    assert.deepEqual(await store.keys('sha256/'), []);
  } finally { await srv.close(); }
});
