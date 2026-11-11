// The five concepts of the 3.0 API end to end (NAMING.md sections 1 to 4), against a stub of Quran Lab's API
// and CDN, a synthetic signed model build and a fake engine host (test/helpers/model3.mjs): Client, Model,
// Session, Heads, Backend, the chunk, the decoded layer, the events, one Client per process, one open Session
// per Model. The engine's numbers are not checked here (the conformance tests do that).
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { TajweedClient, TajweedModel, TajweedSession, TajweedHeads, TajweedError } from '../web/index.js';
import { createClient, resetClientForTests } from '../web/api/client.js';
import { openModel } from '../web/api/model.js';
import { memoryReader, sha256Hex } from '../web/tajweed/manifest.js';
import { build3, stubPlatform, seamsFor, fakeHost, audioFor, KEY, testKeyHex, CLIP_TOKENS } from './helpers/model3.mjs';
import { calFixture } from './tajweed/folder.mjs';

const build = await build3();

async function setup(o = {}, extra = {}) {
  resetClientForTests();
  const api = await stubPlatform({ build, ...o });
  const seams = seamsFor(api, extra);
  const client = await createClient({ key: KEY, appVersion: '1.0' }, seams);
  return { api, seams, client };
}
const code = (c) => (e) => e instanceof TajweedError && e.code === c && typeof e.fix === 'string' && e.docs === `https://sdk.quranlab.ai/docs/errors#${c}`;
const collect = async (it) => { const out = []; for await (const x of it) out.push(x); return out; };

