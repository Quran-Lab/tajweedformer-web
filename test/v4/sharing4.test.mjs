// Sharing in SDK 4.0 (sdk4/loader/sharing.js): the 3.x controller (web/consent, web/sharing, tested by the 3.x
// sharing suite that npm test runs too) on the 4.0 link. What this file checks is what 4.0 changes: the link does no
// register and sends no telemetry of its own, the sheet's counters reach the engine Worker's day, the Opus encoder
// comes from bytes checked against a hash, and a learner who said yes gets the take uploaded exactly as in 3.x.
import test from 'node:test';
import '../../web/index.node.js'; // Node's parts of the 3.x modules (the outbox's Node storage)
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { memoryState } from '../../web/platform/index.js';
import { copyFor } from '../../web/consent/index.js';
import { resetSharingForTests } from '../../web/sharing/index.js';
import { stubApi, KEY } from '../sharing_stub_api.mjs';
import { ROOT } from './helpers/env.mjs';
import { fakeServer } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller } from '../../sdk4/frame/controller.js';
import { ROLES } from '../../sdk4/shared/endpoints.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';

const OPUS = path.join(ROOT, 'dist', 'tajweedformer-opus.wasm');
const skipAudio = existsSync(OPUS) && existsSync(path.join(ROOT, 'dist', 'tajweedformer-opus.mjs')) ? false : 'dist/tajweedformer-opus.* not built (bash scripts/build_opus.sh)';
const OPUS_URL = 'https://web.test/4/app/x/tajweedformer-opus.wasm';
// the sharing chunk bundles the Opus encoder's glue (dist/, made by scripts/build_opus.sh): without it the tests that load
// the chunk are skipped, as the 3.x sharing tests are
const { startSharing } = skipAudio ? { startSharing: null } : await import('../../sdk4/loader/sharing.js');

async function share(flags, extra = {}) {
  const api = await stubApi(flags);
  const calls = [];
  const rpc = { call: async (op, a) => { calls.push([op, a]); return {}; } };
  let opusFetched = 0;
  const fetch = async (url, init) => (url === OPUS_URL ? (opusFetched++, new Response(readFileSync(OPUS))) : api.fetch(url, init));
  // (an install two days old with two sessions: the first ask is due at the next good session, contract section 20)
  const state = memoryState();
  state.set('sharing.v1', { v: 1, consent: 'unknown', asks: 0, lastAskSession: 0, sessions: 2, installedAt: Date.now() - 2 * 86_400_000 });
  const sh = await startSharing({ key: KEY, rpc, apiUrl: 'https://api.test', fetch, trustedKeys: [api.pub], state, bundleId: 'https://app.example',
    opusUrl: OPUS_URL, ...extra });
  return { api, calls, sh, opusFetched: () => opusFetched };
}

test('the 4.0 link: the signed config decides, no register and no telemetry from the page', { skip: skipAudio }, async () => {
  const off = await share({ contributions: false });
  assert.equal(off.sh.sharing.isAvailable, false);
  await assert.rejects(off.sh.sharing.ask(), { code: 'sharing_unavailable' });
  const on = await share({ contributions: true });
  assert.equal(on.sh.sharing.isAvailable, true);
  assert.equal(on.sh.sharing.isOn, false, 'offered is never consent');
  await on.sh.link.sendTelemetry('close', { keepalive: true });
  assert.equal(on.api.state.registers.length, 0, 'the Worker registers, not the page');
  assert.equal(on.api.state.events.length, 0, 'the Worker sends the day, not the page');
  for (const k of ['isAvailable', 'isOn', 'setOn', 'ask', 'feed', 'items', 'summary', 'delete', 'recoveryCode', 'setWording']) assert.ok(k in on.sh.sharing, k);
});

