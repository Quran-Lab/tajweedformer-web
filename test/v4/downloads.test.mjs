// SPEC 16's download rule in the frame, as the native SDKs have it (Android Downloader.kt RetryPlan): a stall ends a
// request, the request is asked again inside the call from the bytes held (Range) at most five times per
// file, refusals, 429s and other statuses are asked once, and 4 MiB blocks (64 KiB here) are kept as ciphertext for the
// next call. Through the real Core: every file that opens is the signed bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller, SdkError } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';
import { QLC } from '../../sdk4/frame/core.js';

const engine = await loadEngine();
const dir = testBuild();
const skip = !engine ? 'no packaged engine (python scripts/build_web4.py engine)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;
const BLOCK = 65536;

/**
 * The fake CDN with Range and faults. plan(path, n, from) for the n-th request of a file (from: the Range start) gives
 * null (the answer) or a fault: { cut: k } (k bytes, then the connection ends), { stall: k } (k bytes, then nothing),
 * { status }, { ignoreRange: true } (200 and the whole file), { wrongRange: true } (a 206 for other bytes).
 */
function faulty(srv, plan) {
  const counts = new Map(), seen = [];
  const fetch = async (url, init = {}) => {
    if (!String(url).startsWith('https://cdn.test/models/')) return srv.fetch(url, init);
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const { range, 'if-range': ifRange, ...rest } = h;
    const r = await srv.fetch(url, { ...init, headers: rest });
    if (r.status !== 200) return r;
    const all = new Uint8Array(await r.arrayBuffer());
    const path = decodeURIComponent(new URL(url).pathname.split('/sdk/')[1].split('/').slice(1).join('/'));
    const n = (counts.get(path) || 0) + 1;
    counts.set(path, n);
    const from = range ? Number(/^bytes=(\d+)-$/.exec(range)[1]) : 0;
    seen.push({ path, n, range: range || null, ifRange: ifRange || null });
    const f = plan(path, n, from) || {};
    // a status with the CDN's JSON error (a refusal of 28.3 for a 4xx), or { page: true }: a proxy's or a firewall's page
    if (f.status) return new Response(f.page ? '<html>blocked</html>' : JSON.stringify({ error: f.status === 429 ? 'model_limit' : f.status === 404 ? 'not_found' : 'model_attestation_required' }), { status: f.status });
    let body = all, status = 200;
    const headers = { etag: '"v1"' };
    if (range && !f.ignoreRange) {
      body = all.subarray(from);
      status = 206;
      headers['content-range'] = f.wrongRange ? `bytes ${from + 1}-${all.length - 1}/${all.length}` : `bytes ${from}-${all.length - 1}/${all.length}`;
    }
    if (f.cut !== undefined || f.stall !== undefined) {
      const k = f.cut !== undefined ? f.cut : f.stall;
      const part = body.slice(0, k);
      let sent = false;
      // the k bytes, then the connection ends (an error at the next read) or nothing more ever comes
      const stream = new ReadableStream({ pull(c) {
        if (!sent) { sent = true; c.enqueue(part); return undefined; }
        if (f.cut !== undefined) { c.error(new TypeError('terminated')); return undefined; }
        return new Promise(() => {});
      } });
      return new Response(stream, { status, headers });
    }
    return new Response(body, { status, headers });
  };
  return { fetch, seen, of: (p) => seen.filter((x) => x.path === p) };
}

async function frame(srv, fetch, { kv = new MemoryKV(), files = new MemoryFiles() } = {}) {
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch, files, kv, engine,
    trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false, download: { pausesMs: [5, 10, 20, 40, 80], stallMs: 300, blockBytes: BLOCK } });
  await c.init();
  return c;
}
// the largest file of the build: the one the faults hit
const bigOf = (srv) => srv.manifest.files.filter((f) => f.context === '*' || f.context === 'c16_l64').sort((a, b) => b.size - a.size)[0];

test('a connection that ends, twice: asked again from the bytes held (Range); the file opens as the signed bytes', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const big = bigOf(srv);
  const cdn = faulty(srv, (p, n) => (p !== big.path ? null : n === 1 ? { cut: 1_000_000 } : n === 2 ? { cut: 500_000 } : null));
  const c = await frame(srv, cdn.fetch);
  const info = await c.openModel();
  assert.ok(info.tokens.length > 0);
  assert.deepEqual(cdn.of(big.path).map((x) => x.range), [null, 'bytes=1000000-', 'bytes=1500000-']);
  // no If-Range: qlab-cdn's CORS allows range but not if-range (a preflight would fail every request of the frame),
  // and a build's files never change under their URL; the SHA-256 decides
  assert.deepEqual(cdn.of(big.path).map((x) => x.ifRange), [null, null, null]);
  assert.equal(c.dl.resumes, 2);
  await c.close();
});

