// SDK 3.0.0, what shared recordings gained (web/sharing/recorder.js; SPEC 11.2, 11.3 and 11.6): the feed's pre-roll
// (up to 1 s from a ring in memory) and tail (up to 0.5 s), dropped at once without a yes or with sharing off;
// take_seq and gap_ms_prev of the session JSON; the take list with a pre-roll. First the shared vector
// sharing_30.json, every case replayed through the recorder with the clock and timer seams (the timers fire
// when the clock reaches them, as in an app); then real Ogg streams through the whole pipeline: the sample
// counts of pre-roll, take and tail in the stream, the session JSON's new fields, the feed through the Client.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShareRecorder } from '../web/sharing/recorder.js';
import { FEED_STALE_MS, GAP_PREV_MAX_MS, TAIL_WAIT_MS } from '../web/sharing/recorder.js';
import { sessionJson } from '../web/sharing/uploader.js';
import { takeList } from '../web/sharing/takes.js';
import { createSharing, loadOpus, MemoryStorage, FILES, MAX_JOIN_MS, RECORDING_CAP_MS, DEFAULT_JOIN_MS, HOLD_MS, readPages } from '../web/sharing/index.js';
import { checkStream } from './sharing_stream_checks.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const vector = JSON.parse(readFileSync(path.join(root, 'test', 'vectors30', 'sharing_30.json'), 'utf8'));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const CONTRIBUTOR = 'c'.repeat(32);

// a wall clock the test moves, and timers that fire only when the clock reaches them
function seams(start = 0) {
  const s = { now: start, pending: new Map(), seq: 0 };
  s.clock = () => s.now;
  s.timers = {
    setTimeout: (f, ms) => { const id = ++s.seq; s.pending.set(id, { f, at: s.now + ms }); return id; },
    clearTimeout: (id) => { s.pending.delete(id); },
  };
  s.to = (t) => {
    for (;;) {
      const due = [...s.pending].filter(([, x]) => x.at <= t).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      s.pending.delete(due[0]);
      s.now = Math.max(s.now, due[1].at);
      due[1].f();
    }
    s.now = Math.max(s.now, t);
  };
  return s;
}

// a capture that only counts what a recording was given and how it ended
function counting() {
  const made = [];
  const make = (opts) => {
    const c = { id: `rec-${made.length + 1}`, opts, failed: false, io: Promise.resolve(), settings: {}, segments: 0, error: null, samples: 0, takes: null, ended: null,
      push(pcm) { this.samples += pcm.length; },
      setTakes(t) { this.takes = t.map((x) => ({ ...x })); },
      async finish({ completed }) { this.ended = { how: 'finish', completed }; return Math.round((this.samples * 1000) / opts.inputSampleRate); },
      async abort() { this.failed = true; this.ended = { how: 'abort' }; },
      async discard() { this.failed = true; this.ended = { how: 'discard' }; },
      kill() { this.failed = true; } };
    made.push(c);
    return c;
  };
  return { made, make };
}

test('the constants of the vector', () => {
  assert.deepEqual([vector.default_window_ms, vector.cap_ms, vector.stale_ms, vector.gap_ms_prev_max], [DEFAULT_JOIN_MS, RECORDING_CAP_MS, FEED_STALE_MS, GAP_PREV_MAX_MS]);
  assert.deepEqual([vector.ring_ms, vector.tail_ms], [1000, 500]);
  assert.equal(vector.cases.length, 41);
  assert.equal(vector.tail_wait_ms, TAIL_WAIT_MS);
  assert.equal(vector.hold_ms, HOLD_MS);
  assert.deepEqual(vector.cap_samples, { 16000: (RECORDING_CAP_MS / 1000) * 16000, 48000: (RECORDING_CAP_MS / 1000) * 48000 });
});

