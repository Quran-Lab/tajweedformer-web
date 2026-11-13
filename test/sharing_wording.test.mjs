// SDK 2.0.1, the consent sheet's own wording and theme: the shared vector (consent_text.json: canonical text,
// SHA-256 and custom version for each case, and the overrides every SDK refuses), the synchronous SHA-256, the
// copy with an app's wording, a wording change changing what a new grant records (never pausing or re-asking an
// existing grant), the session JSON of a custom grant carrying consent_text_sha256 next to consent_version (and no
// hash for the deck's wording),
// the own-UI path never capturing before the learner's answer, withdrawal and deletion under a custom version,
// and the theme's CSS properties.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  enableSharing, validateWording, deriveConsent, canonicalConsentText, sha256HexSync, copyFor, SharingState, themeProperties, THEME_PROPERTIES,
} from '../web/consent/index.js';
import { memoryState } from '../web/platform/index.js';
import { sessionJson, resetSharingForTests } from '../web/sharing/index.js';
import { stubApi, client, clip16k, listen } from './sharing_stub_api.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const vector = JSON.parse(readFileSync(path.join(root, 'test', 'sharing', 'vectors', 'consent_text.json'), 'utf8'));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skipAudio = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const DECK = copyFor('en').consentVersion;

test('the shared vector: every case (canonical bytes, sha256, version) and every refused input', () => {
  assert.equal(DECK, 'share-2026-11-09');
  for (const c of vector.cases) {
    assert.equal(c.base, DECK, 'the vector is made for the bundled deck');
    const ov = validateWording(c.overrides);
    const r = deriveConsent(c.base, ov);
    const text = canonicalConsentText(c.base, ov);
    assert.equal(text === null ? null : Buffer.from(text, 'utf8').toString('hex'), c.canonical_utf8_hex, `${c.name}: canonical text`);
    assert.equal(r.textSha256, c.consent_text_sha256, `${c.name}: sha256`);
    assert.equal(r.version, c.consent_version, `${c.name}: version`);
    if (r.textSha256) assert.equal(r.version.length, 31);
  }
  for (const x of vector.refused) assert.throws(() => validateWording(x.overrides), TypeError, x.why);
  assert.throws(() => validateWording({ 'sheet.what': 3 }), TypeError);
  assert.throws(() => validateWording({ 'impact.minutes.several': 'x' }), TypeError, 'not a plural category');
  assert.throws(() => validateWording({ 'impact.minutes': 'x' }), TypeError, 'the plural object itself is not a line');
  assert.deepEqual(validateWording(null), {});
});