test('Client, model, session, read: chunks carry the decoded layer of the take so far, finish gives the take\'s Heads', async () => {
  const { client, seams, api } = await setup();
  assert.ok(client instanceof TajweedClient);
  const model = await client.model();
  assert.ok(model instanceof TajweedModel);
  assert.equal(model.id, 'v4.0');
  assert.equal(model.version, '4.0.0');
  assert.equal(model.build, build.build);
  assert.deepEqual([...model.contexts], ['c16_l64', 'c8_l64', 'c24_l72']);
  assert.equal(model.defaultContext, 'c16_l64');
  assert.equal(model.chunkMs(), 320);
  assert.equal(model.chunkMs('c8_l64'), 160);
  assert.deepEqual(model.backend, { kind: 'cpu', name: 'wasm', stage: 'cpu', reason: null });
  assert.equal(model.tokens.count, 38);
  assert.equal(model.tokens.blank, 0);
  assert.equal(model.tokens.wordBar, 1);
  assert.equal(model.tokens.name(1), '|');
  assert.equal(model.tokens.id('t5'), 5);
  assert.equal(model.tokens.name(99), null);
  // the files came by the build's URL with the key, only the engine's files of the default context, never the
  // other contexts, the native-only graph, the reference table or the clips
  const got = api.log.filter((x) => x.host === 'cdn').map((x) => x.path);
  assert.ok(api.log.filter((x) => x.host === 'cdn').every((x) => x.build === build.build));
  assert.deepEqual(got.filter((p) => p !== 'manifest.json').sort(), ['c16_l64/frames.zfw', 'c16_l64/model_engine2.onnx.zfg', 'calibration.json.gz',
    'frontend.zfw', 'layers.zfw.gz', 'selftest/selftest.json', 'tokens.txt'].sort());
  // staged into the engine: its files only (the calibration is data, not an engine file); then warmed
  assert.deepEqual(seams.host.calls.find((c) => c[0] === 'stage')[1].sort(), ['c16_l64/frames.zfw', 'c16_l64/model_engine2.onnx.zfg', 'frontend.zfw', 'layers.zfw', 'tokens.txt']);
  assert.deepEqual(seams.host.calls.find((c) => c[0] === 'warm')[1], { context: 'c16_l64', sampleRate: 16000 });
  assert.ok((await client.model()) === model, 'model() again gives the open Model');

  const seen = [];
  const session = model.session({ onChunk: (c) => seen.push(c.index) });
  assert.ok(session instanceof TajweedSession);
  assert.deepEqual(session.backend, model.backend);
  const ids = [0, 0, 3, 3, 0, 5, 5, 5, /* chunk 2 */ 5, 1, 7, 0, 0, 9, 9, 0, /* partial */ 9, 0];
  session.push(audioFor(ids.slice(0, 5)));
  session.push(audioFor(ids.slice(5)));
  const done = session.finish();
  const chunks = await collect(session.chunks);
  const heads = await done;
  assert.deepEqual(chunks.map((c) => [c.index, c.startMs, c.endMs, c.firstFrame]), [[0, 0, 320, 0], [1, 320, 640, 8], [2, 640, 960, 16]]);
  assert.deepEqual(seen, [0, 1, 2]);
  assert.ok(chunks.every((c) => c.backend.kind === 'cpu' && c.backend.name === 'wasm'));
  // a chunk's Heads are that chunk's only: the default six heads
  assert.ok(chunks[0].heads instanceof TajweedHeads);
  assert.deepEqual(chunks[0].heads.names, ['log_probs', 'inter1_log_probs', 'timing_log_probs', 'gem', 'attr_qalqalah', 'conf']);
  const lp = chunks[1].heads.get('log_probs');
  assert.deepEqual([lp.name, lp.kind, lp.frameMs, lp.frames, lp.classes, lp.values.length], ['log_probs', 'ctc', 40, 8, 38, 8 * 38]);
  const gem = chunks[1].heads.get('gem');
  assert.deepEqual([gem.kind, gem.frameMs, gem.frames, gem.classes], ['attribute', 20, 16, 2]);
  assert.equal(chunks[1].heads.get('attr_face'), null, 'a head the take did not compute');
  assert.throws(() => chunks[1].heads.get('nope'), code('invalid_argument'));
  // the decoded layer of the take so far, and what is settled: the last token of chunk 1 (5, still running at
  // the chunk's last frame) can still grow, so it is tentative until the next chunk closes it
  assert.equal(chunks[0].decoded.text, 't3 t5');
  assert.equal(chunks[0].decoded.settled, 1);
  assert.equal(chunks[0].decoded.isFinal, false);
  assert.equal(chunks[1].decoded.text, 't3 t5 | t7 t9');
  assert.equal(chunks[1].decoded.settled, 5);
  assert.equal(chunks[2].decoded.text, 't3 t5 | t7 t9 t9');
  assert.equal(chunks[2].decoded.isFinal, true);
  assert.equal(chunks[2].decoded.settled, 6);
  const d = chunks[2].decoded;
  assert.deepEqual(d.tokens.map((t) => [t.id, t.name, t.firstMs, t.peakMs, t.lastMs]), [[3, 't3', 80, 80, 120], [5, 't5', 200, 200, 320], [1, '|', 360, 360, 360],
    [7, 't7', 400, 400, 400], [9, 't9', 520, 520, 560], [9, 't9', 640, 640, 640]]);
  assert.ok(d.tokens.every((t) => Math.abs(t.confidence - 1 / (1 + Math.exp(-2))) < 1e-6));
  assert.deepEqual(d.words.map((w) => [w.index, w.text, w.firstMs, w.lastMs, w.tokens.length]), [[0, 't3 t5', 80, 320, 2], [1, 't7 t9 t9', 400, 640, 3]]);
  assert.equal(d.frames.length, 24);
  assert.deepEqual([d.frames[2].top1, d.frames[2].runnerUp], [3, 4]);
  assert.ok(Math.abs(d.frames[2].margin - 2.9) < 1e-5);
  assert.equal(d.frames[2].topK, undefined);
  // the take's Heads: every frame, greedy tokens, the final decoded layer
  assert.ok(heads instanceof TajweedHeads);
  assert.equal(heads.get('log_probs').frames, 24);
  assert.equal(heads.get('conf').frames, 48);
  assert.deepEqual(heads.greedy().map((t) => t.id), [3, 5, 1, 7, 9, 9]);
  assert.deepEqual(heads.greedy('log_probs')[1], { id: 5, firstMs: 200, peakMs: 200, lastMs: 320 });
  assert.throws(() => heads.greedy('gem'), code('invalid_argument'));
  assert.deepEqual(heads.decoded().text, d.text);
  assert.equal(heads.decoded().isFinal, true);
  // a Session is one take: it is closed now, and the next take is a new Session of the same Model
  assert.throws(() => session.push(audioFor([1])), code('session_closed'));
  assert.ok((await session.finish()) === heads, 'finish() again gives the same Heads');
  const again = model.session();
  await again.finish();
  await client.close();
});

