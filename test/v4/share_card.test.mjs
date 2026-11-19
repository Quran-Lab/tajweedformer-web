// SDK 4.0's ask to share through the controller (web/consent/index.js), on a fake clock and fake timers: the ask
// waits for the moment to settle (SHARE_ASK_SETTLE_MS with no new take), a take that starts first drops it, a card
// on screen goes with a take start ("Not now"), the card opens into the full sheet as the same ask, a yes on a card
// that was not opened is no yes, and the app's ask() asks only when an ask is due. An app's
// own screen stands in for the SDK's here; test/v4/share_card_browser.test.mjs draws the SDK's card in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enableSharing, SHARE_ASK_SETTLE_MS, APP_SESSION_GAP_MS, copyFor, registerDeck, EN } from '../../web/consent/index.js';

const DAY = 86_400_000;
const T0 = Date.parse('2027-01-15T08:00:00Z');
const GOOD = { end: 'normal', speechMs: 90_000 };

// a platform client's few parts the controller reads, with a fake clock; counts are the day's share_* counters
function fakeQl(stored, { offered = true, shareAsk = null } = {}) {
  const kv = new Map();
  if (stored) kv.set('sharing.v1', JSON.stringify(stored));
  const ql = {
    now: T0, counts: [],
    state: { get: (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), set: (k, v) => kv.set(k, JSON.stringify(v)) },
    clock() { return ql.now; }, sharingAllowed: () => offered,
    config: { v: 1, flags: { contributions: true }, ...(shareAsk ? { share_ask: shareAsk } : {}) },
    telemetry: { count: (f) => ql.counts.push(f) }, reportIssue() {}, contributor: () => 'c'.repeat(32), flags: {},
  };
  return ql;
}
// timers that run only when the test says so
function fakeTimers() {
  const due = [];
  return { due, setTimeout: (f, ms) => { due.push({ f, ms }); return due.length; }, clearTimeout() {}, run() { const x = due.splice(0); for (const d of x) d.f(); return x.map((d) => d.ms); } };
}
const flush = () => new Promise((r) => setImmediate(r));
// an install whose next ask is the second (a card): the sheet was answered "Not now" 15 days and 8 sessions ago
const afterNotNow = () => ({ v: 1, consent: 'declined', asks: 1, sessions: 10, lastAskSession: 2, installedAt: T0 - 20 * DAY, lastAskAt: T0 - 15 * DAY, lastAskDay: Math.floor((T0 - 15 * DAY) / DAY) });

test('the card waits for the moment to settle; a take that starts first drops it, and it is decided again at that take\'s end', async () => {
  const ql = fakeQl(afterNotNow());
  const timers = fakeTimers();
  const seen = [];
  const ctl = enableSharing(ql, { lang: 'en', timers, ask: async (a) => { seen.push(a); return null; } });
  ctl.takeStarted();
  const p1 = ctl.takeEnded(GOOD);
  assert.equal(seen.length, 0, 'nothing before the settle');
  assert.deepEqual(ctl.askInHand, { kind: 'card', number: 2, shown: false });
  // the learner starts another take within the 3 s: the ask is dropped, counted nowhere
  ctl.takeStarted();
  assert.deepEqual(timers.run(), [SHARE_ASK_SETTLE_MS]);
  assert.equal(await p1, null);
  assert.equal(seen.length, 0);
  assert.deepEqual([ctl.askInHand, ql.counts, ql.state.get('sharing.v1').asks], [null, [], 1]);
  // that take ends: decided again, and this time the moment settles
  const p2 = ctl.takeEnded(GOOD);
  timers.run();
  await flush();
  assert.equal(seen.length, 1);
  const a = seen[0];
  assert.equal(a.kind, 'card');
  assert.deepEqual(a.card, { line: EN.strings['card.line'], open: EN.strings['card.open'], notNow: EN.strings['card.not_now'] });
  assert.equal(a.card.line, 'Your recitation today could help another learner tomorrow.');
  assert.deepEqual(ql.counts, ['share_asked'], 'one ask on screen');
  assert.equal(ql.state.get('sharing.v1').asks, 2, 'the card is one of the three once it is on screen');
  assert.equal(await p2, null, 'the app answers later');
});

test('a card on screen goes when a take starts: "Not now", share_no; a card opened is the full sheet for the same ask', async () => {
  const ql = fakeQl(afterNotNow());
  const timers = fakeTimers();
  let shown = null;
  const ctl = enableSharing(ql, { lang: 'en', timers, ask: async (a) => { shown = a; return null; } });
  ctl.takeEnded(GOOD); timers.run(); await flush();
  assert.equal(shown.kind, 'card');
  ctl.takeStarted();
  assert.deepEqual([ql.counts, ql.state.get('sharing.v1').consent, ctl.askInHand], [['share_asked', 'share_no'], 'declined', null]);
  // 30 days and 10 sessions later the last card; opened, then yes on the full sheet
  ql.now += 31 * DAY;
  ctl.launch();
  for (let i = 0; i < 12 && ql.state.get('sharing.v1').asks < 3; i++) { ql.now += 1000; ctl.launch(); ctl.takeStarted(); ctl.takeEnded(GOOD); timers.run(); await flush(); }
  assert.equal(ql.state.get('sharing.v1').asks, 3, 'the third ask, a card');
  assert.equal(shown.kind, 'card');
  assert.equal(shown.open(), true, 'See how it helps');
  assert.equal(shown.open(), true, 'once');
  assert.equal(ql.state.get('sharing.v1').asks, 3, 'the card opened is the same ask, not counted again');
  assert.deepEqual(ctl.askInHand, { kind: 'sheet', number: 3, shown: true });
  assert.equal(ctl.answer(true), 'granted');
  assert.deepEqual(ql.counts.filter((c) => c === 'share_asked').length, 2);
  assert.equal(ql.counts.at(-1), 'share_yes');
});