for (const c of vector.cases) test(`sharing_30.json: ${c.name}`, async () => {
  const s = seams(0);
  const caps = counting();
  const closed = [];
  let on = c.sharing_on_at_start;
  const installs = [];
  // no preset of any kind: the tail wait runs after every take, whether or not the app has fed before
  const rec = new ShareRecorder({ make: caps.make, flags: () => c.flags, clock: s.clock, timers: s.timers, onClosed: (r) => closed.push(r), onInstall: (v) => installs.push(v) });
  const buf = (n) => new Float32Array(n);
  for (const [i, e] of c.events.entries()) {
    const where = `${c.name}, event ${i + 1} (${e.event})`;
    if (e.event === 'feed') {
      s.to(e.wall_ms);
      const r = rec.feed(buf(e.samples), e.rate, e.wall_ms, on);
      assert.deepEqual({ to_tail: r.toTail, to_ring: r.toRing, dropped: r.dropped, ring_samples: r.ringSamples }, e.expect, where);
    } else if (e.event === 'take') {
      s.to(e.start_wall_ms);
      if (!on) {
        // sharing is off: the SDK starts no shared take, and whatever is fed is dropped at once
        const fed = e.fed_during ? rec.feed(buf(e.fed_during), e.rate, e.start_wall_ms, false).dropped : 0;
        assert.deepEqual({ pre_roll: 0, recorded: false, fed_during_dropped: fed, ring_samples: rec.ringSamples }, e.expect, where);
        continue;
      }
      const t = rec.take({ inputSampleRate: e.rate, contributor: CONTRIBUTOR, consentVersion: 'deck-1', decode: { modelRevision: '4.0.0' }, startedAt: e.start_wall_ms });
      const got = { pre_roll: t.preSamples, recorded: true, joined: t.joining, fed_during_dropped: 0, ring_samples: rec.ringSamples };
      const held = Array.isArray(t.held);
      const block = buf(16000); // one buffer for the whole take: the counting capture keeps none of it
      for (let left = e.samples; left > 0; left -= 16000) t.push(left >= 16000 ? block : buf(left));
      if (e.fed_during) got.fed_during_dropped = rec.feed(buf(e.fed_during), e.rate, e.start_wall_ms + 1, true).dropped;
      s.to(e.end_wall_ms);
      await t.finish({ endedAt: e.end_wall_ms });
      // a held take that did not fit did not join; a take cut at the cap says where
      if (t.moved) got.joined = false;
      if (held) got.held = true;
      if (t.cuts.length) got.cut_at_take_samples = t.cuts;
      assert.deepEqual(got, e.expect, where);
    } else if (e.event === 'background') {
      s.to(e.wall_ms);
      await rec.background();
      rec.foreground();   // the app comes back for what follows
      assert.deepEqual({ ring_samples: rec.ringSamples }, e.expect, where);
    } else if (e.event === 'sharing') {
      on = e.on;
      if (!on) await rec.stop();
      assert.deepEqual({ ring_samples: rec.ringSamples }, e.expect, where);
    } else if (e.event === 'delete') {
      // an accepted "delete what I shared": sharing goes off with it, and only a `sharing` event turns it on again
      on = false;
      await rec.stop();
      rec.forgetInstall();
      assert.deepEqual({ ring_samples: rec.ringSamples }, e.expect, where);
    } else assert.fail(`unknown event ${e.event}`);
    await rec.settled();
  }
  // the end of the app's use: every window and every tail's wait passes
  s.to(s.now + MAX_JOIN_MS + 5000);
  await rec.settled();
  const got = closed.map((r) => {
    const o = { rate: r.rate, samples: r.samples, audio_ms: r.audioMs, take_seq: r.takeSeq, gap_ms_prev: r.gapMsPrev, takes: r.takes, parts: r.parts };
    if (caps.made.find((x) => x.id === r.id).ended.how === 'discard') o.deleted = true;
    if (r.closedAtCap) o.closed_at_cap = true;
    return o;
  });
  assert.deepEqual(got, c.recordings, c.name);
  assert.equal(caps.made.every((x) => x.samples <= (RECORDING_CAP_MS / 1000) * x.opts.inputSampleRate), true, 'no recording holds more than 20 minutes');
  // the captures were given exactly the recordings' samples, and the session JSON's two numbers
  for (const [i, r] of closed.entries()) {
    const cap = caps.made.find((x) => x.id === r.id);
    assert.equal(cap.samples, c.recordings[i].samples, `${c.name}: recording ${i + 1} samples`);
    assert.deepEqual([cap.opts.takeSeq, cap.opts.gapMsPrev], [c.recordings[i].take_seq, c.recordings[i].gap_ms_prev]);
  }


  // what is persisted for the install is the last count and the last take's end
  if (installs.length) assert.equal(installs.at(-1).seq, rec.seq);
});