test('one Client per process: a second one is client_exists until the first is closed', async () => {
  const { client, api } = await setup();
  await assert.rejects(createClient({ key: KEY }, seamsFor(api)), code('client_exists'));
  await assert.rejects(TajweedClient.create({ key: KEY, appId: 'x' }), code('client_exists'));
  await client.close();
  const next = await createClient({ key: KEY }, seamsFor(api));
  await next.close();
  // two creates in a row: exactly one wins
  const r = await Promise.allSettled([createClient({ key: KEY }, seamsFor(api)), createClient({ key: KEY }, seamsFor(api))]);
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.ok(code('client_exists')(r.find((x) => x.status === 'rejected').reason));
  await r.find((x) => x.status === 'fulfilled').value.close();
  await assert.rejects(createClient({ key: 'nope' }, seamsFor(api)), code('invalid_argument'));
  await assert.rejects(createClient({ key: KEY, analytics: 'maybe' }, seamsFor(api)), code('invalid_argument'));
});

test('one open Session per Model (session_open); cancel keeps nothing; options are checked', async () => {
  const { client } = await setup();
  const model = await client.model();
  const s = model.session();
  assert.throws(() => model.session(), code('session_open'));
  await assert.rejects(model.listen({ from: audioFor([1]) }), code('session_open'));
  s.push(audioFor([3, 3, 3, 3, 3, 3, 3, 3]));
  await s.cancel();
  await assert.rejects(s.finish(), code('cancelled'));
  assert.deepEqual(await collect(s.chunks), [], 'the chunks of a cancelled take are not kept for a late reader... except those already queued');
  assert.throws(() => s.push(audioFor([1])), code('session_closed'));
  for (const bad of [{ context: 'c99_l1' }, { sampleRate: 100 }, { sampleRate: 16000.5 }, { heads: ['nope'] }, { heads: 'some' }, { backend: 'gpu' }, { topK: 39 },
    { endOnSilenceMs: -1 }, { onChunk: 1 }, { pace: 'fast' }]) {
    assert.throws(() => model.session(bad), code('invalid_argument'), JSON.stringify(bad));
  }
  // heads: a list, or all; log_probs always; topK ranks each frame
  const t = model.session({ heads: ['gem'], topK: 3, backend: 'cpu' });
  t.push(audioFor([4, 4, 0, 0, 0, 0, 0, 0]));
  const h = await t.finish();
  assert.deepEqual(h.names, ['log_probs', 'gem']);
  const f = h.decoded().frames[0];
  assert.deepEqual(f.topK.map((x) => x.id), [4, 5, 0]);
  assert.deepEqual(f.topK.map((x) => x.name), ['t4', 't5', '<blk>']);
  assert.equal(h.decoded().tokens[0].confidence, null, 'no conf head, no confidence');
  const all = model.session({ heads: 'all' });
  all.push(audioFor(new Array(8).fill(0)));
  assert.equal((await all.finish()).names.length, 12);
  await client.close();
});

