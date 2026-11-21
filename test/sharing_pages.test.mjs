// Two pages of one site and one sharing queue. The queue is per origin (IndexedDB `quranlab-sharing`); what a page
// knows about the recording it is capturing lives in its own sharing module. So another tab of the site, or the
// sharing module of an earlier Client in the same page (the loader imports the sharing chunk anew at every create()),
// sees a recording that is being captured as a folder of files, the same as one a closed page left.
//
// Each page here is its own copy of the sharing modules: web/sharing bundled once and imported under two URLs, as
// the loader imports its chunk. Both use one storage (the origin's queue) and one lock manager (the origin's Web
// Locks; `kill` is a page that died, whose locks the browser releases).
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { loadOpus, readPages, segmentName, MemoryStorage } from '../web/sharing/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const opus = have ? await loadOpus() : null;
const API = 'https://api.test';
const TOKEN = { token: 'qlt_v1.eyJ2IjoxfQ.web', attested: false };

// web/sharing as one module file, the way the hosted sharing chunk is one
const dir = mkdtempSync(path.join(tmpdir(), 'tf-pages-'));
const bundle = path.join(dir, 'sharing.mjs');
const esbuild = createRequire(path.join(root, 'package.json'))('esbuild');
await esbuild.build({ entryPoints: [path.join(root, 'web', 'sharing', 'index.js')], outfile: bundle, bundle: true, format: 'esm',
  platform: 'neutral', target: ['es2022'], logLevel: 'error', external: ['*/dist/tajweedformer-opus.mjs'] });
const page = async (name) => import(`${pathToFileURL(bundle).href}?page=${name}`);
test.after(() => { try { unlinkSync(bundle); rmdirSync(dir); } catch (_) { /* the OS cleans its temp folder */ } });

/** The origin's lock manager (navigator.locks): exclusive locks by name, shared by every page; `of(page)` is one page's
 * view, `kill(page)` a page that died (its locks are released, as a browser does). */
function lockOrigin() {
  const held = new Map(); // name -> page
  const waiting = new Map(); // name -> [wake]
  const free = (name) => { held.delete(name); const w = waiting.get(name); if (w && w.length) w.shift()(); };
  return {
    held,
    of: (p) => ({
      async request(name, opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        while (held.has(name)) {
          if (opts && opts.ifAvailable) return cb(null);
          await new Promise((r) => { if (!waiting.has(name)) waiting.set(name, []); waiting.get(name).push(r); });
        }
        held.set(name, p);
        try { return await cb({ name, mode: 'exclusive' }); } finally { if (held.get(name) === p) free(name); }
      },
      async query() { return { held: [...held].map(([name, owner]) => ({ name, mode: 'exclusive', clientId: owner })), pending: [] }; },
    }),
    kill(p) { for (const [name, owner] of [...held]) if (owner === p) free(name); },
  };
}

/** A stub qlab-api and R2: starts, URL batches and PUTs; the objects by key. */
class Server {
  constructor() { this.objects = new Map(); this.starts = 0; this.fetch = this.fetch.bind(this); }
  urls(id, from) {
    const exp = Math.floor(Date.now() / 1000) + 604800;
    return { id, urls: Array.from({ length: 20 }, (_, i) => from + i).map((n) => ({ n, expires_at: exp,
      url: `https://r2.test/qlab-contributions/v1/${id}/${segmentName(n)}.opus?X-Amz-Signature=s${n}` })) };
  }
  async fetch(url, init = {}) {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const res = (status, obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status });
    let m;
    if (u.host === 'api.test' && u.pathname === '/v1/uploads' && init.method === 'POST') { this.starts++; return res(201, this.urls(headers['x-qlab-id'], 1)); }
    if (u.host === 'api.test' && (m = /^\/v1\/uploads\/([0-9a-f]{32})\/urls$/.exec(u.pathname))) return res(200, this.urls(m[1], Number(u.searchParams.get('from'))));
    if (u.host === 'r2.test' && init.method === 'PUT') { this.objects.set(u.pathname, new Uint8Array(init.body)); return res(200, ''); }
    return res(404, { error: 'not_found' });
  }
  /** The pages R2 holds for recording `id`, its segments in order. */
  pages(id) {
    return [...this.objects].filter(([k]) => k.includes(`/v1/${id}/`)).sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([, v]) => readPages(v));
  }
}

