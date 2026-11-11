// Every place where audio or results wait in memory has a bound and a defined behaviour when it is reached:
//   a Session: the take's length, the audio waiting for the engine (behind a microphone, and pushed by the
//   app), the chunks and events nobody reads; the Microphone's unread blocks; the sharing feed's ring (one
//   array of one second) and the fed audio on its way to the pipeline; a take's audio waiting for the sharing
//   session to start; a take held near the 20 minute cap.
// Each test would fail if its bound were removed, and none can run away: a fixed number of pushes, small
// buffers, a clock the test moves. Checks compare numbers and booleans only: a failing assert.equal on an
// object makes Node print the whole object graph behind it (a recording reaches its encoder and its storage).
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TajweedError, Microphone } from '../web/index.js';
import { createClient, resetClientForTests } from '../web/api/client.js';
import { Channel, CHUNKS_LIMIT, EVENTS_LIMIT, MAX_TAKE_MS, MAX_PENDING_MS, MAX_PENDING_SAMPLES } from '../web/api/session.js';
import { MIC_QUEUE_BLOCKS } from '../web/api/microphone.js';
import { ShareRecorder } from '../web/sharing/recorder.js';
import { RECORDING_CAP_MS, HOLD_MS } from '../web/sharing/takes.js';
import { START_WAIT_MS, FEED_WAIT_S, FEED_MAX_S } from '../web/consent/index.js';
import { loadOpus, resetSharingForTests, outbox } from '../web/sharing/index.js';
import { build3, stubPlatform, seamsFor, KEY } from './helpers/model3.mjs';
import { fakeMicrophone, fakePage } from './helpers/fakemic.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const haveOpus = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!haveOpus && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const build = await build3();
const code = (c) => (e) => e instanceof TajweedError && e.code === c;
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function setup({ limits, sharing = false, extra = {} } = {}) {
  resetClientForTests();
  resetSharingForTests();
  const api = await stubPlatform({ build, flags: { analytics: true, issues: true, contributions: sharing } });
  const mic = fakeMicrophone({ sampleRate: 48000 });
  const seams = seamsFor(api, { microphone: mic.seams, lifecycle: fakePage(), limits,
    ...(sharing ? { sharingOptions: { lang: 'en', ask: async () => ({ yes: true }) } } : {}), ...extra });
  const client = await createClient({ key: KEY }, seams);
  const model = await client.model();
  return { client, model, mic, seams, host: seams.host };
}

// the fake engine, held back until release() is called
function gated(host) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const push = host.push.bind(host);
  host.push = async (s) => { await gate; return push(s); };
  return release;
}

test('the constants: 20 minutes a take and a recording, 256 chunks and 64 events waiting, 30 s behind a microphone', () => {
  assert.equal(MAX_TAKE_MS, 1200000);
  assert.equal(RECORDING_CAP_MS, 1200000);
  assert.equal(CHUNKS_LIMIT, 256);
  assert.equal(EVENTS_LIMIT, 64);
  assert.equal(MAX_PENDING_MS, 30000);
  assert.equal(MAX_PENDING_SAMPLES, 57600000);
  assert.equal(MIC_QUEUE_BLOCKS, 1500);
  assert.equal(START_WAIT_MS, 30000);
});

test('an iterator nobody reads keeps its newest values: the oldest is dropped past the limit', async () => {
  const ch = new Channel(4);
  assert.equal(ch.limit, 4);
  for (let i = 0; i < 10; i++) ch.push(i);
  assert.equal(ch.q.length, 4);
  assert.equal(ch.dropped, 6);
  ch.close();
  const got = [];
  for await (const v of ch) got.push(v);
  assert.deepEqual(got, [6, 7, 8, 9]);
  // a reader that is waiting gets each value at once: nothing is queued, nothing dropped
  const live = new Channel(1);
  const it = live[Symbol.asyncIterator]();
  for (let i = 0; i < 5; i++) { const next = it.next(); live.push(i); assert.equal((await next).value, i); }
  assert.equal(live.dropped, 0);
});

