// The invisible Turnstile check (owner, 11-18; contract 18b4bc3, 18.4.9; qlab-api c261dc2): a learner never sees a check
// and is never refused for one. A token: the page session certificate. No token (the invisible check failed or timed out),
// a doubtful token, or Turnstile's outage: the server gives the 24-hour class with `turnstile: unverified`, the frame
// opens the model and files the silent report lease, turnstile_unverified, and the next lease asks again. A token that is
// not ours (another cdata): a refusal, asked again once, then server_rejected. Through the frame and the test Core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';

const engine = await loadEngine();
const dir = testBuild();
const skip = !engine ? 'no packaged engine' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;

async function page(srv, turnstile) {
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch,
    files: new MemoryFiles(), kv: new MemoryKV(), engine, trustedKeys: [srv.trustedKey], turnstile, autoSend: false, leaseStore: false });
  await c.init();
  return c;
}
async function unverifiedReports(c, srv) {
  await c.ql.flushErrors().catch(() => {});
  return srv.state.issues.filter((i) => i.kind === 'error' && i.error && i.error.stage === 'lease' && i.error.reason === 'turnstile_unverified');
}

test('invisible success: the token goes with the first lease, the page session certificate holds, nothing is reported', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const c = await page(srv, srv.turnstile);
  await c.openModel();
  assert.equal(srv.state.turnstilePasses, 1);
  assert.ok(c.turnstilePassed, 'the page session rides on its certificate');
  assert.equal((await unverifiedReports(c, srv)).length, 0);
  await c.close();
});

test('the invisible check gives no token: the lease is asked without one, the 24-hour class opens the model, reported once, never shown', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  let asked = 0;
  const c = await page(srv, async () => { asked++; return false; });
  const info = await c.openModel();
  assert.ok(info.lease.exp - Math.floor(Date.now() / 1000) <= 86400, 'the 24-hour class');
  assert.deepEqual([asked, srv.state.tsTokens, srv.state.unverified, srv.state.leases], [1, [null], ['no_token'], 1]);
  assert.equal(c.turnstilePassed, false, 'no page session certificate: the next lease asks again');
  const r = await unverifiedReports(c, srv);
  assert.deepEqual(r.map((x) => [x.code, x.error.error_code]), [['none', 'no_token']]);
  await c.close();
});

test('a doubtful token and Turnstile\'s outage: the 24-hour class, reported with the server\'s why', { skip }, async () => {
  const doubt = await fakeServer({ cdnDir: dir });
  const a = await page(doubt, async () => 'ts:lease:doubt');
  await a.openModel();
  assert.deepEqual((await unverifiedReports(a, doubt)).map((x) => x.error.error_code), ['token_doubt']);
  await a.close();
  const down = await fakeServer({ cdnDir: dir, turnstile: 'outage' });
  const b = await page(down, down.turnstile);
  await b.openModel();
  assert.deepEqual((await unverifiedReports(b, down)).map((x) => x.error.error_code), ['outage']);
  await b.close();
});

test('a forged token (another install\'s or challenge\'s cdata): refused, asked again once, then server_rejected; no lease', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  let asked = 0;
  const c = await page(srv, async () => { asked++; return 'ts:lease:not-this-cdata'; });
  await assert.rejects(c.openModel(), (e) => e.code === 'server_rejected');
  assert.deepEqual([asked, srv.state.leases], [2, 0]);
  await c.close();
});
