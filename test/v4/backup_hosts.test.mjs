// ENDPOINTS_40.md 28.9 (what a backup host answers) from the SDK's side. The contract's vectors/standby_40.json are a
// server's replay; no SDK replays them as a server. What the web SDK owes them is the reading of 28.3: every answer a
// backup host gives, read by the SDK's own classifier (sdk4/shared/endpoints.js Endpoints.classify), must be what 28.9
// means it to be: its own 503 unreachable (the next host), its 429 a slow down (no other host), a refusal only where it
// passes one on (key_revoked, app_blocked, sdk_too_old), a storage bucket's 404 unreachable. And its hosts and the
// frame origins it takes are the SDK's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Endpoints, ROLES, retryAfterOf } from '../../sdk4/shared/endpoints.js';

const S = JSON.parse(readFileSync(new URL('../vectors40/standby_40.json', import.meta.url), 'utf8'));
const ep = new Endpoints();
const res = (status, json = null, headers = {}) => new Response(status === 304 || status === 204 ? null : json === null ? '' : JSON.stringify(json), { status, headers });
const readAs = async (r, o = {}) => (await ep.classify({ res: r }, o)).cls;

test('the backup hosts and the frame origins of 28.9 are the SDK roles\' hosts, in their places', () => {
  for (const [id, hosts] of Object.entries(S.standbys)) {
    for (const role of ['api', 'models', 'web_frame']) {
      assert.ok(ROLES[role].includes(hosts[role]), `${id} ${role}`);
      assert.notEqual(ROLES[role][0], hosts[role], 'a backup host is never a role\'s first host');
    }
  }
  assert.deepEqual(S.frame_origins, ROLES.web_frame.map((h) => `https://${h}`));
});

test('passes: what a backup host sends is read as 28.3 says; a refusal comes through only for the reasons it may pass on', async () => {
  let refusals = 0;
  for (const c of S.passes) {
    const up = c.upstream;
    const sent = c.standby === 'pass' ? res(up.status, up.json || null) : res(503, { error: 'service_unavailable', message: 'x' }, { 'retry-after': '30' });
    if (c.standby === 'unavailable') { assert.equal(await readAs(sent), 'unreachable', c.name); continue; }
    const s = up.status;
    // a 304 is the answer only to a config request with If-None-Match (the route's own reading)
    if (s === 304) { assert.equal(await readAs(sent, { notModified: true }), 'taken', c.name); continue; }
    const cls = await readAs(sent);
    const want = s === 429 ? 'slow_down' : s >= 200 && s < 300 ? 'taken' : s >= 400 && s < 500 && up.json && typeof up.json.error === 'string' ? 'refused' : 'unreachable';
    assert.equal(cls, want, c.name);
    if (cls === 'refused') {
      refusals++;
      assert.ok(up.json.error === 'sdk_too_old' || S.pass_reasons.includes(up.json.reason), `${c.name}: a refusal a backup host may pass on`);
    }
  }
  assert.ok(refusals >= 3, 'the cases include the refusals it passes on');
});

test('requests: a backup host\'s own answers (503 with Retry-After, 429, health, preflights) and a bucket\'s are read so; Retry-After within its bounds', async () => {
  for (const c of S.requests) {
    const e = c.expect;
    // retry_after: a whole number (an accelerator file: 3600) or its bounds { min, max }
    const bounds = typeof e.retry_after === 'number' ? { min: e.retry_after, max: e.retry_after } : e.retry_after || null;
    const headers = bounds ? { 'retry-after': String(bounds.min) } : {};
    const sent = res(e.status, e.error ? { error: e.error, message: 'x' } : e.status === 200 ? { ok: true } : null, headers);
    const want = e.status === 503 ? 'unreachable' : e.status === 429 ? 'slow_down' : 'taken';
    assert.equal(await readAs(sent), want, c.name);
    if (bounds) {
      const ra = retryAfterOf(sent);
      assert.ok(ra >= bounds.min && ra <= bounds.max, `${c.name}: Retry-After ${ra}`);
    }
    // a model host served from a storage bucket answers what it does not hold with the bucket's own 404 (or another 4xx
    // that is not the API's): unreachable, the next host
    if (c.role === 'models' && c.bucket === 'unreachable') {
      assert.equal(await readAs(new Response('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>', { status: 404 })), 'unreachable', `${c.name}: bucket`);
      assert.equal(await readAs(new Response('', { status: 403 })), 'unreachable', `${c.name}: bucket 403`);
    }
  }
});
