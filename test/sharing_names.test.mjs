// SDK 4.0.2: one sharing database per `storage` name (quranlab-sharing for the default name, quranlab-sharing.<name>
// for another), and what becomes of the recordings a named Client queued in the one database of 4.0.0 and 4.0.1.
//
// The rule (CHANGELOG 4.0.2): the default name's queue leaves alone every recording whose session names the contributor
// id of another storage name of the site (never deleted for its consent stamp, uploaded, listed, expired or deleted by
// an "off" of the default name), and a named Client, at each page start, moves its own recordings (its contributor id)
// from the old database into its own, the files first and the old folder after, then judges them by its own rules. A
// recording whose contributor id is no current name's stays the default name's, as before. The web's real pipeline
// (createSharing, the outbox, real libopus) on memory storages here; the browser's IndexedDB in
// test/sharing_browser.test.mjs.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharing, MemoryStorage, loadOpus, adoptRecordings, sharingDbName, namedContributors, SHARING_DB, segmentName, activeCaptures, resetSharingForTests } from '../web/sharing/index.js';
import { clipSeconds } from './sharing_stream_checks.mjs';
import { startSharing } from '../sdk4/loader/sharing.js';
import { memoryState } from '../web/platform/storage.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const opus = have ? await loadOpus() : null;
const DEF = 'd'.repeat(32), KIDS = 'a'.repeat(32);

// the stand-in API and R2; `down`: no answer at all
function server() {
  const s = { down: false, starts: [], puts: 0 };
  s.fetch = async (url, init = {}) => {
    if (s.down) throw new TypeError('fetch failed');
    const u = new URL(url);
    const res = (status, obj) => new Response(JSON.stringify(obj), { status });
    const urls = (id, from) => ({ id, urls: Array.from({ length: 20 }, (_, i) => from + i).map((n) => ({ n, expires_at: Math.floor(Date.now() / 1000) + 604800, url: `https://r2.test/v1/${id}/${segmentName(n)}.opus` })) });
    if (u.pathname === '/v1/uploads') { s.starts.push(init.headers['x-qlab-id']); return res(201, urls(init.headers['x-qlab-id'], 1)); }
    const m = /^\/v1\/uploads\/([0-9a-f]{32})\/urls$/.exec(u.pathname);
    if (m) return res(200, urls(m[1], Number(u.searchParams.get('from'))));
    if (u.host === 'r2.test' && init.method === 'PUT') { s.puts++; return new Response('', { status: 200 }); }
    return res(404, { error: 'not_found' });
  };
  return s;
}

const pipeline = (storage, srv, contributor, epoch, extra = {}) => createSharing({ api: 'https://api.test', fetch: srv.fetch, tokenProvider: async () => ({ token: 't', attested: false }),
  storage, consentVersion: 'deck-1', contributor, enabled: () => true, epoch: () => epoch, flags: () => ({ contributions: true, upload_trust: { web: 'capped' } }),
  opus: async () => opus, device: { deviceClass: 'browser', osMajor: 14 }, locks: null, lifecycle: { document: null, window: null }, log: () => {}, ...extra });

// a 3 s recording queued by a page of `contributor` under consent count `epoch`, with no network, put into `into` as
// 4.0.1 left it (made in a storage of its own: a 4.0.1 pipeline over the one database deletes the other name's at its scan)
async function queued(into, contributor, epoch) {
  const storage = new MemoryStorage();
  const srv = server();
  srv.down = true;
  const p = await pipeline(storage, srv, contributor, epoch);
  const t = await p.startSession({ inputSampleRate: 48000, inputRoute: 'built_in', decode: { backend: 'exact', modelRevision: '4.1.0' } });
  const id = t.id;
  const pcm = clipSeconds(48000, 3);
  for (let i = 0; i < pcm.length; i += 960) t.push(pcm.subarray(i, i + 960));
  await t.finish({ completed: true });
  await p.closeRecording();
  await p.recorder.settled();
  activeCaptures.delete(id);
  for (const n of await storage.list(id)) await into.write(id, n, await storage.read(id, n));
  return id;
}

async function drained(p) {
  for (let i = 0; i < 20; i++) await p.outbox.drain({ ignoringBackoff: true });
  return p.outbox.items();
}

test('the database of a storage name', () => {
  assert.equal(SHARING_DB, 'quranlab-sharing');
  for (const v of [undefined, null, '']) assert.equal(sharingDbName(v), 'quranlab-sharing');
  assert.equal(sharingDbName('kids'), 'quranlab-sharing.kids');
  assert.equal(sharingDbName('a.b_c-1'), 'quranlab-sharing.a.b_c-1');
});

test('the other names\' contributor ids, from the page\'s storage as the Client keeps them', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const kv = new Map([['quranlab.contributor', JSON.stringify(DEF)], ['quranlab.kids.contributor', JSON.stringify(KIDS)],
    ['quranlab.a.b.contributor', JSON.stringify('b'.repeat(32))], ['quranlab.bad.contributor', JSON.stringify('not hex')], ['other.x.contributor', JSON.stringify('c'.repeat(32))],
    ['quranlab.kids.sharing.v1', '{}']]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return kv.size; }, key: (i) => [...kv.keys()][i] ?? null, getItem: (k) => kv.get(k) ?? null } });
  try { assert.deepEqual([...namedContributors()].sort(), [KIDS, 'b'.repeat(32)].sort()); } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
  }
  assert.deepEqual([...namedContributors()], [], 'none where there is no localStorage');
});

