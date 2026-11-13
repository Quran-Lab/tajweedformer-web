// SDK 3.1.3: no request of the SDK follows a redirect (SPEC 15.4 for the model requests; from 3.1.3 the same
// rule for every request, with or without a credential). A redirect answered is a failed request: the host it
// names is never asked, so neither a header (the developer key of the token request, a recording's id) nor a
// body (a telemetry report, the session JSON of a sharing start, a recording's segment) travels to it.
//
// WHERE THIS RUNS: Node, with two real HTTP servers on this machine's loopback names and Node's own fetch. Server
// A stands in for Quran Lab's API and for the storage host and answers the route under test with a redirect to
// server B (another origin: A is 127.0.0.1, B is localhost). B stands in for "another host" and writes down
// everything it is asked: the method, the path, the NAMES of the headers that matter and the size of the body
// (never a header's value). The clients are the SDK's own: QuranLab (web/platform/client.js: the token request,
// the calls that carry the token, the web's origin check), ContributionClient (web/sharing/uploader.js: a sharing
// start, the segment URLs, the take list, the segment PUT, delete what I shared), deleteWithKey
// (web/consent/index.js) and the model reader (web/tajweed/delivery.js).
// A browser is not run here: scripts/browser-redirect.mjs shows the token request in headless Chrome.
import test, { after, before } from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { QuranLab } from '../web/platform/client.js';
import { memoryState } from '../web/platform/storage.js';
import { ContributionClient } from '../web/sharing/uploader.js';
import { deleteWithKey } from '../web/consent/index.js';
import { cachedReader, memoryStore } from '../web/tajweed/delivery.js';

const KEY = 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa';
const WATCHED = ['x-qlab-key', 'authorization', 'x-qlab-id', 'x-qlab-contributor', 'origin', 'range'];
const CODES = [301, 302, 303, 307, 308];

// B, "another host": it answers everything with 200 and keeps what it was asked, header values left out
const asked = [];
const b = createServer((req, res) => {
  let n = 0;
  req.on('data', (c) => { n += c.length; });
  req.on('end', () => {
    const names = WATCHED.filter((h) => req.headers[h] !== undefined);
    asked.push(`${req.method} ${req.url.split('?')[0]}${req.url.includes('key=') ? ' (the key in its query)' : ''}; headers: ${names.join(', ') || 'none of the watched ones'}; body ${n} bytes`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"token":"from-the-other-host","nonce":"n","ok":true}');
  });
});
// A, Quran Lab's API and the storage host: the routes in `redirected` answer with `code` and a Location on B; the
// others answer as the real servers do, as far as these calls need
const a = { code: 307, redirected: new Set(), got: [] };
const aServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const route = req.url.split('?')[0];
    a.got.push({ method: req.method, route, bytes: Buffer.concat(chunks).length });
    if ([...a.redirected].some((r) => route.startsWith(r))) {
      res.writeHead(a.code, { location: `http://localhost:${b.address().port}${req.url}` });
      res.end();
      return;
    }
    const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (route === '/v1/attest') return json(200, { token: 'qlt_v1.test.sig', expires_in: 86400, attested: false });
    if (route === '/v1/register') return json(200, { ok: true });
    if (req.method === 'PUT') { res.writeHead(200); res.end(); return; }
    return json(404, { error: 'not_found' });
  });
});
let A = '';
before(async () => {
  await new Promise((r) => b.listen(0, r));
  await new Promise((r) => aServer.listen(0, '127.0.0.1', r));
  A = `http://127.0.0.1:${aServer.address().port}`;
});
after(() => { aServer.close(); b.close(); });

// One call with the given routes answered by a redirect, for each redirect status (302 and 307 among them): the
// other host is never asked, the first host is asked once (a redirect is not asked again), and the call fails
// in its ordinary way. What the other host was asked is collected over all the statuses, so a failure lists it.
async function eachCode(routes, call, check) {
  const followed = [];
  for (const code of CODES) {
    a.code = code;
    a.redirected = new Set(routes);
    a.got.length = 0;
    asked.length = 0;
    const out = await call().then((value) => ({ value }), (error) => ({ error }));
    const first = a.got.filter((g) => routes.some((r) => g.route.startsWith(r))).length;
    assert.equal(first, 1, `${code}: the first host is asked once for the redirected route (it was asked ${first} times)`);
    if (asked.length) followed.push(...asked.map((x) => `${code} -> ${x}`));
    else await check(out, code);
  }
  a.redirected = new Set();
  assert.deepEqual(followed, [], 'what the other host was asked');
}
const client = (o = {}) => new QuranLab({ key: KEY, platform: 'linux', bundleId: 'org.example.redirects', apiUrl: A, state: memoryState(),
  autoSend: false, lifecycle: { document: null, window: null }, ...o });
