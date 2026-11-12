// A refusal says what to do (NAMING.md section 7, contract 1.3.9): a 403 of the server with a reason the
// catalogue knows gives server_rejected with that reason's message and fix; and the web's origin check: when a
// request to the API gets no HTTP answer, GET /v1/origin-check?key=<the web key> is asked once per page load and
// its answer decides the error (the table `origin_check` of vectors/names.json, walked here). Everything runs
// against a stub of Quran Lab's API; nothing talks to production.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TajweedError } from '../web/index.js';
import { createClient, resetClientForTests } from '../web/api/client.js';
import { serverRejected, REJECTION_REASONS, RUNTIME_MINIMUM, toTajweedError } from '../web/api/errors.js';
import { ERRORS_JSON } from '../web/api/errors-catalogue.js';
import { SDK_VERSION } from '../web/platform/client.js';
import { ModelFolderError } from '../web/tajweed/manifest.js';
import { build3, stubPlatform, seamsFor, KEY, ORIGIN } from './helpers/model3.mjs';

const names = JSON.parse(readFileSync(new URL('./vectors30/names.json', import.meta.url), 'utf8'));
const entry = JSON.parse(ERRORS_JSON).errors.find((e) => e.code === 'server_rejected');
const reasons = entry.reasons;
const fill = (s) => s.replace('{origin}', ORIGIN);
const build = await build3();

// a Client on a stub of the API. `check`: what the origin check answers ({ status, body }), 'unreachable', or
// null (the route is not expected to be asked); `blocked`: every other request to the API gets no HTTP answer.
async function setup({ check = null, blocked = false, status = null } = {}) {
  resetClientForTests();
  const api = await stubPlatform({ build });
  if (status) Object.assign(api.state.status, status);
  const asked = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    if (u.host === 'api.test' && u.pathname === '/v1/origin-check') {
      asked.push({ search: u.search, init });
      if (check === 'unreachable' || check === null) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(check.body), { status: check.status, headers: { 'content-type': 'application/json' } });
    }
    if (blocked && u.host === 'api.test') throw new TypeError('Failed to fetch');
    return api.fetch(url, init);
  };
  const client = await createClient({ key: KEY }, seamsFor(api, { fetch }));
  return { client, api, asked };
}
const raised = async (p) => { try { await p; } catch (e) { return e; } return null; };

test('the catalogue has the reasons of a refusal, each with its own message and fix', () => {
  assert.deepEqual([...REJECTION_REASONS], Object.keys(reasons));
  for (const r of ['developer_not_approved', 'not_a_member', 'key_type_mismatch', 'origin_not_allowed', 'app_not_allowed', 'app_blocked', 'environment_mismatch',
    'local_needs_development_key']) {
    assert.ok(reasons[r] && reasons[r].message.length > 0 && reasons[r].fix.length > 0, r);
    const e = serverRejected(r, { origin: ORIGIN });
    assert.deepEqual([e.code, e.message, e.fix, e.docs], ['server_rejected', fill(reasons[r].message), fill(reasons[r].fix), 'https://sdk.quranlab.ai/docs/errors#server_rejected'], r);
    assert.ok(!/[{}]/.test(e.message + e.fix), `${r}: a placeholder was left`);
  }
  // the line a developer whose key belongs to another app reads, word for word
  assert.equal(serverRejected('app_not_allowed').message, 'This key belongs to another app (app_not_allowed).');
  assert.equal(serverRejected('app_not_allowed').fix,
    "A key works for the first app that used it. Make a key for this app at https://sdk.quranlab.ai/keys, or allow this app's identifier on the key's page.");
  // a code the catalogue does not know: the entry's own text with the code as the detail
  const other = serverRejected('something_else');
  assert.deepEqual([other.code, other.message, other.fix], ['server_rejected', 'Quran Lab refused this app: something_else.', entry.fix]);
  // a name of Object.prototype is not a reason
  assert.equal(serverRejected('constructor').message, 'Quran Lab refused this app: constructor.');
});

test('a 403 of the server with a reason: server_rejected with exactly the catalogue\'s message and fix; an unknown 403 code gives the generic text', async () => {
  for (const reason of [...Object.keys(reasons), 'something_else']) {
    const { client, asked } = await setup({ status: { '/v1/attest': { status: 403, error: reason } } });
    const e = await raised(client.model());
    assert.ok(e instanceof TajweedError, reason);
    assert.equal(e.code, 'server_rejected', reason);
    if (reasons[reason]) assert.deepEqual([e.message, e.fix], [fill(reasons[reason].message), fill(reasons[reason].fix)], reason);
    else assert.deepEqual([e.message, e.fix], ['Quran Lab refused this app: something_else.', entry.fix]);
    assert.equal((await client.diagnose()).lastError, 'server_rejected', reason);
    assert.equal(asked.length, 0, 'the server answered: the origin check is not asked');
    await client.close();
  }
});

test('the origin check: every row of names.json origin_check, raised by the answer\'s why', async () => {
  const rows = Object.entries(names.origin_check);
  assert.deepEqual(rows.map(([why]) => why), ['listed', 'not_listed', 'local_needs_development_key', 'key_unknown', 'key_revoked', 'key_not_approved', 'not_a_web_key']);
  for (const [why, want] of rows) {
    const body = { origin: ORIGIN, allowed: why === 'listed', why, environment: 'production' };
    const { client, asked } = await setup({ blocked: true, check: { status: 200, body } });
    const e = await raised(client.model());
    assert.ok(e instanceof TajweedError, why);
    if (want === null) {
      // the origin is on the key, so the failure was something else: the error the SDK would have raised
      assert.equal(e.code, 'needs_connection', why);
    } else {
      assert.equal(e.code, want.code, why);
      if (want.reason) assert.deepEqual([e.message, e.fix], [fill(reasons[want.reason].message), fill(reasons[want.reason].fix)], why);
      else assert.equal(e.message, 'Quran Lab does not accept this key.', why);
    }
    assert.equal(asked.length, 1, why);
    // a simple request: the key in the query, no custom header
    assert.equal(asked[0].search, `?key=${KEY}`);
    assert.equal(asked[0].init === undefined || !asked[0].init.headers, true, 'no header on the check');
    await client.close();
  }
});