test('a stall: no byte for the stall time ends the request, and it goes on from the bytes held', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const big = bigOf(srv);
  const cdn = faulty(srv, (p, n) => (p === big.path && n === 1 ? { stall: 300_000 } : null));
  const c = await frame(srv, cdn.fetch);
  await c.openModel();
  assert.deepEqual(cdn.of(big.path).map((x) => x.range), [null, 'bytes=300000-']);
  await c.close();
});

test('a 5xx twice, then the file; a 206 for other bytes is asked again; a server that ignores Range is read from the start', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const big = bigOf(srv);
  const cdn = faulty(srv, (p, n) => (p !== big.path ? null : n <= 2 ? { status: 503 } : n === 3 ? { cut: 700_000 } : n === 4 ? { wrongRange: true } : n === 5 ? { cut: 100_000 } : n === 6 ? { ignoreRange: true } : null));
  const c = await frame(srv, cdn.fetch);
  await c.openModel();
  assert.deepEqual(cdn.of(big.path).map((x) => x.range), [null, null, null, 'bytes=700000-', 'bytes=700000-', 'bytes=800000-']);
  assert.equal(c.dl.resumes, 5, 'five resumes: the most one file has in a call');
  await c.close();
});

test('six failures in one file end the call; the next call goes on from the blocks kept, and drops them once the file is whole', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const big = bigOf(srv);
  let call = 1;
  const cdn = faulty(srv, (p) => (p === big.path && call === 1 ? { cut: 200_000 } : null));
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await frame(srv, cdn.fetch, { kv, files });
  await assert.rejects(a.openModel(), (e) => e instanceof SdkError && e.code === 'download_failed' && /asked 6 times/.test(e.message));
  assert.equal(cdn.of(big.path).length, 6);
  const keptBlocks = Math.floor((6 * 200_000) / BLOCK);
  const parts = (await files.list()).filter((f) => f.form === QLC.FORM_CDN && f.path.startsWith(`${big.path}.part.`));
  assert.equal(parts.length, keptBlocks, 'whole blocks kept, as ciphertext');
  await a.close();
  call = 2;
  const b = await frame(srv, cdn.fetch, { kv, files });
  await b.openModel();
  assert.equal(cdn.of(big.path)[6].range, `bytes=${keptBlocks * BLOCK}-`, 'the next call starts after the kept blocks');
  assert.equal((await files.list()).filter((f) => f.path.includes('.part.')).length, 0, 'the blocks are dropped');
  assert.equal(b.state.get(`part:${big.path}`), null);
  await b.close();
});

test('asked once and never again in the call: a 429, a 404, a refusal', { skip }, async () => {
  for (const status of [429, 404, 403]) {
    const srv = await fakeServer({ cdnDir: dir });
    const big = bigOf(srv);
    const cdn = faulty(srv, (p) => (p === big.path ? { status } : null));
    const c = await frame(srv, cdn.fetch);
    await assert.rejects(c.openModel(), (e) => e.code === 'download_failed' || e.code === 'invalid_key');
    assert.equal(cdn.of(big.path).length, 1, `${status}: one request`);
    await c.close();
  }
});

test('a 4xx that is not the CDN answer (no JSON error: a page of a proxy or a firewall) is unreachable: asked again (ENDPOINTS_40.md 28.3)', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const big = bigOf(srv);
  const cdn = faulty(srv, (p, n) => (p === big.path && n === 1 ? { status: 403, page: true } : null));
  const c = await frame(srv, cdn.fetch);
  await c.openModel();
  assert.equal(cdn.of(big.path).length, 2);
  await c.close();
});

test('kept blocks that make a file that is not the signed bytes are dropped; the next call downloads it whole', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const big = bigOf(srv);
  let call = 1;
  const cdn = faulty(srv, (p) => (p === big.path && call === 1 ? { cut: 200_000 } : null));
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await frame(srv, cdn.fetch, { kv, files });
  await assert.rejects(a.openModel());
  await a.close();
  // one kept block damaged on the device
  const p0 = `${big.path}.part.0`;
  const b0 = await files.get(QLC.FORM_CDN, p0);
  const bad = b0.slice(); bad[10] ^= 1;
  await files.put(QLC.FORM_CDN, p0, bad);
  call = 2;
  const b = await frame(srv, cdn.fetch, { kv, files });
  await assert.rejects(b.openModel(), (e) => e.code === 'checksum_mismatch');
  assert.equal((await files.list()).filter((f) => f.path.includes('.part.')).length, 0);
  await b.close();
  const c = await frame(srv, cdn.fetch, { kv, files });
  await c.openModel();
  assert.equal(cdn.of(big.path).at(-1).range, null, 'the whole file');
  await c.close();
});