const failedFetch = (out) => assert.ok(out.error instanceof TypeError, `the call fails as a request that got no answer (${out.error ? out.error.name + ': ' + out.error.message : 'it resolved with ' + JSON.stringify(out.value)})`);

test('the token request (POST /v1/attest, which carries the developer key) answered with a redirect: the other host is never asked, and the call fails as a request without an answer', async () => {
  await eachCode(['/v1/attest'], () => client().token(), failedFetch);
});

test('a call that carries the token (register, the contribution summary) answered with a redirect: the other host is never asked', async () => {
  await eachCode(['/v1/register'], () => client().register(), failedFetch);
  // the summary answers null when it fails, as for any failure
  await eachCode(['/v1/contributions/summary'], () => client().contributionSummary(), (out) => assert.equal(out.value, null));
});

test('the web\'s origin check (the key is in its query) answered with a redirect: the other host is never asked, and the check counts as not reached', async () => {
  await eachCode(['/v1/origin-check'], () => client({ platform: 'web', bundleId: 'https://app.example' }).originCheck(), (out) => assert.equal(out.value, null));
});

test('a sharing start (its body is the session JSON), the segment URLs and the take list answered with a redirect: the other host is never asked, and each call reports no answer (status 0)', async () => {
  const c = new ContributionClient({ api: A });
  const id = 'f'.repeat(32), token = 'qlt_v1.test.sig';
  const noAnswer = (out) => { assert.equal(out.error, undefined); assert.equal(out.value.status, 0, 'no answer: the outbox tries again later by its own rules'); };
  await eachCode(['/v1/uploads'], () => c.start({ id, session: JSON.stringify({ v: 1, contributor: 'c'.repeat(32) }), token }), noAnswer);
  await eachCode(['/v1/uploads'], () => c.urls({ id, from: 21, contributor: 'c'.repeat(32), token }), noAnswer);
  await eachCode(['/v1/uploads'], () => c.takes({ id, body: '{"takes":[{"start_ms":0,"gap_ms":0},{"start_ms":900,"gap_ms":400}]}', contributor: 'c'.repeat(32), token }), noAnswer);
});

test('a segment PUT to its signed storage URL (its body is the recording): a direct answer succeeds; a redirect is not followed, the other host is never asked and the PUT reports no answer', async () => {
  const c = new ContributionClient({ api: A });
  const bytes = new Uint8Array(4096).fill(7);
  const url = `${A}/bucket/v1/${'f'.repeat(32)}/seg-00001.opus?X-Amz-Signature=x`;
  // the storage host answers directly, as it does: the PUT succeeds and the whole segment arrived
  a.redirected = new Set();
  a.got.length = 0;
  const direct = await c.put({ url, bytes });
  assert.equal(direct.status, 200);
  assert.deepEqual(a.got, [{ method: 'PUT', route: `/bucket/v1/${'f'.repeat(32)}/seg-00001.opus`, bytes: 4096 }]);
  await eachCode(['/bucket/'], () => c.put({ url, bytes }), (out) => assert.equal(out.value.status, 0));
});

test('delete what I shared (no credential; a signed request) answered with a redirect: the other host is never asked and the delete fails, in the uploader and in the consent module', async () => {
  const c = new ContributionClient({ api: A });
  const sign = async () => new Uint8Array(64);
  await eachCode(['/v1/contributions/challenge'], () => c.deleteShared({ app: 'linux:org.example.redirects', contributor: 'c'.repeat(32), sign }),
    (out) => assert.ok(out.error && out.error.name === 'SharingError', 'the delete rejects'));
  await eachCode(['/v1/contributions/challenge'], () => deleteWithKey(client(), { contributor: 'c'.repeat(32), sign }), failedFetch);
});

test('a model request answered with a redirect is not followed either (SPEC 15.4): the other host is never asked', async () => {
  await eachCode(['/models/'], () => cachedReader({ baseUrl: `${A}/models/Quran-Lab/x/${'a'.repeat(40)}/sdk/v4.0/`, store: memoryStore(),
    headers: { 'x-qlab-key': KEY, authorization: 'Bearer qlt_v1.test.sig' } }).read('manifest.json'),
  (out) => assert.ok(out.error && out.error.name === 'DeliveryError' && out.error.code === 'offline', 'a delivery failure, as with no network'));
});
