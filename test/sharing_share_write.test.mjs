// SDK 4.0.2, SHARE_WRITE_40.md (section 29): a write that fails during a shared recording ends it as a crash would,
// and the 2.0.1 recovery keeps the closed segments and the whole pages of the open one when at least one segment had
// closed and sharing is on; nothing is kept otherwise. The vector vectors40/share_write_40.json replayed through the
// web's own pipeline (createSharing: the recorder, ShareCapture, the outbox and its uploads) with real libopus, on a
// storage folder whose writes can be made to fail as on a full disk (write, append and truncate refused with ENOSPC;
// deletes work, as they do on a full disk). The network is down while the events run, so nothing is uploaded before
// the end; then the uploader finishes and the test reads what the stand-in server took.
//
// Web records Opus only (no Ogg FLAC, whatever flags.share_flac says): the vector's FLAC case runs as web records it,
// Opus from 44.1 kHz input, under the same rule.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharing, dirStorage, loadOpus, readPages, segmentName, activeCaptures, SEGMENT_PLAN } from '../web/sharing/index.js';
import { clipSeconds } from './sharing_stream_checks.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const V = JSON.parse(readFileSync(path.join(root, 'test', 'vectors40', 'share_write_40.json'), 'utf8'));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const opus = have ? await loadOpus() : null;
const CONTRIBUTOR = 'c'.repeat(32);

// the stand-in API and R2: one process's view (`alive` false: the process has ended, nothing it asks is answered)
class Server {
  constructor(now) { this.now = now; this.down = true; this.seen = []; this.objects = new Map(); }
  view(proc) {
    return async (url, init = {}) => {
      if (!proc.alive) return new Promise(() => {});
      const u = new URL(url);
      const rec = { method: init.method || 'GET', path: u.pathname, body: init.body };
      if (this.down) throw new TypeError('fetch failed (offline)');
      this.seen.push(rec);
      const res = (status, obj) => new Response(status === 204 ? null : typeof obj === 'string' ? obj : JSON.stringify(obj), { status });
      const urls = (id, from) => ({ id, urls: Array.from({ length: 20 }, (_, i) => from + i).map((n) => ({ n, expires_at: Math.floor(this.now() / 1000) + 604800, url: `https://r2.test/v1/${id}/${segmentName(n)}.opus` })) });
      if (u.pathname === '/v1/uploads') return res(201, urls(init.headers['x-qlab-id'], 1));
      let m = /^\/v1\/uploads\/([0-9a-f]{32})\/urls$/.exec(u.pathname);
      if (m) return res(200, urls(m[1], Number(u.searchParams.get('from'))));
      m = /^\/v1\/uploads\/([0-9a-f]{32})\/takes$/.exec(u.pathname);
      if (m && rec.method === 'POST') return res(204);
      if (u.host === 'r2.test' && rec.method === 'PUT') { this.objects.set(u.pathname, new Uint8Array(init.body)); return res(200, ''); }
      return res(404, { error: 'not_found' });
    };
  }
  starts() { return this.seen.filter((x) => x.path === '/v1/uploads'); }
  lists() { return this.seen.filter((x) => /\/takes$/.test(x.path)); }
  segments(id) { return [...this.objects].filter(([k]) => k.includes(`/v1/${id}/`)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v); }
}