test('sha256HexSync equals node:crypto at every block boundary and on random input', () => {
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4097]) {
    const b = randomBytes(n);
    assert.equal(sha256HexSync(new Uint8Array(b)), createHash('sha256').update(b).digest('hex'), `${n} bytes`);
  }
  assert.equal(sha256HexSync(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the copy with an app\'s wording: overridden strings, plural lines, the rest the deck\'s', () => {
  const ov = validateWording({ 'sheet.title': 'Help the next learner', 'impact.minutes.one': 'You gave {minutes} minute.' });
  const c = copyFor('en', ov);
  assert.equal(c.t('sheet.title'), 'Help the next learner');
  assert.equal(c.t('sheet.who'), copyFor('en').t('sheet.who'));
  assert.equal(c.minutes(1), 'You gave 1 minute.');
  assert.equal(c.minutes(5), copyFor('en').minutes(5), 'categories without an override keep the deck\'s line');
  assert.deepEqual(c.overridden, ['sheet.title', 'impact.minutes.one']);
  // the session JSON: the hash only with its custom version, and absent without one
  const base = { contributor: 'a'.repeat(32), day: '2026-11-09', deviceClass: 'browser', osMajor: 14, inputSampleRate: 16000 };
  const r = deriveConsent(DECK, ov);
  const j = JSON.parse(sessionJson({ ...base, consentVersion: r.version, consentTextSha256: r.textSha256 }));
  assert.equal(j.consent_text_sha256, r.textSha256);
  const keys = Object.keys(j);
  assert.equal(keys.indexOf('consent_text_sha256') + 1, keys.indexOf('consent_version'), 'sorted keys: next to consent_version');
  assert.equal('consent_text_sha256' in JSON.parse(sessionJson({ ...base, consentVersion: DECK })), false);
  assert.throws(() => sessionJson({ ...base, consentVersion: DECK, consentTextSha256: r.textSha256 }), TypeError, 'a hash needs its own version');
});

test('a wording change changes what a new grant records: an existing grant keeps sharing under its version, never asked again; bad wording changes nothing', async () => {
  const api = await stubApi({ contributions: true });
  const ql = await client(api);
  const asked = [];
  const ctl = enableSharing(ql, { lang: 'en', ask: async (a) => { asked.push(a); return { yes: true }; } });
  assert.equal(ctl.consent.version, DECK);
  assert.equal(ctl.consent.textSha256, null);
  ctl.answer(true);
  assert.equal(ctl.state.sharing, true);
  assert.equal(ctl.state.grantTextSha256, null, 'the deck\'s wording: no hash');
  const c1 = ctl.setWording({ 'sheet.what': 'Your recitation audio and the app\'s version. Nothing else.' });
  assert.equal(c1.version, vector.cases.find((c) => c.name === 'one disclosure line reworded').consent_version, 'the vector\'s case');
  assert.match(c1.version, /^custom-[0-9a-f]{24}$/);
  assert.equal(ctl.copy.t('sheet.what'), 'Your recitation audio and the app\'s version. Nothing else.');
  assert.equal(ctl.state.sharing, true, 'a grant to the deck keeps sharing under the app\'s wording');
  assert.equal(await ctl.sessionCompleted(), null, 'and is not asked again');
  assert.equal(asked.length, 0);
  assert.equal(ctl.state.grantVersion, DECK, 'the version agreed to');
  assert.equal(ctl.state.grantTextSha256, null);
  // a new learner after the change: asked once, with the copy carrying the wording, and the grant records it
  const ql2 = await client(api);
  const asked2 = [];
  const ctl2 = enableSharing(ql2, { lang: 'en', wording: { 'sheet.what': 'Your recitation audio and the app\'s version. Nothing else.' },
    ask: async (a) => { asked2.push(a); return { yes: true }; } });
  assert.deepEqual((await ctl2.sessionCompleted()).yes, true);
  assert.equal(asked2.at(-1).variant, 'first');
  assert.equal(asked2.at(-1).consentVersion, c1.version);
  assert.equal(asked2.at(-1).copy.t('sheet.what'), c1.canonicalText.split('\t')[1].trim(), 'the own UI gets the copy with the wording');
  assert.equal(ctl2.state.grantVersion, c1.version);
  assert.equal(ctl2.state.grantTextSha256, c1.textSha256);
  // a second change: still no ask, still the version agreed to
  const c2 = ctl2.setWording({ 'sheet.what': 'Recitation audio only.' });
  assert.equal(ctl2.state.sharing, true);
  for (let i = 0; i < 30; i++) assert.equal(await ctl2.sessionCompleted(), null);
  assert.equal(asked2.length, 1);
  assert.equal(ctl2.state.s.consentVersion, c1.version);
  // refused wording: a TypeError and nothing changes
  assert.throws(() => ctl2.setWording({ 'sheet.nope': 'x' }), TypeError);
  assert.throws(() => ctl2.setWording({ 'sheet.what': ' \n' }), TypeError);
  assert.equal(ctl2.consent.version, c2.version);
  assert.equal(ctl2.state.sharing, true);
  // back to the deck's wording: what a new grant records changes, this grant does not
  ctl2.setWording(null);
  assert.equal(ctl2.consent.version, DECK);
  assert.equal(ctl2.state.sharing, true);
  assert.equal(ctl2.state.grantVersion, c1.version);
});

test('a session of a custom grant carries consent_text_sha256; the deck\'s wording sends none; own UI: nothing before the answer', { skip: skipAudio }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'share-wording-'));
  const cwd = process.cwd();
  process.chdir(dir);
  resetSharingForTests();
  try {
    // share_join_ms 0: each session below is its own recording with its own session JSON, as before 2.0.3 (with
    // the default window, sessions in a row under one grant share a recording and one session JSON)
    const api = await stubApi({ contributions: true, share_join_ms: 0 });
    const ql = await client(api);
    // the app's own UI answers later, from the learner's tap
    let shown = null;
    const ctl = enableSharing(ql, { lang: 'en', wording: { 'sheet.title': 'Help the next learner' }, ask: async (a) => { shown = a; } });
    const pcm = clip16k(12);
    assert.equal(await listen(ctl, pcm), null, 'the own UI resolved without an answer');
    assert.equal(shown.copy.t('sheet.title'), 'Help the next learner');
    assert.equal(ctl.pendingAsk, shown);
    await listen(ctl, pcm, { complete: false });
    assert.equal(api.state.starts.length, 0, 'asked, not answered: nothing captured or sent');
    ctl.answer(true);
    assert.equal(ctl.pendingAsk, null);
    await listen(ctl, pcm, { complete: false });
    for (let i = 0; i < 50 && api.state.starts.length < 1; i++) { await ctl.outbox.resume(); await new Promise((r) => setTimeout(r, 50)); }
    const s = api.state.starts[0];
    assert.equal(s.consent_version, ctl.consent.version);
    assert.match(s.consent_version, /^custom-[0-9a-f]{24}$/);
    assert.equal(s.consent_text_sha256, ctl.consent.textSha256);
    // back to the deck's wording: the grant still sends the custom version and hash it was given to
    ctl.setWording(null);
    assert.equal(await ctl.sessionCompleted(), null, 'no ask');
    await listen(ctl, pcm, { complete: false });
    for (let i = 0; i < 50 && api.state.starts.length < 2; i++) { await ctl.outbox.resume(); await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(api.state.starts[1].consent_version, s.consent_version);
    assert.equal(api.state.starts[1].consent_text_sha256, s.consent_text_sha256);
    // a grant to the deck's wording (another install): no hash in the session JSON
    const ql2 = await client(api);
    const ctl2 = enableSharing(ql2, { lang: 'en', ask: async () => ({ yes: true }) });
    await ctl2.sessionCompleted();
    await listen(ctl2, pcm, { complete: false });
    for (let i = 0; i < 50 && api.state.starts.length < 3; i++) { await ctl2.outbox.resume(); await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(api.state.starts[2].consent_version, DECK);
    assert.equal('consent_text_sha256' in api.state.starts[2], false);
    // withdrawal and deletion under a custom version
    assert.equal(ctl.state.sharing, true);
    ctl.setSharing(false);
    assert.equal(ctl.state.sharing, false, 'withdrawn under a custom version');
    const before = api.state.starts.length;
    await listen(ctl, pcm, { complete: false });
    assert.equal(api.state.starts.length, before, 'nothing after the withdrawal');
    const r = await ctl.deleteShared();
    assert.equal(r.accepted, true);
    assert.equal(api.state.deletes, 1, 'the signed deletion went out under a custom version');
  } finally {
    process.chdir(cwd);
    resetSharingForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the default sheet path: nothing is captured before the learner answers it', { skip: skipAudio }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'share-default-'));
  const cwd = process.cwd();
  process.chdir(dir);
  resetSharingForTests();
  const { QuranLabConsent } = await import('../web/consent/element.js');
  const realShow = QuranLabConsent.prototype.show;
  const realDoc = globalThis.document;
  try {
    let answer;
    const opened = [];
    // the element without a DOM: the sheet resolves when the test "taps"
    globalThis.document = { createElement: () => new QuranLabConsent(), body: { appendChild() {} } };
    QuranLabConsent.prototype.remove = () => {};
    QuranLabConsent.prototype.show = function (o) { opened.push(o); return new Promise((r) => { answer = r; }); };
    const api = await stubApi({ contributions: true });
    const ql = await client(api);
    const ctl = enableSharing(ql, { lang: 'en', wording: { 'sheet.title': 'Help the next learner' }, theme: { accent: '#0b6e4f' } });
    const pcm = clip16k(12);
    const asking = listen(ctl, pcm);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0].wording, { 'sheet.title': 'Help the next learner' }, 'the sheet shows the app\'s wording');
    assert.deepEqual(opened[0].theme, { accent: '#0b6e4f' });
    await listen(ctl, pcm, { complete: false });
    assert.equal(api.state.starts.length, 0, 'the sheet is open: nothing captured or sent');
    answer({ yes: false, guardianConfirmed: false });
    await asking;
    assert.equal(ctl.state.sharing, false);
    await listen(ctl, pcm, { complete: false });
    assert.equal(api.state.starts.length, 0, '"Not now": nothing');
  } finally {
    QuranLabConsent.prototype.show = realShow;
    delete QuranLabConsent.prototype.remove;
    globalThis.document = realDoc;
    process.chdir(cwd);
    resetSharingForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('theme: the Swift SharingTheme keys as CSS custom properties; unknown keys and unsafe values refused', () => {
  assert.deepEqual(Object.keys(THEME_PROPERTIES), ['accent', 'accentText', 'background', 'text', 'secondaryText', 'cornerRadius', 'titleFont', 'bodyFont']);
  assert.deepEqual(themeProperties({ accent: '#0b6e4f', cornerRadius: 8, titleFont: '600 1.3rem "Amiri", serif', background: null }),
    { '--ql-accent': '#0b6e4f', '--ql-radius': '8px', '--ql-title-font': '600 1.3rem "Amiri", serif' });
  assert.deepEqual(themeProperties(null), {});
  assert.throws(() => themeProperties({ colour: 'red' }), TypeError);
  assert.throws(() => themeProperties({ accent: 'red; background: url(x)' }), TypeError);
  const st = new SharingState(memoryState(), { enabled: () => true, consentVersion: DECK });
  assert.equal(st.consentVersion, DECK, 'a theme does not touch the consent version');
});
