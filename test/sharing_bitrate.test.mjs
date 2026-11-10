// SDK 2.0.1, the adaptive Opus bitrate of shared sessions: the ladder against the shared vector
// (bitrate_ladder.json, replayed case by case), which upload answers count as network failures, and the
// wiring through the real outbox and capture with a stub qlab-api and R2: a failed upload lowers the bitrate
// of the next segment a running capture opens, successes raise it again, a backed-up queue lowers it, refusals
// do not, and each segment's bitrate is in its marker and the outbox item. The stream itself at several
// bitrates is checked in sharing_ogg_append.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BitrateLadder, BITRATE_RUNGS, isNetworkFailure, createSharing, MemoryStorage, loadOpus, readPages, decodeOggOpus, markers, segmentName,
} from '../web/sharing/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const vector = JSON.parse(readFileSync(path.join(root, 'test', 'sharing', 'vectors', 'bitrate_ladder.json'), 'utf8'));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const opus = have ? await loadOpus() : null;

test('the shared vector: every case, every step', () => {
  assert.deepEqual([...BITRATE_RUNGS], vector.rungs);
  assert.equal(new BitrateLadder().bitrate, vector.start);
  let steps = 0;
  for (const c of vector.cases) {
    const lad = new BitrateLadder();
    c.steps.forEach((s, i) => {
      if (s.event === 'upload_failed') lad.uploadFailed();
      else if (s.event === 'upload_ok') lad.uploadOk(s.backlog_s);
      else if (s.event === 'segment_closed') lad.segmentClosed(s.backlog_s);
      else assert.fail(`unknown event ${s.event}`);
      assert.equal(lad.bitrate, s.expect, `${c.name}: step ${i + 1} (${s.event})`);
      steps++;
    });
  }
  assert.equal(steps, vector.cases.reduce((k, c) => k + c.steps.length, 0));
  assert.ok(vector.cases.length >= 9 && steps >= 60, `${vector.cases.length} cases, ${steps} steps`);
});

test('network failures for the ladder: no answer, 408, 5xx; never a refusal', () => {
  for (const s of [0, 408, 500, 502, 503, 504, 599]) assert.equal(isNetworkFailure(s), true, String(s));
  for (const s of [200, 201, 400, 401, 403, 404, 409, 410, 413, 425, 429]) assert.equal(isNetworkFailure(s), false, String(s));
});

// ------------------------------------------------------------------------------------------------
// the wiring, against a stub qlab-api and R2

const API = 'https://api.test';
class Server {
  constructor() {
    this.objects = new Map();
    this.put = () => null; // (k) => {status} to answer the k-th PUT
    this.start = () => null;
    this.putCount = 0;
    this.fetch = this.fetch.bind(this);
  }
  urls(id, from) {
    const exp = Math.floor(Date.now() / 1000) + 604800;
    return { id, urls: Array.from({ length: 20 }, (_, i) => from + i).map((n) => ({ n, expires_at: exp, url: `https://r2.test/v1/${id}/${segmentName(n)}.opus` })) };
  }
  async fetch(url, init = {}) {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const res = (status, obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status });
    if (u.host === 'api.test' && u.pathname === '/v1/uploads') {
      const r = this.start();
      return r ? res(r.status, r.body) : res(201, this.urls(h['x-qlab-id'], 1));
    }
    const m = /^\/v1\/uploads\/([0-9a-f]{32})\/urls$/.exec(u.pathname);
    if (m) return res(200, this.urls(m[1], Number(u.searchParams.get('from'))));
    if (u.host === 'r2.test' && init.method === 'PUT') {
      const r = this.put(++this.putCount);
      if (r) return res(r.status, '');
      this.objects.set(u.pathname, new Uint8Array(init.body));
      return res(200, '');
    }
    return res(404, { error: 'not_found' });
  }
}