const noise = (n) => { const x = new Float32Array(n); let s = 7; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; x[i] = ((s >>> 8) / 16777216 - 0.5) * 0.3; } return x; };
const RATE = 48000;
const push = (take, seconds) => { const x = noise(RATE * seconds); for (let at = 0; at < x.length; at += RATE / 100) take.push(x.subarray(at, at + RATE / 100)); };

async function open(mod, { server, storage, locks }) {
  const tokenProvider = async () => TOKEN;
  tokenProvider.invalidate = async () => {};
  return mod.createSharing({ api: API, fetch: server.fetch, tokenProvider, storage, consentVersion: 'deck-1', enabled: () => true,
    flags: () => ({ contributions: true, upload_trust: { web: 'capped' }, share_join_ms: 0 }), opus: async () => opus,
    device: { deviceClass: 'browser', osMajor: 14 }, locks });
}

/** Passes in both pages until recording `id` is uploaded in `by`'s queue (or 100 rounds). */
async function settle(pages, by, id) {
  for (let i = 0; i < 100; i++) {
    for (const p of pages) await p.outbox.drain({ ignoringBackoff: true });
    const it = (await by.outbox.items()).find((x) => x.id === id);
    if (it && it.status !== 'queued') return it;
    await new Promise((r) => setTimeout(r, 5));
  }
  return (await by.outbox.items()).find((x) => x.id === id) || null;
}

const seconds = (pages) => (pages.length ? Math.max(0, pages.at(-1).granule - 312) / 48000 : 0);

test('two pages: the bundle is two copies of the sharing modules (each page knows only its own captures)', { skip }, async () => {
  const [a, b] = [await page('copy-a'), await page('copy-b')];
  assert.notEqual(a.activeCaptures, b.activeCaptures);
});

test('two pages: an upload pass in one page while the other captures leaves the take whole', { skip }, async () => {
  const [A, B] = [await page('a1'), await page('b1')];
  const server = new Server(), storage = new MemoryStorage(), origin = lockOrigin();
  const a = await open(A, { server, storage, locks: origin.of('a') });
  const b = await open(B, { server, storage, locks: origin.of('b') });
  // page A records 4 s of a take: its folder holds the session, capture.json and an open first segment
  const take = await a.startSession({ inputSampleRate: RATE, inputRoute: 'built_in', decode: { backend: 'exact', modelRevision: null } });
  push(take, 4);
  await take.io;
  const id = take.id;
  assert.ok((await storage.list(id)).includes('seg-00001.opus'));
  // page B runs a pass (its own retry, a segment of its own, the app asking for the list)
  await b.outbox.items();
  await b.outbox.drain({ ignoringBackoff: true });
  assert.equal(await storage.read(id, 'end.json'), null, 'page B did not end page A\'s recording');
  // page A records 8 s more and ends the take
  push(take, 8);
  await take.finish();
  await a.closeRecording();
  const item = await settle([a, b], a, id);
  const got = server.pages(id);
  assert.equal(item && item.status, 'uploaded');
  assert.equal(item.completed, true);
  assert.equal(got.at(-1).flags & 0x04, 0x04, 'the stream that reached R2 ends with its end of stream');
  assert.ok(Math.abs(seconds(got) - 12) < 0.05, `R2 holds ${seconds(got).toFixed(2)} s of the 12 s take`);
});