test('4.0.0 and 4.0.1 left a named Client\'s recording in the default name\'s database: the default name leaves it alone; the named Client takes it and uploads it', { skip, timeout: 300_000 }, async () => {
  // the device as 4.0.1 left it: one database; kids queued a recording under its count 1, the default name one under 2
  const legacy = new MemoryStorage();
  const kid = await queued(legacy, KIDS, 1);
  const own = await queued(legacy, DEF, 2);
  // 4.0.1's reading, for the record: a pipeline that knows nothing of other names deletes kids' recording at its first
  // scan (its stamp is not this name's count), and an "off" here deleted it too
  const copy = new MemoryStorage();
  for (const id of [kid, own]) for (const n of await legacy.list(id)) await copy.write(id, n, await legacy.read(id, n));
  const old = await pipeline(copy, server(), DEF, 3);
  await old.outbox.items();
  assert.deepEqual(await copy.sessions(), [], '4.0.1: both gone at the first scan');

  // 4.0.2, the default name (count 3 now): kids' recording is left alone; its own outdated one goes as before
  const srv = server();
  const def = await pipeline(legacy, srv, DEF, 3, { others: () => new Set([KIDS]) });
  const items = await drained(def);
  assert.deepEqual(items, [], 'not listed, not uploaded');
  assert.deepEqual(await legacy.sessions(), [kid], 'kids\' recording stays; the default name\'s outdated one is deleted');
  assert.equal(srv.starts.length, 0);
  // the default name's learner turns sharing off: its queue goes, kids' stays
  await def.stop();
  assert.deepEqual(await legacy.sessions(), [kid]);

  // the next page under the name kids: it takes its recording into its own database, whole, then uploads it there
  const named = new MemoryStorage();
  const files = Object.fromEntries(await Promise.all((await legacy.list(kid)).map(async (n) => [n, Buffer.from(await legacy.read(kid, n)).toString('base64')])));
  // a recording another page is capturing (its lock is held) waits for a later start
  assert.deepEqual(await adoptRecordings(legacy, named, KIDS, { locks: { held: async () => new Set([kid]) } }), []);
  assert.deepEqual(await adoptRecordings(legacy, named, KIDS, { locks: null }), [kid]);
  assert.deepEqual(await legacy.sessions(), []);
  assert.deepEqual(Object.fromEntries(await Promise.all((await named.list(kid)).map(async (n) => [n, Buffer.from(await named.read(kid, n)).toString('base64')]))), files, 'every file, byte for byte');
  assert.deepEqual(await adoptRecordings(legacy, named, DEF, { locks: null }), [], 'another contributor\'s are not taken');
  const srv2 = server();
  const kids = await pipeline(named, srv2, KIDS, 1);
  const up = await drained(kids);
  assert.deepEqual(up.map((x) => [x.id, x.status]), [[kid, 'uploaded']]);
  assert.deepEqual(srv2.starts, [kid]);
});

test('the Client of a storage name opens its own database; a named Client looks in the old one for its own recordings, the default Client never opens another', { timeout: 60_000 }, async () => {
  // a browser's IndexedDB that answers no open (each name asked is kept): what the consent wiring asks for, by name
  const had = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const opened = [];
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open(name) { opened.push(name); const r = {}; setTimeout(() => { r.error = new Error('stub'); if (r.onerror) r.onerror(); }, 0); return r; } } });
  try {
    for (const [storage, want] of [['kids', ['quranlab-sharing', 'quranlab-sharing.kids']], [null, ['quranlab-sharing']]]) {
      opened.length = 0;
      resetSharingForTests(); // a new page: its pipeline is made anew
      const state = memoryState();
      state.set('contributor', KIDS);
      // the learner's answer changed since the queue was last known clean: the page's start looks at the queue
      state.set('sharing.v1', { v: 1, consent: 'granted', consentVersion: 'deck-1', changes: 1 });
      const s = await startSharing({ key: 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa', storage, state, apiUrl: 'https://api.test', fetch: async () => { throw new TypeError('offline'); }, origin: 'https://app.example', bundleId: 'https://app.example' });
      assert.equal(s.link.sharingDb, storage ? `quranlab-sharing.${storage}` : 'quranlab-sharing');
      await s.ctl.loadRetried;
      assert.deepEqual([...new Set(opened)].sort(), want.sort(), String(storage));
    }
  } finally {
    if (had) Object.defineProperty(globalThis, 'indexedDB', had); else delete globalThis.indexedDB;
  }
});

test('a pass of the named Client while its recording is on its way from the old database leaves the half-moved folder alone; it uploads once it is whole', { skip, timeout: 300_000 }, async () => {
  const legacy = new MemoryStorage();
  const kid = await queued(legacy, KIDS, 1);
  // the named database stops after the move's first file (a slow store): the folder holds one file of several
  const inner = new MemoryStorage();
  const gate = { writes: 0, open: null, paused: null };
  gate.wait = new Promise((r) => { gate.open = r; });
  const pausedAt = new Promise((r) => { gate.paused = r; });
  const named = Object.create(inner);
  named.write = async (id, name, bytes) => { await inner.write(id, name, bytes); if (++gate.writes === 1) { gate.paused(); await gate.wait; } };
  const move = adoptRecordings(legacy, named, KIDS, { locks: null });
  await pausedAt;
  // a pass now (another take of this page, its load's retry): it neither recovers nor deletes the half-moved folder
  const srv = server();
  const kids = await pipeline(named, srv, KIDS, 1);
  assert.deepEqual(await kids.outbox.items(), []);
  await kids.outbox.drain({ ignoringBackoff: true });
  assert.deepEqual(await inner.sessions(), [kid], 'the folder is still there');
  assert.equal(srv.starts.length, 0);
  gate.open();
  assert.deepEqual(await move, [kid]);
  const up = await drained(kids);
  assert.deepEqual(up.map((x) => [x.id, x.status]), [[kid, 'uploaded']]);
});