test('the same cases with the timers checked every 50 ms: an earlier look at the clock closes nothing early', async () => {
  for (const c of vector.cases) {
    const s = seams(0);
    const caps = counting();
    const closed = [];
    let on = c.sharing_on_at_start;
    const rec = new ShareRecorder({ make: caps.make, flags: () => c.flags, clock: s.clock, timers: s.timers, onClosed: (r) => closed.push(r) });
    const walk = (t) => { for (let x = s.now + 50; x < t; x += 50) { s.to(x); rec.checkWindow(); } s.to(t); };
    for (const e of c.events) {
      if (e.event === 'feed') { walk(e.wall_ms); rec.feed(new Float32Array(e.samples), e.rate, e.wall_ms, on); }
      else if (e.event === 'take') {
        walk(e.start_wall_ms);
        if (!on) continue;
        const t = rec.take({ inputSampleRate: e.rate, contributor: CONTRIBUTOR, consentVersion: 'deck-1', decode: {}, startedAt: e.start_wall_ms });
        const block = new Float32Array(16000);
        for (let left = e.samples; left > 0; left -= 16000) t.push(left >= 16000 ? block : new Float32Array(left));
        s.to(e.end_wall_ms);
        await t.finish({ endedAt: e.end_wall_ms });
      } else if (e.event === 'background') { walk(e.wall_ms); await rec.background(); rec.foreground(); }
      else if (e.event === 'sharing') { on = e.on; if (!on) await rec.stop(); }
      else if (e.event === 'delete') { on = false; await rec.stop(); rec.forgetInstall(); }
      await rec.settled();
    }
    s.to(s.now + MAX_JOIN_MS + 5000);
    await rec.settled();
    assert.deepEqual(closed.map((r) => ({ samples: r.samples, takes: r.takes, parts: r.parts })), c.recordings.map((r) => ({ samples: r.samples, takes: r.takes, parts: r.parts })), c.name);
  }
});

test('the tail wait runs after every take: with window 0 and an app that never feeds the recording stays open 1500 ms, then closes with the take alone', async () => {
  const s = seams(0);
  const caps = counting();
  const closed = [];
  const rec = new ShareRecorder({ make: caps.make, flags: () => ({ share_join_ms: 0 }), clock: s.clock, timers: s.timers, onClosed: (r) => closed.push(r) });
  const t = rec.take({ inputSampleRate: 16000, contributor: CONTRIBUTOR, decode: {}, startedAt: 0 });
  t.push(new Float32Array(16000));
  s.to(1000);
  await t.finish({ endedAt: 1000 });
  assert.equal(closed.length, 0, 'window 0: the recording is still open for its tail');
  assert.equal(s.pending.size, 1, 'the tail wait armed its timer');
  s.to(1000 + TAIL_WAIT_MS);
  await rec.settled();
  assert.equal(closed.length, 0, 'exactly 1500 ms after the take: a feed at this instant still gives the tail');
  s.to(1000 + TAIL_WAIT_MS + 1);
  await rec.settled();
  assert.deepEqual(closed.map((r) => [r.samples, r.parts]), [[16000, [{ pre_roll: 0, take: 16000, tail: 0 }]]], 'closed, and nothing but the take is in it');
  assert.equal(s.pending.size, 0);
});

test('the session JSON: take_seq, gap_ms_prev and decode.model_build, only when given and well formed', () => {
  const base = { contributor: CONTRIBUTOR, day: '2026-11-11', deviceClass: 'browser', osMajor: 14, inputSampleRate: 48000, modelRevision: '4.0.0' };
  const plain = JSON.parse(sessionJson(base));
  assert.ok(!('take_seq' in plain) && !('gap_ms_prev' in plain) && !('model_build' in plain.decode));
  const j = JSON.parse(sessionJson({ ...base, takeSeq: 3, gapMsPrev: 4000, modelBuild: 'a'.repeat(40) }));
  assert.deepEqual([j.take_seq, j.gap_ms_prev, j.decode.model_build, j.decode.model_revision], [3, 4000, 'a'.repeat(40), '4.0.0']);
  assert.deepEqual(Object.keys(j), Object.keys(j).slice().sort(), 'sorted keys, as every SDK writes it');
  assert.equal(JSON.parse(sessionJson({ ...base, takeSeq: 1 })).gap_ms_prev, undefined, 'the first recording has no gap');
  assert.equal(JSON.parse(sessionJson({ ...base, takeSeq: 2, modelBuild: 'not a build' })).decode.model_build, undefined);
  for (const bad of [{ takeSeq: 0 }, { takeSeq: 1.5 }, { gapMsPrev: 150 }, { gapMsPrev: -100 }, { gapMsPrev: 3600100 }]) assert.throws(() => sessionJson({ ...base, ...bad }), TypeError, JSON.stringify(bad));
  // never a recited range, text or a time: the keys are the 2.0.3 ones plus the three
  assert.deepEqual(Object.keys(j).filter((k) => !(k in plain)), ['gap_ms_prev', 'take_seq']);
  // a take list whose first entry starts after a pre-roll is a list
  assert.deepEqual(takeList([{ start_ms: 1000, gap_ms: 0 }, { start_ms: 6000, gap_ms: 2000 }]), [{ start_ms: 1000, gap_ms: 0 }, { start_ms: 6000, gap_ms: 2000 }]);
  assert.equal(takeList([{ start_ms: 1000, gap_ms: 100 }, { start_ms: 6000, gap_ms: 2000 }]), null);
});