test('a learner who said "Share": the take uploaded as in 3.x, the sheet\'s counts in the Worker\'s day', { skip: skipAudio }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'share4-'));
  const cwd = process.cwd();
  process.chdir(dir); // the outbox's Node storage is <cwd>/.quranlab
  resetSharingForTests();
  try {
    const asked = [];
    const { api, calls, sh, opusFetched } = await share({ contributions: true }, { sharingOptions: { lang: 'en', timers: { setTimeout: (f) => { Promise.resolve().then(f); return 0; }, clearTimeout() {} }, ask: async (a) => { asked.push(a); return { yes: true }; } } });
    const clip = new Float32Array(readFileSync(path.join(ROOT, 'test', 'sharing', 'selftest_16k.f32')).buffer.slice(0));
    const pcm = new Float32Array(16000 * 12);
    for (let i = 0; i < pcm.length; i += clip.length) pcm.set(clip.subarray(0, Math.min(clip.length, pcm.length - i)), i);
    const run = async () => {
      const tap = sh.link.takeStarted({ sampleRate: 16000 }); // what a 4.0 Session calls (sdk4/loader/model.js)
      for (let i = 0; i < pcm.length; i += 640) tap.pushAudio(pcm.subarray(i, i + 640));
      tap.finish();
      await new Promise((r) => setTimeout(r, 300));
      return sh.ctl.takeEnded({ end: 'normal', speechMs: 60000 });
    };
    assert.ok(await run(), 'the first finished take asks');
    assert.equal(asked.length, 1);
    assert.equal(api.state.starts.length, 0, 'nothing captured or sent before the answer');
    await run();
    for (let i = 0; i < 50 && !(api.state.puts.size >= 2); i++) { await sh.ctl.outbox.resume(); await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(api.state.starts.length, 1, 'one shared session');
    assert.equal(api.state.starts[0].consent_version, copyFor('en').consentVersion, 'the deck version the learner agreed to');
    assert.ok(api.state.puts.size >= 2, 'segments uploaded to the presigned URLs');
    assert.equal(opusFetched(), 1, 'the encoder from the checked bytes, once');
    assert.equal(sh.sharing.isOn, true);
    const counts = calls.filter(([op]) => op === 'telemetryCount').map(([, a]) => a.field);
    assert.ok(counts.includes('share_asked') && counts.includes('share_yes'), JSON.stringify(counts));
    assert.ok((await sh.queueBytes()) >= 0);
    // a yes is never asked again
    await run();
    assert.equal(asked.length, 1);
  } finally {
    process.chdir(cwd);
    resetSharingForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

const engine = await loadEngine();
test('the sheet\'s counters land in the engine Worker\'s day; nothing else crosses', { skip: engine && testBuild() ? false : 'no packaged engine or test build' }, async () => {
  const srv = await fakeServer({ cdnDir: testBuild() });
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', fetch: srv.fetch, files: new MemoryFiles(), kv: new MemoryKV(), engine,
    trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false });
  await c.init();
  c.telemetryCount({ field: 'share_asked' });
  c.telemetryCount({ field: 'share_yes' });
  assert.throws(() => c.telemetryCount({ field: 'launches' }), /counter/);
  assert.throws(() => c.telemetryCount({ field: 'share_yes', n: 1000 }), /counter/);
  const d = Object.values(c.state.get('telemetry.days'))[0];
  assert.equal(d.share_asked, 1);
  assert.equal(d.share_yes, 1);
  await c.close();
});

test('one sticky host per role per page (28.3): the sharing link starts from the frame\'s api host, follows it, and tells the frame when an answer moves it', { skip: skipAudio }, async () => {
  const api = await stubApi({ contributions: true });
  const run = async (endpoints) => {
    const asked = [];
    const fetch = async (url, init) => {
      if (url === OPUS_URL) return new Response(readFileSync(OPUS));
      const h = new URL(url).host;
      asked.push(h);
      if (h === ROLES.api[0]) throw new TypeError('fetch failed'); // the first api host gives no answer
      return api.fetch(url, init);
    };
    const sh = await startSharing({ key: KEY, rpc: { call: async () => ({}) }, apiUrl: 'https://api.quranlab.ai', fetch, trustedKeys: [api.pub], state: memoryState(),
      bundleId: 'https://app.example', opusUrl: OPUS_URL, ...(endpoints ? { endpoints } : {}) });
    return { sh, asked };
  };
  // as 4.0.1 before this: the link's own host state asks the first host first, though the frame found it silent
  const alone = await run(null);
  assert.equal(alone.asked[0], ROLES.api[0]);
  // the frame's P (the backup host, moved 1 s ago): the link never asks the first host
  const told = [];
  const listeners = new Set();
  const frameState = { api: { hosts: [...ROLES.api], p: ROLES.api[1], age: 1000 }, models: { hosts: [...ROLES.models], p: ROLES.models[0], age: null } };
  const shared = await run({ state: () => frameState, subscribe: (f) => listeners.add(f), tell: (s) => told.push(s) });
  assert.ok(shared.asked.length > 0);
  assert.ok(!shared.asked.includes(ROLES.api[0]), `the link asked ${shared.asked.join(', ')}`);
  assert.equal(shared.sh.link.ep.roles.api.p, ROLES.api[1]);
  assert.equal(told.length, 0, 'nothing moved: nothing told');
  // the frame's probe found the first host again: the link follows
  for (const f of listeners) f({ ...frameState, api: { hosts: [...ROLES.api], p: ROLES.api[0], age: null } });
  assert.equal(shared.sh.link.ep.roles.api.p, ROLES.api[0]);
  // a request of the link finds it silent once more and the backup answers: the frame is told the link's P
  await shared.sh.link.refreshConfig();
  assert.equal(shared.sh.link.ep.roles.api.p, ROLES.api[1]);
  assert.equal(told.length, 1);
  assert.equal(told[0].api.p, ROLES.api[1]);
});
