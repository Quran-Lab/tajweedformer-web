// SDK 2.0.1, a learner who said yes is never asked again: the sheet is shown at most three times per install
// (the count carried over from 2.0.0's stored `asks`), a grant keeps the consent version recorded when the learner
// agreed across copy decks, wordings and the upgrade from 2.0.0 (whose stored state is read as it is), every
// session JSON carries that recorded version (and its hash for an app's own wording), the settings switch records
// the version in force when it is turned on, and withdrawal and deletion work under an old version.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enableSharing, registerDeck, EN, MAX_ASKS, LEGACY_CONSENT_VERSION, SHARING_STATE_KEY, SharingState } from '../web/consent/index.js';
import { memoryState } from '../web/platform/index.js';
import { resetSharingForTests, outbox as pipeline } from '../web/sharing/index.js';
import { dirStorage, readJson, FILES } from '../web/sharing/outbox.js';
import { stubApi, client, clip16k, listen, dueState, NOW, DAY } from './sharing_stub_api.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skipAudio = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';

// the deck this SDK bundles (3.1.2: contract 1.15.0, deck 2026-11-13.1; 4.0: deck 2026-11-19.1, the same strings and
// the re-ask card's three, without the four sheet.guardian.* strings, under the same consent version)
const DECK = 'share-2026-11-09';
const BUNDLED_DECK = '2026-11-19.1';
// a newer deck than the bundled one, under a language tag no other test uses
const NEXT = 'share-2026-12-01';
registerDeck('zz', { ...EN, lang: 'en', version: '2026-12-01.1', consent_version: NEXT });

/** The web SDK 2.0.0's stored sharing state, exactly as 2.0.0 wrote it under 'sharing.v1' (origin/main
 * web/consent/state.js: FRESH plus the fields answer() and setSharing() set; versionAsked from its version ask). */
const v200 = (o) => ({ v: 1, consent: 'unknown', asks: 0, lastAskSession: 0, sessions: 0, thanked: false, decidedAt: null,
  consentVersion: null, guardian: false, ...o });

/** A controller whose ask handler records every call (and answers as told). */
function wired(ql, { lang = 'en', answer = () => ({ yes: true }), wording } = {}) {
  const asked = [];
  const ctl = enableSharing(ql, { lang, wording, timers: NOW, ask: async (a) => { asked.push(a); return answer(a); } });
  return { ctl, asked };
}

/**
 * One shared session started: listen (without the completed hook), then wait until the start's ANSWER is stored,
 * that is, until the outbox's own record of the new recording (item.json in its storage, read here with the SDK's
 * own storage reader) says `started`. That is what the SDK guarantees about a start. That the server has received
 * the request says less: the answer may still be on its way, and a pipeline that finds the recording not started
 * sends the start again (the same recording id; the server takes it as the same start).
 * Then: exactly one start was sent for it.
 */
