// The engine Worker's controller end to end in Node, against the fake API and CDN (test keys) and the real Core:
// attest with the page session's keys, the signed config, Turnstile at the first lease, the lease, the ciphertext
// downloaded and installed by the Core, the model opened, takes, the recited counts and the app's judgement, a kill
// mid-take recovered once, a signed stop, and what is stored (ciphertext only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller, SdkError } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';
import { QLC } from '../../sdk4/frame/core.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const engine = await loadEngine();
const dir = testBuild();
const skip = !engine ? 'no packaged engine (python scripts/build_web4.py engine)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;

function noise(seconds, seed = 1) {
  const out = new Float32Array(16000 * seconds);
  let x = seed;
  for (let i = 0; i < out.length; i++) { x = (x * 1103515245 + 12345) >>> 0; out[i] = ((x / 2 ** 32) - 0.5) * 0.05; }
  return out;
}

async function session(srv, { files = new MemoryFiles(), kv = new MemoryKV(), turnstile = srv.turnstile, leaseStore } = {}) {
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch,
    files, kv, engine, trustedKeys: [srv.trustedKey], turnstile, autoSend: false, ...(leaseStore === false ? { leaseStore: false } : {}) });
  await c.init();
  return c;
}

async function take(c, { seconds = 2, report = null, finish = true } = {}) {
  const { takeId } = await c.start({ context: 'c16_l64', sampleRate: 16000, heads: ['log_probs', 'timing_log_probs', 'conf'] });
  const pcm = noise(seconds, takeId);
  let chunks = 0;
  for (let i = 0; i < pcm.length; i += 1600) chunks += (await c.push(pcm.slice(i, i + 1600))).chunks.length;
  if (report) c.reportRecited({ takeId, ...report });
  if (!finish) return { takeId, chunks };
  const f = await c.finish();
  return { takeId, chunks: chunks + f.chunks.length, last: f };
}

test('a page session: lease with Turnstile, install, open, takes; only ciphertext is stored', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const files = new MemoryFiles();
  const c = await session(srv, { files });
  const info = await c.openModel();
  assert.equal(info.version, srv.manifest.version);
  assert.equal(info.build, srv.build);
  assert.equal(info.tokens.length, 38);
  assert.ok(info.calibration && info.calibration.text.startsWith('{'));
  assert.equal(srv.state.leases, 1);
  assert.equal(srv.state.passed.size, 1, 'the first lease of the page session passed Turnstile');
  // the order (11-14): config, attest, lease, then the manifest and the files from the lease answer's base
  const calls = srv.state.calls;
  const lease = calls.indexOf('POST /v1/model-key'), cfg = calls.indexOf('GET /v1/config'), att = calls.indexOf('POST /v1/attest');
  const firstCdn = calls.findIndex((x) => x.includes('/models/'));
  assert.ok(att < cfg && cfg < lease && lease < firstCdn, calls.join(' | '));
  assert.ok(calls[firstCdn].endsWith('/manifest.json'));
  // every API and CDN request named the verified site
  assert.deepEqual([...srv.state.sawSite], [srv.site]);
  // stored: device forms (QLE1 containers, form 2) and the plain calibration; no CDN form left, no plaintext
  const stored = await files.list();
  assert.ok(stored.length >= 6);
  for (const f of stored) {
    const b = await files.get(f.form, f.path);
    if (f.form === QLC.FORM_PLAIN) { assert.equal(f.path, 'calibration.json'); continue; }
    assert.equal(f.form, QLC.FORM_DEVICE, f.path);
    assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x51, 0x4c, 0x45, 0x0d, 0x0a, 0x1a, 0x0a], f.path);
    assert.equal(b[13], 2, `${f.path} is the device form`);
  }
  // a second model open in the same page session rides on the same lease and downloads nothing
  const before = srv.state.downloads;
  c.closeModel();
  await c.openModel();
  assert.equal(srv.state.leases, 1);
  assert.equal(srv.state.downloads, before);
  const t = await take(c, { seconds: 2 });
  assert.ok(t.chunks >= 6);
  await c.close();
});

