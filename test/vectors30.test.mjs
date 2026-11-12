// The shared vectors of SDK 3.0.0 (test/vectors30/, copies of the files every TajweedFormer SDK tests against):
// names, ayah counts, the manifest's signed text and acceptance checks, speech and silence, settled tokens, the
// telemetry counters and the app-reported APIs, the context a Session runs on, and the diagnose() schema.
// The sharing vector (sharing_30.json) is in test/sharing_feed.test.mjs.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TajweedError } from '../web/index.js';
import { ERROR_CODES, toTajweedError } from '../web/api/errors.js';
import { HEAD_NAMES, DEFAULT_HEADS, decodedOf, TajweedHeads } from '../web/api/heads.js';
import { resolveContext } from '../web/api/model.js';
import { ayahsIn } from '../web/api/surahs.js';
import { SpeechTracker, activeFrames, greedyIds, ACTIVE_HEADS, DEFAULT_SILENCE_MS, MIN_SILENCE_MS, MAX_SILENCE_MS, FRAME_MS } from '../web/api/speech.js';
import { createClient, resetClientForTests } from '../web/api/client.js';
import { acceptManifest, parseGoldenRawTolerance, MODEL_VERSION_RE, compareModelVersions } from '../web/tajweed/manifest.js';
import { SDK_VERSION } from '../web/platform/client.js';
import { Telemetry } from '../web/platform/telemetry.js';
import { memoryState } from '../web/platform/storage.js';
import { validate } from './helpers/jsonschema.mjs';
import { build3, stubPlatform, seamsFor, audioFor, KEY } from './helpers/model3.mjs';

const DIR = fileURLToPath(new URL('./vectors30/', import.meta.url));
// the folder of the shared 3.0 contract (errors.json, vectors/), where there is one
const SHARED = process.env.TAJWEED_CONTRACT_30 ? path.join(process.env.TAJWEED_CONTRACT_30, 'vectors') : '';
const load = (f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8'));
const code = (c) => (e) => e instanceof TajweedError && e.code === c;

test('the vector files here are the shared ones, byte for byte', { skip: existsSync(SHARED) ? false : 'TAJWEED_CONTRACT_30 is not set (the folder of the shared 3.0 contract)' }, () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 10);
  for (const f of files) assert.ok(readFileSync(path.join(DIR, f)).equals(readFileSync(path.join(SHARED, f))), `${f} differs from the shared vector`);
});

test('names.json: heads, default selection, events, error codes, option values', () => {
  const n = load('names.json');
  const h = new TajweedHeads(Object.fromEntries(n.heads.map((x) => [x.name, new Float32Array((x.frameMs === 40 ? 2 : 4) * x.classes)])), 2, null);
  assert.deepEqual([...HEAD_NAMES], n.heads.map((x) => x.name));
  for (const x of n.heads) {
    const g = h.get(x.name);
    assert.deepEqual([g.name, g.kind, g.frameMs, g.classes], [x.name, x.kind, x.frameMs, x.classes]);
    assert.deepEqual(Object.keys(g), n.head_fields);
  }
  assert.deepEqual([...DEFAULT_HEADS], n.default_heads);
  // the catalogue (errors.json) is the source of the codes; this file lists them in catalogue order
  assert.deepEqual([...ERROR_CODES], n.error_codes);
  assert.equal(n.error_codes.length, 26);
  assert.equal(new TajweedError('cancelled').docs, n.error_docs_base + 'cancelled');
  assert.deepEqual([[...ACTIVE_HEADS], DEFAULT_SILENCE_MS, FRAME_MS, 20], [n.speech.active, n.speech.default_window_ms, n.speech.frame_ms, n.speech.timing_frame_ms]);
  const d = decodedOf({ logProbs: new Float32Array(38).fill(-5), n40: 1 });
  assert.deepEqual(Object.keys(d), n.decoded_fields);
});

