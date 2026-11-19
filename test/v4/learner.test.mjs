// Contract draft 17.8 and 17.9 in the web SDK 4.0 (sdk4/frame/telemetry4.js, learner.js): every group the Apple SDK
// sends (its LearnerAnalyticsTests ported case by case), the flags.metrics switches, the install's days written in
// the same KV transaction as the counters they feed, and a killed page's session and takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telemetry4 } from '../../sdk4/frame/telemetry4.js';
import { LearnerJournal, DayMath, juzOf } from '../../sdk4/frame/learner.js';
import { StateStore, MemoryKV } from '../../sdk4/frame/stores.js';
import { takeCounts, checkReport } from '../../sdk4/shared/recited.js';

const H = 3_600_000, D = 24 * H;
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0); // 2026-10-01 09:00 UTC, a Thursday
// the learner's zone: UTC+3, so local hours and days are fixed whatever this machine's zone is
const local = (ms) => ({ day: DayMath.utc(ms + 3 * H), hour: new Date(ms + 3 * H).getUTCHours() });

async function rig({ off = [], kv = new MemoryKV(), at = T0 } = {}) {
  const state = await StateStore.open(kv);
  const clock = { t: at };
  const t = new Telemetry4({ state, platform: 'web', sdkVersion: '4.0.0', clock: () => clock.t, metricsOff: () => new Set(off), local });
  const sealOne = () => { state.set('telemetry.sealed', null); t.seal(); const s = state.get('telemetry.sealed') || []; return s.length ? JSON.parse(s[s.length - 1].body) : null; };
  return { t, state, kv, clock, sealOne };
}
const take = (t, seconds, o = {}) => t.recordTake({ samples: 16000 * seconds, sampleRate: 16000, aborted: false, hourSpeechMs: {}, ...o });

test('learner, learner_gap, streak: once per active day, with d1, d7, d30 and the gap buckets', async () => {
  const r = await rig();
  take(r.t, 10);
  let b = r.sealOne();
  assert.deepEqual(b.learner, { active: 1, new: 1, d1: 0, d7: 0, d30: 0 });
  assert.deepEqual(b.learner_gap, { new: 1 });
  assert.deepEqual(b.streak, { 1: 1 });
  take(r.t, 10);
  b = r.sealOne();
  assert.equal(b.learner, undefined, 'sealed once per day');
  r.clock.t = T0 + D; take(r.t, 10); b = r.sealOne();
  assert.deepEqual(b.learner, { active: 1, new: 0, d1: 1, d7: 0, d30: 0 });
  assert.deepEqual(b.learner_gap, { 1: 1 });
  assert.deepEqual(b.streak, { '2_3': 1 });
  r.clock.t = T0 + 7 * D; take(r.t, 10); b = r.sealOne();
  assert.deepEqual(b.learner, { active: 1, new: 0, d1: 0, d7: 1, d30: 0 });
  assert.deepEqual(b.learner_gap, { 6: 1 });
  assert.deepEqual(b.streak, { 1: 1 });
  r.clock.t = T0 + 30 * D; take(r.t, 10); b = r.sealOne();
  assert.equal(b.learner.d30, 1);
  assert.deepEqual(b.learner_gap, { 23: 1 });
  r.clock.t = T0 + 70 * D; take(r.t, 10); b = r.sealOne();
  assert.deepEqual(b.learner_gap, { gt_30: 1 });
  // a day with no take with audio sends no learner facts
  r.clock.t = T0 + 71 * D; r.t.recordTake({ samples: 0 }); r.t.count('launches'); b = r.sealOne();
  assert.equal(b.learner, undefined);
});

test('take_s, session_s and hour_speech_s; an aborted take adds audio to the session only', async () => {
  const r = await rig();
  take(r.t, 100, { hourSpeechMs: { 12: 1200 } });
  take(r.t, 20, { hourSpeechMs: { 13: 1000 } });
  take(r.t, 5, { aborted: true, hourSpeechMs: { 14: 900 } });
  r.t.closeSession();
  const b = r.sealOne();
  assert.deepEqual(b.take_s, { le_5: 0, le_15: 0, le_30: 1, le_60: 0, le_120: 1, le_300: 0, le_600: 0, gt_600: 0 });
  assert.deepEqual(b.session_s, { le_60: 0, le_300: 1, le_600: 0, le_1200: 0, le_1800: 0, le_3600: 0, gt_3600: 0 }, 'one session of 125 s');
  assert.deepEqual(b.hour_speech_s, { 12: 1.2, 13: 1 });
});

