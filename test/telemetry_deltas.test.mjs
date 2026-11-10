// SDK 2.0.1 telemetry and register (the platform client doc, section 6, and Quran Lab's 15-minute choice): deltas
// sealed at send points with a fresh report_id kept before sending (a retry sends the same bytes), one report per
// UTC day (none spans midnight), 202 deletes, 400 drops, 503 and network keep the same report; the triggers (every
// 15 minutes while the page is visible, the page hidden or left with keepalive requests, the launch) on the
// client's clock; the new fields from a scored result; the share counters from the SDK's sheet and an app's own UI;
// register once per UTC day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { QuranLab, memoryState, Telemetry, DELTA_INTERVAL_MS } from '../web/platform/index.js';
import { enableSharing } from '../web/consent/index.js';
import { stubApi, KEY } from './sharing_stub_api.mjs';

const T0 = Date.parse('2026-11-09T10:00:00Z');
class FakeDocument extends EventTarget { constructor() { super(); this.visibilityState = 'visible'; } }

async function setup({ flags = { analytics: true, contributions: true }, autoSend = false, clock } = {}) {
  const api = await stubApi(flags);
  const t = { now: T0 };
  const lifecycle = { document: new FakeDocument(), window: new EventTarget() };
  const ql = await QuranLab.configure({ key: KEY, platform: 'linux', bundleId: 'org.example.recfix', apiUrl: 'https://api.test', fetch: api.fetch,
    trustedKeys: [api.pub], state: memoryState(), appVersion: '1', clock: clock || (() => t.now), autoSend, lifecycle });
  return { api, ql, t, lifecycle };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

// a scored result as the model returns it (only the fields telemetry reads)
const result = (o = {}) => ({
  surah: 36, ayah: 1,
  settings: { sites: { vowel_sub: { status: 'validated', enabled: true }, cons_sub: { status: 'validated', enabled: true }, insertion: { status: 'experimental', enabled: false } },
    madd: { status: 'validated', enabled: true }, qalqalah: { status: 'off', enabled: false }, gemination: { status: 'experimental', enabled: true } },
  sites: [{ class: 'vowel_sub', status: 'validated', flagged: true }, { class: 'vowel_sub', status: 'validated', flagged: false },
    { class: 'cons_sub', status: 'validated', flagged: false }, { class: 'insertion', status: 'experimental', flagged: false }],
  madd: [{ count: 2, status: 'validated', flagged: true }, { count: 4, status: 'validated', flagged: false }],
  qalqalah: [{ status: 'off', flagged: false }],
  gemination: [{ status: 'experimental', flagged: true }],
  words: [{ score: 2.1, flagged: true }, { score: 0.3, flagged: false }, { score: null, flagged: null }],
  summary: { sites: 4, flagged: 1 },
  ...o,
});
const fakeTf = { context: 'c16_l64', sampleRate: 16000, info: { chunkMs: 320 }, folder: { manifest: { model_id: 'v4.0', revision: 'abc' } },
  settings: { effective: () => ({ preset: 'balanced', sites: { vowel_sub: { enabled: true } }, madd: { enabled: true }, gemination: { enabled: true },
    qalqalah: { enabled: false }, lazim: { enabled: false } }), app: {}, remote: null, wordLevel: () => null } };

test('the new fields from a scored result: ayahs, surah_ayahs, words, rule checks and flags (only checks that ran; flags <= checks)', async () => {
  const { ql } = await setup();
  ql.telemetry.scored(fakeTf, result());
  ql.telemetry.scored(fakeTf, result({ surah: 1 }));
  ql.telemetry.seal();
  const p = ql.telemetry.pending().at(-1);
  assert.equal(p.ayahs, 2);
  assert.deepEqual(p.surah_ayahs, { 1: 1, 36: 1 });
  assert.equal(p.words, 4, 'words scored (not the unscored one)');
  assert.deepEqual(p.rule_checks, { vowel_sub: 4, cons_sub: 2, madd: 4, gemination: 2, word: 4 }, 'insertion (disabled) and qalqalah (off) not counted');
  assert.deepEqual(p.rule_flags, { vowel_sub: 2, madd: 2, gemination: 2, word: 2 });
  for (const [k, v] of Object.entries(p.rule_flags)) assert.ok(v <= p.rule_checks[k], `${k}: flags <= checks`);
  for (const k of Object.keys(p.rule_checks)) assert.match(k, /^[a-z][a-z0-9_]{0,23}$/);
  // at most 32 keys
  const many = result({ sites: Array.from({ length: 40 }, (_, i) => ({ class: `rule_${i}`, flagged: true })), settings: undefined });
  ql.telemetry.scored(fakeTf, many);
  ql.telemetry.seal();
  assert.equal(Object.keys(ql.telemetry.pending().at(-1).rule_checks).length, 32);
});

test('sealing: a fresh report_id per delta, stored before sending; 503 keeps the same bytes and id, then 202 deletes; 400 drops', async () => {
  const { api, ql, t } = await setup();
  assert.equal(api.state.events.length, 1, 'the launch delta');
  const launchId = api.state.events[0].body.report_id;
  ql.telemetry.count('ayahs');
  api.state.eventReply = () => ({ status: 503, body: { error: 'storage_unavailable' } });
  await ql.sendTelemetry();
  const [kept] = ql.telemetry.reports();
  assert.ok(kept, 'kept after a 503');
  assert.notEqual(kept.report_id, launchId, 'a fresh id per delta');
  const sent1 = api.state.events.at(-1).raw;
  assert.equal(sent1, kept.body, 'the stored bytes are what was sent');
  // more counted meanwhile: a new delta, the kept one unchanged; retries after the backoff send the same bytes
  ql.telemetry.count('words', 5);
  t.now += 61_000;
  api.state.eventReply = () => ({ status: 202, body: { ok: true, points: 1 } });
  await ql.sendTelemetry();
  const bodies = api.state.events.slice(-2).map((e) => e.raw);
  assert.equal(bodies[0], sent1, 'the retry: same body, same report_id');
  assert.equal(JSON.parse(bodies[1]).words, 5);
  assert.notEqual(JSON.parse(bodies[1]).report_id, kept.report_id);
  assert.deepEqual(ql.telemetry.reports(), [], '202 deletes both');
  // a network failure keeps it too (no answer at all)
  const realFetch = ql.fetch;
  ql.fetch = async (u, i) => { if (String(u).endsWith('/v1/events')) throw new TypeError('fetch failed'); return realFetch(u, i); };
  ql.telemetry.count('ayahs');
  await ql.sendTelemetry();
  assert.equal(ql.telemetry.reports().length, 1);
  ql.fetch = realFetch;
  // the backoff: not before 1 minute, then 10 minutes, then the next launch
  const id = ql.telemetry.reports()[0].report_id;
  assert.equal(ql.telemetry.due().length, 0);
  t.now += 60_001;
  assert.equal(ql.telemetry.due()[0].report_id, id);
  // 400: dropped, never retried
  api.state.eventReply = () => ({ status: 400, body: { error: 'invalid_body' } });
  await ql.flush();
  assert.deepEqual(ql.telemetry.reports(), []);
  // unsent reports older than 7 days are deleted
  ql.telemetry.count('ayahs');
  ql.telemetry.seal();
  t.now += 8 * 86_400_000;
  assert.deepEqual(ql.telemetry.reports(), []);
});

test('no delta spans midnight: counts before and after 00:00 UTC are sealed as two reports under their own days', async () => {
  const { api, ql, t } = await setup();
  t.now = Date.parse('2026-11-09T23:59:00Z');
  ql.telemetry.count('ayahs', 3);
  t.now = Date.parse('2026-11-10T00:01:00Z');
  ql.telemetry.count('ayahs', 2);
  const before = api.state.events.length;
  await ql.sendTelemetry();
  const sent = api.state.events.slice(before).map((e) => e.body);
  assert.deepEqual(sent.map((b) => [b.day, b.ayahs]), [['2026-11-09', 3], ['2026-11-10', 2]], 'oldest first, one per day');
  assert.notEqual(sent[0].report_id, sent[1].report_id);
});

test('triggers: every 15 minutes while visible (not while hidden), the page hidden and left (keepalive), at launch', async () => {
  const { api, ql, t, lifecycle } = await setup({ autoSend: true });
  try {
    assert.equal(api.state.events.length, 1, 'at launch');
    const n = () => api.state.events.length;
    ql.telemetry.count('ayahs');
    t.now += DELTA_INTERVAL_MS - 1000;
    assert.equal(ql._tick(), false, 'not before 15 minutes');
    t.now += 1000;
    assert.equal(ql._tick(), true, '15 minutes after the last send point');
    await settle();
    assert.equal(n(), 2);
    assert.equal(api.state.events.at(-1).body.ayahs, 1);
    // hidden: the background send point, with keepalive requests; no interval sends while hidden
    ql.telemetry.count('words', 3);
    lifecycle.document.visibilityState = 'hidden';
    lifecycle.document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    assert.equal(n(), 3);
    assert.equal(api.state.events.at(-1).keepalive, true);
    assert.equal(api.state.events.at(-1).body.words, 3);
    ql.telemetry.count('ayahs');
    t.now += DELTA_INTERVAL_MS * 2;
    assert.equal(ql._tick(), false, 'hidden: no interval delta');
    // back: a launch counted (and the next delta carries it)
    lifecycle.document.visibilityState = 'visible';
    lifecycle.document.dispatchEvent(new Event('visibilitychange'));
    // left: pagehide is a background send point too
    lifecycle.window.dispatchEvent(new Event('pagehide'));
    await settle();
    const last = api.state.events.at(-1);
    assert.equal(last.keepalive, true);
    assert.equal(last.body.launches, 1, 'the return to the foreground');
    assert.equal(last.body.ayahs, 1);
  } finally { ql.stopSchedule(); }
});

test('share counters: the SDK\'s sheet and an app\'s own UI count asks, yes and no; the settings switch does not', async () => {
  const { ql } = await setup();
  // own UI: answered through the return value, then later through answer()
  const answers = [{ yes: false }, null];
  const ctl = enableSharing(ql, { lang: 'en', ask: async () => answers.shift() });
  await ctl.sessionCompleted();
  for (let i = 0; i < 7; i++) await ctl.sessionCompleted(); // the re-ask after 7 sessions
  ctl.answer(true);
  ctl.setSharing(false);
  ctl.setSharing(true);
  ql.telemetry.seal();
  let p = ql.telemetry.pending().at(-1);
  assert.equal(p.share_asked, 2);
  assert.equal(p.share_no, 1);
  assert.equal(p.share_yes, 1, 'the switch is not a sheet answer');
  // the SDK's own sheet (the element without a DOM: its answer is the test's tap)
  const { ql: ql2 } = await setup();
  const { QuranLabConsent } = await import('../web/consent/element.js');
  const realShow = QuranLabConsent.prototype.show, realDoc = globalThis.document;
  try {
    globalThis.document = { createElement: () => new QuranLabConsent(), body: { appendChild() {} } };
    QuranLabConsent.prototype.remove = () => {};
    QuranLabConsent.prototype.show = async () => ({ yes: true, guardianConfirmed: false });
    const ctl2 = enableSharing(ql2, { lang: 'en' });
    await ctl2.sessionCompleted();
    ql2.telemetry.seal();
    p = ql2.telemetry.pending().at(-1);
    assert.equal(p.share_asked, 1);
    assert.equal(p.share_yes, 1);
    assert.equal(p.share_no, undefined, 'zero is left out');
  } finally {
    QuranLabConsent.prototype.show = realShow;
    delete QuranLabConsent.prototype.remove;
    globalThis.document = realDoc;
  }
});

test('register once per UTC day: twice in a day is one call, the next day one more; a failed attempt is made again', async () => {
  const { api, ql, t } = await setup();
  assert.equal(api.state.registers.length, 1);
  assert.equal(api.state.registers[0].new_install, true);
  assert.equal(await ql.register(), null, 'already registered today');
  ql.foreground();
  await ql.launch();
  await settle();
  assert.equal(api.state.registers.length, 1, 'one call today');
  t.now += 86_400_000;
  ql.foreground(); // the first foreground of the next day
  await settle();
  assert.equal(api.state.registers.length, 2);
  assert.equal(api.state.registers[1].new_install, false);
  ql.foreground();
  await settle();
  assert.equal(api.state.registers.length, 2);
  // a failure leaves the day unstamped and new_install pending
  const fresh = await setup({ clock: () => T0 });
  const st = memoryState();
  let fail = true;
  const fetch = async (u, i) => (fail && String(u).endsWith('/v1/register') ? new Response('{"error":"internal"}', { status: 500 }) : fresh.api.fetch(u, i));
  const q = await QuranLab.configure({ key: KEY, platform: 'linux', bundleId: 'org.example.recfix', apiUrl: 'https://api.test', fetch,
    trustedKeys: [fresh.api.pub], state: st, appVersion: '1', clock: () => T0, autoSend: false });
  const before = fresh.api.state.registers.length;
  fail = false;
  q.foreground();
  await settle();
  assert.equal(fresh.api.state.registers.length, before + 1, 'tried again the same day after the failure');
  assert.equal(fresh.api.state.registers.at(-1).new_install, true, 'new_install survives the failed attempt');
});

test('Telemetry.hasContent: an empty delta is not sealed', () => {
  const t = new Telemetry({ state: memoryState(), device: { class: 'node', os_major: 2 } });
  assert.equal(t.seal(), 0);
  t.count('share_no');
  assert.equal(t.seal(), 1);
  assert.throws(() => t.count('sessions'), RangeError);
});