test('two pages: a pass in the other page between a new recording\'s first two files leaves it whole', { skip }, async () => {
  const [A, B] = [await page('a4'), await page('b4')];
  const server = new Server(), storage = new MemoryStorage(), origin = lockOrigin();
  // page A's writes of capture.json wait until the gate opens: its folder holds session.json alone (IndexedDB writes
  // the two files in two transactions)
  let open_ = null;
  const gate = new Promise((r) => { open_ = r; });
  const slow = Object.create(storage);
  slow.write = async (id, name, bytes) => { if (name === 'capture.json') await gate; return storage.write(id, name, bytes); };
  const a = await open(A, { server, storage: slow, locks: origin.of('a') });
  const b = await open(B, { server, storage, locks: origin.of('b') });
  const take = await a.startSession({ inputSampleRate: RATE, inputRoute: 'built_in', decode: { backend: 'exact', modelRevision: null } });
  push(take, 4);
  const id = take.id;
  for (let i = 0; i < 50 && !(await storage.list(id)).includes('session.json'); i++) await new Promise((r) => setTimeout(r, 2));
  const before = (await storage.list(id)).sort();
  assert.ok(before.includes('session.json') && !before.includes('capture.json'), before.join());
  await b.outbox.items();
  await b.outbox.drain({ ignoringBackoff: true });
  assert.deepEqual((await storage.list(id)).sort(), before, 'page B left page A\'s new recording as it was');
  open_();
  push(take, 8);
  await take.finish();
  await a.closeRecording();
  const item = await settle([a, b], a, id);
  const got = server.pages(id);
  assert.equal(item && item.status, 'uploaded');
  assert.ok(Math.abs(seconds(got) - 12) < 0.05, `R2 holds ${seconds(got).toFixed(2)} s of the 12 s take`);
});

test('two pages: a recording whose page died is recovered by the other page and uploaded', { skip }, async () => {
  const [A, B] = [await page('a2'), await page('b2')];
  const server = new Server(), storage = new MemoryStorage(), origin = lockOrigin();
  const a = await open(A, { server, storage, locks: origin.of('a') });
  const b = await open(B, { server, storage, locks: origin.of('b') });
  const take = await a.startSession({ inputSampleRate: RATE, inputRoute: 'built_in', decode: { backend: 'exact', modelRevision: null } });
  push(take, 13);
  await take.io;
  const id = take.id;
  // page A is gone mid-recording: nothing more is written, its locks go with it
  a.outbox.stopped = true;
  if (a.outbox.wakeTimer) clearTimeout(a.outbox.wakeTimer);
  a.recorder.kill();
  origin.kill('a');
  const item = await settle([b], b, id);
  assert.equal(item && item.status, 'uploaded');
  assert.equal(item.completed, false);
  const got = server.pages(id);
  assert.ok(seconds(got) > 12, `R2 holds ${seconds(got).toFixed(2)} s of the 13 s recorded`);
});

test('a page whose lock manager never answers records after CAPTURE_LOCK_WAIT_MS and uploads', { skip }, async () => {
  const [A] = [await page('a5')];
  const server = new Server(), storage = new MemoryStorage();
  const silent = { request: () => new Promise(() => {}), query: () => new Promise((r) => r({ held: [], pending: [] })) };
  const a = await open(A, { server, storage, locks: silent });
  const take = await a.startSession({ inputSampleRate: RATE, inputRoute: 'built_in', decode: { backend: 'exact', modelRevision: null } });
  const t0 = Date.now();
  push(take, 3);
  await take.finish();
  const waited = Date.now() - t0;
  await a.closeRecording();
  assert.ok(waited >= A.CAPTURE_LOCK_WAIT_MS - 50 && waited < A.CAPTURE_LOCK_WAIT_MS + 3000, `the take ended after ${waited} ms`);
  const item = await settle([a], a, take.id);
  assert.equal(item && item.status, 'uploaded');
  assert.ok(Math.abs(seconds(server.pages(take.id)) - 3) < 0.05);
});

test('a page whose lock manager refuses still records and uploads (as without locks)', { skip }, async () => {
  const [A] = [await page('a3')];
  const server = new Server(), storage = new MemoryStorage();
  const refusing = { request: () => Promise.reject(Object.assign(new Error('no locks here'), { name: 'SecurityError' })), query: () => Promise.reject(new Error('no locks here')) };
  const a = await open(A, { server, storage, locks: refusing });
  const take = await a.startSession({ inputSampleRate: RATE, inputRoute: 'built_in', decode: { backend: 'exact', modelRevision: null } });
  push(take, 3);
  await take.finish();
  await a.closeRecording();
  const item = await settle([a], a, take.id);
  assert.equal(item && item.status, 'uploaded');
  assert.ok(Math.abs(seconds(server.pages(take.id)) - 3) < 0.05);
});
