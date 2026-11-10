// Recitation sharing in 2.0.1: Quran Lab's signed config decides whether the sheet is offered (not the app's
// `contributions` option), consent is never assumed, and a learner's "Share" really gets a session uploaded
// through the SDK's own wiring (QuranLab -> enableSharing -> createSharingSession -> outbox -> PUT). In 2.0.0
// that wiring never uploaded anything (the telemetry device shape, a token string, a flags snapshot); this
// test drives it against a stub API with real libopus (dist/tajweedformer-opus.mjs) and decodes what the
// stub received.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuranLab, memoryState } from '../web/platform/index.js';
import { enableSharing, SharingState, copyFor } from '../web/consent/index.js';
import { loadOpus, readPages, decodeOggOpus, resetSharingForTests } from '../web/sharing/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skipAudio = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';

import { stubApi, client, KEY } from './sharing_stub_api.mjs';

test('the signed config decides whether sharing is offered; the app option no longer does', async () => {
  const on = await stubApi({ analytics: true, issues: true, contributions: true });
  assert.equal((await client(on)).sharingAllowed(), true, 'offered by the config, without the app option');
  assert.equal((await client(on, { contributions: false })).sharingAllowed(), true, 'the option cannot veto the backend');
  const off = await stubApi({ analytics: true, issues: true, contributions: false });
  assert.equal((await client(off, { contributions: true })).sharingAllowed(), false, 'the option cannot force it on');
  const absent = await stubApi({ analytics: true, issues: true });
  assert.equal((await client(absent, { contributions: true })).sharingAllowed(), false, 'only a literal true in the signed config');
  const closed = await stubApi({ contributions: true, upload_trust: { linux: 'off' } });
  assert.equal((await client(closed)).sharingAllowed(), false, 'a platform the config closes');
  // no config at all (offline first launch): nothing offered
  const offline = new QuranLab({ key: KEY, platform: 'linux', bundleId: 'org.example.recfix', apiUrl: 'https://api.test', fetch: async () => { throw new Error('offline'); }, state: memoryState() });
  assert.equal(offline.sharingAllowed(), false);
});

test('offered is never consent: no capture before "Share"; a grant keeps sharing under a newer deck, never asked again', async () => {
  const api = await stubApi({ contributions: true });
  const ql = await client(api);
  const st = new SharingState(ql.state, { enabled: () => ql.sharingAllowed(), consentVersion: 'deck-2' });
  assert.equal(st.sharing, false, 'offered, not asked: not sharing');
  assert.deepEqual(st.sessionCompleted({ feedback: true }), { variant: 'first', guardian: false });
  assert.equal(st.sharing, false, 'asked, not answered: not sharing');
  st.answer(false);
  assert.equal(st.sharing, false, '"Not now": not sharing');
  st.answer(true);
  assert.equal(st.sharing, true);
  const newer = new SharingState(ql.state, { enabled: () => ql.sharingAllowed(), consentVersion: 'deck-3' });
  assert.equal(newer.sharing, true, 'a grant to deck-2 keeps sharing under deck-3');
  assert.equal(newer.grantVersion, 'deck-2', 'under the version agreed to');
  for (let i = 0; i < 30; i++) assert.equal(newer.sessionCompleted({ feedback: true }), null, 'and is never asked again');
  st.setSharing(false);
  assert.equal(st.sharing, false, 'withdrawn');
});

test('a learner who said "Share" gets the whole session uploaded through the SDK wiring', { skip: skipAudio }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'share-wiring-'));
  const cwd = process.cwd();
  process.chdir(dir); // the outbox's Node storage is <cwd>/.quranlab
  resetSharingForTests();
  try {
    const api = await stubApi({ contributions: true });
    const ql = await client(api);
    const asked = [];
    const ctl = enableSharing(ql, { lang: 'en', ask: async (a) => { asked.push(a); return { yes: true }; } });
    const clip = new Float32Array(readFileSync(path.join(root, 'test', 'sharing', 'selftest_16k.f32')).buffer.slice(0));
    const pcm = new Float32Array(16000 * 12);
    for (let i = 0; i < pcm.length; i += clip.length) pcm.set(clip.subarray(0, Math.min(clip.length, pcm.length - i)), i);
    const run = async () => {
      const s = { pushAudio: () => 0, finish: () => 0, free: () => 0 };
      ctl.streamStarted({ sampleRate: 16000 }, s);
      for (let i = 0; i < pcm.length; i += 640) s.pushAudio(pcm.subarray(i, i + 640));
      s.finish();
      await new Promise((r) => setTimeout(r, 300));
      return ctl.sessionCompleted({ feedback: true });
    };
    assert.ok(await run(), 'the first scored session asks');
    assert.equal(asked.length, 1);
    assert.equal(api.state.starts.length, 0, 'nothing was captured or sent before the answer');
    await run();
    for (let i = 0; i < 50 && !(api.state.puts.size >= 2); i++) { await ctl.outbox.resume(); await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(api.state.starts.length, 1, 'one session started');
    const m = api.state.starts[0];
    assert.equal(m.consent_version, copyFor('en').consentVersion, 'the deck version the learner agreed to');
    assert.equal(m.device_class, 'node');
    assert.ok(Number.isInteger(m.os_major));
    assert.equal(m.decode.sdk_version, '2.0.2');
    const keys = [...api.state.puts.keys()].sort();
    assert.equal(keys.length, 2, `12 s is two segments (10 s, then the rest): ${keys.join(', ')}`);
    const all = Buffer.concat(keys.map((k) => api.state.puts.get(k)));
    const pages = readPages(new Uint8Array(all));
    assert.equal(pages[pages.length - 1].flags & 0x04, 0x04, 'the last segment ends the stream');
    const decoded = decodeOggOpus(await loadOpus(), pages);
    assert.equal(decoded.length, 12 * 48000, 'the uploaded stream decodes to the whole 12 s session');
    // withdrawal: off stops sharing; the next session captures nothing
    ctl.setSharing(false);
    const before = api.state.starts.length;
    await run();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(api.state.starts.length, before, 'nothing after the learner turned it off');
  } finally {
    process.chdir(cwd);
    resetSharingForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

