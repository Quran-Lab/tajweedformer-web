// SDK 2.0.3, back-to-back takes share one recording (web/sharing/takes.js, recorder.js): the shared vector
// takes_join.json replayed through the recorder (a clock seam and a timer seam: no test here waits for the join
// window), the join rules the vector leaves open, real streams with real libopus (three takes in a row are one
// recording whose bytes and decoded PCM equal one continuous encode; a gap over the window gives two valid
// streams), a page killed between takes and inside a take (recovered with its take list), the take list call
// (POST /v1/uploads/{id}/takes: once, after the last segment, the exact body; 404, 400, 401, 410, retries),
// withdrawal and background during the window, and the SDK's own wiring (the consent controller and the platform
// client's background hook). Tried and rejected: sleeping through the window with real timers (slow, and a
// loaded machine would join or split by chance); encoding the vector's 20 minute case with libopus (the
// recorder is what the case is about, so it runs there with a counting capture).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSharing, ShareRecorder, MemoryStorage, loadOpus, opusVersion, OggOpusWriter, OpusEncoder, ShareResampler, OPUS_SETTINGS, SEGMENT_PLAN,
  readPages, decodeOggOpus, segmentName, markers, recover, FILES, joinWindowMs, roundGap, takeStartMs, takeList, takesBody,
  DEFAULT_JOIN_MS, MAX_JOIN_MS, RECORDING_CAP_MS, MAX_TAKES, HOLD_MS, MAX_AGE_MS, SDK_VERSION, resetSharingForTests,
} from '../web/sharing/index.js';
import { enableSharing } from '../web/consent/index.js';
import { SERIAL, clipSeconds, concat, sameBytes, checkStream, ffmpeg, ffprobeDuration, decodeBoth } from './sharing_stream_checks.mjs';
import { stubApi, client, clip16k, listen } from './sharing_stub_api.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const vector = JSON.parse(readFileSync(path.join(root, 'test', 'sharing', 'vectors', 'takes_join.json'), 'utf8'));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const opus = have ? await loadOpus() : null;

const API = 'https://api.test';
const CONTRIBUTOR = 'c'.repeat(32);
const yieldNow = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------------------------------------------
// seams: a wall clock the test moves, and timers that fire only when the clock reaches them

function seams(start = 0) {
  const s = { now: start, pending: new Map(), seq: 0, armed: 0 };
  s.clock = () => s.now;
  s.timers = {
    setTimeout: (f, ms) => { const id = ++s.seq; s.armed++; s.pending.set(id, { f, at: s.now + ms }); return id; },
    clearTimeout: (id) => { s.pending.delete(id); },
  };
  /** Moves the clock to `t` and fires the timers due by then (in order). */
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
  s.advance = (ms) => s.to(s.now + ms);
  return s;
}

/** A capture that only counts (the recorder's seam): what a recording was given, and how it ended. */
function counting() {
  const made = [];
  const make = (opts) => {
    const c = {
      id: `rec-${made.length + 1}`, opts, failed: false, io: Promise.resolve(), settings: {}, segments: 0, error: null,
      samples: 0, pushes: 0, takes: null, ended: null,
      push(pcm) { this.samples += pcm.length; this.pushes++; },
      setTakes(t) { this.takes = t.map((x) => ({ ...x })); },
      async finish({ completed }) { this.ended = { how: 'finish', completed }; return Math.round(this.samples * 1000 / opts.inputSampleRate); },
      async abort() { this.failed = true; this.ended = { how: 'abort' }; },
      async discard() { this.failed = true; this.ended = { how: 'discard' }; },
      kill() { this.failed = true; },
    };
    made.push(c);
    return c;
  };
  return { made, make };
}

/** A recorder over counting captures, with what closed. */
function bench({ flags = {}, start = 0, enabled = () => true } = {}) {
  const s = seams(start);
  const caps = counting();
  const closed = [];
  const cfg = { flags };
  const rec = new ShareRecorder({ make: caps.make, flags: () => cfg.flags, clock: s.clock, timers: s.timers, onClosed: (r) => closed.push(r) });
  const zeros = new Float32Array(16000);
  /** One take: starts at `at` (wall ms), `samples` of audio, ends at `end`. */
  const take = async (at, samples, end, o = {}) => {
    s.to(at);
    const t = rec.take({ inputSampleRate: 16000, contributor: CONTRIBUTOR, consentVersion: 'deck-1', decode: { modelRevision: 'v4.0+abc' }, enabled, ...o });
    for (let left = samples; left > 0; left -= zeros.length) t.push(left >= zeros.length ? zeros : zeros.subarray(0, left));
    s.to(end);
    const ms = await t.finish({ completed: o.completed !== false });
    return { t, ms };
  };
  /** The end of the app's use: the open recording's window passes. */
  const end = async () => { s.advance(MAX_JOIN_MS + 1); await rec.settled(); };
  const shape = () => closed.map((r) => ({ rate: r.rate, audio_ms: r.audioMs, takes: r.takes }));
  return { s, rec, caps, closed, cfg, take, end, shape };
}

// ------------------------------------------------------------------------------------------------
// 1. the shared vector

test('the shared vector takes_join.json: every case through the recorder with the clock seam', async () => {
  assert.equal(vector.default_window_ms, DEFAULT_JOIN_MS);
  assert.equal(vector.cap_ms, RECORDING_CAP_MS);
  assert.equal(vector.cases.length, 10, 'the 10 cases of the vector');
  const names = [];
  for (const c of vector.cases) {
    const b = bench({ flags: c.flags });
    for (const e of c.events) {
      if (e.event === 'background') {
        b.s.to(e.wall_ms);
        await b.rec.background();
        b.rec.foreground(); // the app is in front again for the next take
        continue;
      }
      assert.equal(e.event, 'take', `unknown event ${e.event}`);
      await b.take(e.start_wall_ms, e.samples, e.end_wall_ms, { inputSampleRate: e.rate });
    }
    await b.end();
    assert.equal(b.rec.recording, null, `${c.name}: nothing left open`);
    assert.deepEqual(b.shape(), c.expect, c.name);
    // each recording got exactly its audio, and its take list (2 or more takes) where recovery reads it
    b.closed.forEach((r, i) => {
      const cap = b.caps.made.find((x) => x.id === r.id);
      assert.equal(cap.samples, r.samples, `${c.name}: recording ${i + 1} samples`);
      assert.deepEqual(cap.takes, r.takes, `${c.name}: recording ${i + 1} takes.json`);
      assert.equal(cap.ended.how, 'finish');
    });
    assert.equal(b.caps.made.length, c.expect.length, `${c.name}: one capture per recording`);
    names.push(c.name);
  }
  assert.ok(names.includes('the 20-minute cap: a new recording') && names.includes('gap rounding and odd sample counts'));
});

test('the join window of the signed config: a whole number 0 to 10000, anything else 3000', () => {
  for (const [v, want] of [[0, 0], [1, 1], [3000, 3000], [8000, 8000], [10000, 10000], [10001, 3000], [-1, 3000], [2.5, 3000], ['5', 3000], ['3000', 3000],
    [true, 3000], [false, 3000], [null, 3000], [undefined, 3000], [NaN, 3000], [Infinity, 3000], [[100], 3000], [{ ms: 100 }, 3000], [1e3, 1000]]) {
    assert.equal(joinWindowMs({ share_join_ms: v }), want, `share_join_ms ${JSON.stringify(v)}`);
  }
  assert.equal(joinWindowMs({}), 3000);
  assert.equal(joinWindowMs(null), 3000);
  assert.equal(joinWindowMs(undefined), 3000);
  assert.deepEqual([DEFAULT_JOIN_MS, MAX_JOIN_MS, RECORDING_CAP_MS, MAX_TAKES, HOLD_MS], [3000, 10000, 1200000, 256, 30000]);
});