async function shareOne(api, ctl, pcm) {
  const n = api.state.starts.length;
  const store = await dirStorage(path.join(process.cwd(), '.quranlab')); // the outbox's Node storage
  const before = new Set(await store.sessions());
  await listen(ctl, pcm, { complete: false });
  let stored = null;
  for (let i = 0; i < 120 && !stored; i++) {
    await ctl.outbox.resume();
    const fresh = (await store.sessions()).filter((id) => !before.has(id));
    assert.ok(fresh.length <= 1, `one new recording (found ${fresh.length})`);
    const rec = fresh.length ? await readJson(store, fresh[0], FILES.item) : null;
    if (rec && rec.started === true) stored = rec; else await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(stored, 'the start was answered and the answer is stored: the outbox\'s record of the recording says started');
  assert.equal(api.state.starts.length, n + 1, 'one session started');
  return api.state.starts[n];
}

/**
 * The app ends and starts again, as far as a test in one process can show it. The page's pipeline is stopped the
 * way the end of its process stops it: its requests in flight are aborted and its passes leave, nothing is
 * deleted and nothing is written afterwards (the library's own outbox.pause(), which nothing resumes). Then it is
 * forgotten, and the next enableSharing makes a new pipeline on the same folder. resetSharingForTests() alone
 * leaves the old pipeline running beside the new one, which no restart of an app does.
 */
async function restart() {
  await pipeline.pause().catch(() => {});
  resetSharingForTests();
}

async function inDir(name, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  const cwd = process.cwd();
  process.chdir(dir); // the outbox's Node storage is <cwd>/.quranlab
  resetSharingForTests();
  try { await fn(); } finally {
    await restart(); // the pipeline of this folder is stopped before the folder goes
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('upgrade from 2.0.0: a stored grant (with its version, and without one) shares under the 2.0.1 deck, no ask before or after, the session JSON carries the old version', { skip: skipAudio }, async () => {
  const pcm = clip16k(12);
  for (const [stored, want] of [
    // what 2.0.0 wrote: the deck version in force when the learner agreed (and versionAsked from its version ask)
    [v200({ consent: 'granted', asks: 1, lastAskSession: 2, sessions: 9, decidedAt: '2026-11-07', consentVersion: 'share-2026-11-07', thanked: true, versionAsked: 'share-2026-11-08' }), 'share-2026-11-07'],
    // a grant stored without a version: the deck 2.0.0 bundled
    [v200({ consent: 'granted', asks: 1, lastAskSession: 2, sessions: 4, decidedAt: '2026-11-07' }), LEGACY_CONSENT_VERSION],
  ]) {
    await inDir('share-upgrade-', async () => {
      const api = await stubApi({ contributions: true });
      const st = memoryState();
      st.set(SHARING_STATE_KEY, stored);
      const ql = await client(api, { state: st });
      const { ctl, asked } = wired(ql);
      assert.equal(ctl.consent.version, DECK, 'the 2.0.1 deck is in force');
      assert.equal(ctl.state.sharing, true, 'sharing is on at once');
      assert.equal(asked.length, 0, 'no ask before the session');
      const s = await shareOne(api, ctl, pcm);
      assert.equal(await ctl.takeEnded({ end: 'normal', speechMs: 60000 }), null, 'no ask after the session');
      for (let i = 0; i < 30; i++) await ctl.takeEnded({ end: 'normal', speechMs: 60000 });
      assert.equal(asked.length, 0, 'the handler was never called');
      assert.equal(s.consent_version, want, 'the version the learner agreed to under 2.0.0');
      assert.equal('consent_text_sha256' in s, false);
      assert.equal(ctl.state.s.asks, stored.asks, 'nothing counted as shown');
    });
  }
  assert.equal(LEGACY_CONSENT_VERSION, 'share-2026-11-07');
});

test('a deck change with a 2.0.1 grant: no ask, sharing stays on, the JSON carries the version agreed to', { skip: skipAudio }, () => inDir('share-deck-', async () => {
  const api = await stubApi({ contributions: true });
  const st = dueState();
  const pcm = clip16k(12);
  let ql = await client(api, { state: st });
  let w = wired(ql);
  assert.ok(await listen(w.ctl, pcm), 'the first scored session asks');
  assert.equal(w.asked.length, 1);
  assert.equal(w.ctl.state.grantVersion, DECK);
  // a restart with a newer deck in force
  await restart();
  ql = await client(api, { state: st });
  w = wired(ql, { lang: 'zz' });
  assert.equal(w.ctl.consent.version, NEXT, 'the newer deck is in force');
  assert.equal(w.ctl.state.sharing, true, 'not paused');
  const s = await shareOne(api, w.ctl, pcm);
  for (let i = 0; i < 30; i++) assert.equal(await w.ctl.takeEnded({ end: 'normal', speechMs: 60000 }), null);
  assert.equal(w.asked.length, 0, 'no ask under the new deck');
  assert.equal(s.consent_version, DECK, 'the old version, not the deck in force');
  assert.equal(w.ctl.state.s.consentVersion, DECK, 'the stored grant is unchanged');
}));

// SDK 3.1.2: the bundled deck is 2026-11-13.1, consent share-2026-11-09. The two
// earlier decks, under language tags no other test uses: the deck SDK 2.0.1 to 3.0.2 bundled (2026-11-09.1, whose
// consent version is the bundled one again) and the deck SDK 3.1.0 and 3.1.1 bundled (2026-11-12.1, consent
// share-2026-11-12). The consent state code is the code of those releases, so the yes a page stores here under
// one of these decks is the yes a page of that release stored.
const DECK_302 = 'share-2026-11-09';
registerDeck('yy', { ...EN, lang: 'en', version: '2026-11-09.1', consent_version: DECK_302 });
const DECK_311 = 'share-2026-11-12';
registerDeck('yx', { ...EN, lang: 'en', version: '2026-11-12.1', consent_version: DECK_311 });

/** A start of the app on 3.1.2 with a stored yes: nothing is asked at the start, after 30 sessions or by the
 * app's own ask, and the next recording carries the stored version (with the stored hash for an own wording). */
async function keptWithoutAsk(api, st, pcm, want, { wording, hash = null } = {}) {
  await restart();
  const before = st.get(SHARING_STATE_KEY);
  const w = wired(await client(api, { state: st }), { wording });
  assert.equal(w.ctl.state.sharing, true, 'sharing is on at the start');
  assert.equal(w.asked.length, 0, 'no ask at the start');
  const s = await shareOne(api, w.ctl, pcm);
  await w.ctl.closeRecording(); // the next start's recording is one of its own
  assert.equal(s.consent_version, want, 'the next recording carries the version agreed to');
  if (hash) assert.equal(s.consent_text_sha256, hash, 'and the hash of the wording agreed to'); else assert.equal('consent_text_sha256' in s, false);
  for (let i = 0; i < 30; i++) assert.equal(await w.ctl.takeEnded({ end: 'normal', speechMs: 60000 }), null, 'no ask after a session');
  assert.equal(await w.ctl.askNow(), null, 'no ask when the app asks now');
  assert.equal(w.ctl.state.decide({ type: 'ask_now', offered: true }).action, 'none');
  assert.equal(w.asked.length, 0, 'the ask handler was never called');
  const after = st.get(SHARING_STATE_KEY);
  assert.deepEqual([after.consent, after.consentVersion, after.consentTextSha256 || null, after.asks], [before.consent, want, hash, before.asks], 'the stored yes is unchanged');
  assert.equal(w.ctl.state.grantVersion, want);
  return w;
}

test('3.1.2: a yes stored under share-2026-11-12 (3.1.0 and 3.1.1) or under share-2026-11-09 is not asked again, at the start, after many sessions, by ask-now or after a restart, and the next recording carries the version agreed to', { skip: skipAudio }, async () => {
  const pcm = clip16k(12);
  assert.equal(DECK, 'share-2026-11-09');
  for (const [lang, version] of [['yx', DECK_311], ['yy', DECK_302]]) {
    await inDir('share-kept-', async () => {
      const api = await stubApi({ contributions: true, share_join_ms: 0 });
      const st = dueState();
      // the learner agrees in a page of the earlier release: its deck is in force
      let w = wired(await client(api, { state: st }), { lang });
      assert.equal(w.ctl.consent.version, version);
      assert.ok(await listen(w.ctl, pcm), 'the first scored session asks');
      assert.equal(w.asked.length, 1);
      assert.equal(w.asked[0].consentVersion, version);
      assert.deepEqual([st.get(SHARING_STATE_KEY).consent, st.get(SHARING_STATE_KEY).consentVersion], ['granted', version], 'the stored yes');
      await w.ctl.closeRecording();
      // the page loads again with 3.1.2: its own deck is in force, nothing is asked, the version is kept
      w = await keptWithoutAsk(api, st, pcm, version);
      assert.equal(w.ctl.consent.version, DECK, 'the 3.1.2 deck is in force');
      assert.equal(w.ctl.copy.version, BUNDLED_DECK);
      // and after one more restart
      await keptWithoutAsk(api, st, pcm, version);
      assert.equal(st.get(SHARING_STATE_KEY).consentVersion, version, 'kept on the device');
    });
  }
});

test('upgrade from 3.1.1 to 3.1.2: the state 3.1.1 stored for a yes (under share-2026-11-12) is read as it is: sharing on, no ask, the recording carries share-2026-11-12', { skip: skipAudio }, () => inDir('share-311-', async () => {
  const pcm = clip16k(12);
  const api = await stubApi({ contributions: true, share_join_ms: 0 });
  const st = memoryState();
  // exactly what the web SDK 3.1.1 wrote under 'sharing.v1' after a yes on the first ask and three more sessions
  st.set(SHARING_STATE_KEY, { v: 1, consent: 'granted', asks: 1, lastAskSession: 1, sessions: 4, thanked: false, decidedAt: '2026-11-12',
    consentVersion: 'share-2026-11-12', consentTextSha256: null, guardian: false, changes: 1 });
  const w = await keptWithoutAsk(api, st, pcm, 'share-2026-11-12');
  assert.equal(w.ctl.consent.version, DECK, 'the 3.1.2 deck is in force for a new ask');
  await keptWithoutAsk(api, st, pcm, 'share-2026-11-12');
  assert.equal(st.get(SHARING_STATE_KEY).changes, 1, 'no change of mind was counted');
  // the learner can still turn it off and delete, under that version
  await restart();
  const off = wired(await client(api, { state: st }));
  await off.ctl.setSharing(false);
  assert.equal(off.ctl.state.sharing, false);
  for (let i = 0; i < 30; i++) assert.equal(await off.ctl.takeEnded({ end: 'normal', speechMs: 60000 }), null);
  assert.equal(off.asked.length, 0, 'and is not asked after turning it off');
}));

// ONE_SHEET_40 26.1.4 and Quran Lab's permanent rule (a learner who agreed is never asked again): a yes an SDK 3.x
// page stored after its guardian sheet, { consent: 'granted', guardian: true }, is a yes like any other in 4.0. It is
// read as it is: sharing on at once, no ask at the start, after many sessions or by the app's own ask; the recordings
// go up under the version agreed to. 4.0 never reads `guardian` and writes it back unchanged with every write of the
// state (the sessions counted, the thank-you, the switch turned off and on again).
const v3GuardianYes = () => ({ v: 1, consent: 'granted', asks: 1, lastAskSession: 3, sessions: 6, thanked: false, decidedAt: '2026-11-14',
  consentVersion: 'share-2026-11-09', consentTextSha256: null, guardian: true, changes: 1 });
// what 4.0 may write over a 3.x state: 20.4's counts and clocks; every other field stays as 3.x stored it
const KEPT = ['v', 'consent', 'asks', 'thanked', 'decidedAt', 'consentVersion', 'consentTextSha256', 'guardian', 'changes'];
const kept = (o) => Object.fromEntries(KEPT.map((k) => [k, o[k]]));

test('upgrade from 3.x: a yes stored with guardian true reads as granted, nobody is asked, and guardian is written back unchanged', async () => {
  const api = await stubApi({ contributions: true });
  const st = memoryState();
  st.set(SHARING_STATE_KEY, v3GuardianYes());
  const w = wired(await client(api, { state: st }));
  assert.equal(w.ctl.state.sharing, true, 'sharing is on at once');
  assert.equal(w.ctl.state.grantVersion, 'share-2026-11-09', 'under the version agreed to');
  for (let i = 0; i < 30; i++) assert.equal(await w.ctl.takeEnded({ end: 'normal', speechMs: 60000 }), null, 'no ask after a session');
  assert.equal(await w.ctl.askNow(), null, 'no ask when the app asks now');
  w.ctl.launch();
  assert.equal(w.ctl.state.decide({ type: 'ask_now', offered: true }).action, 'none');
  assert.equal(w.asked.length, 0, 'the ask handler was never called');
  let after = st.get(SHARING_STATE_KEY);
  assert.equal(after.sessions, 36, 'the state was written (30 sessions counted)');
  assert.deepEqual(kept(after), kept(v3GuardianYes()), 'the stored yes is as 3.x wrote it, guardian included');
  // more writes of the state: the thank-you, the switch off and on again (SharingState itself: the switch's queue sweep
  // is the outbox's, tested elsewhere)
  const s = w.ctl.state;
  assert.equal(s.takeThanks(), true);
  assert.equal(st.get(SHARING_STATE_KEY).guardian, true, 'after the thank-you');
  s.setSharing(false);
  assert.deepEqual([st.get(SHARING_STATE_KEY).consent, st.get(SHARING_STATE_KEY).guardian], ['final', true], 'after the switch off');
  s.setSharing(true);
  after = st.get(SHARING_STATE_KEY);
  assert.deepEqual([after.consent, after.guardian, after.changes], ['granted', true, 3], 'after the switch on: guardian as it was, never set or cleared');
  // a 4.0 install's own grant stores no guardian field at all
  const fresh = memoryState();
  const n = new SharingState(fresh, { enabled: () => true, consentVersion: DECK });
  n.setSharing(true);
  assert.equal(fresh.get(SHARING_STATE_KEY).consent, 'granted');
  assert.equal('guardian' in fresh.get(SHARING_STATE_KEY), false);
});

test('upgrade from 3.x: with a yes stored with guardian true, the recordings go up under the version agreed to, with no ask, and guardian stays', { skip: skipAudio }, () => inDir('share-3x-guardian-', async () => {
  const pcm = clip16k(12);
  const api = await stubApi({ contributions: true, share_join_ms: 0 });
  const st = memoryState();
  st.set(SHARING_STATE_KEY, v3GuardianYes());
  await keptWithoutAsk(api, st, pcm, 'share-2026-11-09');
  await keptWithoutAsk(api, st, pcm, 'share-2026-11-09');
  // (the thank-you after the first shared recording is the one change)
  assert.deepEqual(kept(st.get(SHARING_STATE_KEY)), kept({ ...v3GuardianYes(), thanked: true }), 'the stored yes is as 3.x wrote it, guardian included');
}));

test('3.1.2: a learner asked from now on agrees to share-2026-11-09 (deck 2026-11-13.1; 2026-11-19.1 from 4.0), and the recording carries it', { skip: skipAudio }, () => inDir('share-new-', async () => {
  const pcm = clip16k(12);
  const api = await stubApi({ contributions: true });
  const w = wired(await client(api));
  assert.ok(await listen(w.ctl, pcm));
  assert.equal(w.asked.length, 1);
  assert.equal(w.asked[0].consentVersion, 'share-2026-11-09', 'the sheet asks for share-2026-11-09');
  assert.equal(w.asked[0].copy.version, BUNDLED_DECK);
  assert.equal(w.ctl.state.grantVersion, 'share-2026-11-09');
  const s = await shareOne(api, w.ctl, pcm);
  assert.equal(s.consent_version, 'share-2026-11-09');
}));

test('3.1.2, an app with its own wording: the custom version changes with the deck\'s base, and a yes held under the base of 3.1.1 keeps its version and hash and is not asked again', { skip: skipAudio }, () => inDir('share-custom-kept-', async () => {
  const pcm = clip16k(12);
  const wording = { 'sheet.title': 'Help the next learner' };
  const api = await stubApi({ contributions: true, share_join_ms: 0 });
  const st = dueState();
  // the learner agrees to the app's wording in a page of 3.1.1 (base share-2026-11-12)
  let w = wired(await client(api, { state: st }), { lang: 'yx', wording });
  const held = w.ctl.consent;
  assert.match(held.version, /^custom-[0-9a-f]{24}$/);
  assert.ok(await listen(w.ctl, pcm));
  assert.equal(w.asked.length, 1);
  assert.equal(st.get(SHARING_STATE_KEY).consentVersion, held.version);
  await w.ctl.closeRecording();
  // 3.1.2 with the same wording: another custom version (the base is share-2026-11-09), and the held yes stays
  w = await keptWithoutAsk(api, st, pcm, held.version, { wording, hash: held.textSha256 });
  assert.match(w.ctl.consent.version, /^custom-[0-9a-f]{24}$/);
  assert.notEqual(w.ctl.consent.version, held.version, 'the custom version follows the deck\'s base');
  await keptWithoutAsk(api, st, pcm, held.version, { wording, hash: held.textSha256 });
}));

test('a wording change after a custom grant: no ask, the original custom version and hash in the JSON; a new learner records the new version', { skip: skipAudio }, () => inDir('share-wording-later-', async () => {
  // share_join_ms 0: each session is its own recording with its own session JSON, as before 2.0.3 (with the
  // default window, the two sessions in a row under the first grant would share one)
  const api = await stubApi({ contributions: true, share_join_ms: 0 });
  const pcm = clip16k(12);
  const ql = await client(api);
  const { ctl, asked } = wired(ql, { wording: { 'sheet.title': 'Help the next learner' } });
  const c0 = ctl.consent;
  assert.match(c0.version, /^custom-[0-9a-f]{24}$/);
  assert.ok(await listen(ctl, pcm));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].consentVersion, c0.version);
  const c1 = ctl.setWording({ 'sheet.what': 'Recitation audio only.' });
  assert.notEqual(c1.version, c0.version);
  assert.equal(ctl.state.sharing, true, 'a wording change does not pause a grant');
  const s1 = await shareOne(api, ctl, pcm);
  ctl.setWording(null);
  const s2 = await shareOne(api, ctl, pcm);
  for (let i = 0; i < 30; i++) assert.equal(await ctl.takeEnded({ end: 'normal', speechMs: 60000 }), null);
  assert.equal(asked.length, 1, 'asked once, at the start');
  for (const s of [s1, s2]) {
    assert.equal(s.consent_version, c0.version, 'the custom version agreed to');
    assert.equal(s.consent_text_sha256, c0.textSha256, 'and its hash');
  }
  // a new learner (another install) after the change agrees to the wording in force then
  const ql2 = await client(api);
  const w2 = wired(ql2, { wording: { 'sheet.what': 'Recitation audio only.' } });
  assert.ok(await listen(w2.ctl, pcm));
  assert.equal(w2.asked.length, 1);
  assert.equal(w2.ctl.state.grantVersion, c1.version);
  const s3 = await shareOne(api, w2.ctl, pcm);
  assert.equal(s3.consent_version, c1.version);
  assert.equal(s3.consent_text_sha256, c1.textSha256);
}));

// SDK 4.0: one good session a day on a fake clock, through the controller's wiring
async function days(w, n, at, { from = 0 } = {}) {
  const seen = [];
  for (let d = from; d < from + n; d++) {
    at.t = at.t0 + d * DAY;
    w.ctl.launch();
    if (await w.ctl.takeEnded({ end: 'normal', speechMs: 90000 })) seen.push([d, w.asked.at(-1).kind]);
  }
  return seen;
}

test('"Not now" three times: the sheet, then two cards (14 days and 7 sessions, then 30 days and 10), never a fourth, across a restart', async () => {
  const api = await stubApi({ contributions: true });
  const st = memoryState();
  const at = { t0: Date.now(), t: 0 }; // (from now: the stub's signed config is valid for a day from now)
  at.t = at.t0;
  const w = wired(await client(api, { state: st, clock: () => at.t }), { answer: () => ({ yes: false }) });
  // a fresh install: the first ask at its 3rd good session after 24 hours, then 14 days later, then 30 days later
  assert.deepEqual(await days(w, 80, at), [[2, 'sheet'], [16, 'card'], [46, 'card']]);
  assert.equal(w.ctl.state.s.asks, MAX_ASKS);
  assert.equal(w.ctl.state.s.consent, 'final');
  assert.equal(w.ctl.state.decide({ type: 'ask_now', offered: true }).action, 'none', 'nor through the app\'s own timing');
  // a restart: the count is stored
  const r = wired(await client(api, { state: st, clock: () => at.t }), { answer: () => ({ yes: false }) });
  assert.deepEqual(await days(r, 60, at, { from: 80 }), []);
  assert.equal(r.ctl.state.sharing, false);
  // a restart between asks keeps the clocks and the count
  const st2 = memoryState();
  const b0 = { t0: at.t0, t: at.t0 };
  const a = wired(await client(api, { state: st2, clock: () => b0.t }), { answer: () => ({ yes: false }) });
  assert.deepEqual(await days(a, 10, b0), [[2, 'sheet']]);
  const b = wired(await client(api, { state: st2, clock: () => b0.t }), { answer: () => ({ yes: false }) });
  assert.deepEqual(await days(b, 70, b0, { from: 10 }), [[16, 'card'], [46, 'card']], 'the intervals count from before the restart');
  // an ask an app's own UI never answered still counts once it was handed to the app
  const c0 = { t0: at.t0, t: at.t0 };
  const c = wired(await client(api, { state: memoryState(), clock: () => c0.t }), { answer: () => null });
  await days(c, 120, c0);
  assert.equal(c.asked.length, MAX_ASKS);
});

test('upgrade from 2.0.0 with an ask count: two asks and a decline give one more ask at most, 30 days after the upgrade; a final or off 2.0.0 state stays off', async () => {
  const api = await stubApi({ contributions: true });
  const st = memoryState();
  st.set(SHARING_STATE_KEY, v200({ consent: 'declined', asks: 2, lastAskSession: 9, sessions: 12, decidedAt: '2026-11-07' }));
  const at = { t0: Date.now(), t: 0 }; // (from now: the stub's signed config is valid for a day from now)
  at.t = at.t0;
  const w = wired(await client(api, { state: st, clock: () => at.t }), { answer: () => ({ yes: false }) });
  assert.equal(w.ctl.state.sharing, false, 'declined stays declined');
  assert.deepEqual(await days(w, 60, at), [[30, 'card']], 'one more ask: a card, 30 days after the upgrade');
  assert.equal(w.ctl.state.s.consent, 'final');
  const r = wired(await client(api, { state: st, clock: () => at.t }));
  assert.deepEqual(await days(r, 60, at, { from: 60 }), [], 'never a fourth');
  // 2.0.0 'final' (its last "Not now", or the switch turned off): never asked, not sharing
  for (const stored of [v200({ consent: 'final', asks: 3, lastAskSession: 20, sessions: 25 }), v200({ consent: 'final', asks: 1, lastAskSession: 1, sessions: 2, consentVersion: 'share-2026-11-07' })]) {
    const s = memoryState();
    s.set(SHARING_STATE_KEY, stored);
    const f0 = { t0: at.t0, t: at.t0 };
    const f = wired(await client(api, { state: s, clock: () => f0.t }));
    assert.deepEqual(await days(f, 60, f0), []);
    assert.equal(f.ctl.state.sharing, false);
  }
  // a 2.0.0 state without an ask count starts from zero, its clock at the upgrade
  const z = memoryState();
  z.set(SHARING_STATE_KEY, { v: 1, consent: 'unknown' });
  const z0 = { t0: at.t0, t: at.t0 };
  const u = wired(await client(api, { state: z, clock: () => z0.t }), { answer: () => ({ yes: false }) });
  assert.deepEqual(await days(u, 120, z0), [[2, 'sheet'], [16, 'card'], [46, 'card']]);
});

test('a yes ends asking: the answer and askNow change nothing afterwards; turning sharing off ends asking; the switch turns it on with the version in force then', { skip: skipAudio }, () => inDir('share-switch-', async () => {
  const api = await stubApi({ contributions: true });
  const pcm = clip16k(12);
  const st = dueState();
  const ql = await client(api, { state: st });
  const { ctl, asked } = wired(ql);
  assert.ok(await listen(ctl, pcm));
  assert.equal(ctl.state.grantVersion, DECK);
  ctl.setWording({ 'sheet.title': 'Help the next learner' });
  assert.equal(ctl.answer(false), 'granted', 'an answer after a yes changes nothing');
  assert.equal(ctl.answer(true), 'granted');
  ctl.setSharing(true);
  assert.equal(ctl.state.grantVersion, DECK, 'the grant keeps the version agreed to');
  assert.equal(ctl.state.decide({ type: 'ask_now', offered: true }).action, 'none');
  // off: never asked again, also across a restart
  ctl.setSharing(false);
  assert.equal(ctl.state.sharing, false);
  for (let i = 0; i < 30; i++) assert.equal(await ctl.takeEnded({ end: 'normal', speechMs: 60000 }), null);
  const r = wired(await client(api, { state: st }));
  for (let i = 0; i < 30; i++) assert.equal(await r.ctl.takeEnded({ end: 'normal', speechMs: 60000 }), null);
  assert.equal(asked.length + r.asked.length, 1, 'only the first ask');
  assert.equal(r.ctl.answer(true), 'final', 'only the switch turns it on now');
  assert.equal(r.ctl.state.sharing, false);
  // the switch: on, under the wording in force now
  r.ctl.setWording({ 'sheet.what': 'Recitation audio only.' });
  r.ctl.setSharing(true);
  assert.equal(r.ctl.state.sharing, true);
  const s = await shareOne(api, r.ctl, pcm);
  assert.equal(s.consent_version, r.ctl.consent.version);
  assert.match(s.consent_version, /^custom-/);
  assert.equal(s.consent_text_sha256, r.ctl.consent.textSha256);
  // and on under the deck in force: the deck's version, no hash
  const ql3 = await client(api);
  const t = wired(ql3, { lang: 'zz' });
  t.ctl.setSharing(true);
  const s3 = await shareOne(api, t.ctl, pcm);
  assert.equal(s3.consent_version, NEXT);
  assert.equal('consent_text_sha256' in s3, false);
  assert.equal(t.asked.length, 0);
}));

test('withdrawal and deletion under an old version (a 2.0.0 grant)', { skip: skipAudio }, () => inDir('share-withdraw-old-', async () => {
  const api = await stubApi({ contributions: true });
  const pcm = clip16k(12);
  const st = memoryState();
  st.set(SHARING_STATE_KEY, v200({ consent: 'granted', asks: 1, lastAskSession: 1, sessions: 3, decidedAt: '2026-11-07', consentVersion: 'share-2026-11-07' }));
  const ql = await client(api, { state: st });
  const { ctl, asked } = wired(ql);
  const s = await shareOne(api, ctl, pcm);
  assert.equal(s.consent_version, 'share-2026-11-07');
  ctl.setSharing(false);
  assert.equal(ctl.state.sharing, false, 'withdrawn under the old version');
  const before = api.state.starts.length;
  await listen(ctl, pcm, { complete: false });
  assert.equal(api.state.starts.length, before, 'nothing after the withdrawal');
  const r = await ctl.deleteShared();
  assert.equal(r.accepted, true);
  assert.equal(api.state.deletes, 1, 'the signed deletion went out');
  for (let i = 0; i < 30; i++) await ctl.takeEnded({ end: 'normal', speechMs: 60000 });
  assert.equal(asked.length, 0, 'never asked, before or after');
}));

test('delete what I shared (3.0.1): a delete the server does not take changes nothing; an accepted one turns sharing off, nobody is asked again, and on again shares under a new contributor',
  { skip: skipAudio }, () => inDir('share-delete-rule-', async () => {
    const api = await stubApi({ contributions: true });
    const pcm = clip16k(12);
    const ql = await client(api, { state: memoryState() });
    const { ctl, asked } = wired(ql);
    await ctl.setSharing(true);
    const first = await shareOne(api, ctl, pcm);
    await ctl.closeRecording(); // no take follows: the next take is a recording of its own
    const who = ql.contributor();
    assert.equal(first.contributor, who);
    const code = ctl.recoveryCode();
    // the server does not take the delete: the call reports it, and nothing changed
    api.state.deleteStatus = 503;
    await assert.rejects(ctl.deleteShared());
    assert.equal(api.state.deletes, 0);
    assert.deepEqual([ctl.state.sharing, ql.contributor(), ctl.recoveryCode()], [true, who, code], 'sharing is still on, the same contributor, the same recovery code');
    const second = await shareOne(api, ctl, pcm);
    await ctl.closeRecording();
    assert.equal(second.contributor, who, 'the queue goes on: the next take is shared as before');
    // the server accepts: sharing is off, and stays off without a word to the learner
    api.state.deleteStatus = null;
    await ctl.deleteShared();
    assert.equal(api.state.deletes, 1);
    assert.equal(ctl.state.sharing, false, 'an accepted delete turns sharing off');
    const before = api.state.starts.length;
    await listen(ctl, pcm, { complete: false });
    for (let i = 0; i < 30; i++) await ctl.takeEnded({ end: 'normal', speechMs: 60000 });
    assert.equal(api.state.starts.length, before, 'nothing is shared while it is off');
    assert.equal(asked.length, 0, 'nobody is asked again');
    // the learner turns it on with the switch: shared again, under a new contributor
    await ctl.setSharing(true);
    const third = await shareOne(api, ctl, pcm);
    assert.match(third.contributor, /^[0-9a-f]{32}$/);
    assert.notEqual(third.contributor, who, 'a new contributor after the delete');
  }));