test('juz_ayahs over a juz boundary, and repeat_ayahs within the page session only', async () => {
  const r = await rig();
  assert.equal(juzOf(2, 141), 1); assert.equal(juzOf(2, 142), 2); assert.equal(juzOf(114, 6), 30); assert.equal(juzOf(18, 74), 15); assert.equal(juzOf(18, 75), 16);
  const page = new Set();
  const m = { found: true, surah: 2, first: 140, last: 143 };
  const c = () => { const x = takeCounts(m, null); x.range = { surah: 2, first: 140, last: 143 }; return x; };
  r.t.countTake(c(), { repeatSeen: page, detectorRan: true });
  r.t.countTake(c(), { repeatSeen: page, detectorRan: true });
  r.t.countTake(c(), { repeatSeen: new Set(), detectorRan: true }); // the next page session: not a repeat
  const b = r.sealOne();
  assert.deepEqual(b.juz_ayahs, { 1: 6, 2: 6 });
  assert.equal(b.repeat_ayahs, 4);
  assert.equal(b.ayahs, 12);
  assert.deepEqual(b.recited_takes, { measured: 3 });
  assert.equal(b.reported, undefined, 'measured counts are never in reported');
});

test('recited_takes: none, app, recovered; lease ok and failed by cause', async () => {
  const r = await rig();
  r.t.countTake(takeCounts({ found: false }, null), { detectorRan: true });
  r.t.countTake(takeCounts(null, checkReport(1, 1, 7)), { detectorRan: true, recovered: true });
  r.t.recordLease('ok'); r.t.recordLease('ok'); r.t.recordLease('offline'); r.t.recordLease('attestation'); r.t.recordLease('bogus');
  const b = r.sealOne();
  assert.deepEqual(b.recited_takes, { none: 1, app: 1, recovered: 1 });
  assert.deepEqual(b.lease, { ok: 2, failed: { offline: 1, attestation: 1, other: 1 } });
  assert.equal(b.app_ayahs, 7);
});

test('first attempt against repeat, mistakes once per range, judged_tenure on the wire', async () => {
  const r = await rig();
  const seen = new Set();
  take(r.t, 10); // the first active day: tenure w1
  const report = checkReport(2, 255, 257, { outcome: { correct: false, mistakes: 2, rules: ['madd'] }, perAyah: { 255: { correct: true } } });
  r.t.countTake(takeCounts(null, report, seen), { detectorRan: true });
  r.t.countTake(takeCounts(null, checkReport(2, 255, 255, { outcome: { correct: true } }), seen), { detectorRan: true });
  const b = r.sealOne();
  assert.deepEqual(b.judged, { ayahs: 4, correct: 2, incorrect: 2, mistakes: 2, first: 3, first_correct: 1, repeat: 1, repeat_correct: 1 });
  assert.deepEqual(b.judged_tenure, { w1: { judged: 4, correct: 2 } });
  assert.deepEqual(b.rule_checks, { madd: 2 });
  assert.deepEqual(b.judged_surah_ayahs, { 2: 4 });
  assert.deepEqual(b.correct_surah_ayahs, { 2: 2 });
  for (const k of ['judged', 'judged_tenure', 'judged_surah_ayahs', 'correct_surah_ayahs', 'app_ayahs']) assert.ok(b.reported.includes(k), k);
});

test('tenure boundaries (days 6, 7, 27, 28, 89, 90) and the Monday of a week', () => {
  const j = LearnerJournal.from({ firstDay: '2026-09-21' });
  for (const [n, want] of [[0, 'w1'], [6, 'w1'], [7, 'w2_4'], [27, 'w2_4'], [28, 'm2_3'], [89, 'm2_3'], [90, 'later']]) assert.equal(j.tenure(DayMath.add('2026-09-21', n)), want, `day ${n}`);
  assert.equal(DayMath.monday('2026-11-14'), '2026-11-09');
  assert.equal(DayMath.monday('2026-11-16'), '2026-11-16');
  assert.equal(DayMath.monday('2026-11-15'), '2026-11-09');
});