test('gap rounding, take starts and the take list as the server takes it', () => {
  assert.deepEqual([0, 49, 50, 149, 150, 1200, 1249, 1250, 9949, 9950, 10000, 12000, -1, -5000].map(roundGap),
    [0, 0, 100, 100, 200, 1200, 1200, 1300, 9900, 10000, 10000, 10000, 0, 0]);
  assert.equal(takeStartMs(12345, 16000), 771);
  assert.equal(takeStartMs(12345 + 999, 16000), 834);
  assert.equal(takeStartMs(19184000, 16000), 1199000);
  const ok = [{ start_ms: 0, gap_ms: 0 }, { start_ms: 5000, gap_ms: 1200 }, { start_ms: 8000, gap_ms: 800 }];
  assert.deepEqual(takeList(ok), ok);
  assert.equal(takesBody(ok), '{"takes":[{"start_ms":0,"gap_ms":0},{"start_ms":5000,"gap_ms":1200},{"start_ms":8000,"gap_ms":800}]}');
  // a recording recovered at 7999 ms keeps the takes that start before it; fewer than 2: no list
  assert.deepEqual(takeList(ok, 8000), ok.slice(0, 2));
  assert.deepEqual(takeList(ok, 8001), ok);
  assert.equal(takeList(ok, 5000), null);
  for (const bad of [null, {}, [], [ok[0]], [{ start_ms: 1, gap_ms: 0 }, ok[1]], [{ start_ms: 0, gap_ms: 100 }, ok[1]], [ok[0], { start_ms: 0, gap_ms: 100 }],
    [ok[0], { start_ms: 5000, gap_ms: 150 }], [ok[0], { start_ms: 5000, gap_ms: 10100 }], [ok[0], { start_ms: 5000, gap_ms: -100 }],
    [ok[0], { start_ms: 5000.5, gap_ms: 100 }], [ok[0], { start_ms: '5000', gap_ms: 100 }], [ok[0], ok[2], ok[1]],
    [ok[0], ...Array.from({ length: 256 }, (_, i) => ({ start_ms: i + 1, gap_ms: 0 }))]]) {
    assert.equal(takeList(bad), null, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(takeList([ok[0], ...Array.from({ length: 255 }, (_, i) => ({ start_ms: i + 1, gap_ms: 0 }))]).length, 256);
});

// ------------------------------------------------------------------------------------------------
// the rules the vector leaves open (the same in every SDK), through the recorder

test('the window is decided by the clock: a timer that fires early closes nothing; the config changes it at once', async () => {
  const b = bench();
  await b.take(0, 16000, 1000);
  assert.equal(b.s.pending.size, 1, 'the window armed its timer');
  // the timer runs late or early: only the clock counts
  b.s.now = 3999;
  assert.equal(b.rec.checkWindow(), false, '2999 ms after the take: still open');
  b.s.now = 4000;
  assert.equal(b.rec.checkWindow(), false, 'exactly the window: still open (a take at this instant joins)');
  assert.ok(b.rec.recording);
  b.s.now = 4001;
  assert.equal(b.rec.checkWindow(), true, 'past the window: closed');
  await b.rec.settled();
  assert.equal(b.rec.recording, null);
  assert.deepEqual(b.shape(), [{ rate: 16000, audio_ms: 1000, takes: null }]);
  // the timer alone, through the seam
  await b.take(10000, 16000, 11000);
  b.s.to(14000);
  assert.ok(b.rec.recording, 'the timer has not fired at the window edge');
  b.s.to(14001);
  await b.rec.settled();
  assert.equal(b.rec.recording, null, 'the timer closed it one ms past the window');
  // the window in force when the decision is made: 8000 from the config, then 0
  b.cfg.flags = { share_join_ms: 8000 };
  await b.take(20000, 16000, 21000);
  await b.take(28500, 16000, 29500); // 7500 ms later: joins under 8000
  assert.deepEqual(b.rec.takes, [{ start_ms: 0, gap_ms: 0 }, { start_ms: 1000, gap_ms: 7500 }]);
  b.cfg.flags = { share_join_ms: 0 };
  await b.take(29600, 16000, 30600); // the config now says never
  await b.rec.settled();
  assert.equal(b.rec.recording, null, 'window 0: the recording closes when its take ends');
  assert.deepEqual(b.shape().slice(2), [{ rate: 16000, audio_ms: 2000, takes: [{ start_ms: 0, gap_ms: 0 }, { start_ms: 1000, gap_ms: 7500 }] },
    { rate: 16000, audio_ms: 1000, takes: null }]);
  assert.equal(b.s.pending.size, 0, 'no timer left');
});

test('a take without audio adds no entry and does not move the previous end; a take in the same millisecond adds none', async () => {
  const b = bench();
  await b.take(0, 16000, 2000);
  const silent = await b.take(3000, 0, 4500); // joins, pushes nothing
  assert.equal(silent.ms, 0);
  assert.ok(b.rec.recording, 'still inside the window of the take that had audio');
  await b.take(5000, 8000, 5600); // 3000 ms after the END OF THE TAKE WITH AUDIO: joins, gap 3000
  assert.deepEqual(b.rec.takes, [{ start_ms: 0, gap_ms: 0 }, { start_ms: 1000, gap_ms: 3000 }]);
  // a silent take cannot stretch the window: 3001 ms after the last audio the recording is closed
  await b.take(6000, 0, 8601);
  await b.rec.settled();
  assert.equal(b.rec.recording, null, 'closed when the silent take ended past the window');
  assert.deepEqual(b.shape(), [{ rate: 16000, audio_ms: 1500, takes: [{ start_ms: 0, gap_ms: 0 }, { start_ms: 1000, gap_ms: 3000 }] }]);
  // strictly increasing start_ms: 5 samples at 16 kHz do not reach the next millisecond
  const c = bench();
  await c.take(0, 16000, 1000);
  await c.take(1100, 5, 1200); // start 1000
  await c.take(1300, 16000, 2300); // start floor(16005 / 16) = 1000 again: no entry, its audio joins
  await c.take(2400, 160, 2500); // start 2000
  await c.end();
  assert.deepEqual(c.shape(), [{ rate: 16000, audio_ms: 2010, takes: [{ start_ms: 0, gap_ms: 0 }, { start_ms: 1000, gap_ms: 100 }, { start_ms: 2000, gap_ms: 100 }] }]);
  assert.equal(c.caps.made[0].samples, 16000 + 5 + 16000 + 160);
});

test('a take joins only the recording of its contributor, consent version, consent text and model; route and backend may differ', async () => {
  const same = bench();
  await same.take(0, 16000, 1000, { inputRoute: 'built_in', decode: { modelRevision: 'v4.0+abc', backend: 'exact' } });
  await same.take(1500, 16000, 2500, { inputRoute: 'bluetooth', decode: { modelRevision: 'v4.0+abc', backend: 'neuralEngine' } });
  await same.end();
  assert.equal(same.closed.length, 1, 'another route and backend still join');
  assert.equal(same.caps.made[0].opts.inputRoute, 'built_in', 'the session JSON keeps the first take\'s');
  for (const [what, o] of [['contributor', { contributor: 'd'.repeat(32) }], ['consent version', { consentVersion: 'deck-2' }],
    ['consent text', { consentTextSha256: 'e'.repeat(64) }], ['model revision', { decode: { modelRevision: 'v4.0+def' } }]]) {
    const b = bench();
    await b.take(0, 16000, 1000);
    await b.take(1500, 16000, 2500, o);
    await b.end();
    assert.deepEqual(b.shape(), [{ rate: 16000, audio_ms: 1000, takes: null }, { rate: 16000, audio_ms: 1000, takes: null }], `another ${what}: a new recording`);
  }
  // sharing off when the next take starts: no join, and the open recording ends
  let on = true;
  const off = bench({ enabled: () => on });
  await off.take(0, 16000, 1000);
  on = false;
  await off.take(1500, 16000, 2500);
  await off.rec.settled();
  assert.equal(off.closed.length, 2);
  assert.equal(off.rec.recording, null);
});

test('256 takes at most: the 257th starts a new recording', async () => {
  const b = bench();
  let at = 0;
  for (let i = 0; i < 257; i++) { await b.take(at, 160, at + 10); at += 110; }
  await b.end();
  assert.equal(b.closed.length, 2);
  assert.equal(b.closed[0].takes.length, 256);
  assert.equal(b.closed[0].samples, 256 * 160);
  assert.ok(b.closed[0].takes.every((t, i, a) => i === 0 || t.start_ms > a[i - 1].start_ms), 'strictly increasing');
  assert.deepEqual(b.closed[0].takes[255], { start_ms: 2550, gap_ms: 100 });
  assert.deepEqual(b.closed[1].takes, null);
  assert.ok(takeList(b.closed[0].takes), 'a list the server takes');
});

test('the 20 minute cap, live: held within 30 s of the cap (joins when it fits, a new recording when it outgrows the room); whole beyond', async () => {
  const S = 16000;
  // 29 s of room: the take is held, fits (20 s), and joins when it ends
  const fits = bench();
  await fits.take(0, 1171 * S, 1171000);
  fits.s.to(1171500);
  const t = fits.rec.take({ inputSampleRate: S, contributor: CONTRIBUTOR, consentVersion: 'deck-1', decode: { modelRevision: 'v4.0+abc' } });
  const second = new Float32Array(S);
  for (let i = 0; i < 20; i++) t.push(second);
  assert.equal(fits.caps.made[0].samples, 1171 * S, 'held: nothing reached the recording yet');
  assert.equal(fits.caps.made[0].takes, null);
  fits.s.to(1191500);
  assert.equal(await t.finish(), 20000);
  assert.equal(fits.caps.made[0].samples, 1191 * S, 'the held take joined when it ended');
  assert.deepEqual(fits.caps.made[0].takes, [{ start_ms: 0, gap_ms: 0 }, { start_ms: 1171000, gap_ms: 500 }]);
  await fits.end();
  assert.deepEqual(fits.shape(), [{ rate: S, audio_ms: 1191000, takes: [{ start_ms: 0, gap_ms: 0 }, { start_ms: 1171000, gap_ms: 500 }] }]);
  // exactly the cap fits (recording ms + take ms <= cap)
  const edge = bench();
  await edge.take(0, 1190 * S, 1190000);
  await edge.take(1190100, 10 * S, 1200100);
  await edge.rec.settled();
  assert.deepEqual(edge.shape(), [{ rate: S, audio_ms: 1200000, takes: [{ start_ms: 0, gap_ms: 0 }, { start_ms: 1190000, gap_ms: 100 }] }], 'at the cap it closes with the take');
  // one sample more than fits: the recording closes without the take
  const over = bench();
  await over.take(0, 1190 * S, 1190000);
  await over.take(1190100, 10 * S + 16, 1200200);
  await over.end();
  assert.deepEqual(over.shape(), [{ rate: S, audio_ms: 1190000, takes: null }, { rate: S, audio_ms: 10001, takes: null }]);
  assert.equal(over.caps.made[1].samples, 10 * S + 16, 'the held audio went to the new recording, whole');
  // 31 s of room: the take joins at once, stays whole past the cap, and the recording closes with it
  const whole = bench();
  await whole.take(0, 1169 * S, 1169000);
  whole.s.to(1169500);
  const w = whole.rec.take({ inputSampleRate: S, contributor: CONTRIBUTOR, consentVersion: 'deck-1', decode: { modelRevision: 'v4.0+abc' } });
  w.push(second);
  assert.equal(whole.caps.made[0].samples, 1170 * S, 'not held: its audio goes in as it comes');
  for (let i = 0; i < 39; i++) w.push(second);
  whole.s.to(1209500);
  await w.finish();
  await whole.rec.settled();
  assert.equal(whole.rec.recording, null, 'past 20 minutes: closed when the take ended');
  await whole.take(1209600, S, 1210600);
  await whole.end();
  assert.deepEqual(whole.shape(), [{ rate: S, audio_ms: 1209000, takes: [{ start_ms: 0, gap_ms: 0 }, { start_ms: 1169000, gap_ms: 500 }] },
    { rate: S, audio_ms: 1000, takes: null }]);
});

test('background, the close call, sharing off, a take that never ended', async () => {
  // background between takes closes now; in the background nothing joins
  const b = bench();
  await b.take(0, 16000, 1000);
  await b.rec.background();
  assert.equal(b.rec.recording, null);
  assert.equal(b.closed[0].completed, true);
  await b.take(1200, 16000, 2200); // still in the background: its recording closes with it
  await b.rec.settled();
  assert.equal(b.rec.recording, null);
  b.rec.foreground();
  await b.take(2300, 16000, 3300);
  assert.ok(b.rec.recording, 'in the foreground again the window opens');
  // background while a take runs: the recording closes when the take ends
  b.s.to(3400);
  const t = b.rec.take({ inputSampleRate: 16000, contributor: CONTRIBUTOR, consentVersion: 'deck-1', decode: { modelRevision: 'v4.0+abc' } });
  t.push(new Float32Array(16000));
  await b.rec.background();
  assert.ok(b.rec.recording, 'the take is still running');
  t.push(new Float32Array(16000));
  b.s.to(5400);
  await t.finish();
  assert.equal(b.rec.recording, null);
  assert.deepEqual(b.shape(), [{ rate: 16000, audio_ms: 1000, takes: null }, { rate: 16000, audio_ms: 1000, takes: null },
    { rate: 16000, audio_ms: 3000, takes: [{ start_ms: 0, gap_ms: 0 }, { start_ms: 1000, gap_ms: 100 }] }]);
  // the close call: now between takes, at the take's end while one runs
  const c = bench();
  await c.take(0, 16000, 1000);
  await c.rec.closeRecording();
  assert.equal(c.rec.recording, null);
  c.s.to(1100);
  const u = c.rec.take({ inputSampleRate: 16000, contributor: CONTRIBUTOR, consentVersion: 'deck-1', decode: {} });
  u.push(new Float32Array(8000));
  await c.rec.closeRecording();
  assert.ok(c.rec.recording);
  c.s.to(1600);
  await u.finish();
  assert.equal(c.rec.recording, null, 'closed with the take, no window');
  assert.equal(c.s.pending.size, 0);
  // sharing off between takes: the recording is discarded at once; a running take records nothing more
  const d = bench();
  await d.take(0, 16000, 1000);
  await d.rec.stop();
  assert.equal(d.rec.recording, null);
  assert.equal(d.caps.made[0].ended.how, 'discard');
  assert.equal(d.s.pending.size, 0, 'the window timer is gone');
  d.s.to(1100);
  const v = d.rec.take({ inputSampleRate: 16000, contributor: CONTRIBUTOR, consentVersion: 'deck-1', decode: {} });
  v.push(new Float32Array(16000));
  await d.rec.stop();
  v.push(new Float32Array(16000));
  assert.equal(d.caps.made[1].samples, 16000, 'nothing after sharing went off');
  assert.equal(await v.finish(), 0);
  assert.equal(d.caps.made[1].ended.how, 'discard');
  // a take that never ended: it ends, not completed, when the next one starts, which joins it
  const e = bench();
  e.s.to(0);
  const first = e.rec.take({ inputSampleRate: 16000, contributor: CONTRIBUTOR, consentVersion: 'deck-1', decode: {} });
  first.push(new Float32Array(16000));
  e.s.to(1000);
  const next = e.rec.take({ inputSampleRate: 16000, contributor: CONTRIBUTOR, consentVersion: 'deck-1', decode: {} });
  next.push(new Float32Array(16000));
  first.push(new Float32Array(16000)); // an ended take records nothing
  e.s.to(2000);
  await next.finish({ completed: true });
  await e.end();
  assert.deepEqual(e.shape(), [{ rate: 16000, audio_ms: 2000, takes: [{ start_ms: 0, gap_ms: 0 }, { start_ms: 1000, gap_ms: 0 }] }]);
  assert.equal(e.closed[0].completed, true, 'completed is the last take\'s');
  // completed false of the last take with audio; a later silent take does not change it
  const f = bench();
  await f.take(0, 16000, 1000);
  await f.take(1500, 16000, 2500, { completed: false });
  await f.take(3000, 0, 3100, { completed: true });
  await f.end();
  assert.equal(f.closed[0].completed, false);
  assert.equal(f.caps.made[0].ended.completed, false);
});

// ------------------------------------------------------------------------------------------------
// the real pipeline: libopus, storage, the outbox, a stub qlab-api and R2

class Server {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.down = false;
    this.seen = []; // [{ method, path, headers, body }]
    this.objects = new Map();
    this.takes = () => null; // (k, rec) => {status, body} for the k-th take list call; 'down' throws
    this.takeCalls = 0;
    this.fetch = this.fetch.bind(this);
  }
  urls(id, from) {
    const exp = Math.floor(this.now() / 1000) + 604800;
    return { id, urls: Array.from({ length: 20 }, (_, i) => from + i).map((n) => ({ n, expires_at: exp, url: `https://r2.test/v1/${id}/${segmentName(n)}.opus` })) };
  }
  async fetch(url, init = {}) {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const rec = { method: init.method || 'GET', path: u.pathname, headers, body: init.body };
    this.seen.push(rec);
    if (this.down) throw new TypeError('fetch failed (offline)');
    const res = (status, obj) => new Response(status === 204 ? null : typeof obj === 'string' ? obj : JSON.stringify(obj), { status });
    if (u.host === 'api.test' && u.pathname === '/v1/uploads') return res(201, this.urls(headers['x-qlab-id'], 1));
    let m = /^\/v1\/uploads\/([0-9a-f]{32})\/urls$/.exec(u.pathname);
    if (m) return res(200, this.urls(m[1], Number(u.searchParams.get('from'))));
    m = /^\/v1\/uploads\/([0-9a-f]{32})\/takes$/.exec(u.pathname);
    if (m && rec.method === 'POST') {
      const r = this.takes(++this.takeCalls, rec);
      if (r === 'down') throw new TypeError('fetch failed (offline)');
      return r ? res(r.status, r.body || {}) : res(204);
    }
    if (u.host === 'r2.test' && rec.method === 'PUT') {
      this.objects.set(u.pathname, new Uint8Array(init.body));
      return res(200, '');
    }
    return res(404, { error: 'not_found' });
  }
  starts() { return this.seen.filter((x) => x.path === '/v1/uploads'); }
  puts(id) { return this.seen.filter((x) => x.method === 'PUT' && (!id || x.path.includes(id))); }
  lists(id) { return this.seen.filter((x) => /\/takes$/.test(x.path) && (!id || x.path.includes(id))); }
  segments(id) { return [...this.objects].filter(([k]) => k.includes(`/v1/${id}/`)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v); }
}

async function pipeline(server, { storage = new MemoryStorage(), flags = {}, s = seams(Date.now()), state = { enabled: true }, lifecycle = {} } = {}) {
  server.now = s.clock;
  const tokens = { n: 0, invalidated: 0 };
  const tokenProvider = async () => ({ token: `qlt_v1.eyJ2IjoxfQ.t${tokens.n}`, attested: false });
  tokenProvider.invalidate = async () => { tokens.invalidated++; tokens.n++; };
  const issues = [], logs = [], closed = [];
  const sharing = await createSharing({ api: API, fetch: server.fetch, tokenProvider, storage, consentVersion: 'share-2026-11-09', contributor: CONTRIBUTOR,
    enabled: () => state.enabled, flags: () => ({ contributions: true, upload_trust: { web: 'capped' }, ...flags }), opus: async () => opus,
    device: { deviceClass: 'browser', osMajor: 14 }, random: () => 0.5, clock: s.clock, timers: s.timers, lifecycle,
    onIssue: (kind, code) => issues.push([kind, code]), log: (m) => logs.push(m) });
  sharing.recorder.onClosed = (r) => closed.push(r);
  return { sharing, outbox: sharing.outbox, recorder: sharing.recorder, storage, s, state, tokens, issues, logs, closed, server };
}

/** One take through the pipeline: `pcm` at `rate` in 40 ms pieces, as a microphone gives them. */
async function say(p, pcm, rate, { completed = true, ms = Math.round(pcm.length * 1000 / rate), serial, end = true } = {}) {
  const t = await p.sharing.startSession({ inputSampleRate: rate, inputRoute: 'built_in', decode: { backend: 'exact', modelRevision: 'v4.0+abc' }, serial });
  const step = Math.round(rate * 0.04);
  for (let i = 0; i < pcm.length; i += step) t.push(pcm.subarray(i, Math.min(pcm.length, i + step)));
  p.s.advance(ms); // the take lasted as long as its audio
  if (end) await t.finish({ completed });
  else await t.io;
  return t;
}

/** Drains until `count` items satisfy `done` (no waiting: the stub answers at once). */
async function settle(outbox, done = (x) => x.status !== 'queued', count = 1) {
  for (let i = 0; i < 300; i++) {
    await outbox.drain({ ignoringBackoff: true });
    const items = await outbox.items();
    if (items.length >= count && items.filter(done).length >= count) return items;
    await yieldNow();
  }
  throw new Error(`not settled: ${JSON.stringify(await outbox.items())}`);
}

/** One continuous encode of `pcm` with the segment plan and the given bitrate per segment: the reference. */
function continuous(pcm, rate, bitrates, serial = SERIAL) {
  const segs = new Map();
  const encoder = new OpusEncoder(opus, { sampleRate: 48000, settings: { ...OPUS_SETTINGS, bitrate: bitrates[0] } });
  const w = new OggOpusWriter({
    encoder, resampler: rate === 48000 ? null : new ShareResampler(rate), inputRate: rate, plan: SEGMENT_PLAN, settings: OPUS_SETTINGS, serial,
    vendor: `QuranLab SDK ${SDK_VERSION} ${opusVersion(opus)}`, bitrate: (n) => (n > 1 ? bitrates[n - 1] : null),
    onPage: (n, b) => { if (!segs.has(n)) segs.set(n, []); segs.get(n).push(b); },
  });
  // fed in 40 ms pieces from the start of the whole audio: other piece edges than the takes had
  const step = Math.round(rate * 0.04);
  for (let i = 0; i < pcm.length; i += step) w.append(pcm.subarray(i, Math.min(pcm.length, i + step)));
  w.finish();
  encoder.free();
  const files = [...segs.keys()].sort((a, b) => a - b).map((n) => concat(segs.get(n)));
  return { files, all: concat(files) };
}

const asBytes = (f32) => new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);