test('a take has an end: at the longest take it ends by itself (ended: limit) with its Heads, for pushed audio and for the microphone', async () => {
  const { model, mic } = await setup({ limits: { maxTakeMs: 1000 } });
  const events = [];
  const session = model.session({ context: 'c16_l64', onEvent: (ev) => events.push(ev) });
  assert.equal(session._chunks.limit, CHUNKS_LIMIT);
  assert.equal(session._events.limit, EVENTS_LIMIT);
  session.push(new Float32Array(8000));
  session.push(new Float32Array(12000)); // 0.25 s past the end: the audio up to the limit is taken
  assert.equal(session._samples, 16000, 'the samples over the end were not taken');
  assert.throws(() => session.push(new Float32Array(1)), code('session_closed'));
  const heads = await session.finish();
  assert.equal(heads.get('log_probs').frames, 32, 'one second in chunks of 320 ms, the last one padded: every Head is kept');
  const last = events[events.length - 1];
  assert.deepEqual([last.type, last.reason, 'error' in last], ['ended', 'limit', false]);
  const chunks = [];
  for await (const c of session.chunks) chunks.push(c.decoded.isFinal);
  assert.equal(chunks[chunks.length - 1], true, 'the last chunk is final');
  assert.equal(session._counts, true, 'it counts like any take that ended with its Heads');
  // the microphone: the take ends by itself and the device is released
  const got = [];
  const heard = await model.listen({ onEvent: (ev) => got.push(ev.type + ':' + (ev.reason || '')) });
  mic.play(new Float32Array(2 * 48000));
  assert.equal(heard._samples, 48000, 'exactly the longest take was taken');
  assert.equal(mic.track.stopped, true, 'the microphone is released');
  const h2 = await heard.finish();
  assert.equal(h2.get('log_probs').frames > 0, true);
  assert.equal(got[got.length - 1], 'ended:limit');
  await model.close();
});

test('an engine slower than the microphone: at most the allowed audio waits, then the take ends with engine_failed', async () => {
  const { model, mic, host } = await setup({ limits: { maxPendingMs: 200 } });
  const release = gated(host);
  const events = [];
  const session = await model.listen({ onEvent: (ev) => events.push(ev) });
  mic.play(new Float32Array(48000)); // 50 blocks of 20 ms while the engine answers nothing
  assert.equal(session._pending <= 9600, true, `${session._pending} samples wait, 200 ms at 48 kHz is 9600`);
  assert.equal(session._pending > 0, true);
  assert.equal(mic.track.stopped, true, 'the microphone is released at once');
  release();
  await assert.rejects(session.finish(), code('engine_failed'));
  const last = events[events.length - 1];
  assert.deepEqual([last.type, last.reason, last.error.code], ['ended', 'error', 'engine_failed']);
  await model.close();
});

test('audio the app pushes ahead of the engine: past the allowed amount push throws and the take ends', async () => {
  const { model, host } = await setup({ limits: { maxPendingSamples: 16000 } });
  const release = gated(host);
  const session = model.session();
  session.push(new Float32Array(8000));
  session.push(new Float32Array(8000)); // exactly the allowed amount
  assert.throws(() => session.push(new Float32Array(1)), code('invalid_argument'));
  assert.equal(session._pending, 16000);
  release();
  await assert.rejects(session.finish(), code('invalid_argument'));
  // one push larger than the allowed amount is taken when nothing waits (the take's length bounds it)
  const { model: m2 } = await setup({ limits: { maxPendingSamples: 16000 } });
  const s2 = m2.session();
  s2.push(new Float32Array(32000));
  const heads = await s2.finish();
  assert.equal(heads.get('log_probs').frames >= 50, true, 'the two seconds were decoded');
  await m2.close();
  await model.close();
});

test('chunks and events of a Session nobody reads: the newest stay, the take still gives its whole Heads', async () => {
  const { model, client } = await setup({ limits: { chunks: 3 } });
  const session = model.session({ context: 'c16_l64' });
  session.push(new Float32Array(10 * 5120)); // ten chunks of 320 ms
  const heads = await session.finish();
  assert.equal(heads.get('log_probs').frames, 80, 'the Heads hold every frame');
  assert.equal(session._chunks.q.length, 3);
  assert.equal(session._chunks.dropped >= 7, true, `${session._chunks.dropped} dropped`);
  assert.equal((await client.diagnose()).droppedChunks, session._chunks.dropped, 'diagnose() counts them');
  const got = [];
  for await (const c of session.chunks) got.push(c);
  assert.equal(got.length, 3);
  assert.equal(got[2].decoded.isFinal, true, 'the last chunk is among them');
  await model.close();
});

