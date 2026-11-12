// R5 at the sharing pipeline (SDK 3.0.2; SPEC 11.7): recordings the stop did not delete. The restart cases of
// the shared vector, through the consent controller, are in test/sharing_restart.test.mjs; this file drives
// web/sharing itself, on both storages a Node test can run.
//
// The case: the page or process dies after the learner's "off" (or an accepted delete) was saved and before the
// queue was deleted; or the stop could not delete a recording. The rule this file asserts:
//   - a recording made before the learner's last "off" is NEVER uploaded, in the same page or after a restart,
//     also when the learner turns sharing on again;
//   - it is deleted at the next pass or start, as soon as deleting works, with sharing on or off;
//   - the off call keeps its bound when deleting fails, however many recordings there are.
//
// A "restart" is a new pipeline (a new Outbox) on the same storage. The count of consent changes is what the
// consent state would keep (`epoch`): the test raises it when the learner turns sharing off, as the controller
// would in the same write as the "off". On code without that option the option is ignored.
//
// Nine recordings, both storages a Node test can run: the folder (dirStorage) and MemoryStorage (the same
// interface as the IndexedDB storage; the Outbox's code is the same over all three).
//
import test from 'node:test';
import '../web/index.node.js';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharing, loadOpus, dirStorage, MemoryStorage, segmentName } from '../web/sharing/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const opus = have ? await loadOpus() : null;
const N = 9;
const BOUND = 3000;
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));
const UPLOAD = ['put', 'start', 'urls', 'takes'];

// Quran Lab's API and the storage as one fetch: every request is noted with the recording it is for, and answered.
function stubServer() {
  const s = { seen: [], objects: 0 };
  const res = (status, obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status });
  const urls = (id, from) => ({ id, urls: Array.from({ length: 20 }, (_, i) => from + i).map((n) => ({ n, expires_at: Math.floor(Date.now() / 1000) + 604800,
    url: `https://r2.test/v1/${id}/${segmentName(n)}.opus?X-Amz-Signature=s${n}` })) });
  s.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const kind = u.host === 'r2.test' ? 'put' : u.pathname === '/v1/uploads' ? 'start' : /\/urls$/.test(u.pathname) ? 'urls' : /\/takes$/.test(u.pathname) ? 'takes' : 'other';
    const id = kind === 'start' ? (init.headers || {})['x-qlab-id'] : (/([0-9a-f]{32})/.exec(u.pathname) || [])[1] || null;
    s.seen.push({ kind, id, bytes: kind === 'put' && init.body ? init.body.length : 0 });
    if (kind === 'start') return res(201, urls(id, 1));
    if (kind === 'urls') return res(200, urls(id, Number(u.searchParams.get('from'))));
    if (kind === 'takes') return res(200, { ok: true });
    if (kind === 'put') { s.objects++; return res(200, ''); }
    return res(404, { error: 'not_found' });
  };
  s.uploadsFor = (ids) => s.seen.filter((e) => UPLOAD.includes(e.kind) && ids.includes(e.id));
  return s;
}

// a storage whose removal of a recording can be made to fail (a file of the folder is open, the database is blocked)
function failing(real, sw) {
  const wrap = Object.create(real);
  wrap.removeSession = async (id) => { sw.tried++; if (sw.fail) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; } return real.removeSession(id); };
  return wrap;
}

async function pipeline(storage, server, st, extra = {}) {
  return createSharing({ api: 'https://api.test', fetch: server.fetch, storage, consentVersion: 'deck-1', contributor: 'c'.repeat(32),
    tokenProvider: async () => { if (st.gate) await st.gate; return { token: 't', attested: false }; },
    enabled: () => st.on, epoch: () => st.epoch, flags: () => ({ contributions: true, upload_trust: { web: 'capped' } }),
    opus: async () => opus, device: { deviceClass: 'browser', osMajor: 14 }, lifecycle: {}, log: (m) => st.logs.push(m), ...extra });
}

async function record(sharing, seconds = 3) {
  const block = Float32Array.from({ length: 16000 }, (_, i) => 0.2 * Math.sin(i / 7));
  const s = await sharing.startSession({ inputSampleRate: 16000, inputRoute: 'built_in', decode: { backend: 'exact', modelRevision: '4.0.0' } });
  for (let i = 0; i < seconds; i++) s.push(block);
  await s.finish();
  await sharing.closeRecording();
}

// the recordings on the device that still hold audio
async function withAudio(storage) {
  const out = [];
  for (const id of await storage.sessions()) if ((await storage.list(id)).some((f) => f.endsWith('.opus'))) out.push(id);
  return out;
}

// nine recordings made with sharing on, none of them uploaded (the token never comes: the device is offline)
async function nineQueued(storage) {
  const st = { on: true, epoch: 0, gate: new Promise(() => {}), logs: [] };
  const server = stubServer();
  const a = await pipeline(storage, server, st);
  for (let i = 0; i < N; i++) await record(a);
  const ids = await withAudio(storage);
  assert.equal(ids.length, N, 'nine recordings are in the queue');
  assert.equal(server.uploadsFor(ids).length, 0, 'none of them was uploaded');
  return { a, st, server, ids };
}

const drainFor = async (p, ms) => { const end = Date.now() + ms; while (Date.now() < end) { await Promise.race([p.outbox.drain({ ignoringBackoff: true }).catch(() => {}), tick(250)]); await tick(10); } };