test('the weekly trend: better, worse, same, not enough, once per week, none for an app that judges nothing', () => {
  const sealing = '2026-11-18'; // the week of 11-16; the last week is 11-09
  const fill = (lastCorrect, prevCorrect, n = 20) => {
    const j = new LearnerJournal();
    for (let i = 0; i < n; i++) j.judged('2026-11-10', i < lastCorrect * n);
    for (const w of ['2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03']) for (let i = 0; i < n / 4; i++) j.judged(w, i < (prevCorrect * n) / 4);
    return j;
  };
  assert.equal(fill(0.9, 0.75).takeTrend(sealing), 'better', '90 % against 75 %');
  assert.equal(fill(0.6, 0.75).takeTrend(sealing), 'worse');
  assert.equal(fill(0.8, 0.775, 40).takeTrend(sealing), 'same', '2.5 points');
  assert.equal(fill(0.9, 0.75, 8).takeTrend(sealing), 'not_enough');
  const once = fill(0.9, 0.75);
  assert.equal(once.takeTrend(sealing), 'better');
  assert.equal(once.takeTrend('2026-11-19'), null, 'once per week');
  assert.equal(new LearnerJournal().takeTrend(sealing), null);
});

test('flags.metrics: each switch turns off its own group only; learner facts are not spent while off', async () => {
  const groups = { juz: ['juz_ayahs'], hours: ['hour_speech_s'], lengths: ['take_s', 'session_s'], learner: ['learner', 'learner_gap', 'streak'],
    repeats: ['repeat_ayahs'], health: ['recited_takes', 'lease'], judged: ['judged', 'judged_surah_ayahs', 'correct_surah_ayahs', 'judged_tenure'] };
  for (const [g, fields] of Object.entries(groups)) {
    const r = await rig({ off: [g] });
    const page = new Set();
    take(r.t, 30, { hourSpeechMs: { 10: 500 } });
    const m = { found: true, surah: 2, first: 140, last: 143 };
    for (let i = 0; i < 2; i++) { const c = takeCounts(m, checkReport(2, 140, 143, { outcome: { correct: true } }), new Set()); c.range = { surah: 2, first: 140, last: 143 }; r.t.countTake(c, { repeatSeen: page, detectorRan: true }); }
    r.t.recordLease('ok');
    r.t.closeSession();
    const b = r.sealOne();
    for (const f of fields) assert.equal(b[f], undefined, `${g} off: no ${f}`);
    assert.equal(b.ayahs, 8, 'a switch turns off its group only');
    for (const [g2, f2] of Object.entries(groups)) if (g2 !== g) assert.notEqual(b[f2[0]], undefined, `${g} off keeps ${f2[0]}`);
    if (g === 'learner') assert.deepEqual(r.state.get('learner').sentDays, [], 'facts not spent while the group is off');
  }
});

test('the install\'s days and the counters they feed go in one KV transaction', async () => {
  const kv = new MemoryKV();
  const r = await rig({ kv });
  await r.state.flush();
  const before = kv.writes;
  take(r.t, 10);
  r.t.countTake(takeCounts(null, checkReport(1, 1, 7, { outcome: { correct: true } })), { detectorRan: true });
  await r.state.flush();
  assert.equal(kv.writes - before, 1, 'one transaction');
  assert.ok(kv.m.has('learner') && kv.m.has('telemetry.days') && kv.m.has('analytics.session'));
  r.sealOne();
  await r.state.flush();
  assert.deepEqual(kv.m.get('learner').sentDays, ['2026-10-01'], 'the sealed delta and the spent facts together');
  assert.ok(kv.m.get('telemetry.sealed').length >= 1);
});

test('a killed tab: its open session is closed into its own day at the next start, once', async () => {
  const kv = new MemoryKV();
  const a = await rig({ kv });
  take(a.t, 600);
  take(a.t, 300);
  await a.state.flush(); // the tab is killed here: nothing else runs
  const b = await rig({ kv, at: T0 + D });
  b.t.closeSession(); // what the Worker does at init
  const days = b.state.get('telemetry.days');
  assert.deepEqual(days['2026-10-01'].v4.session_s.slice(0, 4), [0, 0, 0, 1], 'one session of 900 s, on the day it ran');
  b.t.closeSession();
  assert.equal(b.state.get('analytics.session'), null);
  const sealed = (() => { b.t.seal(); return b.state.get('telemetry.sealed').map((s) => JSON.parse(s.body)); })();
  assert.equal(sealed.filter((s) => s.session_s).length, 1);
});