test('Microphone.samples(): a reader that stops reading keeps the newest blocks only', async () => {
  const fm = fakeMicrophone({ sampleRate: 48000 });
  const mic = await Microphone.open(fm.seams);
  const it = mic.samples()[Symbol.asyncIterator]();
  fm.play(new Float32Array(960 * (MIC_QUEUE_BLOCKS + 200)));
  assert.equal(mic._queue.length, MIC_QUEUE_BLOCKS);
  assert.equal((await it.next()).value.length, 960);
  mic.close();
});

test('the feed ring is one array of exactly one second, however the app feeds', () => {
  let now = 1000;
  const rec = new ShareRecorder({ make: () => { throw new Error('no recording in this test'); }, clock: () => now });
  // 5000 buffers of 1 ms
  const tiny = new Float32Array(16);
  for (let i = 0; i < 5000; i++) { now += 1; tiny.fill(i); rec.feed(tiny, 16000, now); }
  assert.deepEqual(Object.keys(rec.ring).sort(), ['at', 'buf', 'rate', 'samples', 'start'], 'no list that grows with the calls');
  assert.equal(rec.ring.buf.length, 16000);
  assert.equal(rec.ringSamples, 16000);
  let copy = rec._ringCopy();
  assert.deepEqual([copy.length, copy[0], copy[15], copy[16], copy[15999]], [16000, 4000, 4000, 4001, 4999], 'the last second, oldest first');
  // one buffer of five seconds: its last second
  const long = new Float32Array(80000);
  for (let i = 0; i < long.length; i++) long[i] = i;
  now += 5000;
  rec.feed(long, 16000, now);
  copy = rec._ringCopy();
  assert.deepEqual([rec.ring.buf.length, copy.length, copy[0], copy[15999]], [16000, 16000, 64000, 79999]);
  // another rate: a new ring of that rate's second
  now += 10;
  rec.feed(new Float32Array(480), 48000, now);
  assert.deepEqual([rec.ring.buf.length, rec.ringSamples], [48000, 480]);
  // a rate no microphone has is dropped before anything is allocated
  const r = rec.feed(new Float32Array(10), 1e9, now);
  assert.deepEqual([r.dropped, rec.ring.buf.length], [10, 48000]);
  // not allowed: nothing stays, the array goes too
  rec.feed(new Float32Array(480), 48000, now, false);
  assert.deepEqual([rec.ringSamples, rec.ring.buf === null], [0, true]);
});

test('a take held near the 20 minute cap holds at most the room that was left (30 s or less), then moves to a new recording', async () => {
  let now = 0;
  const made = [];
  const make = (opts) => {
    const c = { id: `rec-${made.length + 1}`, failed: false, io: Promise.resolve(), settings: {}, segments: 0, error: null, samples: 0,
      push(pcm) { this.samples += pcm.length; }, setTakes() {}, async finish() { return Math.round(this.samples / 8); }, async abort() { this.failed = true; },
      async discard() { this.failed = true; }, kill() {} };
    made.push(c);
    return c;
  };
  const rec = new ShareRecorder({ make, clock: () => now, timers: { setTimeout: () => 1, clearTimeout: () => {} } });
  const block = new Float32Array(8000); // one second at 8 kHz
  const opts = { inputSampleRate: 8000, contributor: 'c'.repeat(32) };
  const first = rec.take({ ...opts, startedAt: now });
  for (let i = 0; i < 19 * 60 + 45; i++) first.push(block); // 15 s of room under the cap
  now = 1185000;
  await first.finish({ endedAt: now });
  now += 1000;
  const second = rec.take({ ...opts, startedAt: now });
  assert.equal(Array.isArray(second.held), true, 'the take is held: whether it fits is known when it ends');
  let most = 0;
  for (let i = 0; i < 60; i++) {
    second.push(block);
    most = Math.max(most, second.heldSamples);
    if (i >= 15) assert.equal(second.held === null, true, `second ${i + 1}: nothing is held past the room`);
  }
  assert.equal(most, 15 * 8000, 'at most the 15 s of room were ever held');
  assert.equal(most <= (HOLD_MS / 1000) * 8000, true);
  assert.equal(made.length, 2, 'the take went on in a new recording');
  assert.deepEqual([made[0].samples, made[1].samples], [(RECORDING_CAP_MS / 1000 - 15) * 8000, 60 * 8000]);
  await second.finish({ endedAt: now + 60000 });
  await rec.settled();
});

