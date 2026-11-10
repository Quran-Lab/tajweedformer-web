// Shared sessions end to end against a stub qlab-api and R2 (fetch injected), ported from the Swift
// SDK's SharingTests plus PLATFORM_CLIENT.md sections 8 to 10 for the web: the start (the session
// JSON, closed schema), segments PUT straight to R2 on their own presigned URLs, the next batch at 5
// left, fresh URLs on a 403, offline and relaunch, a page closed mid-session, sharing turned off,
// refusals, the capped tier (Turnstile, segment cap), 7-day expiry, one PUT at a time in segment order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSharing, MemoryStorage, dirStorage, loadOpus, readPages, decodeOggOpus, segmentName, MAX_AGE_MS,
} from '../web/sharing/index.js';
// Swift SharingCodecTests.noise: a 64-bit LCG, the top 24 bits of the state
function noise(n, seed = 1n, gain = 0.3) {
  let s = BigInt(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    out[i] = Math.fround((Number(s >> 40n) / 16777216 * 2 - 1) * Math.fround(gain)); // Float arithmetic, as Swift
  }
  return out;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const opus = have ? await loadOpus() : null;
const API = 'https://api.test';
const ATT = { token: 'qlt_v1.eyJ2IjoxfQ.att', attested: true };
const UNATT = { token: 'qlt_v1.eyJ2IjoxfQ.web', attested: false };

/** A stub qlab-api and R2. Each batch's URLs carry X-Amz-Signature=b<batch>-<n>. */
class Server {
  constructor({ batch = 20, expiresIn = 604800 } = {}) {
    this.batch = batch;
    this.expiresIn = expiresIn;
    this.down = false;
    this.seen = [];
    this.objects = new Map();
    this.batches = 0;
    this.start = () => null; // (k) => {status, body} to refuse the k-th start
    this.put = () => null; // (k) => {status, text}
    this.urlsReply = () => null;
    this.putCount = 0;
    this.startCount = 0;
    this.parallel = 0;
    this.maxParallel = 0;
    this.putDelay = 0;
    this.fetch = this.fetch.bind(this);
  }
  urls(id, from) {
    const b = ++this.batches;
    const exp = Math.floor(Date.now() / 1000) + this.expiresIn;
    return { id, urls: Array.from({ length: this.batch }, (_, i) => from + i).map((n) => ({ n, expires_at: exp,
      url: `https://r2.test/qlab-contributions/v1/${id}/${segmentName(n)}.opus?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=604800&X-Amz-SignedHeaders=content-type%3Bhost&X-Amz-Signature=b${b}-${n}` })) };
  }
  async fetch(url, init = {}) {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body;
    const rec = { method: init.method || 'GET', path: u.pathname, search: u.search, headers, body };
    this.seen.push(rec);
    if (this.down) throw new TypeError('fetch failed (offline)');
    const res = (status, obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status });
    if (u.host === 'api.test' && u.pathname === '/v1/uploads' && rec.method === 'POST') {
      const k = ++this.startCount;
      const r = this.start(k, rec);
      if (r) return res(r.status, r.body);
      return res(201, this.urls(headers['x-qlab-id'], 1));
    }
    let m;
    if (u.host === 'api.test' && (m = /^\/v1\/uploads\/([0-9a-f]{32})\/urls$/.exec(u.pathname))) {
      const r = this.urlsReply(rec);
      if (r) return res(r.status, r.body);
      return res(200, this.urls(m[1], Number(u.searchParams.get('from'))));
    }
    if (u.host === 'api.test' && u.pathname === '/v1/contributions/challenge') return res(200, { nonce: 'd1.1790000000.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB', expires_in: 300 });
    if (u.host === 'api.test' && u.pathname === '/v1/contributions/delete') return res(202, { ok: true });
    if (u.host === 'api.test' && u.pathname === '/v1/contributions/summary') return res(200, { you: { sessions: 1, minutes: 0.4 }, app: null, all: { contributors: 3, minutes: 9 } });
    if (u.host === 'r2.test' && rec.method === 'PUT') {
      const k = ++this.putCount;
      this.parallel++;
      this.maxParallel = Math.max(this.maxParallel, this.parallel);
      try {
        if (this.putDelay) await new Promise((r, j) => { const t = setTimeout(r, this.putDelay); init.signal?.addEventListener('abort', () => { clearTimeout(t); j(new DOMException('aborted', 'AbortError')); }); });
        const r = this.put(k, rec);
        if (r) return res(r.status, r.text || '');
        this.objects.set(u.pathname, new Uint8Array(body));
        return res(200, '');
      } finally { this.parallel--; }
    }
    return res(404, { error: 'not_found' });
  }
  starts() { return this.seen.filter((s) => s.path === '/v1/uploads'); }
  puts() { return this.seen.filter((s) => s.method === 'PUT'); }
  urlCalls(id) { return this.seen.filter((s) => s.path === `/v1/uploads/${id}/urls`).map((s) => Number(new URLSearchParams(s.search).get('from'))); }
  segments(id) { return [...this.objects].filter(([k]) => k.includes(`/v1/${id}/`)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v); }
}
const sig = (p) => /X-Amz-Signature=([^&]+)/.exec(p.search)[1];
const concat = (parts) => { const out = new Uint8Array(parts.reduce((k, p) => k + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

async function configure(server, { storage = new MemoryStorage(), enabled = true, flags = { contributions: true, upload_trust: { web: 'capped' } },
  token = UNATT, consentVersion = 'deck-1', clock, turnstile, bitrate } = {}) {
  const state = { enabled, flags };
  const tokenProvider = async () => token;
  tokenProvider.invalidate = async () => {};
  const sharing = await createSharing({ api: API, fetch: server.fetch, tokenProvider, storage, consentVersion, clock, turnstile,
    enabled: () => state.enabled, flags: () => state.flags, opus: async () => opus, device: { deviceClass: 'browser', osMajor: 14 }, bitrate });
  return { sharing, storage, state, outbox: sharing.outbox };
}

/** A session of `seconds` at `rate` pushed in 10 ms pieces, ended by `end`: 'finish', 'cancel' or 'open'. */
async function session(sharing, seconds, { rate = 48000, end = 'finish', route = 'built_in' } = {}) {
  const s = await sharing.startSession({ inputSampleRate: rate, inputRoute: route, decode: { backend: 'exact', modelRevision: null } });
  const x = noise(Math.round(rate * seconds), 3n, 0.2);
  const step = rate / 100;
  for (let at = 0; at < x.length; at += step) s.push(x.subarray(at, Math.min(x.length, at + step)));
  if (end === 'finish') await s.finish();
  else if (end === 'cancel') await s.finish({ completed: false });
  else await s.io;
  return s;
}

/** Drains until the outbox holds `count` items that satisfy `done`. */
async function settle(outbox, done = (x) => x.status !== 'queued', count = 1) {
  for (let i = 0; i < 200; i++) {
    await outbox.drain({ ignoringBackoff: true });
    const items = await outbox.items();
    if (items.length >= count && items.filter(done).length >= count) return items;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`not settled: ${JSON.stringify(await outbox.items())}`);
}

test('off: nothing is captured or sent (the switch, the config flag, web upload_trust off)', { skip }, async () => {
  for (const opts of [{ enabled: false }, { flags: { contributions: false, upload_trust: { web: 'capped' } } }, { flags: { contributions: true, upload_trust: { web: 'off' } } }]) {
    const server = new Server();
    const c = await configure(server, opts);
    await session(c.sharing, 12);
    await c.outbox.drain();
    assert.equal((await c.outbox.items()).length, 0, JSON.stringify(opts));
    assert.equal(server.seen.length, 0);
    assert.deepEqual(await c.storage.sessions(), []);
  }
});

test('a 25 s session streams its segments to R2: one start, each segment on its own URL', { skip }, async () => {
  const server = new Server();
  const c = await configure(server);
  await session(c.sharing, 25);
  const [item] = await settle(c.outbox);
  assert.equal(item.status, 'uploaded');
  assert.equal(item.segments, 2);
  assert.equal(item.durationMs, 25000);
  assert.equal(item.completed, true);
  const starts = server.starts();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].headers.authorization, `Bearer ${UNATT.token}`);
  assert.equal(starts[0].headers['x-qlab-id'], item.id);
  const meta = JSON.parse(starts[0].body);
  assert.deepEqual(Object.keys(meta).sort(), ['audio', 'consent_version', 'contributor', 'day', 'decode', 'device_class', 'format', 'os_major']);
  assert.equal(meta.format, 1);
  assert.equal(meta.consent_version, 'deck-1');
  assert.equal(meta.contributor, await c.sharing.contributorId());
  assert.equal(meta.day, new Date().toISOString().slice(0, 10));
  assert.deepEqual([meta.device_class, meta.os_major], ['browser', 14]);
  assert.deepEqual(meta.audio, { channels: 1, codec: 'opus', container: 'ogg', input_route: 'built_in', input_sample_rate: 48000, sample_rate: 48000 });
  assert.deepEqual(Object.keys(meta.decode).sort(), ['backend', 'model_revision', 'sdk_version', 'weights_sha256']);
  assert.equal(meta.decode.backend, 'exact');
  assert.equal(meta.decode.model_revision, null);
  const puts = server.puts();
  assert.deepEqual(puts.map((p) => p.path), [1, 2].map((n) => `/qlab-contributions/v1/${item.id}/${segmentName(n)}.opus`));
  assert.deepEqual(puts.map(sig), ['b1-1', 'b1-2']);
  for (const p of puts) {
    assert.deepEqual(Object.keys(p.headers), ['content-type']);
    assert.equal(p.headers['content-type'], 'audio/ogg');
  }
  assert.equal(server.seen.filter((s) => s.path.startsWith('/v1/uploads')).length, 1, 'the Worker is called once');
  const segs = server.segments(item.id);
  const pages = segs.map((s) => readPages(s));
  assert.equal(pages[0].filter((p) => !(p.flags & 0x02) && !(p.packets[0][0] === 0x4f && p.packets[0][4] === 0x54)).length, 10);
  assert.equal(pages.at(-1).at(-1).flags, 0x04, 'the last page ends the stream');
  assert.equal(pages.at(-1).at(-1).granule - 312, 25 * 48000);
  assert.equal(decodeOggOpus(opus, readPages(concat(segs))).length, 25 * 48000);
  assert.ok(!(await c.storage.list(item.id)).some((n) => n.endsWith('.opus')), 'the audio goes once uploaded');
});

test('a 44.1 kHz session records its input rate (JSON and OpusHead), coded at 48 kHz', { skip }, async () => {
  const server = new Server();
  const c = await configure(server);
  await session(c.sharing, 12, { rate: 44100, route: 'usb' });
  const [item] = await settle(c.outbox);
  assert.equal(item.durationMs, 12000);
  const audio = JSON.parse(server.starts()[0].body).audio;
  assert.deepEqual([audio.sample_rate, audio.input_sample_rate, audio.input_route], [48000, 44100, 'usb']);
  const segs = server.segments(item.id);
  const head = readPages(segs[0])[0].packets[0];
  assert.equal(new DataView(head.buffer, head.byteOffset).getUint32(12, true), 44100);
  assert.equal(decodeOggOpus(opus, readPages(concat(segs))).length, 12 * 48000);
});

test('without a consent version none is sent', { skip }, async () => {
  const server = new Server();
  const c = await configure(server, { consentVersion: null });
  await session(c.sharing, 1);
  await settle(c.outbox);
  assert.ok(!('consent_version' in JSON.parse(server.starts()[0].body)));
});

test('a cancelled session under 2 s stays local; a longer one is shared, not completed', { skip }, async () => {
  const server = new Server();
  const c = await configure(server);
  await session(c.sharing, 1.5, { end: 'cancel' });
  await c.outbox.drain();
  assert.equal(server.seen.length, 0);
  assert.deepEqual(await c.storage.sessions(), []);
  await session(c.sharing, 2.5, { rate: 16000, end: 'cancel' });
  const [item] = await settle(c.outbox);
  assert.equal(item.completed, false);
  assert.equal(item.durationMs, 2500);
  assert.equal(server.puts().length, 1);
});

test('an expired URL (403) is renewed from the same segment and the PUT sent again', { skip }, async () => {
  const server = new Server();
  server.put = (k) => (k === 1 ? { status: 403, text: '<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>' } : null);
  const c = await configure(server);
  await session(c.sharing, 1);
  const [item] = await settle(c.outbox);
  assert.equal(item.status, 'uploaded');
  assert.deepEqual(server.urlCalls(item.id), [1]);
  assert.equal(server.seen.find((s) => s.path.endsWith('/urls')).headers['x-qlab-contributor'], await c.sharing.contributorId());
  assert.deepEqual(server.puts().map(sig), ['b1-1', 'b2-1']);
  assert.equal(server.segments(item.id).length, 1);
});

test('a URL past its expiry is never tried: fresh ones first', { skip }, async () => {
  const server = new Server({ expiresIn: 200 }); // inside the 5 minute margin
  const c = await configure(server);
  await session(c.sharing, 1);
  const [item] = await settle(c.outbox);
  assert.equal(item.status, 'uploaded');
  assert.deepEqual(server.urlCalls(item.id), [1]);
  assert.deepEqual(server.puts().map(sig), ['b2-1'], 'the start batch (expiring) was never used');
});

test('the next batch comes when 5 unused URLs remain; a finished session asks for nothing more', { skip }, async () => {
  const server = new Server({ batch: 6 });
  const c = await configure(server);
  const running = await session(c.sharing, 12, { end: 'open' });
  await c.outbox.drain({ ignoringBackoff: true });
  const [item] = await c.outbox.items();
  assert.equal(server.puts().length, 1);
  assert.deepEqual(server.urlCalls(item.id), [7], 'segment 1 used, 5 left: the batch from 7');
  await running.finish();
  const [done] = await settle(c.outbox);
  assert.equal(done.segments, 2);
  assert.deepEqual(server.urlCalls(item.id), [7]);
  assert.deepEqual(server.puts().map(sig), ['b1-1', 'b1-2']);
  assert.equal(server.starts().length, 1);
});

test('a segment past the URLs it holds asks for URLs from its number', { skip }, async () => {
  const server = new Server({ batch: 1 });
  server.down = true;
  const c = await configure(server);
  await session(c.sharing, 25);
  await c.outbox.drain({ ignoringBackoff: true });
  server.down = false;
  const [item] = await settle(c.outbox);
  assert.equal(item.segments, 2);
  assert.deepEqual(server.urlCalls(item.id), [2]);
  assert.deepEqual(server.puts().map(sig), ['b1-1', 'b2-2']);
});

test('offline for a whole session: segments wait, then go in order; a relaunch loses nothing', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-share-'));
  try {
    const server = new Server();
    server.down = true;
    const first = await configure(server, { storage: await dirStorage(dir) });
    await session(first.sharing, 35);
    await first.outbox.drain({ ignoringBackoff: true });
    const [waiting] = await first.outbox.items();
    assert.equal(waiting.status, 'queued');
    assert.equal(waiting.segments, 3);
    assert.ok(waiting.lastError);
    server.down = false;
    const second = await configure(server, { storage: await dirStorage(dir) });
    await second.outbox.drain({ ignoringBackoff: true });
    const done = await second.outbox.item(waiting.id);
    assert.equal(done.status, 'uploaded');
    assert.deepEqual(server.puts().slice(-3).map((p) => p.path), [1, 2, 3].map((n) => `/qlab-contributions/v1/${waiting.id}/${segmentName(n)}.opus`));
    const third = await configure(server, { storage: await dirStorage(dir) });
    const before = server.puts().length;
    await third.outbox.drain({ ignoringBackoff: true });
    assert.equal(server.puts().length, before, 'an uploaded session is never sent again');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a page closed 13 s into a session (a page torn) is uploaded on the next load', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-kill-'));
  try {
    const server = new Server();
    server.down = true;
    const storage = await dirStorage(dir);
    const first = await configure(server, { storage });
    const running = await session(first.sharing, 13, { end: 'open' });
    const id = running.id;
    const whole = await storage.read(id, 'seg-00002.opus');
    assert.ok(whole.length > 0);
    await storage.append(id, 'seg-00002.opus', concat([new TextEncoder().encode('OggS'), new Uint8Array(100).fill(7)]));
    // the page was closed: its capture is gone without an end (no finish, no abort)
    const { activeCaptures } = await import('../web/sharing/index.js');
    activeCaptures.delete(id);
    running.failed = true;
    first.outbox.stopped = true; // the killed page's outbox does nothing more
    if (first.outbox.wakeTimer) clearTimeout(first.outbox.wakeTimer);
    while (first.outbox.running) await first.outbox.running.catch(() => {});
    const startsBefore = server.starts().length;
    server.down = false;
    const relaunched = await configure(server, { storage: await dirStorage(dir) });
    const items = await settle(relaunched.outbox, (x) => x.id === id && x.status === 'uploaded');
    const item = items.find((x) => x.id === id);
    assert.equal(item.completed, false);
    assert.equal(item.segments, 2);
    const segs = server.segments(id);
    assert.equal(segs.length, 2);
    assert.deepEqual(segs[1], whole, 'the torn page is cut off, the whole pages stay');
    const pages = segs.map((s) => readPages(s));
    assert.notEqual(pages.at(-1).at(-1).flags, 0x04, 'no end of stream: the session did not end');
    assert.equal(item.durationMs, Math.trunc((pages.at(-1).at(-1).granule - 312) / 48));
    assert.equal(server.starts().length - startsBefore, 1, 'one start after the relaunch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('turning sharing off: in-flight PUTs aborted, the queue deleted, later sessions not captured', { skip }, async () => {
  const server = new Server();
  server.putDelay = 2000;
  const c = await configure(server);
  await session(c.sharing, 1);
  const pass = c.outbox.drain({ ignoringBackoff: true });
  while (server.parallel === 0) await new Promise((r) => setTimeout(r, 5));
  c.state.enabled = false;
  const t0 = Date.now();
  await c.sharing.stop();
  await pass;
  assert.ok(Date.now() - t0 < 1500, 'stopped at once');
  assert.equal(server.objects.size, 0);
  assert.deepEqual(await c.outbox.items(), []);
  assert.deepEqual(await c.storage.sessions(), []);
  await session(c.sharing, 1);
  assert.deepEqual(await c.storage.sessions(), [], 'a session after sharing went off is not shared');
});

test('refusals: 400 fails for good; 403 attestation_required and contributions_disabled pause; 404 and 410 drop', { skip }, async () => {
  const server = new Server();
  server.start = () => ({ status: 400, body: { error: 'invalid_body', message: 'json.format: out of range' } });
  const c = await configure(server);
  await session(c.sharing, 1);
  const [item] = await settle(c.outbox);
  assert.deepEqual([item.status, item.failCode, item.failMessage], ['failed', 'invalid_body', 'json.format: out of range']);
  await c.outbox.drain({ ignoringBackoff: true });
  assert.equal(server.starts().length, 1, 'a refused item is not retried');
  assert.equal(server.puts().length, 0);

  for (const code of ['attestation_required', 'contributions_disabled']) {
    const s2 = new Server();
    s2.start = () => ({ status: 403, body: { error: code, message: '' } });
    const c2 = await configure(s2);
    await session(c2.sharing, 1);
    await c2.outbox.drain({ ignoringBackoff: true });
    const [q] = await c2.outbox.items();
    assert.equal(q.status, 'queued', code);
    assert.match(q.lastError, new RegExp(code));
    const rec = c2.outbox.records.get(q.id);
    assert.ok(rec.nextAttempt - Date.now() > 4 * 3600 * 1000, `${code}: paused for hours`);
  }
  for (const status of [404, 410]) {
    const s3 = new Server();
    s3.start = () => ({ status, body: { error: status === 404 ? 'not_found' : 'upload_deleted' } });
    const c3 = await configure(s3);
    await session(c3.sharing, 1);
    await c3.outbox.drain({ ignoringBackoff: true });
    assert.deepEqual(await c3.outbox.items(), [], `${status}: dropped locally`);
    assert.deepEqual(await c3.storage.sessions(), []);
  }
});

test('web with upload_trust attested (which it cannot meet): nothing captured, no upload started', { skip }, async () => {
  const server = new Server();
  const c = await configure(server, { flags: { contributions: true, upload_trust: { web: 'attested' } } });
  await session(c.sharing, 1);
  await c.outbox.drain({ ignoringBackoff: true });
  assert.deepEqual(await c.outbox.items(), []);
  assert.equal(server.starts().length, 0);
  assert.match(c.outbox.uploadAllowed().why, /no attestation/);
});

test('owner decision 11-07: no upload_trust entry for web means the lower trust tier (capped): the session uploads', { skip }, async () => {
  const server = new Server();
  const c = await configure(server, { flags: { contributions: true } });
  await session(c.sharing, 12);
  const items = await settle(c.outbox);
  assert.equal(items[0].status, 'uploaded');
  assert.equal(server.starts().length, 1);
});

test('capped tier: the Turnstile header when turnstile_web is on; 403 segment_cap stops the session', { skip }, async () => {
  const server = new Server({ batch: 1 });
  server.urlsReply = () => ({ status: 403, body: { error: 'segment_cap', message: 'segments_per_session' } });
  const c = await configure(server, { flags: { contributions: true, upload_trust: { web: 'capped' }, capped_limits: { turnstile_web: true } },
    turnstile: async () => 'ts-token-1' });
  await session(c.sharing, 35);
  const [item] = await settle(c.outbox);
  assert.equal(server.starts()[0].headers['x-qlab-turnstile'], 'ts-token-1');
  assert.equal(item.status, 'uploaded');
  assert.equal(item.capped, true);
  assert.equal(server.puts().length, 1, 'only the segment it had a URL for');
  assert.ok(!(await c.storage.list(item.id)).some((n) => n.endsWith('.opus')));
});

test('one PUT at a time, in segment order (also from storage on disk, after an outage)', { skip }, async () => {
  for (const onDisk of [false, true]) {
    const dir = onDisk ? mkdtempSync(path.join(tmpdir(), 'tf-share-order-')) : null;
    try {
      const server = new Server();
      server.down = true;
      const c = await configure(server, onDisk ? { storage: await dirStorage(dir) } : {});
      await session(c.sharing, 75); // 10 + 20 + 40 + 5 s: 4 segments
      await c.outbox.drain({ ignoringBackoff: true });
      server.down = false;
      server.putDelay = 30;
      const [item] = await settle(c.outbox);
      assert.equal(item.segments, 4);
      assert.equal(server.maxParallel, 1, 'one PUT at a time');
      assert.deepEqual(server.puts().map((p) => p.path), [1, 2, 3, 4].map((n) => `/qlab-contributions/v1/${item.id}/${segmentName(n)}.opus`),
        'in segment order');
      assert.equal(server.segments(item.id).length, 4);
    } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
  }
});

test('unsent sessions older than 7 days are deleted', { skip }, async () => {
  let now = Date.now();
  const server = new Server();
  server.down = true;
  const c = await configure(server, { clock: () => now });
  await session(c.sharing, 1);
  await c.outbox.drain({ ignoringBackoff: true });
  assert.equal((await c.outbox.items()).length, 1);
  now += MAX_AGE_MS + 1000;
  await c.outbox.drain({ ignoringBackoff: true });
  assert.deepEqual(await c.outbox.items(), []);
  assert.deepEqual(await c.storage.sessions(), []);
});

test('cancel before the server has it; contributor id stable until reset; delete what I shared', { skip }, async () => {
  const server = new Server();
  server.down = true;
  const c = await configure(server);
  await session(c.sharing, 1);
  await c.outbox.drain({ ignoringBackoff: true });
  const [item] = await c.outbox.items();
  await c.outbox.cancel(item.id);
  assert.deepEqual(await c.storage.sessions(), []);
  await assert.rejects(c.outbox.cancel(item.id));
  server.down = false;
  const id = await c.sharing.contributorId();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(await c.sharing.contributorId(), id, 'stable per install');
  // deletion with the device key (PLATFORM_CLIENT 9.1): challenge, the exact message signed, delete; no app credential
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  let signed = null;
  const r = await c.sharing.deleteShared({ app: 'web:https://app.example', sign: async (bytes) => {
    signed = bytes;
    return new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, bytes));
  } });
  assert.deepEqual(r, { ok: true });
  const ch = server.seen.find((x) => x.path === '/v1/contributions/challenge');
  assert.deepEqual(JSON.parse(ch.body), { app: 'web:https://app.example', contributor: id });
  const del = server.seen.find((x) => x.path === '/v1/contributions/delete');
  assert.ok(!('authorization' in del.headers) && !('x-qlab-key' in del.headers), 'no app credential');
  const body = JSON.parse(del.body);
  assert.deepEqual(Object.keys(body).sort(), ['action', 'app', 'contributor', 'nonce', 'signature', 'timestamp']);
  assert.equal(new TextDecoder().decode(signed), `quranlab-contribution-delete 1\napp web:https://app.example\ncontributor ${id}\n` +
    `nonce ${body.nonce}\ntimestamp ${body.timestamp}\naction delete-all\n`);
  assert.match(body.signature, /^[A-Za-z0-9_-]{86}$/, 'r||s, 64 bytes, base64url');
  const sigBytes = Uint8Array.from(atob(body.signature.replace(/-/g, '+').replace(/_/g, '/')), (ch2) => ch2.charCodeAt(0));
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sigBytes, signed));
  assert.deepEqual((await c.sharing.summary()).all, { contributors: 3, minutes: 9 });
});