test('real streams: two takes 2 s apart with a feed are one recording with the lead-in and the tail in it; 4 s apart are two with take_seq 1 and 2', { skip, timeout: 120000 }, async () => {
  const opus = await loadOpus();
  const s = seams(Date.parse('2026-11-11T10:00:00Z'));
  const storage = new MemoryStorage();
  const state = { enabled: true };
  const install = { v: null, get: async () => install.v, set: (v) => { install.v = v; } };
  const fetch = async () => new Response(JSON.stringify({ error: 'offline' }), { status: 503 });
  const sharing = await createSharing({ api: 'https://api.test', fetch, tokenProvider: async () => ({ token: 't', attested: false }), storage, consentVersion: 'share-2026-11-09',
    contributor: CONTRIBUTOR, enabled: () => state.enabled, flags: () => ({ contributions: true, upload_trust: { web: 'capped' } }), opus: async () => opus,
    device: { deviceClass: 'browser', osMajor: 14 }, clock: s.clock, timers: s.timers, lifecycle: {}, install, log: () => {} });
  const closed = [];
  sharing.recorder.onClosed = (r) => closed.push(r);
  const tone = (n, f) => Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * f * i) / 16000));
  const feed = (ms) => { for (let left = ms; left > 0; left -= 100) { s.to(s.now + 100); sharing.feed(tone(1600, 300), 16000, s.now); } };
  const take = async (seconds) => {
    const t = await sharing.startSession({ inputSampleRate: 16000, inputRoute: 'built_in', decode: { backend: 'exact', modelRevision: '4.0.0', modelBuild: 'b'.repeat(40) }, startedAt: s.now });
    t.push(tone(16000 * seconds, 440));
    s.to(s.now + 1000 * seconds);
    await t.finish({ endedAt: s.now });
    return t;
  };
  feed(1500);                       // 1.5 s before the first take: the last second is the lead-in
  const first = await take(3);
  feed(2000);                       // 2 s between the takes: 0.5 s tail, then the ring for the next lead-in
  const second = await take(2);
  assert.equal(second.id, first.id, 'one recording');
  feed(300);                        // the tail of the second take
  s.to(s.now + 4000);               // nothing follows: the window passes
  await sharing.recorder.settled();
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0].parts, [{ pre_roll: 16000, take: 48000, tail: 8000 }, { pre_roll: 16000, take: 32000, tail: 4800 }]);
  assert.equal(closed[0].samples, 16000 + 48000 + 8000 + 16000 + 32000 + 4800);
  assert.deepEqual(closed[0].takes, [{ start_ms: 1000, gap_ms: 0 }, { start_ms: 5500, gap_ms: 2000 }]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await storage.read(first.id, FILES.takes))), { takes: closed[0].takes });
  const ses = JSON.parse(new TextDecoder().decode(await storage.read(first.id, FILES.session)));
  assert.deepEqual([ses.take_seq, ses.gap_ms_prev, ses.decode.model_revision, ses.decode.model_build], [1, undefined, '4.0.0', 'b'.repeat(40)]);
  // the stream on disk is one valid Ogg Opus stream of exactly that much audio (at 48 kHz: three times the samples)
  const names = (await storage.list(first.id)).filter((n) => n.endsWith('.opus')).sort();
  const bytes = Buffer.concat(await Promise.all(names.map(async (n) => Buffer.from(await storage.read(first.id, n)))));
  const all = new Uint8Array(bytes);
  const info = checkStream(all, readPages(all)[0].serial);
  assert.equal(info.lastGranule, 312 + 3 * closed[0].samples, 'the final granule (pre-skip 312): pre-roll, takes and tails are all in the stream, and nothing else');
  // 4 s later a take with no feed: a new recording, take_seq 2, gap_ms_prev from the previous take's end
  const third = await take(1);
  assert.notEqual(third.id, first.id);
  s.to(s.now + 4000);
  await sharing.recorder.settled();
  assert.deepEqual([closed[1].takeSeq, closed[1].gapMsPrev, closed[1].takes, closed[1].parts], [2, 4300, null, [{ pre_roll: 0, take: 16000, tail: 0 }]]);
  const ses2 = JSON.parse(new TextDecoder().decode(await storage.read(third.id, FILES.session)));
  assert.deepEqual([ses2.take_seq, ses2.gap_ms_prev], [2, 4300]);
  assert.deepEqual(install.v, { seq: 2, prevEnd: s.now - 4000 }, 'kept for the next page load');
  // sharing off: what is fed is dropped at once and nothing is in memory after the call
  state.enabled = false;
  assert.deepEqual(sharing.feed(tone(1600, 300), 16000, s.now), { toTail: 0, toRing: 0, dropped: 1600, ringSamples: 0 });
  state.enabled = true;
  feed(500);
  assert.equal(sharing.recorder.ringSamples, 8000);
  await sharing.stop();
  assert.equal(sharing.recorder.ringSamples, 0, 'sharing went off: the ring is emptied at once');
});