test('recited counts: the app report counts where the detector counted nothing, with the judgement, once', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const kv = new MemoryKV();
  const c = await session(srv, { kv });
  await c.openModel();
  // noise: the detector counts nothing, so the app's report is the take's source (17.1)
  await take(c, { report: { surah: 2, from: 255, to: 257, outcome: { correct: false, mistakes: 2, rules: ['madd', 'qalqalah'] }, perAyah: { 255: { correct: true } } } });
  // a report after the take ended, for the take just finished, is still taken (until the next take starts)
  const t2 = await take(c, { seconds: 1 });
  c.reportRecited({ takeId: t2.takeId, surah: 1, from: 1, to: 7 });
  await take(c, { seconds: 1 }); // the next take: t2 settles with its report
  assert.throws(() => c.reportRecited({ takeId: 99, surah: 2, from: 3, to: 1 }), /ayahs 3 to 1/);
  const d = Object.values(c.state.get('telemetry.days'))[0];
  assert.equal(d.app_ayahs, 3 + 7);
  assert.deepEqual(d.app_surah_ayahs, { 1: 7, 2: 3 });
  assert.equal(d.ayahs || 0, 0, 'nothing measured');
  assert.deepEqual(d.judged, { ayahs: 3, correct: 1, incorrect: 2, mistakes: 2, first: 3, first_correct: 1 }, 'the mistakes of a range outcome count once');
  assert.deepEqual(d.v4.recited_takes, { app: 2 });
  assert.deepEqual(d.rule_checks, { madd: 2, qalqalah: 2 });
  c.ql.telemetry.seal();
  const body = JSON.parse(c.state.get('telemetry.sealed')[0].body);
  assert.deepEqual(body.reported, ['app_ayahs', 'app_surah_ayahs', 'rule_checks', 'rule_flags', 'judged', 'judged_surah_ayahs', 'correct_surah_ayahs', 'judged_tenure']);
  assert.equal(body.coverage, undefined);
  // the last take waits for a report until the next take or the close; the close settles it
  await c.close();
  assert.equal([...c.state.m.keys()].filter((k) => k.startsWith('take:')).length, 0);
});

// a take has a journal record only where the recited detector runs: the build must carry the recited index
const recitedSkip = skip || (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).files.some((f) => f.role === 'recited') ? false : 'the test build has no recited index');
test('a kill mid-take: the next page session finishes the take from the journal and counts it once', { skip: recitedSkip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await session(srv, { kv, files });
  await a.openModel();
  // a finished take first (the page reports it: the analytics session opens), then one the kill cuts
  await take(a, { seconds: 1 });
  a.takeReport({ cohort: { revision: '4.1.0', build: srv.build, context: 'c16_l64', backend: 'cpu' }, data: { samples: 16000 * 90, sampleRate: 16000, aborted: false, hourSpeechMs: { 10: 2000 } } });
  const t = await take(a, { seconds: 2, finish: false, report: { surah: 112, from: 1, to: 4 } });
  a.tick(); // the background timer journals the units fed so far
  await a.state.flush();
  // the page is killed: nothing else runs. The next page session (new keys, new lease, the same site's storage):
  const b = await session(srv, { kv, files });
  await b.openModel();
  const days = Object.values(b.state.get('telemetry.days') || {});
  assert.equal(days.reduce((n, d) => n + (d.app_ayahs || 0), 0), 4, `take ${t.takeId} counted once from its record`);
  assert.equal([...b.state.m.keys()].filter((k) => k.startsWith('take:')).length, 0);
  const v = days.reduce((o, d) => ({ ...o, ...(d.v4 || {}) }), {});
  assert.equal(v.recited_takes.recovered, 1, 'counted as recovered');
  // closed at the next start before its launch's send point: in the report b sent at launch
  const sentSessions = srv.state.events.map((e) => (typeof e === 'string' ? JSON.parse(e) : e)).filter((e) => e.session_s);
  assert.equal(sentSessions.length, 1);
  assert.equal(sentSessions[0].session_s.le_300, 1, 'the session of the killed page (90 s) closed at the next start, once');
  assert.ok(b.state.get('learner').activeDays.length === 1, 'the active day kept with the counters');
  await b.close();
  const c = await session(srv, { kv, files });
  await c.openModel();
  // b's close sealed and sent its day; what was sent plus what c holds is still the one take
  const sent = srv.state.events.map((e) => JSON.parse(typeof e === 'string' ? e : JSON.stringify(e))).reduce((n, e) => n + (e.app_ayahs || 0), 0);
  const held = Object.values(c.state.get('telemetry.days') || {}).reduce((n, d) => n + (d.app_ayahs || 0), 0);
  assert.equal(sent + held, 4, 'never counted twice');
  await c.close();
});

test('a signed stop on the lease route clears the lease and removes the files; an unverified one changes nothing', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await session(srv, { kv, files });
  await a.openModel();
  await a.close();
  assert.ok((await files.list()).length > 0);
  srv.state.stop = 'key_revoked';
  // a page without a kept lease (storage that keeps none), so the lease route is asked and answers the signed stop
  const b = await session(srv, { kv, files, leaseStore: false });
  await assert.rejects(b.openModel(), (e) => e instanceof SdkError && e.code === 'invalid_key' && e.reason === 'key_revoked');
  assert.equal((await files.list()).filter((f) => f.form === QLC.FORM_DEVICE).length, 0, 'the device forms are gone');
  // the stop is remembered: the next call fails before asking anything
  const calls = srv.state.calls.length;
  await assert.rejects(b.openModel(), (e) => e.code === 'invalid_key');
  assert.equal(srv.state.calls.length, calls);
});

test('Turnstile: a token for another challenge is refused, asked again once, then the call fails', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  let asked = 0;
  const c = await session(srv, { turnstile: async () => { asked++; return 'ts:lease:wrong'; } });
  await assert.rejects(c.openModel(), (e) => e.code === 'server_rejected');
  assert.equal(asked, 2);
  assert.equal(srv.state.leases, 0);
  await c.close();
});