test('contributor key and recovery hash in the start; contributor errors reach the controller typed; volume_limit waits for tomorrow', { skip }, async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  assert.equal(raw.length, 65);
  const recoveryHash = 'a'.repeat(64);
  const errors = [];
  for (const [status, code] of [[403, 'contributor_revoked'], [409, 'contributor_key_mismatch']]) {
    const server = new Server();
    server.start = () => ({ status, body: { error: code, message: '' } });
    const c = await configure(server);
    c.sharing.update({ contributorKeyRaw: raw, recoveryHash, contributor: 'b'.repeat(32), onError: (e) => errors.push(e) });
    await session(c.sharing, 1);
    const [item] = await settle(c.outbox);
    const meta = JSON.parse(server.starts()[0].body);
    assert.equal(meta.contributor, 'b'.repeat(32));
    assert.equal(meta.recovery_hash, recoveryHash);
    const b64 = btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(meta.contributor_key, b64);
    assert.deepEqual([item.status, item.failCode], ['failed', code]);
  }
  assert.deepEqual(errors.map((e) => [e.name, e.code, e.status]), [['SharingError', 'contributor_revoked', 403], ['SharingError', 'contributor_key_mismatch', 409]]);

  const server = new Server();
  server.start = () => ({ status: 429, body: { error: 'volume_limit', message: 'sessions_per_contributor_day' } });
  const c = await configure(server);
  await session(c.sharing, 1);
  await c.outbox.drain({ ignoringBackoff: true });
  const [q] = await c.outbox.items();
  assert.equal(q.status, 'queued');
  const next = c.outbox.records.get(q.id).nextAttempt;
  const midnight = (Math.floor(Date.now() / 86400000) + 1) * 86400000;
  assert.ok(next >= midnight && next < midnight + 3600000, 'after the next UTC midnight');
});

