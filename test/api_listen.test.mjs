// model.listen() and the public Microphone (SPEC 13.1 and 13.6, NAMING.md sections 3 to 5) with a stand-in
// microphone (test/helpers/fakemic.mjs) and the fake engine host: the device's rate carried to the Session, the
// permission refused, an interruption, a device change, a hidden page, nothing captured before listen() or after
// the take ends; and the same path with no microphone: a sample clip or the app's samples, at real-time pace
// or as fast as possible. A real browser with a fake audio device runs scripts/browser-quickstart.mjs.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { TajweedError, Microphone } from '../web/index.js';
import { createClient, resetClientForTests } from '../web/api/client.js';
import { microphonePermission } from '../web/api/microphone.js';
import { build3, stubPlatform, seamsFor, audioFor, KEY, CLIP_TOKENS } from './helpers/model3.mjs';
import { fakeMicrophone, fakePage } from './helpers/fakemic.mjs';

const build = await build3();
const code = (c) => (e) => e instanceof TajweedError && e.code === c;
const collect = async (it) => { const out = []; for await (const x of it) out.push(x); return out; };
const settle = () => new Promise((r) => setTimeout(r, 5));

async function setup(micOptions = {}, extra = {}) {
  resetClientForTests();
  const api = await stubPlatform({ build });
  const mic = fakeMicrophone(micOptions);
  const page = fakePage();
  const seams = seamsFor(api, { microphone: mic.seams, lifecycle: page, ...extra });
  const client = await createClient({ key: KEY }, seams);
  const model = await client.model();
  return { client, model, mic, page, seams, host: seams.host };
}