test('ayah_counts.json: the 114 counts', () => {
  const a = load('ayah_counts.json');
  const counts = a.counts || a.ayah_counts || a.ayahs;
  assert.equal(counts.length, 114);
  for (let s = 1; s <= 114; s++) assert.equal(ayahsIn(s), counts[s - 1], `surah ${s}`);
  assert.equal(counts.reduce((x, y) => x + y, 0), 6236);
  assert.equal(ayahsIn(0), 0);
  assert.equal(ayahsIn(115), 0);
});

test('manifest_30.json: every case is accepted or refused with its code; the signed text, the tolerance and the versions', async () => {
  const v = load('manifest_30.json');
  const enc = new TextEncoder();
  // `sdk_version` is the version the file was built with; its cases hold for an SDK of 3.0.0 to 3.1.99 (the two
  // cases of a model that needs a newer SDK name 3.1.100 and 3.2.0). Every case runs against the SDK's OWN
  // version (no sdkVersion option), which must be in that range and not below the file's.
  const [own, built] = [SDK_VERSION, v.sdk_version].map((s) => s.split('.').map(Number));
  assert.equal(own[0] === 3 && own[1] <= 1 && (own[1] > built[1] || (own[1] === built[1] && own[2] >= built[2])), true, `SDK ${SDK_VERSION} is ${v.sdk_version} or a later 3.0.x or 3.1.x`);
  for (const c of v.cases) {
    const opts = { trustedKeys: [v.public_key_hex], requireSignature: true, requireVersion: true,
      expect: c.config ? { version: c.config.version, build: c.config.revision } : {} };
    let got;
    try { got = await acceptManifest(enc.encode(c.manifest), opts); } catch (e) {
      assert.equal(c.expect.outcome, 'refused', `${c.name}: refused with ${e.code} (${e.message})`);
      assert.equal(toTajweedError(e).code, c.expect.code, c.name);
      continue;
    }
    assert.equal(c.expect.outcome, 'ok', `${c.name}: accepted, expected ${c.expect.code}`);
    assert.equal(got.manifest.version, c.expect.version, c.name);
    assert.equal(got.build, c.expect.build, c.name);
    assert.equal(got.toleranceSigned, c.expect.golden_tolerance_signed, `${c.name}: golden_tolerance signed`);
    assert.equal(got.rawToleranceSigned, c.expect.golden_raw_signed, `${c.name}: golden_raw signed`);
    const raw = got.rawToleranceSigned ? parseGoldenRawTolerance(got.manifest.golden_raw_tolerance) : null;
    assert.deepEqual(raw ? raw.tolerance : null, c.expect.golden_raw_tolerance, `${c.name}: the tolerance in force`);
    assert.deepEqual(raw ? raw.tokensOnly.slice().sort() : [], (c.expect.tokens_only_builds || []).slice().sort(), `${c.name}: builds judged on tokens only`);
    assert.equal(got.signedText, c.signed_text, `${c.name}: the signed text`);
  }
  for (const s of v.versions.valid) assert.ok(MODEL_VERSION_RE.test(s), s);
  for (const s of v.versions.invalid) { assert.ok(!MODEL_VERSION_RE.test(s), JSON.stringify(s)); assert.equal(compareModelVersions(s, '4.0.0'), null); }
  for (const [a, b, want] of v.versions.order) assert.equal(compareModelVersions(a, b), want, `${a} ? ${b}`);
  // the two production manifests of 2.x verify with the production key and are refused as builds for an older SDK
  for (const r of v.real_manifests) {
    const bytes = readFileSync(fileURLToPath(new URL(`./tajweed/${r.file}`, import.meta.url)));
    await assert.rejects(acceptManifest(bytes, { trustedKeys: [r.trusted_key], requireSignature: true, requireVersion: true }),
      (e) => e.code === 'version_missing' && toTajweedError(e).code === r.expect.code);
  }
});

// log_probs rows for greedy ids: the id at -0.1, everything else at -10
function rows(ids) {
  const a = new Float32Array(ids.length * 38).fill(-10);
  ids.forEach((id, t) => { a[t * 38 + id] = -0.1; });
  return a;
}
const runs = (ids) => ids.filter((x, i) => x !== 0 && x !== ids[i - 1]).length;