test('a recording never holds more than 20 minutes: a take that crosses the cap goes on in a new recording at the next sample', async () => {
  let now = 0;
  const made = [], closed = [];
  const make = (opts) => {
    const c = { id: `rec-${made.length + 1}`, takeSeq: opts.takeSeq, gapMsPrev: opts.gapMsPrev, failed: false, io: Promise.resolve(), settings: {}, segments: 0,
      error: null, samples: 0, most: 0,
      push(pcm) { this.samples += pcm.length; this.most = Math.max(this.most, this.samples); }, setTakes() {},
      async finish({ completed }) { this.completed = completed; return Math.round(this.samples / 8); }, async abort() { this.failed = true; },
      async discard() { this.failed = true; }, kill() {} };
    made.push(c);
    return c;
  };
  const rec = new ShareRecorder({ make, clock: () => now, timers: { setTimeout: () => 1, clearTimeout: () => {} },
    onClosed: (r) => closed.push([r.id, r.samples, r.completed, r.takeSeq, r.gapMsPrev, r.takes === null]) });
  const cap = (RECORDING_CAP_MS / 1000) * 8000;
  const block = new Float32Array(7000); // not a divisor of the cap: the cut falls inside a buffer
  const take = rec.take({ inputSampleRate: 8000, contributor: 'c'.repeat(32), startedAt: now });
  const pushes = Math.ceil((45 * 60 * 8000) / 7000); // 45 minutes: two caps crossed
  for (let i = 0; i < pushes; i++) take.push(block);
  assert.equal(made.length, 3);
  assert.deepEqual(made.map((c) => c.most <= cap), [true, true, true], 'no recording ever held more than the cap');
  assert.deepEqual(made.map((c) => c.samples), [cap, cap, pushes * 7000 - 2 * cap], 'every sample of the take is in one of them');
  assert.deepEqual(made.map((c) => [c.takeSeq, c.gapMsPrev]), [[1, null], [2, 0], [3, 0]], 'the continuation: the next take_seq, gap_ms_prev 0');
  now = 2700000;
  const ms = await take.finish({ endedAt: now });
  assert.equal(ms, Math.round((pushes * 7000) / 8));
  await rec.settled();
  assert.deepEqual(closed.slice(0, 2), [['rec-1', cap, true, 1, null, true], ['rec-2', cap, true, 2, 0, true]], 'closed at the cap as whole recordings');
  // a take that ends exactly at the cap leaves no empty recording behind; the next take starts a new one
  const rec2 = new ShareRecorder({ make, clock: () => now, timers: { setTimeout: () => 1, clearTimeout: () => {} } });
  const exact = rec2.take({ inputSampleRate: 8000, contributor: 'c'.repeat(32), startedAt: now });
  const sec = new Float32Array(8000);
  for (let i = 0; i < 1200; i++) exact.push(sec);
  assert.equal(rec2.recording === null, true, 'closed where its audio reached 20 minutes');
  assert.equal(made.length, 4);
  now += 1200000;
  assert.equal(await exact.finish({ endedAt: now }), 1200000);
  now += 500;
  const next = rec2.take({ inputSampleRate: 8000, contributor: 'c'.repeat(32), startedAt: now });
  next.push(sec);
  assert.deepEqual([made.length, made[4].takeSeq, made[4].gapMsPrev], [5, 2, 500]);
  await next.finish({ endedAt: now + 1000 });
  await rec2.closeRecording();
  await rec2.settled();
});

test('fed audio on its way to the pipeline: at most two seconds at a time, a buffer over ten seconds is not taken', async () => {
  const { client } = await setup({ sharing: true });
  const ctl = client._i.ctl;
  ctl.setSharing(true);
  const buf = new Float32Array(1600);
  for (let i = 0; i < 100; i++) client.sharing.feed(buf, 16000); // ten seconds in one go, as no microphone delivers
  assert.equal(ctl.feedWaiting(), FEED_WAIT_S * 16000);
  client.sharing.feed(new Float32Array(FEED_MAX_S * 16000 + 1), 16000);
  assert.equal(ctl.feedWaiting(), FEED_WAIT_S * 16000);
  for (let i = 0; i < 200 && ctl.feedWaiting() > 0; i++) await settle();
  assert.equal(ctl.feedWaiting(), 0, 'what was taken reached the pipeline');
  const sharing = await outbox.sharing();
  assert.equal(sharing.recorder.ringSamples, 16000, 'and its last second is the ring');
  // the feed goes on afterwards
  client.sharing.feed(buf, 16000);
  assert.equal(ctl.feedWaiting(), 1600);
  for (let i = 0; i < 200 && ctl.feedWaiting() > 0; i++) await settle();
  await client.close();
});