test('the context: the app, then the config\'s inference.context, then the manifest default; one the build lacks is ignored', async () => {
  let { client, seams, api } = await setup({ inference: { context: 'c8_l64' } });
  let model = await client.model();
  assert.equal(model.defaultContext, 'c8_l64');
  let s = model.session();
  await s.finish();
  assert.equal(seams.host.calls.filter((c) => c[0] === 'start').pop()[1].context, 'c8_l64');
  // the app's choice wins; its files are fetched on first use (lazily) and staged
  assert.ok(!api.log.some((x) => x.path === 'c24_l72/frames.zfw'));
  s = model.session({ context: 'c24_l72' });
  s.push(audioFor(new Array(12).fill(2)));
  const chunks = [];
  s.finish();
  for await (const c of s.chunks) chunks.push(c);
  assert.equal(chunks[0].endMs, 480);
  assert.ok(api.log.some((x) => x.path === 'c24_l72/frames.zfw'));
  assert.equal(seams.host.calls.filter((c) => c[0] === 'start').pop()[1].context, 'c24_l72');
  await client.close();
  ({ client, seams } = await setup({ inference: { context: 'c99_l9' } }));
  model = await client.model();
  assert.equal(model.defaultContext, 'c16_l64');
  await client.close();
  ({ client } = await setup({}));
  assert.equal((await client.model()).defaultContext, 'c16_l64');
  await client.close();
});