// one case of speech.json through the tracker, chunk by chunk, as a Session feeds it
function replaySpeech(c) {
  const t = new SpeechTracker(c.endOnSilenceMs || DEFAULT_SILENCE_MS);
  const chunkSpeech = [], events = [];
  let used = 0, ended = false;
  for (let at = 0, k = 0; at < c.frames.length && !ended; at += c.chunk_frames, k++) {
    const ids = c.frames.slice(at, at + c.chunk_frames);
    const r = t.feed(ids, c.timing.slice(2 * at, 2 * (at + c.chunk_frames)));
    used += ids.length;
    chunkSpeech.push(r.speech);
    for (const e of r.events) events.push({ event: e.type, ...(e.type === 'speechStarted' ? { atMs: e.atMs } : { atMs: e.atMs, silenceMs: e.silenceMs }), chunk: k });
    // endOnSilenceMs: the chunk with the frame of speechEnded is whole and the last one
    if (c.endOnSilenceMs && r.events.some((e) => e.type === 'speechEnded')) { ended = true; events.push({ event: 'ended', reason: 'silence', chunk: k }); }
  }
  return { used, chunkSpeech, events, counts: t.counts() };
}

test('speech.json: active frames, totals, tokens per head, chunk.speech and the events of every case, chunk by chunk', () => {
  const v = load('speech.json');
  assert.deepEqual([v.frame_ms, v.timing_frame_ms, v.default_window_ms, v.default_window_frames], [FRAME_MS, 20, DEFAULT_SILENCE_MS, 38]);
  assert.equal(v.cases.length, 32);
  for (const c of v.cases) {
    assert.equal(c.timing.length, 2 * c.frames.length, c.name);
    const { used, chunkSpeech, events, counts: n } = replaySpeech(c);
    const x = c.expect;
    assert.equal(used, x.frames_used, c.name);
    assert.deepEqual(activeFrames(c.frames.slice(0, used), c.timing.slice(0, 2 * used)).map((b) => (b ? 1 : 0)), x.speech, `${c.name}: speech frames`);
    assert.deepEqual([n.speech, n.silence], [x.speech_frames, x.silence_frames], `${c.name}: totals`);
    assert.ok(Math.abs((n.speech * 40) / 1000 - x.speech_s) < 1e-9 && Math.abs((n.silence * 40) / 1000 - x.silence_s) < 1e-9, c.name);
    assert.deepEqual(chunkSpeech, x.chunk_speech, `${c.name}: chunk.speech`);
    assert.deepEqual(events, x.events, `${c.name}: events`);
    // tokens per CTC head, through the public Heads (greedy runs; a 20 ms head counts on its own frames)
    const arrays = { log_probs: rows(c.frames.slice(0, used)) };
    for (const [h, ids] of Object.entries(c.other_heads || {})) arrays[h] = rows(ids);
    const heads = new TajweedHeads(arrays, used, null);
    for (const [h, want] of Object.entries(x.tokens)) assert.equal(heads.greedy(h).length, want, `${c.name}: tokens of ${h}`);
    // greedyIds reads the ids back from head values (the lowest id on ties: a uniform row is blank)
    assert.deepEqual(greedyIds(rows(c.frames.slice(0, 16))), c.frames.slice(0, 16), c.name);
  }
  assert.deepEqual(greedyIds(new Float32Array(76).fill(-3.6)), [0, 0]);
});

const speechCase = (start) => {
  const c = load('speech.json').cases.find((x) => x.name.startsWith(start));
  assert.ok(c, `speech.json has the case "${start}"`);
  return { c, r: replaySpeech(c) };
};