test('the origin check: the {origin} of the refusal is the answer\'s origin', async () => {
  const { client } = await setup({ blocked: true, check: { status: 200, body: { origin: 'http://localhost:5173', allowed: false, why: 'local_needs_development_key', environment: 'production' } } });
  const e = await raised(client.model());
  assert.equal(e.message, 'This page runs on http://localhost:5173, and a production key does not work on a local address (local_needs_development_key).');
  assert.match(e.fix, /development key/);
  await client.close();
});

test('the origin check: an unknown why with allowed false is server_rejected with the why as the detail', async () => {
  const { client } = await setup({ blocked: true, check: { status: 200, body: { origin: ORIGIN, allowed: false, why: 'something_new', environment: 'production' } } });
  const e = await raised(client.model());
  assert.deepEqual([e.code, e.message, e.fix], ['server_rejected', 'Quran Lab refused this app: something_new.', entry.fix]);
  await client.close();
});

test('the origin check cannot be reached either (no answer, a 429, a 404): needs_connection', async () => {
  for (const check of ['unreachable', { status: 429, body: { error: 'rate_limited' } }, { status: 404, body: { error: 'not_found' } }, { status: 500, body: {} }]) {
    const { client, asked } = await setup({ blocked: true, check });
    const e = await raised(client.model());
    assert.equal(e.code, 'needs_connection', JSON.stringify(check));
    assert.equal(asked.length, 1);
    assert.equal((await raised(client.prefetch())).code, 'needs_connection');
    assert.equal(asked.length, 1, 'asked once per page load, also when it was not reached');
    await client.close();
  }
});

test('the origin check is asked once per page load: a second failure raises the first answer\'s error without asking again', async () => {
  const { client, asked } = await setup({ blocked: true, check: { status: 200, body: { origin: ORIGIN, allowed: false, why: 'not_listed', environment: 'production' } } });
  const first = await raised(client.model());
  const second = await raised(client.model());
  const third = await raised(client.prefetch());
  for (const e of [first, second, third]) assert.deepEqual([e.code, e.message], ['server_rejected', fill(reasons.origin_not_allowed.message)]);
  assert.equal(asked.length, 1);
  const d = await client.diagnose();
  assert.deepEqual([d.key.accepted, d.key.reason, d.lastError], [false, 'server_rejected', 'server_rejected']);
  await client.close();
});

test('a page that works never calls the origin check', async () => {
  const { client, asked, api } = await setup({});
  const model = await client.model();
  const s = model.session();
  s.push(new Float32Array(16000));
  await s.finish();
  await client.prefetch();
  await client.diagnose();
  assert.equal(asked.length, 0);
  assert.equal(api.log.some((x) => x.path === '/v1/origin-check'), false);
  await client.close();
});

test('a runtime without Ed25519 in WebCrypto is runtime_unsupported, with the one minimum text', () => {
  const e = toTajweedError(new ModelFolderError('signature_unsupported', 'this runtime has no Ed25519 in WebCrypto, so the manifest signature cannot be checked'));
  assert.deepEqual([e.code, e.message, e.fix], ['runtime_unsupported', 'The SDK cannot run here: this runtime has no Ed25519 in WebCrypto.',
    `Run the app where the SDK is supported: ${RUNTIME_MINIMUM}.`]);
  for (const feature of ['WebAssembly SIMD', 'AudioWorklet', 'Ed25519 in WebCrypto', 'Node 20']) assert.ok(RUNTIME_MINIMUM.includes(feature), feature);
});

test('refusals.json: the answer\'s reason is read first; every case gives exactly the expected code, message and fix', async () => {
  const v = JSON.parse(readFileSync(new URL('./vectors30/refusals.json', import.meta.url), 'utf8'));
  assert.equal(v.cases.length, 11);
  let checked = 0;
  for (const c of v.cases) {
    resetClientForTests();
    const api = await stubPlatform({ build });
    const asked = [];
    // every request to the API is answered with the case's status and body
    const fetch = async (url, init) => {
      const u = new URL(url);
      if (u.host !== 'api.test') return api.fetch(url, init);
      asked.push(u.pathname);
      return new Response(JSON.stringify(c.body), { status: c.status, headers: { 'content-type': 'application/json' } });
    };
    // {origin} is the identifier the Client registered with: the case file's app
    const client = await createClient({ key: KEY }, seamsFor(api, { fetch, origin: v.app }));
    const e = await raised(client.model());
    assert.ok(e instanceof TajweedError, c.name);
    // the vector was made for SDK 3.0.0: where a message names the running SDK, it names this one
    const message = c.expect.message.replace(`this is ${v.sdk}`, `this is ${SDK_VERSION}`);
    assert.deepEqual([e.code, e.message, e.fix], [c.expect.code, message, c.expect.fix], c.name);
    const d = await client.diagnose();
    assert.deepEqual([d.key.accepted, d.key.reason, d.lastError], [false, c.expect.code, c.expect.code], `${c.name}: diagnose`);
    assert.equal(asked.includes('/v1/origin-check'), false, `${c.name}: the server answered, the origin check is not asked`);
    await client.close();
    checked++;
  }
  assert.equal(checked, 11);
});