test('the calibration is read-only data, byte for byte; a folder without it opens with null', async () => {
  const { client } = await setup();
  const model = await client.model();
  const cal = model.calibration;
  assert.equal(cal.text, calFixture);
  assert.equal(cal.sha256, await sha256Hex(new TextEncoder().encode(calFixture)));
  assert.equal(cal.format, JSON.parse(calFixture).format);
  assert.deepEqual(cal.json, JSON.parse(calFixture));
  assert.ok(Object.isFrozen(cal.json) && Object.isFrozen(cal.json.contexts));
  assert.throws(() => { 'use strict'; cal.json.default_preset = 'x'; }, TypeError);
  const ctx = cal.contexts[0];
  assert.deepEqual(cal.context(ctx), JSON.parse(calFixture).contexts[ctx]);
  assert.equal(cal.context('nope'), null);
  const cls = Object.keys(JSON.parse(calFixture).contexts[ctx].sites)[0];
  assert.equal(cal.threshold(ctx, cls, 'balanced'), JSON.parse(calFixture).contexts[ctx].sites[cls].thresholds.balanced);
  assert.equal(cal.threshold(ctx, 'nope', 'balanced'), null);
  await client.close();
  const bare = await build3({ calibration: false, reference: false, selftest: false });
  const m = await openModel({ reader: memoryReader(bare.files), folder: { trustedKeys: [testKeyHex] }, seams: { host: fakeHost() } });
  assert.equal(m.calibration, null);
  assert.equal(m.reference, null);
  assert.deepEqual([...m.sampleClips], []);
  const s = m.session();
  s.push(audioFor([2, 2, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual((await s.finish()).greedy().map((t) => t.id), [2]);
  await m.close();
});

test('events: speechStarted and speechEnded from the model\'s output; endOnSilenceMs ends the take with ended(silence)', async () => {
  const { client } = await setup();
  const model = await client.model();
  // tokens at frames 2 and 3, then silence: without the option speechEnded comes when 38 inactive frames (1520 ms)
  // have arrived after the last active frame, with frame 3 + 38 = 41, and the take goes on
  const events = [];
  let s = model.session({ onEvent: (e) => events.push(e) });
  s.push(audioFor([0, 0, 3, 5, 0, 0, 0, 0, ...new Array(64).fill(0)]));
  await s.finish();
  assert.deepEqual(await collect(s.events), events);
  assert.deepEqual(events, [{ type: 'speechStarted', atMs: 80 }, { type: 'speechEnded', atMs: 160, silenceMs: 1520 }]);
  // with the option the take finishes there by itself (500 ms is 13 frames: frame 3 + 13 = 16, in the third chunk):
  // that chunk is whole and final, chunks end, later audio is not decoded, finish() gives the Heads
  s = model.session({ endOnSilenceMs: 500 });
  s.push(audioFor([0, 0, 3, 5, 0, 0, 0, 0, ...new Array(64).fill(0)]));
  const evs = await collect(s.events);
  assert.deepEqual(evs, [{ type: 'speechStarted', atMs: 80 }, { type: 'speechEnded', atMs: 160, silenceMs: 520 }, { type: 'ended', reason: 'silence' }]);
  const chunks = await collect(s.chunks);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.decoded.isFinal), [false, false, true]);
  assert.deepEqual(chunks.map((c) => c.speech), [true, false, false]);
  assert.equal((await s.finish()).get('log_probs').frames, 24);
  for (const bad of [-1, 1, 99, 499, 60001, 1.5, '1000', true]) assert.throws(() => model.session({ endOnSilenceMs: bad }), code('invalid_argument'), String(bad));
  for (const off of [null, 0, undefined]) await model.session({ endOnSilenceMs: off }).cancel();
  assert.deepEqual((await s.finish()).greedy().map((t) => t.id), [3, 5]);
  assert.throws(() => s.push(audioFor([1])), code('session_closed'));
  await client.close();
});

test('speech: a held sound that log_probs shows as blank keeps the take going; the timing head is computed on every Session and handed out only when selected', async () => {
  const { client, seams } = await setup();
  const model = await client.model();
  // a token, then the sound held for 60 frames (2.4 s: log_probs blank, the timing head holds it), a token, silence
  const held = [0, 0, 3, ...new Array(60).fill(-3), 5, ...new Array(48).fill(0)];
  for (const heads of [['log_probs'], ['log_probs', 'timing_log_probs'], undefined]) {
    const s = model.session({ heads, endOnSilenceMs: 1500 });
    s.push(audioFor(held));
    const evs = await collect(s.events);
    // one speechStarted, one speechEnded after the LAST token (frame 63): the held sound ended nothing
    assert.deepEqual(evs, [{ type: 'speechStarted', atMs: 80 }, { type: 'speechEnded', atMs: 2560, silenceMs: 1520 }, { type: 'ended', reason: 'silence' }], String(heads));
    const chunks = await collect(s.chunks);
    assert.deepEqual(chunks.map((c) => c.speech), [true, true, true, true, true, true, true, true, false, false, false, false, false], String(heads));
    const h = await s.finish();
    assert.deepEqual(h.greedy().map((t) => t.id), [3, 5]);
    // the engine was asked for the timing head in every case; the app sees it only when it selected it
    assert.equal(seams.host.calls.filter((c) => c[0] === 'start').at(-1)[1].heads.includes('timing_log_probs'), true);
    const selected = !heads || heads.includes('timing_log_probs');
    assert.equal(h.names.includes('timing_log_probs'), selected, String(heads));
    assert.equal(h.get('timing_log_probs') !== null && h.get('timing_log_probs') !== undefined, selected);
    assert.equal(chunks.every((c) => c.heads.names.includes('timing_log_probs') === selected), true);
  }
  await client.close();
});

test('an engine failure ends the take with ended(error) carrying a TajweedError; finish() rejects with it', async () => {
  const { client, seams } = await setup();
  const model = await client.model();
  const s = model.session();
  s.push(audioFor(new Array(8).fill(3)));
  seams.host.failPush = 'the engine said no';
  s.push(audioFor(new Array(8).fill(3)));
  const evs = await collect(s.events);
  assert.equal(evs[evs.length - 1].type, 'ended');
  assert.equal(evs[evs.length - 1].reason, 'error');
  assert.ok(code('engine_failed')(evs[evs.length - 1].error));
  assert.match(evs[evs.length - 1].error.message, /the engine said no/);
  await assert.rejects(s.finish(), code('engine_failed'));
  seams.host.failPush = null;
  const next = model.session();
  await next.finish();
  await client.close();
});