const STORAGES = {
  'the folder (Node)': async () => { const dir = mkdtempSync(path.join(tmpdir(), 'tf-left-')); return { make: () => dirStorage(dir), done: () => rmSync(dir, { recursive: true, force: true }) }; },
  'MemoryStorage (the interface of the IndexedDB storage)': async () => { const m = new MemoryStorage(); return { make: async () => m, done: () => {} }; },
};

for (const [name, open] of Object.entries(STORAGES)) {
  test(`${name}: the process dies after the off was saved and before the queue was deleted; restart with sharing off, then on`, { skip, timeout: 120000 }, async () => {
    const box = await open();
    const facts = [];
    try {
      const { st: dead, ids } = await nineQueued(await box.make());
      // the learner turned sharing off: the consent state has it (and its count of changes), the queue was not deleted
      dead.on = false;

      // the next start, sharing still off
      const st = { on: false, epoch: 1, gate: null, logs: [] };
      const server = stubServer();
      const storage = await box.make();
      const b = await pipeline(storage, server, st);
      await tick(50);
      facts.push(`at the start, before any pass: ${(await withAudio(storage)).length} of ${N} still on the device`);
      await drainFor(b, 300);
      const afterPass = (await withAudio(storage)).length;
      facts.push(`after a pass with sharing off: ${afterPass} of ${N} still on the device, ${server.uploadsFor(ids).length} upload requests for them`);

      // the learner turns sharing on again, and records
      st.on = true;
      await b.outbox.resume().catch(() => {});
      await record(b);
      await drainFor(b, 1500);
      const sent = server.uploadsFor(ids);
      const uploadedIds = new Set(sent.map((e) => e.id));
      facts.push(`after on again: ${sent.length} upload requests for ${uploadedIds.size} of the ${N} old recordings (${sent.filter((e) => e.kind === 'put').length} PUTs of audio, ${sent.reduce((n, e) => n + e.bytes, 0)} bytes); `
        + `${server.objects - sent.filter((e) => e.kind === 'put').length} segments of the new recording went up; ${(await withAudio(storage)).filter((id) => ids.includes(id)).length} old ones still hold audio on the device`);
      console.log(`LEFT | ${name} | died before the delete | ${facts.join(' | ')}`);
      assert.equal(afterPass, 0, 'the leftover recordings are deleted at the next pass with sharing off');
      assert.equal(sent.length, 0, 'no upload request for a recording made before the off');
      assert.equal(server.objects > 0, true, 'the recording made after on again is uploaded');
    } finally { box.done(); }
  });

  test(`${name}: the stop cannot delete (nine recordings); same page on again; restart off then on; then deleting works`, { skip, timeout: 180000 }, async () => {
    const box = await open();
    const facts = [];
    try {
      const sw = { fail: true, tried: 0 };
      const { a, st, server, ids } = await nineQueued(failing(await box.make(), sw));
      // the learner turns sharing off: the delete of every recording fails
      st.on = false; st.epoch = 1;
      const t0 = Date.now();
      await a.outbox.stop().catch((e) => facts.push(`the off call failed: ${e && e.message}`));
      const took = Date.now() - t0;
      const left = (await withAudio(await box.make())).length;
      facts.push(`the off call took ${took} ms with ${N} deletes failing (${sw.tried} tries); ${left} of ${N} left on the device; ${st.logs.length} log lines`);

      // the same page: sharing on again, the token comes
      st.on = true; st.gate = null;
      await a.outbox.resume().catch(() => {});
      await drainFor(a, 1500);
      const samePage = server.uploadsFor(ids);
      facts.push(`same page, on again: ${samePage.length} upload requests for ${new Set(samePage.map((e) => e.id)).size} of the ${N} (${samePage.filter((e) => e.kind === 'put').length} PUTs of audio, ${samePage.reduce((n, e) => n + e.bytes, 0)} bytes)`);

      // a restart on the same storage (deleting still fails): off, a pass, then on
      st.on = false;
      const st2 = { on: false, epoch: 1, gate: null, logs: [] }; // the count the consent state kept
      const server2 = stubServer();
      const b = await pipeline(failing(await box.make(), sw), server2, st2);
      await drainFor(b, 300);
      st2.on = true;
      await b.outbox.resume().catch(() => {});
      await drainFor(b, 1500);
      const afterRestart = server2.uploadsFor(ids);
      facts.push(`restart, off then on: ${afterRestart.length} upload requests for ${new Set(afterRestart.map((e) => e.id)).size} of the ${N} (${afterRestart.filter((e) => e.kind === 'put').length} PUTs of audio, ${afterRestart.reduce((n, e) => n + e.bytes, 0)} bytes)`);

      // deleting works again: one pass
      sw.fail = false;
      await drainFor(b, 500);
      const gone = (await withAudio(await box.make())).filter((id) => ids.includes(id)).length;
      facts.push(`deleting works again, after a pass: ${gone} of the ${N} still hold audio on the device`);
      console.log(`LEFT | ${name} | the delete fails | ${facts.join(' | ')}`);
      assert.equal(took <= BOUND, true,`the off call returns within its bound when deleting fails (${took} ms)`);
      assert.equal(samePage.length, 0, 'same page: no upload request for a recording the stop could not delete');
      assert.equal(afterRestart.length, 0, 'after a restart: no upload request for a recording the stop could not delete');
      assert.equal(gone, 0, 'they are gone once deleting works');
    } finally { box.done(); }
  });
}