const clip = new Float32Array(readFileSync(path.join(root, 'test', 'sharing', 'selftest_16k.f32')).buffer.slice(0));
/** Pushes `seconds` of the self-test clip at 16 kHz in 40 ms pieces (synchronous, as a microphone callback). */
function speak(cap, seconds, state) {
  const n = Math.round(seconds * 16000);
  for (let i = 0; i < n; i += 640) {
    const piece = new Float32Array(Math.min(640, n - i));
    for (let k = 0; k < piece.length; k++) piece[k] = clip[(state.at + k) % clip.length];
    state.at += piece.length;
    cap.push(piece);
  }
}

async function pipeline(server) {
  const tokenProvider = async () => ({ token: 'qlt_v1.eyJ2IjoxfQ.web', attested: false });
  tokenProvider.invalidate = async () => {};
  return createSharing({ api: API, fetch: server.fetch, tokenProvider, storage: new MemoryStorage(), consentVersion: 'share-2026-11-09',
    enabled: () => true, flags: () => ({ contributions: true, upload_trust: { web: 'capped' } }), opus: async () => opus,
    device: { deviceClass: 'browser', osMajor: 14 }, random: () => 0.5 });
}

test('wiring: a failed upload lowers the next segment of a running capture; three successes raise it', { skip }, async () => {
  const server = new Server();
  server.put = (k) => (k === 1 ? { status: 503 } : null); // the first PUT meets a server error
  const sharing = await pipeline(server);
  const { outbox, ladder } = sharing;
  const cap = await sharing.startSession({ inputSampleRate: 16000, inputRoute: 'built_in', decode: { backend: 'exact' } });
  const at = { at: 0 };
  const log = [];
  // 10.5 s: segment 1 (192k) closes as segment 2 opens, still at 192k (the upload has not run yet)
  speak(cap, 10.5, at);
  await cap.io;
  await outbox.drain();
  log.push(ladder.bitrate);
  assert.equal(ladder.bitrate, 96000, 'the PUT answered 503: one rung down');
  // to 30.5 s: segment 2 closes, segment 3 opens at 96k
  speak(cap, 20, at);
  await cap.io;
  await outbox.drain({ ignoringBackoff: true }); // segments 1 and 2 go up: two successes
  log.push(ladder.bitrate);
  assert.equal(ladder.bitrate, 96000, 'two successes: not yet');
  // to 70.5 s: segment 3 closes (40 s waiting: no step down), segment 4 opens at 96k; its PUT is the third success
  speak(cap, 40, at);
  await cap.io;
  await outbox.drain({ ignoringBackoff: true });
  log.push(ladder.bitrate);
  assert.equal(ladder.bitrate, 192000, 'three successes with nothing waiting: one rung up');
  // to 130.5 s: segment 4 closes, segment 5 opens at 192k; the session ends
  speak(cap, 60, at);
  assert.ok(await cap.finish() > 130000);
  for (let i = 0; i < 50; i++) {
    await outbox.drain({ ignoringBackoff: true });
    if ((await outbox.items())[0].status === 'uploaded') break;
  }
  const [item] = await outbox.items();
  assert.equal(item.status, 'uploaded');
  assert.deepEqual(item.segmentBitrates, [192000, 192000, 96000, 96000, 192000], 'the outbox item lists each segment\'s bitrate');
  const ms = await markers(sharing.storage, cap.id);
  assert.deepEqual(ms.map((m) => m.bitrate), item.segmentBitrates, 'each marker holds its segment\'s bitrate');
  // what R2 received is one valid stream of the whole session
  const keys = [...server.objects.keys()].sort();
  const all = new Uint8Array(Buffer.concat(keys.map((k) => server.objects.get(k))));
  const pages = readPages(all);
  pages.forEach((p, i) => assert.equal(p.sequence, i));
  assert.equal(decodeOggOpus(opus, pages).length, Math.round(130.5 * 48000), 'decodes to the whole session');
  const kbps = keys.map((k, i) => (server.objects.get(k).length * 8) / [10, 20, 40, 60, 0.5][i] / 1000);
  assert.ok(kbps[2] < kbps[1] * 0.75 && kbps[3] < kbps[1] * 0.75, `96k segments are smaller per second: ${kbps.map((x) => x.toFixed(0)).join(', ')}`);
  console.log(`# wiring: ladder after each phase ${log.join(', ')}; segments ${item.segmentBitrates.join(', ')} bit/s; ${kbps.map((x) => x.toFixed(1)).join(', ')} kbit/s`);
});