test('listen(): the microphone at the device\'s rate, carried to the Session; finish stops it; nothing is captured after', async () => {
  const { client, model, mic, host } = await setup({ sampleRate: 48000 });
  assert.equal(mic.opened, 0, 'nothing is opened before listen()');
  const session = await model.listen({ endOnSilenceMs: 1500 });
  assert.equal(mic.opened, 1);
  // mono, with the browser's speech processing off
  assert.deepEqual(mic.constraints, { audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
  await settle();
  assert.equal(host.calls.filter((c) => c[0] === 'start').pop()[1].sampleRate, 48000, 'the Session runs at the microphone\'s rate, not 16000');
  assert.throws(() => session.push(audioFor([1])), code('invalid_argument'), 'a listen Session is fed by the SDK');
  mic.play(audioFor([0, 0, 3, 3, 0, 5, 5, 5, 1, 7, 0, 0, 9, 9, 0, 0], 48000));
  const heads = await session.finish();
  assert.deepEqual(heads.greedy().map((t) => t.id), [3, 5, 1, 7, 9]);
  assert.equal(heads.decoded().text, 't3 t5 | t7 t9');
  // the microphone is released, and audio the device still delivers reaches nothing
  assert.equal(mic.track.stopped, true);
  assert.equal(mic.contexts[0].closed, true);
  const pushes = host.calls.filter((c) => c[0] === 'push').length;
  mic.play(audioFor([4, 4, 4, 4, 4, 4, 4, 4], 48000));
  await settle();
  assert.equal(host.calls.filter((c) => c[0] === 'push').length, pushes);
  // options that do not belong to a microphone take
  await assert.rejects(model.listen({ sampleRate: 16000 }), code('invalid_argument'));
  await assert.rejects(model.listen({ pace: 'fast' }), code('invalid_argument'));
  await assert.rejects(model.listen({ context: 'nope' }), code('invalid_argument'));
  assert.equal(mic.opened, 1, 'bad options are refused before the permission prompt');
  await client.close();
});

test('a refused permission is microphone_denied; no input device is microphone_unavailable; no take is left open', async () => {
  const { client, model, mic } = await setup({ deny: 'NotAllowedError' });
  await assert.rejects(model.listen(), code('microphone_denied'));
  mic.deny = 'NotFoundError';
  await assert.rejects(model.listen(), code('microphone_unavailable'));
  mic.deny = 'NotReadableError';
  await assert.rejects(model.listen(), code('microphone_unavailable'));
  mic.deny = null;
  const s = await model.listen();   // the Model has no Session left open by the refusals
  await s.cancel();
  assert.equal(mic.track.stopped, true);
  assert.equal(await microphonePermission({ ...mic.seams, permissions: { query: async () => ({ state: 'denied' }) } }), 'denied');
  assert.equal(await microphonePermission({ ...mic.seams, permissions: { query: async () => ({ state: 'granted' }) } }), 'granted');
  assert.equal(await microphonePermission(mic.seams), 'notAsked');
  await client.close();
});

test('in Node there is no microphone: listen() without `from` is microphone_unavailable, listen({ from }) works', async () => {
  resetClientForTests();
  const api = await stubPlatform({ build });
  const client = await createClient({ key: KEY }, seamsFor(api));
  const model = await client.model();
  await assert.rejects(model.listen(), code('microphone_unavailable'));
  await assert.rejects(Microphone.open(), code('microphone_unavailable'));
  assert.equal(await microphonePermission(), 'none');
  assert.equal((await client.diagnose()).microphone, 'none');
  const s = await model.listen({ from: model.sampleClips[0], pace: 'fast' });
  await collect(s.chunks);   // until the clip ran out
  assert.deepEqual((await s.finish()).greedy().map((t) => t.id), [3, 5, 1, 7, 9]);
  await client.close();
});

test('an interruption pauses the take (no audio is read) and resumed goes on in the same take', async () => {
  const { client, model, mic } = await setup();
  const session = await model.listen();
  const events = [];
  (async () => { for await (const e of session.events) events.push(e); })();
  mic.play(audioFor([3, 3, 0, 0, 0, 0, 0, 0], 48000));
  mic.track.fire('mute');                                    // a call, or another app took the audio
  mic.play(audioFor([4, 4, 4, 4, 4, 4, 4, 4], 48000));       // whatever the device still delivers is not read
  mic.track.fire('unmute');
  mic.play(audioFor([0, 5, 5, 0, 0, 0, 0, 0], 48000));
  const heads = await session.finish();
  assert.deepEqual(heads.greedy().map((t) => t.id), [3, 5], 'one take, without the audio of the interruption');
  assert.deepEqual(events.filter((e) => e.type === 'interrupted' || e.type === 'resumed'), [{ type: 'interrupted', cause: 'interruption' }, { type: 'resumed' }]);
  // the audio context suspended by the system is the same interruption
  const again = await model.listen();
  const seen = [];
  (async () => { for await (const e of again.events) seen.push(e.type); })();
  const ctx = mic.contexts.at(-1);
  ctx.state = 'interrupted'; ctx.fire('statechange');
  ctx.state = 'running'; ctx.fire('statechange');
  await again.finish();
  assert.deepEqual(seen, ['interrupted', 'resumed']);
  await client.close();
});

test('a device change reopens the microphone and the take goes on (interrupted: routeChange); a lost device ends it (ended: interrupted)', async () => {
  const { client, model, mic, host } = await setup();
  let session = await model.listen();
  const events = [];
  (async () => { for await (const e of session.events) events.push(e); })();
  mic.play(audioFor([3, 3, 0, 0, 0, 0, 0, 0], 48000));
  const first = mic.track;
  mic.mediaDevices.fire('devicechange');                     // headphones in or out
  await settle();
  assert.equal(first.stopped, true);
  assert.equal(mic.opened, 2);
  assert.equal(mic.contexts.length, 1, 'the same AudioContext: the rate does not change within a take');
  mic.play(audioFor([0, 6, 6, 0, 0, 0, 0, 0], 48000));
  assert.deepEqual((await session.finish()).greedy().map((t) => t.id), [3, 6]);
  assert.deepEqual(events.filter((e) => e.type === 'interrupted'), [{ type: 'interrupted', cause: 'routeChange' }]);
  assert.equal(host.calls.filter((c) => c[0] === 'start').length, 1, 'one take');
  // the input went away and no other can be opened: the take ends by itself with what was heard
  session = await model.listen();
  mic.play(audioFor([7, 7, 0, 0, 0, 0, 0, 0], 48000));
  mic.deny = 'NotFoundError';
  mic.track.fire('ended');
  const evs = await collect(session.events);
  assert.deepEqual(evs.filter((e) => e.type === 'ended'), [{ type: 'ended', reason: 'interrupted' }]);
  assert.equal(evs.at(-1).type, 'ended');
  assert.deepEqual((await session.finish()).greedy().map((t) => t.id), [7]);
  await client.close();
});

test('a hidden page ends the take (ended: hidden) and releases the microphone; back on the page a new take starts', async () => {
  const { client, model, mic, page } = await setup();
  let session = await model.listen();
  mic.play(audioFor([3, 3, 0, 0, 0, 0, 0, 0], 48000));
  page.hide();
  const evs = await collect(session.events);
  assert.deepEqual(evs.at(-1), { type: 'ended', reason: 'hidden' });
  const chunks = await collect(session.chunks);
  assert.equal(chunks.at(-1).decoded.isFinal, true);
  assert.deepEqual((await session.finish()).greedy().map((t) => t.id), [3]);
  assert.equal(mic.track.stopped, true, 'the SDK never holds the microphone in the background');
  assert.equal(page.document.listeners('visibilitychange'), 0);
  // a listen() while the page is hidden ends at once; after the return a new take is one line
  session = await model.listen();
  assert.deepEqual(await collect(session.events), [{ type: 'ended', reason: 'hidden' }]);
  page.show();
  session = await model.listen();
  mic.play(audioFor([8, 8, 0, 0, 0, 0, 0, 0], 48000));
  page.window.fire('pagehide');                               // leaving the page ends it the same way
  assert.deepEqual((await collect(session.events)).at(-1), { type: 'ended', reason: 'hidden' });
  assert.deepEqual((await session.finish()).greedy().map((t) => t.id), [8]);
  await client.close();
});

test('listen({ from }): a sample clip gives the tokens of the self-test file; samples at their own rate; fast and real-time pace', async () => {
  let now = 1000;
  const timers = { pending: [], setTimeout(f, ms) { const t = { f, at: now + ms }; this.pending.push(t); return t; }, clearTimeout(t) { this.pending = this.pending.filter((x) => x !== t); } };
  const { client, model, host, mic } = await setup({}, { clock: () => now, timers });
  const expected = JSON.parse(new TextDecoder().decode(build.files['selftest/expected_c16_l64.json']));
  assert.deepEqual(model.sampleClips.map((c) => [c.name, c.kind, c.durationMs]), [['Clip_001001', 'clean', 640], ['Clip_planted', 'planted', 320]]);
  assert.ok(Object.isFrozen(model.sampleClips) && Object.isFrozen(model.sampleClips[0]));
  // as fast as possible
  let s = await model.listen({ from: model.sampleClips[0], pace: 'fast' });
  const evs = await collect(s.events);
  assert.deepEqual(evs.at(-1), { type: 'ended', reason: 'sourceEnd' });
  const heads = await s.finish();
  assert.deepEqual(heads.greedy().map((t) => t.id), expected.clips.Clip_001001.tokens);
  assert.equal(host.calls.filter((c) => c[0] === 'start').pop()[1].sampleRate, 16000, 'the clip\'s own rate');
  assert.equal(mic.opened, 0, 'no microphone');
  // real-time pace (the default): the audio arrives as the clock moves, 100 ms per step
  s = await model.listen({ from: model.sampleClips[0] });
  await settle();
  const pushed = () => host.calls.slice(host.calls.map((c) => c[0]).lastIndexOf('start')).filter((c) => c[0] === 'push').reduce((n, c) => n + c[1], 0);
  assert.equal(pushed(), 1600, 'the first 100 ms at once');
  for (let i = 0; i < 20 && timers.pending.length; i++) { now += 100; const t = timers.pending.shift(); t.f(); await settle(); if (i === 2) assert.equal(pushed(), 1600 * 4); }
  assert.deepEqual((await s.finish()).greedy().map((t) => t.id), expected.clips.Clip_001001.tokens);
  assert.equal(pushed(), CLIP_TOKENS.length * 640);
  // samples the app has, at their rate
  s = await model.listen({ from: audioFor([0, 6, 6, 0, 2, 0, 0, 0], 44100), sampleRate: 44100, pace: 'fast' });
  await collect(s.chunks);
  assert.deepEqual((await s.finish()).greedy().map((t) => t.id), [6, 2]);
  assert.equal(host.calls.filter((c) => c[0] === 'start').pop()[1].sampleRate, 44100);
  // finish() before the clip ran out ends the take there
  s = await model.listen({ from: model.sampleClips[0] });
  await s.finish();
  assert.equal(timers.pending.length, 0, 'the pacing timer is cleared');
  for (const bad of [{ from: 'clip' }, { from: { name: 'Clip_001001' } }, { from: [0, 1] }, { from: model.sampleClips[0], sampleRate: 16000 }, { from: model.sampleClips[0], pace: 'slow' }]) {
    await assert.rejects(model.listen(bad), code('invalid_argument'), JSON.stringify(Object.keys(bad)));
  }
  await client.close();
});

test('Microphone: samples only, for apps that own the rest', async () => {
  const fake = fakeMicrophone({ sampleRate: 44100 });
  const mic = await Microphone.open(fake.seams);
  assert.equal(mic.sampleRate, 44100);
  const got = [];
  const reader = (async () => { for await (const block of mic.samples()) got.push(block.length); })();
  fake.play(new Float32Array(2000));
  await settle();
  mic.close();
  await reader;
  assert.deepEqual(got, [960, 960, 80]);
  assert.equal(fake.track.stopped, true);
  assert.equal(fake.mediaDevices.listeners('devicechange'), 0);
  fake.deny = 'NotAllowedError';
  await assert.rejects(Microphone.open(fake.seams), code('microphone_denied'));
});

test('the suite\'s model build has the production shape: no tolerance of either kind, a tokens-only self-test file; its sample clip gives those tokens', async () => {
  assert.equal('golden_tolerance' in build.manifest || 'golden_raw_tolerance' in build.manifest, false);
  const expected = JSON.parse(new TextDecoder().decode(build.files['selftest/expected_c16_l64.json']));
  assert.deepEqual(Object.keys(expected).sort(), ['clips', 'context', 'engine', 'format']);
  assert.deepEqual(Object.keys(expected.clips.Clip_001001).sort(), ['chunks', 'tokens']);
  const { client, model } = await setup();
  const clip = model.sampleClips.find((c) => c.name === 'Clip_001001');
  const s = await model.listen({ from: clip, pace: 'fast' });
  for await (const ev of s.events) { if (ev.type === 'ended') break; }
  assert.deepEqual((await s.finish()).greedy().map((t) => t.id), expected.clips.Clip_001001.tokens);
  await client.close();
});