test('speech: the longest held vowel of the fixture does not end the take at the default 1500 ms', () => {
  const { c, r } = speechCase('fixture take 20: the longest held vowel of the fixture does not end the take');
  assert.equal(c.endOnSilenceMs, null);
  assert.equal(c.frames.length, 128);
  // log_probs alone is blank for 39 frames in a row (1.56 s, longer than the window) from frame 57
  let run = 0, longest = 0, from = -1;
  c.frames.forEach((id, f) => { run = id === 0 ? run + 1 : 0; if (run > longest && c.frames.slice(0, f - run + 1).some((x) => x !== 0) && c.frames.slice(f + 1).some((x) => x !== 0)) { longest = run; from = f - run + 1; } });
  assert.deepEqual([longest, from], [39, 57]);
  assert.deepEqual(r.events, [{ event: 'speechStarted', atMs: 280, chunk: r.events[0].chunk }], 'one speechStarted at 280 ms, no speechEnded');
  assert.equal(r.used, 128);
});

test('speech: real silence ends the take 1500 ms after the last active frame, within one chunk', () => {
  const { c, r } = speechCase('fixture take 20 followed by silence');
  const ended = r.events.find((e) => e.event === 'speechEnded');
  assert.deepEqual([ended.atMs, ended.silenceMs, ended.chunk, c.chunk_frames, r.used], [4000, 1520, 17, 8, 144]);
  assert.equal(r.events.filter((e) => e.event === 'speechEnded').length, 1);
  assert.deepEqual(r.events, c.expect.events);
});

test('speech: a clip that ends on a held vowel followed by silence ends once', () => {
  const { c, r } = speechCase('fixture take 20 cut at the end of its held vowel, then silence');
  const count = (name) => r.events.filter((e) => e.event === name).length;
  assert.deepEqual([count('speechStarted'), count('speechEnded'), count('ended')], [1, 1, 1]);
  assert.equal(r.events.find((e) => e.event === 'speechEnded').atMs, 3560);
  assert.deepEqual(r.events, c.expect.events);
});

test('speech.json: endOnSilenceMs is off, or a whole number from 500 to 60000; anything else is invalid_argument', async () => {
  const v = load('speech.json').endOnSilenceMs;
  assert.deepEqual([MIN_SILENCE_MS, MAX_SILENCE_MS], [load('names.json').session_options.endOnSilenceMs.min, load('names.json').session_options.endOnSilenceMs.max]);
  resetClientForTests();
  const api = await stubPlatform({ build: await build3() });
  const client = await createClient({ key: KEY }, seamsFor(api));
  const model = await client.model();
  for (const value of [...v.off, ...v.valid]) { const s = model.session({ endOnSilenceMs: value }); assert.equal(s._o.endOnSilenceMs, value || 0, String(value)); await s.cancel(); }
  for (const value of v.invalid_argument) assert.throws(() => model.session({ endOnSilenceMs: value }), code('invalid_argument'), JSON.stringify(value));
  await client.close();
});

test('settled.json: the decoded tokens and settled after each chunk, with replacements; settled never drops without one', () => {
  const v = load('settled.json');
  for (const c of v.cases) {
    let chunks = [], before = 0;
    for (const s of c.steps) {
      const replaced = !!s.backendChanged;
      if (replaced) chunks = [...chunks.slice(0, s.backendChanged.fromChunk), ...s.backendChanged.chunks];
      else chunks.push(s.chunk);
      const ids = chunks.flat();
      const d = decodedOf({ logProbs: rows(ids), n40: ids.length, isFinal: !!s.final });
      assert.equal(ids.length, s.expect.frames, c.name);
      assert.deepEqual(d.tokens.map((t) => ({ id: t.id, firstFrame: t.firstMs / 40, lastFrame: t.lastMs / 40, firstMs: t.firstMs, lastMs: t.lastMs })), s.expect.tokens, c.name);
      assert.equal(d.settled, s.expect.settled, `${c.name}: settled`);
      assert.equal(d.isFinal, s.expect.isFinal, c.name);
      if (!replaced) assert.ok(d.settled >= before, `${c.name}: settled dropped without a replacement`);
      before = d.settled;
    }
  }
});

