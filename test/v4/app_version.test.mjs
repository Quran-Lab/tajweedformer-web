// APP_VERSION_40.md (section 27, SDK 4.0.1): the app's version and build on every config request, cleaned by 27.1's
// four steps, and register's app_version cleaned the same way (27.3's checks 1 to 4, 6 and 7 on the web code: the
// platform client the frame and the Node path run, the loader's and the Node client's options).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuranLab, appValue } from '../../web/platform/client.js';
import { TajweedClient as LoaderClient } from '../../sdk4/loader/client.js';
import { TajweedClient as NodeClient } from '../../sdk4/node/index.js';
import { signedConfig, TRUSTED } from './helpers/vector-answers.mjs';

const KEY = 'qlk_v1_apps-one_aaaaaaaaaaaaaaaaaaaaaa';
const memState = () => { const m = new Map(); return { m, get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { if (v === null || v === undefined) m.delete(k); else m.set(k, v); }, flush: async () => {} }; };

test('27.1: the cleaning, in its four steps (27.3 item 7)', () => {
  const cases = [[' 7.1 (beta)', '7.1beta'], ['-7.1', '7.1'], ['v2.0+42', 'v2.0+42'], ['7.1-é', '7.1-'], ['...', null], ['0', null],
    ['1'.repeat(40), '1'.repeat(32)], ['+.-7', '7'], ['', null], [undefined, null], [42, null], ['  0  ', null], ['7.1+beta', '7.1+beta'],
    // step 3 before step 4: the leading signs go before the 32 are counted
    [`---${'9'.repeat(40)}`, '9'.repeat(32)]];
  for (const [v, want] of cases) assert.equal(appValue(v), want, JSON.stringify(v));
});

// a platform client whose API answers a token, register and a signed config; `seen` keeps each request
function client({ appVersion, appBuild, pin = null } = {}) {
  const seen = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    seen.push({ path: u.pathname, query: u.search.slice(1), body: init.body ? JSON.parse(init.body) : null, headers: init.headers || {} });
    if (u.pathname === '/v1/attest') return new Response(JSON.stringify({ token: 'tok', expires_in: 86400 }), { status: 200 });
    if (u.pathname === '/v1/register') return new Response('{}', { status: 200 });
    if (u.pathname === '/v1/config') {
      if (init.headers && init.headers['if-none-match']) return new Response(null, { status: 304 });
      const c = signedConfig();
      return new Response(c.body, { status: 200, headers: c.headers });
    }
    return new Response('{"error":"not_found"}', { status: 404 });
  };
  const ql = new QuranLab({ key: KEY, bundleId: 'https://app.example', fetch, state: memState(), trustedKeys: TRUSTED, autoSend: false, issues: false,
    ...(appVersion !== undefined ? { appVersion } : {}), ...(appBuild !== undefined ? { appBuild } : {}) });
  if (pin) ql.modelVersionPin = pin;
  return { ql, seen };
}
const configQueries = (seen) => seen.filter((r) => r.path === '/v1/config').map((r) => r.query);

test('27.3 items 1, 3 and 6: both parameters after bucket, sdk and model_version, a + as %2B; again at a refresh with If-None-Match', async () => {
  const { ql, seen } = client({ appVersion: '7.1+beta', appBuild: '412', pin: '4.0.0' });
  await ql.refreshConfig();
  // the stored config's ETag is sent at the next refresh (304): the parameters are there all the same
  await ql.refreshConfig();
  const qs = configQueries(seen);
  assert.equal(qs.length, 2);
  for (const q of qs) {
    const keys = [...new URLSearchParams(q).keys()];
    assert.deepEqual(keys, ['bucket', 'sdk', 'model_version', 'app_version', 'app_build'], q);
    assert.match(q, /&app_version=7\.1%2Bbeta&app_build=412$/);
  }
  assert.ok(seen.filter((r) => r.path === '/v1/config')[1].headers['if-none-match'], 'the second asked with If-None-Match');
});

test('27.3 items 2 and 7: an unknown or empty version sends nothing, and register sends "0"; register sends the cleaned version', async () => {
  for (const [appVersion, appBuild, query, reg] of [[undefined, undefined, null, '0'], ['...', '0', null, '0'], [' 7.1 (beta)', ' 41 2', '7.1beta|412', '7.1beta'],
    ['-7.1', undefined, '7.1|', '7.1'], ['v2.0+42', '+42', 'v2.0%2B42|42', 'v2.0+42']]) {
    const { ql, seen } = client({ appVersion, appBuild });
    await ql.register();
    await ql.refreshConfig();
    const q = new URLSearchParams(configQueries(seen)[0]);
    const raw = configQueries(seen)[0];
    if (query === null) {
      assert.equal(q.has('app_version'), false, JSON.stringify(appVersion));
      assert.equal(q.has('app_build'), false, JSON.stringify(appBuild));
    } else {
      const [v, b] = query.split('|');
      assert.ok(raw.includes(`app_version=${v}`), `${raw}: ${v}`);
      if (b) assert.ok(raw.includes(`app_build=${b}`), `${raw}: ${b}`); else assert.equal(q.has('app_build'), false);
    }
    assert.equal(seen.find((r) => r.path === '/v1/register').body.app_version, reg, JSON.stringify(appVersion));
    assert.equal('app_build' in seen.find((r) => r.path === '/v1/register').body, false, 'register\'s body is closed: no app_build');
  }
});

test('27.3 item 4: appBuild that is not a string is invalid_argument naming it (the loader and the Node client); a string is taken', async () => {
  await assert.rejects(LoaderClient.create({ key: KEY, appBuild: 42 }), (e) => e.code === 'invalid_argument' && /appBuild/.test(e.message));
  await assert.rejects(NodeClient.create({ key: KEY, appId: 'org.example.app', appBuild: 42 }), (e) => e.code === 'invalid_argument' && /appBuild/.test(e.message));
  // a string passes the option check (the loader then needs a browser page)
  await assert.rejects(LoaderClient.create({ key: KEY, appBuild: '42' }), (e) => e.code === 'runtime_unsupported');
});