// A storage folder whose writes fail while `disk.full` (as on a full disk): the recording's pages, markers,
// capture.json, the take list, and the outbox's own records. One process's view: `alive` false answers nothing.
function failing(inner, disk, proc) {
  const WRITES = new Set(['write', 'append', 'truncate', 'setGlobal']);
  const out = {};
  for (const k of ['sessions', 'list', 'read', 'write', 'append', 'truncate', 'remove', 'removeSession', 'getGlobal', 'setGlobal']) {
    out[k] = async (...a) => {
      if (!proc.alive) return new Promise(() => {});
      if ((disk.full || disk.once) && WRITES.has(k)) {
        disk.once = false;
        disk.refused++;
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      return inner[k](...a);
    };
  }
  return out;
}

// a wall clock the test moves, and timers that fire only when the clock reaches them
function seams(start) {
  const s = { now: start, pending: new Map(), seq: 0 };
  s.clock = () => s.now;
  s.timers = { setTimeout: (f, ms) => { const id = ++s.seq; s.pending.set(id, { f, at: s.now + ms }); return id; }, clearTimeout: (id) => { s.pending.delete(id); } };
  s.to = (t) => {
    for (;;) {
      const due = [...s.pending].filter(([, x]) => x.at <= t).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      s.pending.delete(due[0]);
      s.now = Math.max(s.now, due[1].at);
      due[1].f();
    }
    s.now = t;
  };
  return s;
}

async function process1(server, storageOf, s, state, flags) {
  const proc = { alive: true };
  const storage = storageOf(proc);
  const sharing = await createSharing({ api: 'https://api.test', fetch: server.view(proc), tokenProvider: async () => ({ token: 't', attested: false }), storage,
    consentVersion: 'deck-1', contributor: CONTRIBUTOR, enabled: () => state.enabled, flags: () => ({ contributions: true, upload_trust: { web: 'capped' }, ...flags }),
    opus: async () => opus, device: { deviceClass: 'browser', osMajor: 14 }, random: () => 0.5, clock: s.clock, timers: s.timers, locks: null,
    lifecycle: { document: null, window: null }, log: () => {} });
  return { proc, sharing };
}

// the stream the server holds: pages valid, sequence continuous, no EOS; its audio in ms (the last granule, Opus
// pre-skip off)
function stream(segs) {
  const all = new Uint8Array(segs.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of segs) { all.set(b, at); at += b.length; }
  const pages = readPages(all);
  pages.forEach((p, i) => assert.equal(p.sequence, i, `page sequence number continuous at ${i}`));
  assert.equal(pages[0].flags & 0x02, 0x02, 'BOS on page 0');
  const head = pages[0].packets[0];
  const preSkip = head[10] | (head[11] << 8);
  return { eos: pages.some((p) => (p.flags & 0x04) !== 0), audioMs: Math.trunc((pages[pages.length - 1].granule - preSkip) / 48) };
}

/** One case: the failed expectations (an empty list passes), and what was seen. */
async function replay(c) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-share-write-'));
  const s = seams(Date.UTC(2026, 10, 21, 9, 0, 0));
  const server = new Server(s.clock);
  const disk = { full: false, refused: 0 };
  const inner = await dirStorage(dir);
  const state = { enabled: true };
  const storageOf = (proc) => failing(inner, disk, proc);
  let p = await process1(server, storageOf, s, state, c.flags);
  const takeMs = [];
  let take = null;
  const rate = c.rate;
  try {
    for (const ev of c.events) {
      if (ev.event === 'take_start') take = await p.sharing.startSession({ inputSampleRate: rate, inputRoute: 'built_in', decode: { backend: 'exact', modelRevision: '4.1.0' } });
      else if (ev.event === 'audio') {
        const pcm = clipSeconds(rate, ev.s), step = Math.round(rate * 0.02);
        for (let i = 0; i < pcm.length; i += step) take.push(pcm.subarray(i, Math.min(pcm.length, i + step)));
        s.to(s.now + ev.s * 1000);
        // the capture's writes happen under the disk as it is now, and a capture a write failed for ends under it too
        await Promise.resolve(take.io).catch(() => {});
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
        if (take.capture && take.capture._aborted) await take.capture._aborted;
      } else if (ev.event === 'write_fails') disk.full = true;
      else if (ev.event === 'one_write_fails') disk.once = true;
      else if (ev.event === 'disk_ok') disk.full = false;
      else if (ev.event === 'take_end') takeMs.push(await take.finish({ completed: ev.completed }));
      else if (ev.event === 'sharing_off') { state.enabled = false; await p.sharing.stop(); }
      else if (ev.event === 'relaunch') {
        // the process ends with the files as they are: nothing it holds answers any more, and its module state goes
        p.proc.alive = false;
        p.sharing.recorder.kill();
        activeCaptures.clear();
        p = await process1(server, storageOf, s, state, c.flags);
      } else throw new Error(`an event this test does not know: ${ev.event}`);
    }
    // the open recording closes (its join window passes), then the uploader finishes
    s.to(s.now + 120_000);
    await p.sharing.closeRecording();
    await p.sharing.recorder.settled();
    server.down = false;
    let items = [];
    for (let i = 0; i < 60; i++) {
      await p.sharing.outbox.drain({ ignoringBackoff: true });
      items = await p.sharing.outbox.items();
      if (items.every((x) => x.status !== 'queued')) break;
      await new Promise((r) => setImmediate(r));
    }
    const e = c.expect, failed = [];
    const check = (key, ok, seen) => { if (!ok) failed.push(`${key} (${JSON.stringify(seen)})`); };
    check('take_ms', JSON.stringify(takeMs) === JSON.stringify(e.take_ms), takeMs);
    const starts = server.starts();
    const left = await inner.sessions();
    if (!e.kept) {
      check('kept: false, nothing reached the server', starts.length === 0 && server.objects.size === 0, { starts: starts.length, objects: server.objects.size });
      check('kept: false, the outbox is empty', left.length === 0, left);
      return { failed, seen: { takeMs, starts: starts.length, left, items } };
    }
    check('kept: one recording reached the server', starts.length === 1, starts.length);
    const segs = server.segments(items[0] ? items[0].id : '');
    check('segments', segs.length >= e.segments_min && segs.length <= e.segments_max, segs.length);
    let st = null;
    try { st = segs.length ? stream(segs) : null; } catch (x) { check('valid pages', false, String(x.message)); }
    if (st) {
      check('audio_ms', st.audioMs >= e.audio_ms_min && st.audioMs <= e.audio_ms_max, st.audioMs);
      check('eos', st.eos === e.eos, st.eos);
    }
    check('uploaded, not completed', items.length === 1 && items[0].status === 'uploaded' && items[0].completed === e.completed, items.map((x) => [x.status, x.completed]));
    const lists = server.lists();
    const takes = lists.length ? JSON.parse(lists[lists.length - 1].body).takes.length : null;
    check('takes', takes === e.takes, takes);
    return { failed, seen: { takeMs, segments: segs.length, audioMs: st && st.audioMs, eos: st && st.eos, items: items.map((x) => [x.status, x.completed]), takes, refused: disk.refused } };
  } finally {
    p.proc.alive = false;
    try { p.sharing.recorder.kill(); } catch (_) { /* gone */ }
    activeCaptures.clear();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('share_write_40.json: six cases on the standard plan', () => {
  assert.deepEqual([...SEGMENT_PLAN], V.plan_s);
  assert.equal(V.cases.length, 6);
});

for (const c of V.cases) {
  test(`share_write_40.json: ${c.name}${c.form === 'flac' ? ' (web: Opus from 44.1 kHz; web has no Ogg FLAC)' : ''}`, { skip, timeout: 300_000 }, async () => {
    const r = await replay(c);
    console.log(`# SHARE_WRITE | ${c.name} | ${r.failed.length ? 'FAIL' : 'pass'} | ${JSON.stringify(r.seen)}`);
    assert.deepEqual(r.failed, []);
  });
}

test('one write fails and the disk is fine again at once: nothing after the failed page is written, so the stream has no hole', { skip, timeout: 300_000 }, async () => {
  // 29.1: the failure ends the recording at once. The pages the capture had queued after the one that failed would
  // otherwise land after a missing page (4.0.1 wrote them): a stream with a hole in its page sequence
  const c = { name: 'one write fails', form: 'opus', rate: 48000, flags: {},
    events: [{ event: 'take_start' }, { event: 'audio', s: 35 }, { event: 'one_write_fails' }, { event: 'audio', s: 1 }, { event: 'take_end', completed: true }],
    expect: { kept: true, segments_min: 3, segments_max: 3, audio_ms_min: 30000, audio_ms_max: 35000, eos: false, completed: false, takes: null, take_ms: [0] } };
  const r = await replay(c);
  console.log(`# SHARE_WRITE | ${c.name} | ${r.failed.length ? 'FAIL' : 'pass'} | ${JSON.stringify(r.seen)}`);
  assert.deepEqual(r.failed, []);
});