test('inference_context.json: the app, then the config, then the manifest; the app\'s unknown context is an error', () => {
  const v = load('inference_context.json');
  for (const c of v.cases) {
    if (c.expect.error) { assert.throws(() => resolveContext(c.app, c.config, c.manifest), code(c.expect.error), c.name); continue; }
    assert.deepEqual(resolveContext(c.app, c.config, c.manifest), c.expect, c.name);
  }
});

test('telemetry_30.json: the 6.2 counters of six takes per cohort, and the whole payload of a day', () => {
  const v = load('telemetry_30.json');
  const t = new Telemetry({ state: memoryState(), platform: 'web', sdkVersion: SDK_VERSION, appVersion: '3.2', device: { class: 'browser', soc: 'wasm', os_major: 13 },
    clock: () => Date.parse('2026-11-11T10:00:00Z') });
  for (const k of v.takes) {
    const ids = k.heads.log_probs;
    const tokens = {};
    for (const h of v.ctc_heads) if (k.selected.includes(h) && k.heads[h]) tokens[h] = runs(k.heads[h]);
    // speech and silence from the same active frames as the events: log_probs or timing_log_probs, whether or
    // not the app selected the timing head (it is counted in `tokens` only when selected)
    const sp = activeFrames(ids, k.heads.timing_log_probs).filter(Boolean).length;
    const aborted = k.end === 'cancel' || k.end === 'ended:error';
    t.take({ revision: v.version, build: v.build, context: k.context, backend: k.backend },
      { samples: k.samples, sampleRate: k.sample_rate, chunkUs: k.chunk_compute_us, aborted, tokens: aborted ? {} : tokens, speechFrames: sp, silenceFrames: ids.length - sp });
  }
  for (const [surah, from, to] of v.example_reports.recited) t.recited(surah, to - from + 1);
  for (const [rule, checked, flagged] of v.example_reports.checks) t.checks(rule, checked, flagged);
  t.seal();
  const p = t.pending().at(-1);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.equal(p.cohorts.length, v.cohorts.length);
  for (const want of v.cohorts) {
    const c = p.cohorts.find((x) => x.context === want.context && x.backend === want.backend);
    assert.deepEqual([c.revision, c.build, c.sessions, c.aborted, c.takes], [want.revision, want.build, want.sessions, want.aborted, want.takes], want.context);
    for (const f of ['audio_s', 'speech_s', 'silence_s', 'compute_s']) assert.ok(near(c[f], want[f]), `${want.context} ${f}: ${c[f]} != ${want[f]}`);
    assert.deepEqual(c.tokens, want.tokens, want.context);
    for (const gone of v.cohort_fields_removed) assert.ok(!(gone in c), gone);
  }
  // the app-reported part of the example payload, and its `reported` list
  const ex = v.example_payload;
  for (const f of v.reported_order) assert.deepEqual(p[f], ex[f], f);
  assert.deepEqual(p.reported, ex.reported);
  // every field of our body is one the example payload (the server's closed schema takes it as it is) has
  const exCohort = new Set(Object.keys(ex.cohorts[0]));
  for (const c of p.cohorts) for (const f of Object.keys(c)) assert.ok(exCohort.has(f), `cohort field ${f}`);
  for (const f of Object.keys(p)) assert.ok(f in ex, `top-level field ${f}`);
});

test('`reported` lists exactly the app-reported fields in the body, for every combination of the six', () => {
  const v = load('telemetry_30.json');
  const six = v.reported_order;
  for (let mask = 0; mask < 64; mask++) {
    const day = { v: 2, day: '2026-11-11', product: 'web', platform: 'web', sdk_version: '3.0.0', app_version: '1', device: {}, cohorts: [], coverage: {}, downloads: [], launches: 1 };
    const want = six.filter((_, i) => mask & (1 << i));
    // rule_flags only travels with rule_checks (a flag is of a check)
    if (want.includes('rule_flags') && !want.includes('rule_checks')) continue;
    for (const f of want) day[f] = f === 'ayahs' || f === 'words' ? 3 : f === 'rule_checks' || f === 'rule_flags' ? { madd: 2 } : { 1: 3 };
    const body = Telemetry.wire(day);
    const present = six.filter((f) => body[f] !== undefined);
    assert.deepEqual(present, want, `mask ${mask}`);
    if (want.length) assert.deepEqual(body.reported, want, `mask ${mask}`); else assert.ok(!('reported' in body), 'nothing reported: no field');
  }
  assert.deepEqual(v.nothing_reported.fields, {});
});