test('the shared vector through the real pipeline: recordings, their audio, takes and take lists as the server gets them', { skip }, async () => {
  for (const c of vector.cases) {
    if (c.events.some((e) => e.samples > 16000 * 60)) continue; // the 20 minute case runs through the recorder above
    const server = new Server();
    const p = await pipeline(server, { flags: c.flags });
    const t0 = p.s.now;
    for (const e of c.events) {
      if (e.event === 'background') { p.s.to(t0 + e.wall_ms); await p.sharing.background(); p.sharing.foreground(); continue; }
      p.s.to(t0 + e.start_wall_ms);
      await say(p, clipSeconds(e.rate, e.samples / e.rate), e.rate, { ms: e.end_wall_ms - e.start_wall_ms });
    }
    p.s.advance(MAX_JOIN_MS + 1);
    await p.recorder.settled();
    const items = await settle(p.outbox, (x) => x.status === 'uploaded', c.expect.length);
    assert.equal(items.length, c.expect.length, `${c.name}: recordings`);
    assert.equal(server.starts().length, c.expect.length, `${c.name}: one start per recording`);
    c.expect.forEach((want, i) => {
      const item = items[i];
      const ses = JSON.parse(server.starts().find((x) => x.headers['x-qlab-id'] === item.id).body);
      assert.equal(ses.audio.input_sample_rate, want.rate, `${c.name}: rate of recording ${i + 1}`);
      assert.ok(Math.abs(item.durationMs - want.audio_ms) <= 1, `${c.name}: ${item.durationMs} ms for ${want.audio_ms}`);
      assert.equal(p.closed[i].audioMs, want.audio_ms, `${c.name}: audio ms of recording ${i + 1}`);
      assert.deepEqual(p.closed[i].takes, want.takes, `${c.name}: takes of recording ${i + 1}`);
      assert.equal(item.takes, want.takes ? want.takes.length : 1, `${c.name}: the item's take count`);
      assert.equal(item.completed, true);
      const all = concat(server.segments(item.id));
      // every check of the stream test (it wants more than a second of audio pages; the 0.9 s case has one page)
      const pages = want.audio_ms >= 2000 ? checkStream(all, readPages(all)[0].serial).pages : readPages(all);
      pages.forEach((pg, k) => assert.equal(pg.sequence, k, `${c.name}: page sequence`));
      assert.equal(pages[pages.length - 1].flags & 0x04, 0x04, `${c.name}: EOS on the last page`);
      assert.equal(decodeOggOpus(opus, pages).length, Math.ceil(p.closed[i].samples * 48000 / want.rate), `${c.name}: decoded length`);
      const lists = server.lists(item.id);
      if (want.takes) {
        assert.equal(lists.length, 1, `${c.name}: one take list call`);
        assert.equal(lists[0].body, takesBody(want.takes), `${c.name}: the exact body`);
        assert.equal(item.takeList, 'sent');
      } else {
        assert.equal(lists.length, 0, `${c.name}: one take sends no list`);
        assert.equal(item.takeList, null);
      }
    });
  }
});