test('a take that outruns a slow start of sharing is not shared; the next one is', { skip: haveOpus ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)' }, async () => {
  let open;
  const gate = new Promise((r) => { open = r; });
  const { client, model } = await setup({ sharing: true, extra: { sharing: { opus: () => gate } } });
  client._i.ctl.setSharing(true);
  const second = new Float32Array(16000);
  const closed = [];
  // more than START_WAIT_MS of audio while the encoder is still loading
  const long = model.session();
  for (let i = 0; i < START_WAIT_MS / 1000 + 1; i++) long.push(second);
  await long.finish();
  let sharing = null;
  for (let i = 0; i < 200 && !sharing; i++) { await settle(); sharing = await outbox.sharing(); }
  assert.equal(sharing !== null, true, 'the pipeline was made');
  sharing.recorder.onClosed = (r) => closed.push({ samples: r.samples, sharedMs: r.sharedMs });
  open(await loadOpus());
  for (let i = 0; i < 400 && closed.length < 1; i++) await settle();
  assert.deepEqual(closed, [{ samples: 0, sharedMs: 0 }], 'nothing of the long take was recorded');
  // a take within the bound is shared whole
  const short = model.session();
  short.push(second);
  await short.finish();
  for (let i = 0; i < 200 && !sharing.recorder.recording; i++) await settle();
  await client.sharing.closeRecording?.();
  await sharing.closeRecording();
  for (let i = 0; i < 400 && closed.length < 2; i++) await settle();
  assert.deepEqual(closed[1], { samples: 16000, sharedMs: 1000 });
  await client.close();
});

test('during the tail wait only fed audio is recorded: a listen take ends, the wait runs out, the recording holds exactly the take\'s samples, and the microphone was stopped at the take\'s end',
  { skip: haveOpus ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)' }, async () => {
    // a wall clock the test moves, and timers that fire only when the clock reaches them (the recorder's window and tail wait)
    const s = { now: Date.now(), pending: new Map(), seq: 0 };
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
      s.now = Math.max(s.now, t);
    };
    const { client, model, mic } = await setup({ sharing: true, extra: { clock: s.clock, sharing: { clock: s.clock, timers: s.timers } } });
    client._i.ctl.setSharing(true);
    const session = await model.listen();
    mic.play(new Float32Array(48000).fill(0.01)); // one second from the microphone, in the device's blocks
    await session.finish();
    assert.equal(mic.track.stopped, true, 'the microphone is stopped when the take ends');
    assert.equal(mic.opened, 1);
    let sharing = null;
    for (let i = 0; i < 400 && !(sharing && sharing.recorder.recording && !sharing.recorder.current); i++) { await settle(); sharing = await outbox.sharing(); }
    assert.equal(!!(sharing && sharing.recorder.recording), true, 'the recording is open after the take: it waits for a tail');
    const closed = [];
    sharing.recorder.onClosed = (r) => closed.push({ samples: r.samples, parts: r.parts });
    // the device goes on delivering, as a microphone left open would: nothing of it may reach the recording
    mic.play(new Float32Array(48000).fill(0.02));
    s.to(s.now + 1500);
    await sharing.recorder.settled();
    s.to(s.now + 2000); // past the join window too
    await sharing.recorder.settled();
    for (let i = 0; i < 400 && closed.length < 1; i++) await settle();
    assert.deepEqual(closed, [{ samples: 48000, parts: [{ pre_roll: 0, take: 48000, tail: 0 }] }], 'exactly the take\'s samples: no tail without sharing.feed');
    assert.equal(mic.opened, 1, 'the SDK never reopened the microphone for a tail');
    assert.equal(mic.tracks.every((t) => t.stopped), true);
    await client.close();
  });