test('createSharingSession: the controller\'s names, one page pipeline, module outbox stop/resume; headers go to the Worker only', { skip }, async () => {
  const mod = await import('../web/sharing/index.js');
  mod.resetSharingForTests();
  const server = new Server();
  const storage = new MemoryStorage();
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const common = { api: API, fetch: server.fetch, tokenProvider: async () => UNATT, headers: { 'x-qlab-sdk': 'web/2.0.0' },
    contributor: 'c'.repeat(32), contributorKeyRaw: raw, recoveryHash: 'd'.repeat(64), consentVersion: 'deck-1',
    device: { deviceClass: 'browser', osMajor: 14 }, flags: { contributions: true, upload_trust: { web: 'capped' } }, storage,
    opus: async () => opus };
  const s = await mod.createSharingSession({ ...common, inputSampleRate: 16000, inputRoute: 'built_in', decodeInfo: { backend: 'exact', modelRevision: 'v4.0+abc' } });
  assert.equal(typeof s.push, 'function');
  const x = noise(16000 * 2, 5n, 0.2);
  for (let at = 0; at < x.length; at += 160) s.push(x.subarray(at, at + 160));
  assert.equal(await s.finish(), 2000);
  const p = await mod.outbox.sharing();
  for (let i = 0; i < 50 && (await mod.outbox.pending()).length; i++) await (await p).outbox.drain({ ignoringBackoff: true });
  const items = await mod.outbox.items();
  assert.deepEqual(items.map((i) => i.status), ['uploaded']);
  const start = server.starts()[0];
  assert.equal(start.headers['x-qlab-sdk'], 'web/2.0.0');
  assert.equal(JSON.parse(start.body).decode.model_revision, 'v4.0+abc');
  for (const put of server.puts()) assert.deepEqual(Object.keys(put.headers), ['content-type'], 'no extra header to R2');
  // a second session reuses the pipeline; stop() deletes its queue at once
  server.down = true;
  const s2 = await mod.createSharingSession({ ...common, inputSampleRate: 48000 });
  for (let at = 0; at < 48000; at += 480) s2.push(noise(480, BigInt(at + 1), 0.2));
  await s2.finish();
  assert.equal((await mod.outbox.pending()).length, 1);
  await mod.outbox.stop();
  assert.equal((await mod.outbox.pending()).length, 0);
  await mod.outbox.resume();
  mod.resetSharingForTests();
});

test('bitrate: SHARING_BITRATE_DEFAULT (192 kbit/s) unless the app passes another; a lower one gives smaller segments', { skip }, async () => {
  const { SHARING_BITRATE_DEFAULT } = await import('../web/sharing/index.js');
  assert.equal(SHARING_BITRATE_DEFAULT, 192000);
  const bytes = {};
  for (const b of [undefined, 24000]) {
    const server = new Server();
    const c = await configure(server, { bitrate: b });
    const s = await session(c.sharing, 12);
    assert.equal(s.settings.bitrate, b || 192000);
    await settle(c.outbox);
    bytes[b || 192000] = server.puts().reduce((n, p) => n + p.body.length, 0);
  }
  assert.ok(bytes[24000] < bytes[192000] / 3, JSON.stringify(bytes));
});