// 2. three takes in a row: one recording, equal to one continuous encode
for (const [label, rate] of [['16 kHz through the resampler', 16000], ['48 kHz direct', 48000]]) {
  test(`three takes in a row (gaps 1.2 s and 0.8 s) are ONE recording whose bytes and decoded PCM equal one continuous encode, ${label}`, { skip }, async () => {
    // the self-test clip, 47.3 s, cut where no 40 ms piece, no 20 ms Opus frame and no page ends: the second
    // take completes the frame the first left open; segments are cut inside takes (10 s, 30 s)
    const pcm = clipSeconds(rate, 47.3);
    const n1 = Math.floor(rate * 12.3137) + 7, n2 = Math.floor(rate * 18.0711) + 3;
    const takes = [pcm.subarray(0, n1), pcm.subarray(n1, n1 + n2), pcm.subarray(n1 + n2)];
    assert.ok(n1 % (rate / 50) !== 0 && (n1 + n2) % (rate / 50) !== 0, 'the cuts are inside Opus frames');
    const server = new Server();
    const p = await pipeline(server);
    const first = await say(p, takes[0], rate, { serial: SERIAL });
    assert.ok(p.recorder.recording, 'the recording stays open after the take');
    const id = first.id;
    // the ladder steps down between the takes: the segment that opens inside take 2 is coded at 96 kbit/s
    await p.outbox.drain();
    p.sharing.ladder.uploadFailed();
    p.s.advance(1200);
    const second = await say(p, takes[1], rate);
    p.s.advance(800);
    const third = await say(p, takes[2], rate);
    assert.deepEqual([second.id, third.id], [id, id], 'every take has the recording\'s id');
    assert.equal(await p.storage.read(id, FILES.end), null, 'still open: no end.json');
    const start2 = Math.floor(n1 * 1000 / rate), start3 = Math.floor((n1 + n2) * 1000 / rate);
    const want = [{ start_ms: 0, gap_ms: 0 }, { start_ms: start2, gap_ms: 1200 }, { start_ms: start3, gap_ms: 800 }];
    assert.equal(new TextDecoder().decode(await p.storage.read(id, FILES.takes)), takesBody(want), 'takes.json as the takes joined');
    assert.equal((await p.outbox.item(id)).takes, 3, 'the open item counts its takes');
    p.s.advance(DEFAULT_JOIN_MS + 1); // no fourth take: the window passes
    await p.recorder.settled();
    const [item] = await settle(p.outbox, (x) => x.status === 'uploaded');
    assert.equal((await p.outbox.items()).length, 1, 'ONE recording');
    assert.equal(server.starts().length, 1, 'one session JSON, at the first take');
    assert.deepEqual([item.id, item.takes, item.completed, item.durationMs, item.takeList], [id, 3, true, Math.round(pcm.length * 1000 / rate), 'sent']);
    assert.deepEqual(item.segmentBitrates, [192000, 192000, 96000], 'the ladder across takes: each segment at the rung in force when it opened');
    const end = JSON.parse(new TextDecoder().decode(await p.storage.read(id, FILES.end)));
    assert.deepEqual(end, { durationMs: item.durationMs, completed: true, takes: 3 });
    // every check of the append test on the concatenated segments
    const files = server.segments(id);
    assert.equal(files.length, 3, '47.3 s is three segments (10, 20, then the rest)');
    const all = concat(files);
    const st = checkStream(all);
    const total = Math.ceil(pcm.length * 48000 / rate);
    assert.equal(st.lastGranule, 312 + total, 'the final granule: pre-skip plus the takes\' samples at 48 kHz');
    const dec = decodeOggOpus(opus, st.pages);
    assert.equal(dec.length, takes.reduce((k, t) => k + t.length, 0) * 48000 / rate, 'decoded length: exactly the sum of the takes\' samples at 48 kHz');
    // one continuous encode of the same audio, the same segment plan and bitrates
    const ref = continuous(pcm, rate, item.segmentBitrates);
    assert.equal(ref.files.length, files.length);
    files.forEach((f, i) => assert.ok(sameBytes(f, ref.files[i]), `segment ${i + 1}: ${f.length} bytes vs ${ref.files[i].length} of the continuous encode`));
    assert.ok(sameBytes(all, ref.all), 'the recording\'s bytes are the continuous encode\'s');
    const refDec = decodeOggOpus(opus, readPages(ref.all));
    assert.ok(sameBytes(asBytes(dec), asBytes(refDec)), 'decoded PCM bit-identical to the continuous encode');
    // the take list: after the last segment, once
    const order = server.seen.filter((x) => x.method === 'PUT' || /\/takes$/.test(x.path)).map((x) => x.path.split('/').pop());
    assert.deepEqual(order, ['seg-00001.opus', 'seg-00002.opus', 'seg-00003.opus', 'takes']);
    assert.equal(server.lists(id)[0].body, takesBody(want));
    console.log(`# ${label}: 3 takes (${takes.map((t) => (t.length / rate).toFixed(3)).join(' + ')} s), ${files.map((f) => f.length).join('+')} bytes in ${files.length} segments, ` +
      `${st.pages.length} pages, ${dec.length} samples decoded, bytes and PCM equal to the continuous encode`);
    if (ffmpeg) {
      const dir = mkdtempSync(path.join(tmpdir(), 'ogg-takes-'));
      try {
        const fa = path.join(dir, 'takes.ogg'), fb = path.join(dir, 'continuous.ogg');
        writeFileSync(fa, all); writeFileSync(fb, ref.all);
        const pr = ffprobeDuration(fa);
        assert.equal(pr.streams[0].codec_name, 'opus');
        assert.equal(Number(pr.streams[0].channels), 1);
        const dur = Number(pr.format.duration);
        assert.ok(Math.abs(dur - pcm.length / rate) < 0.02, `ffprobe duration ${dur} for ${pcm.length / rate} s`);
        const a = decodeBoth(fa), b = decodeBoth(fb);
        assert.ok(sameBytes(a.native, b.native), 'ffmpeg native decoder: takes == continuous');
        assert.ok(sameBytes(a.libopus, b.libopus), 'ffmpeg libopus decoder: takes == continuous');
        assert.equal(a.native.length / 2, total, 'ffmpeg native: exact sample count');
        assert.equal(a.libopus.length / 2, total, 'ffmpeg libopus: exact sample count');
        console.log(`# ${label}: ffprobe ${dur.toFixed(3)} s; ffmpeg native and libopus decode ${a.native.length / 2} samples, bit-identical to the continuous encode`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
}

// 3. a gap over the window
test('a gap over the window gives two recordings, each a valid stream', { skip }, async () => {
  const rate = 16000;
  const pcm = clipSeconds(rate, 17);
  const server = new Server();
  const p = await pipeline(server);
  await say(p, pcm.subarray(0, 12 * rate), rate);
  p.s.advance(DEFAULT_JOIN_MS + 1); // one ms too late: the window's timer closed the recording
  await p.recorder.settled();
  assert.equal(p.recorder.recording, null);
  await say(p, pcm.subarray(12 * rate), rate);
  p.s.advance(DEFAULT_JOIN_MS + 1);
  await p.recorder.settled();
  const items = await settle(p.outbox, (x) => x.status === 'uploaded', 2);
  assert.deepEqual(items.map((x) => [x.durationMs, x.completed, x.takes, x.takeList]), [[12000, true, 1, null], [5000, true, 1, null]]);
  assert.equal(server.starts().length, 2);
  assert.equal(server.lists().length, 0, 'no take list for a recording of one take');
  const serials = new Set();
  for (const [i, item] of items.entries()) {
    const all = concat(server.segments(item.id));
    const serial = readPages(all)[0].serial;
    serials.add(serial);
    const st = checkStream(all, serial); // headers, sequence from 0, granules, EOS on its last page
    assert.equal(decodeOggOpus(opus, st.pages).length, [12, 5][i] * 48000);
    assert.equal(await p.storage.read(item.id, FILES.takes), null);
  }
  assert.equal(serials.size, 2, 'two streams');
});

// 4. a page killed between takes, and inside the second take
test('a page killed between takes and inside the second take: one recording recovered with its takes.json, uploaded with the take list', { skip }, async () => {
  const rate = 16000;
  const pcm = clipSeconds(rate, 30);
  const n1 = Math.floor(rate * 12.3137) + 7;
  const start2 = Math.floor(n1 * 1000 / rate);
  const ref = continuous(pcm, rate, [192000, 192000, 192000]);
  const refDec = decodeOggOpus(opus, readPages(ref.all));
  // [what, seconds of take 2 before the kill, whether take 2 ended, the take list expected]
  for (const [what, s2, ended, list] of [
    ['between takes (in the window after take 2)', 9.4, true, [{ start_ms: 0, gap_ms: 0 }, { start_ms: start2, gap_ms: 1200 }]],
    ['inside take 2, 6 s in', 6, false, [{ start_ms: 0, gap_ms: 0 }, { start_ms: start2, gap_ms: 1200 }]],
    ['inside take 2, before a page of it was written', 0.3, false, null],
  ]) {
    const server = new Server();
    server.down = true; // nothing went up before the kill
    const p = await pipeline(server);
    const first = await say(p, pcm.subarray(0, n1), rate, { serial: SERIAL });
    const id = first.id;
    p.s.advance(1200);
    await say(p, pcm.subarray(n1, n1 + Math.round(s2 * rate)), rate, { end: ended });
    if (ended) p.s.advance(500);
    await p.outbox.drain();
    assert.equal(new TextDecoder().decode(await p.storage.read(id, FILES.takes)), takesBody([{ start_ms: 0, gap_ms: 0 }, { start_ms: start2, gap_ms: 1200 }]),
      `${what}: takes.json was written when take 2 joined`);
    assert.equal(await p.storage.read(id, FILES.end), null, `${what}: the recording was open`);
    // the page is gone: what storage holds now is all the next load finds
    const disk = p.storage.snapshot();
    p.recorder.kill();
    p.outbox.stopped = true;
    server.down = false;
    const q = await pipeline(server, { storage: disk, s: p.s });
    await q.outbox.resume();
    const [item] = await settle(q.outbox, (x) => x.status === 'uploaded');
    assert.equal((await q.outbox.items()).length, 1, `${what}: ONE recording`);
    assert.equal(item.id, id);
    assert.equal(item.completed, false, `${what}: a recovered recording is not complete`);
    const all = concat(server.segments(id));
    const pages = readPages(all);
    pages.forEach((pg, i) => assert.equal(pg.sequence, i, 'sequence numbers continuous'));
    assert.equal(pages[pages.length - 1].flags & 0x04, 0, 'no end-of-stream flag: closed at its last whole page');
    const g = pages[pages.length - 1].granule;
    assert.equal(item.durationMs, Math.trunc((g - 312) / 48), 'the recovered duration is the last whole page');
    const dec = decodeOggOpus(opus, pages);
    assert.ok(dec.length > 0 && sameBytes(asBytes(dec), asBytes(refDec.subarray(0, dec.length))), `${what}: a prefix of the continuous encode's decode`);
    const lists = server.lists(id);
    if (list) {
      assert.ok(item.durationMs > start2, `${what}: audio of take 2 was kept (${item.durationMs} ms)`);
      assert.equal(item.takes, 2);
      assert.equal(lists.length, 1, `${what}: the take list went up`);
      assert.equal(lists[0].body, takesBody(list));
      assert.equal(lists[0].headers['x-qlab-contributor'], CONTRIBUTOR);
      assert.equal(item.takeList, 'sent');
      const order = server.seen.filter((x) => (x.method === 'PUT' || /\/takes$/.test(x.path)) && x.path.includes(id)).map((x) => x.path.split('/').pop());
      assert.equal(order[order.length - 1], 'takes', 'after the last segment');
    } else {
      assert.ok(item.durationMs <= start2, `${what}: no audio of take 2 was kept (${item.durationMs} ms of ${start2})`);
      assert.equal(item.takes, 1, `${what}: the take that left no audio is not in the list`);
      assert.equal(lists.length, 0, `${what}: fewer than 2 takes left, no list`);
      assert.equal(item.takeList, null);
    }
    assert.equal(await disk.read(id, FILES.takes), null, 'takes.json is gone once the list is sent or dropped');
    console.log(`# killed ${what}: recovered ${item.durationMs} ms in ${item.segments} segments, takes ${item.takes}, take list ${lists.length ? lists[0].body : 'none'}`);
  }
});

// 5. the take list call
/** Three takes (5 s, 3 s, 4 s at 16 kHz, gaps 1.2 s and 0.8 s: the vector's first case), the recording closed. */
async function threeTakes(p) {
  const pcm = clipSeconds(16000, 12);
  const first = await say(p, pcm.subarray(0, 80000), 16000);
  p.s.advance(1200);
  await say(p, pcm.subarray(80000, 128000), 16000);
  p.s.advance(800);
  await say(p, pcm.subarray(128000), 16000);
  await p.sharing.closeRecording();
  return first.id;
}
const BODY = '{"takes":[{"start_ms":0,"gap_ms":0},{"start_ms":5000,"gap_ms":1200},{"start_ms":8000,"gap_ms":800}]}';

test('the take list call: once, after the last segment, the exact body; one take sends none', { skip }, async () => {
  const server = new Server();
  const p = await pipeline(server);
  const id = await threeTakes(p);
  const [item] = await settle(p.outbox, (x) => x.status === 'uploaded');
  assert.deepEqual([item.status, item.takes, item.takeList, item.segments], ['uploaded', 3, 'sent', 2]);
  const mine = server.seen.filter((x) => x.path.includes(id) || x.headers['x-qlab-id'] === id);
  assert.deepEqual(mine.map((x) => `${x.method} ${x.path.replace(id, 'ID')}`),
    ['POST /v1/uploads', 'PUT /v1/ID/seg-00001.opus', 'PUT /v1/ID/seg-00002.opus', 'POST /v1/uploads/ID/takes']);
  const call = server.lists(id)[0];
  assert.equal(call.body, BODY);
  assert.deepEqual(Object.keys(call.headers).sort(), ['authorization', 'content-type', 'x-qlab-contributor']);
  assert.equal(call.headers.authorization, 'Bearer qlt_v1.eyJ2IjoxfQ.t0');
  assert.equal(call.headers['x-qlab-contributor'], CONTRIBUTOR);
  assert.equal(call.headers['content-type'], 'application/json');
  for (let i = 0; i < 5; i++) await p.outbox.drain({ ignoringBackoff: true });
  assert.equal(server.lists().length, 1, 'never sent again');
  assert.equal(await p.storage.read(id, FILES.takes), null, 'takes.json goes once the list is sent');
  assert.deepEqual([p.issues, p.logs], [[], []]);
  // one take: no call
  await say(p, clipSeconds(16000, 3), 16000);
  await p.sharing.closeRecording();
  const items = await settle(p.outbox, (x) => x.status === 'uploaded', 2);
  assert.deepEqual([items[1].takes, items[1].takeList], [1, null]);
  assert.equal(server.lists().length, 1);
});

test('the take list call: a 404 drops it without failing the session (logged once); 410 drops; 400 drops with the issue', { skip }, async () => {
  // a server without the route: the stub's 404 not_found for every unknown path
  const server = new Server();
  server.takes = () => ({ status: 404, body: { error: 'not_found' } });
  const p = await pipeline(server);
  const a = await threeTakes(p);
  const b = await threeTakes(p);
  const items = await settle(p.outbox, (x) => x.status === 'uploaded', 2);
  assert.deepEqual(items.map((x) => [x.id, x.status, x.takes, x.takeList, x.failCode]), [[a, 'uploaded', 3, 'dropped', null], [b, 'uploaded', 3, 'dropped', null]]);
  assert.equal(server.lists().length, 2, 'one call per recording, never again');
  for (let i = 0; i < 5; i++) await p.outbox.drain({ ignoringBackoff: true });
  assert.equal(server.lists().length, 2);
  assert.equal(p.logs.length, 1, 'logged once');
  assert.match(p.logs[0], /take list/);
  assert.deepEqual(p.issues, []);
  assert.equal(await p.storage.read(a, FILES.takes), null);
  // 410: the upload was deleted; 400: a refused body is never sent again, and the issue is raised
  for (const [status, error, issue] of [[410, 'upload_deleted', []], [400, 'invalid_body', [['other', 'takes:invalid_body']]]]) {
    const s2 = new Server();
    s2.takes = () => ({ status, body: { error } });
    const q = await pipeline(s2);
    const id = await threeTakes(q);
    const [item] = await settle(q.outbox, (x) => x.status === 'uploaded');
    assert.deepEqual([item.status, item.takeList, item.takes], ['uploaded', 'dropped', 3], String(status));
    for (let i = 0; i < 5; i++) await q.outbox.drain({ ignoringBackoff: true });
    assert.equal(s2.lists(id).length, 1, `${status}: not sent again`);
    assert.deepEqual(q.issues, issue, String(status));
    assert.deepEqual(q.logs, []);
    assert.equal(await q.storage.read(id, FILES.takes), null);
  }
});

test('the take list call: 401 renews the token and sends again; a network failure, 429 and 503 retry the same body with the outbox backoff, across a reload', { skip }, async () => {
  // 401: the token is renewed and the same body goes again at once
  const s1 = new Server();
  s1.takes = (k) => (k === 1 ? { status: 401, body: { error: 'invalid_token' } } : null);
  const p = await pipeline(s1);
  const id1 = await threeTakes(p);
  const [i1] = await settle(p.outbox, (x) => x.status === 'uploaded' && x.takeList === 'sent');
  assert.equal(i1.id, id1);
  assert.equal(p.tokens.invalidated, 1, 'the token was renewed once');
  assert.deepEqual(s1.lists(id1).map((x) => [x.headers.authorization, x.body]), [['Bearer qlt_v1.eyJ2IjoxfQ.t0', BODY], ['Bearer qlt_v1.eyJ2IjoxfQ.t1', BODY]]);
  // no connection for the take list only: the session is uploaded, the list waits
  const s2 = new Server();
  s2.takes = (k) => (k <= 2 ? 'down' : null);
  const q = await pipeline(s2);
  const id2 = await threeTakes(q);
  await q.outbox.drain();
  let item = await q.outbox.item(id2);
  assert.deepEqual([item.status, item.takeList, item.takes, item.lastError], ['uploaded', 'pending', 3, null], 'uploaded whatever becomes of the list');
  assert.equal(s2.lists(id2).length, 1);
  assert.equal(new TextDecoder().decode(await q.storage.read(id2, FILES.takes)), BODY, 'the list is kept');
  assert.equal(q.sharing.ladder.bitrate, 192000, 'a take list failure is not an upload failure for the bitrate');
  // not before its backoff (30 s, jitter 1.0 here)
  await q.outbox.drain();
  q.s.advance(29000);
  await q.outbox.drain();
  assert.equal(s2.lists(id2).length, 1, 'not again before the backoff');
  q.s.advance(1001);
  await q.outbox.drain();
  assert.equal(s2.lists(id2).length, 2, 'again after 30 s');
  assert.equal((await q.outbox.item(id2)).takeList, 'pending', 'the second try failed too');
  // the page is reloaded: the list is still there, and goes up with the same body
  const disk = q.storage.snapshot();
  q.outbox.stopped = true;
  const r = await pipeline(s2, { storage: disk, s: q.s });
  item = await r.outbox.item(id2);
  assert.deepEqual([item.status, item.takeList, item.takes], ['uploaded', 'pending', 3], 'after the reload');
  await r.outbox.resume();
  assert.equal(s2.lists(id2).length, 2, 'the backoff holds across the reload (60 s after the second failure)');
  r.s.advance(60001);
  await r.outbox.drain();
  item = await r.outbox.item(id2);
  assert.deepEqual([item.status, item.takeList], ['uploaded', 'sent']);
  assert.deepEqual(s2.lists(id2).map((x) => x.body), [BODY, BODY, BODY], 'every try sent the same body');
  assert.equal(await disk.read(id2, FILES.takes), null);
  assert.equal(s2.puts(id2).length, 2, 'no segment was sent again');
  // 429 and 503: later, the same body
  for (const status of [429, 503]) {
    const s3 = new Server();
    s3.takes = (k) => (k === 1 ? { status, body: { error: status === 429 ? 'rate_limited' : 'unavailable' } } : null);
    const t = await pipeline(s3);
    const id3 = await threeTakes(t);
    await t.outbox.drain();
    assert.deepEqual([(await t.outbox.item(id3)).status, (await t.outbox.item(id3)).takeList], ['uploaded', 'pending'], String(status));
    await t.outbox.drain();
    assert.equal(s3.lists(id3).length, 1, `${status}: not before the backoff`);
    t.s.advance(30001);
    await t.outbox.drain();
    assert.equal((await t.outbox.item(id3)).takeList, 'sent', String(status));
    assert.deepEqual(s3.lists(id3).map((x) => x.body), [BODY, BODY]);
    assert.equal(t.sharing.ladder.bitrate, 192000);
  }
});

// 6. withdrawal, background, the config's window
test('withdrawal during the join window: the recording ends at once and the queue is deleted; a waiting take list is dropped', { skip }, async () => {
  const server = new Server();
  server.down = true;
  const p = await pipeline(server);
  const t = await say(p, clipSeconds(16000, 12), 16000);
  const id = t.id;
  assert.ok(p.recorder.recording, 'in its join window');
  assert.ok((await p.storage.sessions()).includes(id));
  assert.equal(p.s.pending.size, 1, 'the window\'s timer is armed');
  p.state.enabled = false; // the learner turned sharing off
  await p.sharing.stop();
  assert.equal(p.recorder.recording, null, 'ended at once, not at the end of the window');
  assert.deepEqual(await p.storage.sessions(), [], 'the queue is deleted, the open recording with it');
  assert.deepEqual(await p.outbox.items(), []);
  assert.equal(p.s.pending.size, 0);
  server.down = false;
  p.s.advance(MAX_JOIN_MS);
  await p.outbox.resume();
  assert.equal(server.puts().length, 0, 'nothing was sent');
  await say(p, clipSeconds(16000, 3), 16000);
  await p.recorder.settled();
  assert.deepEqual(await p.storage.sessions(), [], 'a take after the withdrawal is not recorded');
  // withdrawal while a take list waits: nothing more is sent
  const s2 = new Server();
  s2.takes = () => 'down';
  const q = await pipeline(s2);
  const id2 = await threeTakes(q);
  await q.outbox.drain();
  assert.equal((await q.outbox.item(id2)).takeList, 'pending');
  q.state.enabled = false;
  await q.sharing.stop();
  assert.equal((await q.outbox.item(id2)).takeList, 'dropped');
  assert.equal(await q.storage.read(id2, FILES.takes), null);
  s2.takes = () => null;
  q.state.enabled = true;
  q.s.advance(3600000);
  await q.outbox.resume();
  assert.equal(s2.lists(id2).length, 1, 'the dropped list is never sent');
  // a list that waited 7 days (the age limit of unsent sessions) is dropped too
  const s3 = new Server();
  s3.takes = () => ({ status: 503, body: { error: 'unavailable' } });
  const r = await pipeline(s3);
  const id3 = await threeTakes(r);
  await r.outbox.drain();
  assert.deepEqual([(await r.outbox.item(id3)).status, (await r.outbox.item(id3)).takeList], ['uploaded', 'pending']);
  r.s.advance(MAX_AGE_MS + 1000);
  await r.outbox.drain();
  assert.deepEqual([(await r.outbox.item(id3)).status, (await r.outbox.item(id3)).takeList], ['uploaded', 'dropped']);
  assert.equal(await r.storage.read(id3, FILES.takes), null);
  assert.equal(s3.lists(id3).length, 1, 'not sent again once it is too old');
});

test('background during the join window closes the recording (the page hidden, the pipeline\'s call); the config\'s window 0 and 8000', { skip }, async () => {
  // the page's own events, through the lifecycle seam
  const listeners = {};
  const doc = { visibilityState: 'visible', addEventListener: (name, f) => { listeners[name] = f; } };
  const win = { addEventListener: (name, f) => { listeners[name] = f; } };
  const server = new Server();
  const p = await pipeline(server, { lifecycle: { document: doc, window: win } });
  assert.deepEqual(Object.keys(listeners).sort(), ['pagehide', 'pageshow', 'visibilitychange']);
  const t = await say(p, clipSeconds(16000, 5), 16000);
  assert.ok(p.recorder.recording);
  doc.visibilityState = 'hidden';
  listeners.visibilitychange();
  await p.recorder.settled();
  assert.equal(p.recorder.recording, null, 'the hidden page closed it');
  let [item] = await settle(p.outbox, (x) => x.status === 'uploaded');
  assert.deepEqual([item.id, item.completed, item.durationMs, item.takes], [t.id, true, 5000, 1]);
  checkStream(concat(server.segments(t.id)), readPages(server.segments(t.id)[0])[0].serial); // EOS on its last page
  doc.visibilityState = 'visible';
  listeners.visibilitychange();
  // 500 ms later, well inside the window: a new recording all the same
  p.s.advance(500);
  const u = await say(p, clipSeconds(16000, 3), 16000);
  assert.notEqual(u.id, t.id);
  // pagehide, then the pipeline's own call
  listeners.pagehide();
  await p.recorder.settled();
  assert.equal(p.recorder.recording, null);
  listeners.pageshow();
  p.s.advance(100);
  await say(p, clipSeconds(16000, 3), 16000);
  await p.sharing.background();
  assert.equal(p.recorder.recording, null);
  p.sharing.foreground();
  const items = await settle(p.outbox, (x) => x.status === 'uploaded', 3);
  assert.deepEqual(items.map((x) => [x.completed, x.takes]), [[true, 1], [true, 1], [true, 1]]);
  // share_join_ms 0: the recording closes with its take, as before 2.0.3 (no timer at all)
  const zero = await pipeline(new Server(), { flags: { share_join_ms: 0 } });
  await say(zero, clipSeconds(16000, 3), 16000);
  assert.equal(zero.recorder.recording, null);
  assert.equal(zero.s.armed, 0, 'no window, no timer');
  zero.s.advance(100);
  await say(zero, clipSeconds(16000, 3), 16000);
  assert.equal((await settle(zero.outbox, (x) => x.status === 'uploaded', 2)).length, 2);
  // share_join_ms 8000: a take 7 s later joins (the default would not)
  const wide = await pipeline(new Server(), { flags: { share_join_ms: 8000 } });
  const w1 = await say(wide, clipSeconds(16000, 3), 16000);
  wide.s.advance(7000);
  const w2 = await say(wide, clipSeconds(16000, 3), 16000);
  assert.equal(w2.id, w1.id);
  wide.s.advance(8001);
  await wide.recorder.settled();
  [item] = await settle(wide.outbox, (x) => x.status === 'uploaded');
  assert.deepEqual([item.takes, item.durationMs, item.takeList], [2, 6000, 'sent']);
  assert.equal(wide.server.lists()[0].body, '{"takes":[{"start_ms":0,"gap_ms":0},{"start_ms":3000,"gap_ms":7000}]}');
});

test('a partial recording: the 2 s minimum counts the recording\'s whole audio; completed is the last take\'s', { skip }, async () => {
  const server = new Server();
  const p = await pipeline(server);
  // two cancelled takes of 1.2 s: 2.4 s in all, shared, not completed
  await say(p, clipSeconds(16000, 1.2), 16000, { completed: false });
  p.s.advance(500);
  await say(p, clipSeconds(16000, 1.2), 16000, { completed: false });
  await p.sharing.closeRecording();
  let items = await settle(p.outbox, (x) => x.status === 'uploaded');
  assert.deepEqual(items.map((x) => [x.durationMs, x.completed, x.takes]), [[2400, false, 2]]);
  // one cancelled take of 1.2 s alone: under 2 s, nothing is shared
  await say(p, clipSeconds(16000, 1.2), 16000, { completed: false });
  await p.sharing.closeRecording();
  assert.equal((await p.outbox.items()).length, 1);
  assert.equal((await p.storage.sessions()).length, 1);
  // a cancelled take, then a completed one: completed
  await say(p, clipSeconds(16000, 1.2), 16000, { completed: false });
  p.s.advance(500);
  await say(p, clipSeconds(16000, 0.5), 16000, { completed: true });
  await p.sharing.closeRecording();
  items = await settle(p.outbox, (x) => x.status === 'uploaded', 2);
  assert.deepEqual([items[1].durationMs, items[1].completed, items[1].takes], [1700, true, 2]);
});

test('a recording abandoned mid-take (abort) ends at its last whole page with the takes that left audio', { skip }, async () => {
  const server = new Server();
  server.down = true;
  const p = await pipeline(server);
  const pcm = clipSeconds(16000, 25);
  await say(p, pcm.subarray(0, 12 * 16000), 16000);
  p.s.advance(1000);
  const t = await say(p, pcm.subarray(12 * 16000, 20 * 16000), 16000, { end: false });
  await t.abort();
  assert.equal(p.recorder.recording, null);
  server.down = false;
  const [item] = await settle(p.outbox, (x) => x.status === 'uploaded');
  assert.deepEqual([item.completed, item.takes, item.takeList], [false, 2, 'sent']);
  assert.equal(server.lists(t.id)[0].body, '{"takes":[{"start_ms":0,"gap_ms":0},{"start_ms":12000,"gap_ms":1000}]}');
  assert.ok(item.durationMs > 12000 && item.durationMs < 20000);
});

// ------------------------------------------------------------------------------------------------
// the SDK's own wiring: QuranLab -> enableSharing -> createSharingSession -> the recorder

test('through the SDK wiring: two takes in a row are one shared session with its take list; the platform client\'s background closes it', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'share-takes-wiring-'));
  const cwd = process.cwd();
  process.chdir(dir); // the outbox's Node storage is <cwd>/.quranlab
  resetSharingForTests();
  try {
    const api = await stubApi({ contributions: true });
    const ql = await client(api);
    const ctl = enableSharing(ql, { lang: 'en', ask: async () => ({ yes: true }) });
    ctl.setSharing(true);
    const pcm = clip16k(12);
    await listen(ctl, pcm, { complete: false });
    // the ask after a finished take does not close the recording
    assert.equal(await ctl.sessionCompleted({ feedback: true }), null);
    const mod = await import('../web/sharing/index.js');
    const sharing = await mod.outbox.sharing();
    assert.ok(sharing.recorder.recording, 'the recording waits for the next take');
    const id = sharing.recorder.recording.cap.id;
    await listen(ctl, pcm, { complete: false }); // a moment later, inside the window
    assert.equal(sharing.recorder.recording.cap.id, id, 'the second take joined');
    assert.equal(sharing.recorder.takes.length, 2);
    await ctl.closeRecording(); // the app knows no take follows
    assert.equal(sharing.recorder.recording, null);
    for (let i = 0; i < 100 && api.state.takes.length < 1; i++) { await ctl.outbox.resume(); await yieldNow(); }
    assert.equal(api.state.starts.length, 1, 'one session JSON for both takes');
    assert.equal(api.state.takes.length, 1, 'the take list went up');
    const list = JSON.parse(api.state.takes[0].body);
    assert.equal(api.state.takes[0].id, id);
    assert.equal(api.state.takes[0].contributor, ql.contributor());
    assert.deepEqual(list.takes[0], { start_ms: 0, gap_ms: 0 });
    assert.equal(list.takes.length, 2);
    assert.equal(list.takes[1].start_ms, 12000);
    assert.ok(list.takes[1].gap_ms % 100 === 0 && list.takes[1].gap_ms <= 3000, `gap ${list.takes[1].gap_ms}`);
    const keys = [...api.state.puts.keys()].filter((k) => k.includes(id)).sort();
    const pages = readPages(new Uint8Array(Buffer.concat(keys.map((k) => api.state.puts.get(k)))));
    assert.equal(pages[pages.length - 1].flags & 0x04, 0x04);
    assert.equal(decodeOggOpus(opus, pages).length, 24 * 48000, 'one stream of both takes');
    const [item] = (await ctl.outbox.items()).filter((x) => x.id === id);
    assert.deepEqual([item.status, item.takes, item.takeList, item.completed], ['uploaded', 2, 'sent', true]);
    // the platform client's background hook (the page hidden) closes the open recording
    await listen(ctl, pcm, { complete: false });
    assert.ok(sharing.recorder.recording);
    await ql.background();
    await sharing.recorder.settled();
    assert.equal(sharing.recorder.recording, null, 'ql.background() closed it');
    assert.equal(sharing.recorder.backgrounded, true);
    ql.foreground();
    await yieldNow();
    assert.equal(sharing.recorder.backgrounded, false);
    // withdrawal in the window: the open recording goes with the queue
    await listen(ctl, pcm, { complete: false });
    assert.ok(sharing.recorder.recording);
    ctl.setSharing(false);
    await mod.outbox.stop();
    assert.equal(sharing.recorder.recording, null);
    for (let i = 0; i < 200 && (await ctl.outbox.pending()).length; i++) await yieldNow(); // the switch's own stop() ends
    assert.equal((await ctl.outbox.pending()).length, 0);
    // on again in the same page: the next take is shared (the stopped pipeline takes sessions again)
    const before = api.state.starts.length;
    ctl.setSharing(true);
    await listen(ctl, pcm, { complete: false });
    await ctl.closeRecording();
    for (let i = 0; i < 100 && api.state.starts.length === before; i++) { await ctl.outbox.resume(); await yieldNow(); }
    assert.equal(api.state.starts.length, before + 1, 'a take after off and on is shared');
  } finally {
    process.chdir(cwd);
    resetSharingForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recover() keeps a take list only for takes with audio before the recovered end (the files, without a pipeline)', { skip }, async () => {
  const storage = new MemoryStorage();
  const id = 'a'.repeat(32);
  const te = new TextEncoder();
  // 9 s in one segment: the two header pages, nine audio pages of a second each, the end page
  const seg = continuous(clipSeconds(16000, 9), 16000, [192000]).files[0];
  const ends = [];
  for (let at = 0; at < seg.length;) {
    const n = seg[at + 26];
    let len = 27 + n;
    for (let i = 0; i < n; i++) len += seg[at + 27 + i];
    at += len;
    ends.push(at);
  }
  assert.equal(ends.length, 12);
  const three = [{ start_ms: 0, gap_ms: 0 }, { start_ms: 3000, gap_ms: 500 }, { start_ms: 8000, gap_ms: 300 }];
  // [whole audio pages on disk when the page was killed, the recovered duration, the take list left]
  for (const [audioPages, ms, want] of [[9, 8993, three], [8, 7993, three.slice(0, 2)], [3, 2993, null]]) {
    await storage.removeSession(id);
    await storage.write(id, FILES.session, te.encode('{}'));
    await storage.write(id, FILES.capture, te.encode(JSON.stringify({ preSkip: 312, bitrates: { 1: 192000 } })));
    await storage.write(id, FILES.takes, te.encode(takesBody(three)));
    await storage.write(id, segmentName(1) + '.opus', seg.subarray(0, ends[1 + audioPages] + 100)); // and a torn page
    assert.equal(await recover(storage, id), true);
    const end = JSON.parse(new TextDecoder().decode(await storage.read(id, FILES.end)));
    const [m] = await markers(storage, id);
    assert.equal(m.bytes, ends[1 + audioPages], 'cut back to the last whole page');
    assert.equal(end.durationMs, ms);
    assert.equal(end.completed, false);
    if (want) {
      assert.equal(new TextDecoder().decode(await storage.read(id, FILES.takes)), takesBody(want), `${audioPages} pages: the takes that start before ${ms} ms`);
      assert.equal(end.takes, want.length);
    } else {
      assert.equal(await storage.read(id, FILES.takes), null, `${audioPages} pages: fewer than 2 takes left, no list`);
      assert.equal('takes' in end, false);
    }
  }
});