async function clientFor(o = {}) {
  resetClientForTests();
  const api = await stubPlatform({ build: await build3(), ...o });
  const clock = { now: Date.parse('2026-11-11T10:00:00Z') };
  const seams = seamsFor(api, { clock: () => clock.now });
  const client = await createClient({ key: KEY, appVersion: '1.0' }, seams);
  return { api, seams, client, clock };
}
const dayOf = (client) => {
  const d = (client._ql.state.get('telemetry.days') || {})['2026-11-11'] || {};
  const wire = Telemetry.wire({ v: 2, cohorts: [], ...d });
  return Object.fromEntries(['ayahs', 'surah_ayahs', 'coverage', 'words', 'rule_checks', 'rule_flags', 'reported'].filter((f) => wire[f] !== undefined).map((f) => [f, wire[f]]));
};

test('telemetry_30.json: reportRecited, every valid and refused call, and when a report is counted', async () => {
  const v = load('telemetry_30.json').report_recited;
  const { client, seams } = await clientFor();
  const model = await client.model();
  const take = async (steps) => {
    const s = model.session();
    s.push(audioFor([3, 3, 0, 0, 0, 0, 0, 0]));
    const results = [];
    let over = null;
    for (const [what, ...a] of steps) {
      if (what === 'recited') {
        try { s.reportRecited(...a); results.push('ok'); } catch (e) { assert.ok(code(v.refused_code)(e)); results.push(e.code); }
      } else if (a[0] === 'finish') { await s.finish(); over = a[0]; }
      else if (a[0] === 'cancel') { await s.cancel(); over = a[0]; }
      else if (a[0] === 'ended:error') { seams.host.failPush = 'boom'; s.push(audioFor([1])); await s.finish().catch(() => {}); seams.host.failPush = null; over = a[0]; }
      else if (a[0].startsWith('ended:')) { s._end(a[0].slice(6)); await s.finish(); over = a[0]; }
      else throw new Error(`unknown end ${a[0]}`);
    }
    if (!over) await s.cancel();
    return results;
  };
  for (const call of v.valid) { const s = model.session(); s.reportRecited(...call); await s.cancel(); }
  for (const call of [...v.refused, ...v.refused_untyped]) {
    const s = model.session();
    assert.throws(() => s.reportRecited(...call), code(v.refused_code), JSON.stringify(call));
    await s.cancel();
  }
  assert.deepEqual(dayOf(client), {}, 'cancelled takes count no report');
  for (const k of v.takes) {
    assert.deepEqual(await take(k.steps), k.results, k.name);
    assert.deepEqual(dayOf(client), k.day_after, k.name);
  }
  await client.close();
});

test('telemetry_30.json: reportChecks, every valid and refused call, the day\'s sequence, 32 rules a day', async () => {
  const v = load('telemetry_30.json').report_checks;
  let { client } = await clientFor();
  const call = (c) => { try { client.analytics.reportChecks(...c); return 'ok'; } catch (e) { assert.ok(code(v.refused_code)(e)); return e.code; } };
  for (const c of v.valid) assert.equal(call(c), 'ok', JSON.stringify(c));
  for (const c of [...v.refused, ...v.refused_untyped]) assert.equal(call(c), v.refused_code, JSON.stringify(c));
  await client.close();
  ({ client } = await clientFor());
  for (const s of v.sequence.calls) assert.equal(call(s.call), s.result, JSON.stringify(s.call));
  assert.deepEqual(dayOf(client), v.sequence.day_after);
  await client.close();
  ({ client } = await clientFor());
  const r = v.rules_a_day;
  r.calls.forEach((c, i) => assert.equal(call(c), r.results[i], JSON.stringify(c)));
  assert.deepEqual(dayOf(client), r.day_after);
  // analytics off: the calls are still validated and nothing is counted
  await client.close();
  resetClientForTests();
  const api = await stubPlatform({ build: await build3() });
  client = await createClient({ key: KEY, analytics: 'off' }, seamsFor(api));
  assert.equal(call(['madd', 3, 1]), 'ok');
  assert.equal(call(['Madd', 3, 1]), v.refused_code);
  assert.equal(client._ql.state.get('telemetry.days'), null);
  await client.close();
});