test('a yes on a card that was not opened is no yes; the page hidden takes the card back as "Not now"; after 30 minutes hidden a new app session', async () => {
  const ql = fakeQl(afterNotNow());
  const timers = fakeTimers();
  let shown = null;
  const ctl = enableSharing(ql, { lang: 'en', timers, ask: async (a) => { shown = a; return null; } });
  ctl.takeEnded(GOOD); timers.run(); await flush();
  // the page is hidden with the card on screen: withdrawn, "Not now"
  await ctl.background();
  assert.deepEqual([ql.state.get('sharing.v1').consent, ql.counts], ['declined', ['share_asked', 'share_no']]);
  // shown again after 31 minutes: a new app session (its takes and recitation start again)
  ql.now += APP_SESSION_GAP_MS + 60_000;
  await ctl.foreground();
  assert.equal(ctl.state.app.takes, 0);
  // the app's own card screen answers yes without open(): not a yes (the SDK would draw its own full sheet)
  const own = fakeQl(afterNotNow());
  const t2 = fakeTimers();
  const c2 = enableSharing(own, { lang: 'en', timers: t2, ask: async () => ({ yes: true }) });
  const p = c2.takeEnded(GOOD); t2.run(); await flush();
  assert.notEqual(own.state.get('sharing.v1').consent, 'granted', 'a yes on the card itself is not consent');
  void p.catch(() => {});
});

test('ask(): only when an ask is due (never before a completed take of this app session, never during a take); otherwise null and nothing shown', async () => {
  const ql = fakeQl(afterNotNow());
  const timers = fakeTimers();
  const seen = [];
  const ctl = enableSharing(ql, { lang: 'en', timers, ask: async (a) => { seen.push(a); return { yes: false }; } });
  assert.equal(await ctl.askNow(), null, 'at launch: no take yet');
  ctl.takeStarted();
  assert.equal(await ctl.askNow(), null, 'during a take');
  ctl.takeEnded({ end: 'normal', speechMs: 5000 }); // a short take: completed, not a good moment
  assert.equal(seen.length, 0);
  const r = await ctl.askNow();
  assert.deepEqual(r, { yes: false }, 'due: the app\'s own moment, without the 60 s');
  assert.deepEqual([seen.length, seen[0].kind], [1, 'card']);
  assert.equal(await ctl.askNow(), null, 'one ask per app session');
  // a fresh install: not in the first 24 hours
  const fresh = fakeQl(null);
  const c3 = enableSharing(fresh, { lang: 'en', timers: fakeTimers(), ask: async () => ({ yes: true }) });
  c3.takeEnded(GOOD);
  assert.equal(await c3.askNow(), null);
});

test('an app\'s own screen (ONE_SHEET_40 26.1.3): handed no guardian, read for its yes alone, and the yes takes no argument', async () => {
  // the first ask is due at the next good session: an install two days old with two completed sessions
  const due = () => ({ v: 1, consent: 'unknown', asks: 0, sessions: 2, lastAskSession: 0, installedAt: T0 - 2 * DAY });
  const ql = fakeQl(due());
  ql.audience = 'children'; // what a 3.x link carried: never read
  const timers = fakeTimers();
  const seen = [];
  const ctl = enableSharing(ql, { lang: 'en', timers, ask: async (a) => { seen.push(a); return { yes: true, guardianConfirmed: false }; } });
  const p = ctl.takeEnded(GOOD); timers.run(); await flush();
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['consentVersion', 'copy', 'kind', 'lang', 'open', 'variant'], 'nothing about a guardian');
  assert.deepEqual([seen[0].kind, seen[0].variant], ['sheet', 'first']);
  assert.deepEqual(await p, { yes: true }, 'the answer is read for yes alone');
  assert.equal(ql.state.get('sharing.v1').consent, 'granted', 'a yes is a yes, whatever else the answer holds');
  assert.equal('guardian' in ql.state.get('sharing.v1'), false, 'and stores no guardian');
  assert.deepEqual(ql.counts, ['share_asked', 'share_yes']);
  // the learner's tap later, through answer(yes): a second argument is not read
  const ql2 = fakeQl(due());
  const t2 = fakeTimers();
  const c2 = enableSharing(ql2, { lang: 'en', timers: t2, ask: async () => null });
  c2.takeEnded(GOOD); t2.run(); await flush();
  assert.equal(c2.answer(true, { guardianConfirmed: false }), 'granted');
  assert.deepEqual(ql2.counts, ['share_asked', 'share_yes']);
});

test('a deck without the card strings is told apart from one with them (the SDK then shows the re-ask sheet)', () => {
  const old = { ...EN, version: '2026-11-13.1', strings: Object.fromEntries(Object.entries(EN.strings).filter(([k]) => !k.startsWith('card.'))) };
  registerDeck('zq', old);
  const c = copyFor('zq');
  assert.equal(c.has('card.line'), false, 'not through the English fallback');
  assert.equal(c.t('card.line'), EN.strings['card.line'], 't() still falls back');
  assert.equal(copyFor('en').has('card.line'), true);
  assert.equal(copyFor('zq', { 'card.line': 'Our own line.' }).has('card.line'), true, 'an app\'s own wording has the key');
  for (const lang of ['en', 'ar', 'id', 'ur', 'tr', 'ms', 'fr', 'bn']) for (const k of ['card.line', 'card.open', 'card.not_now']) assert.ok(copyFor(lang).has(k), `${lang} ${k}`);
});