test('wiring: a backed-up queue (120 s waiting) lowers the next segment; refusals and volume limits do not', { skip }, async () => {
  const server = new Server();
  // the server refuses for the day: nothing goes up, nothing is a network failure
  server.start = () => ({ status: 429, body: { error: 'volume_limit', message: 'tomorrow' } });
  const sharing = await pipeline(server);
  const { outbox, ladder } = sharing;
  const cap = await sharing.startSession({ inputSampleRate: 16000, inputRoute: 'built_in', decode: { backend: 'exact' } });
  const at = { at: 0 };
  const seen = [];
  for (const s of [10.2, 20, 40, 60, 20]) {
    speak(cap, s, at);
    seen.push({ backlog: Math.round(outbox.backlogSeconds()), bitrate: ladder.bitrate });
    await cap.io;
    await outbox.drain({ ignoringBackoff: true });
  }
  await cap.finish();
  // backlog when each segment closed: 10, 30, 70, 130 (>= 120: one rung down before segment 5 opens)
  assert.deepEqual(seen.slice(0, 4).map((x) => x.backlog), [10, 30, 70, 130]);
  const ms = await markers(sharing.storage, cap.id);
  assert.deepEqual(ms.map((m) => m.bitrate), [192000, 192000, 192000, 192000, 96000]);
  // the last segment closed with 150 s waiting: one more rung for the next session; the 429s changed nothing
  assert.equal(Math.round(outbox.backlogSeconds()), 150);
  assert.equal(ladder.bitrate, 64000, '429 volume_limit is not a network failure');
  // a 403 on a PUT (an expired URL) and a 400 are refusals: no step down
  const s2 = new Server();
  s2.put = (k) => (k === 1 ? { status: 403 } : k === 2 ? { status: 400 } : null);
  const p2 = await pipeline(s2);
  const c2 = await p2.startSession({ inputSampleRate: 16000, inputRoute: 'built_in', decode: { backend: 'exact' } });
  speak(c2, 12, { at: 0 });
  await c2.finish();
  for (let i = 0; i < 5; i++) await p2.outbox.drain({ ignoringBackoff: true });
  assert.equal(p2.ladder.bitrate, 192000);
  assert.ok(s2.putCount >= 2);
  // a new pipeline (a new page) starts at the top again
  assert.equal((await pipeline(new Server())).ladder.bitrate, 192000);
});

test('a killed capture: recovery closes the open segment with the bitrate it was opened at', { skip }, async () => {
  const server = new Server();
  // the first PUT finds no connection
  server.fetch =((f) => async (url, init) => { if (init && init.method === 'PUT' && server.putCount === 0) { server.putCount++; throw new TypeError('fetch failed'); } return f(url, init); })(server.fetch);
  const sharing = await pipeline(server);
  const cap = await sharing.startSession({ inputSampleRate: 16000, inputRoute: 'built_in', decode: { backend: 'exact' } });
  const at = { at: 0 };
  speak(cap, 10.5, at);
  await cap.io;
  await sharing.outbox.drain();
  assert.equal(sharing.ladder.bitrate, 96000, 'no connection on the PUT: one rung down');
  speak(cap, 25, at); // segment 2 closes at 30 s, segment 3 opens at 96k and runs 5.5 s
  await cap.io;
  // the page is closed here: what storage holds at this moment, recovered by the next load
  const disk = sharing.storage.snapshot();
  const { recover } = await import('../web/sharing/index.js');
  assert.equal(await recover(disk, cap.id), true);
  const ms = await markers(disk, cap.id);
  assert.deepEqual(ms.map((m) => m.n), [1, 2, 3]);
  assert.deepEqual(ms.map((m) => m.bitrate), [192000, 192000, 96000], 'the open segment keeps the bitrate it was opened at');
  await cap.abort();
});