test('diagnosis: the schema takes the valid examples and refuses the invalid ones', () => {
  const schema = load('diagnosis.schema.json');
  const ex = load('diagnosis_examples.json');
  for (const e of ex.valid) assert.deepEqual(validate(schema, e.report), [], e.name);
  for (const e of ex.invalid) assert.ok(validate(schema, e.report).length > 0, e.name);
});

test('topk.json: every row at k 1, 2, 3 and 38 through the decoded layer\'s ranking: ids, log-probs and margins exactly', () => {
  const v = load('topk.json');
  assert.deepEqual(v.k_to_test, [1, 2, 3, 38]);
  assert.equal(v.cases.length, 26);
  const fields = load('names.json').session_options.topK_entry_fields;
  let values = 0;
  for (const c of v.cases) {
    // the 38 float32 values of one frame, as big-endian hex
    const row = new Float32Array(c.bits.map((h) => Buffer.from(h, 'hex').readFloatBE(0)));
    for (const k of v.k_to_test) {
      const frame = decodedOf({ logProbs: row, n40: 1, topK: k }).frames[0];
      assert.equal(frame.topK.length, k, `${c.name} k ${k}`);
      for (let j = 0; j < k; j++) {
        const e = frame.topK[j];
        for (const f of fields) assert.ok(f in e, `an entry has ${f}`);
        // exact: a margin that is off in its last place was computed in float32, not as a double
        assert.equal(e.id === c.ranked.ids[j] && e.logProb === c.ranked.log_probs[j] && e.margin === c.ranked.margins[j], true,
          `${c.name} k ${k} rank ${j + 1}: ${e.id} ${e.logProb} ${e.margin} != ${c.ranked.ids[j]} ${c.ranked.log_probs[j]} ${c.ranked.margins[j]}`);
        values += 3;
      }
    }
  }
  assert.equal(values, 3432, '26 rows x (1 + 2 + 3 + 38) entries x 3 values');
  // off: a frame has no topK
  assert.equal(decodedOf({ logProbs: new Float32Array(38).fill(-5), n40: 1 }).frames[0].topK, undefined);
});

test('the topK option takes 0 (off) or 1 to 38; anything else is invalid_argument', async () => {
  const names = load('names.json').session_options;
  assert.deepEqual([names.topK_default, names.topK_max], [0, 38]);
  resetClientForTests();
  const api = await stubPlatform({ build: await build3() });
  const client = await createClient({ key: KEY }, seamsFor(api));
  const model = await client.model();
  for (const k of [undefined, null, 0, 1, 2, 3, 37, 38]) { const s = model.session({ topK: k }); assert.equal(s._o.topK, k || 0, String(k)); await s.cancel(); }
  for (const k of [-1, 39, 1.5, '3', true, NaN]) assert.throws(() => model.session({ topK: k }), code('invalid_argument'), String(k));
  const s = model.session({ topK: 38 });
  s.push(audioFor([0, 4, 0, 0, 0, 0, 0, 0]));
  const frames = (await s.finish()).decoded().frames;
  assert.deepEqual([frames[1].topK.length, frames[1].topK[0].id, frames[1].topK[37].margin], [38, 4, 0], '38 deep: every token ranked, the last margin 0');
  await client.close();
});
