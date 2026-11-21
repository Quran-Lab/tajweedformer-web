// SDK 4.0 has no analytics option (owner, 11-16): the anonymous daily counts and durations are always kept and sent;
// Quran Lab's signed config (flags.analytics false) is the only off switch. The frame's platform client, against a
// stand-in API (test keys only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuranLab4 } from '../../sdk4/frame/api4.js';
import { InstallKeys } from '../../sdk4/frame/keys.js';
import { StateStore, MemoryKV } from '../../sdk4/frame/stores.js';
import { edSignBytes, signerPub, sha256, b64u } from './helpers/fake-api.mjs';
import { hex } from '../../sdk4/shared/bytes.js';

function stand(flags) {
  const pub = signerPub();
  const st = { events: 0, calls: [] };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    st.calls.push(`${init.method || 'GET'} ${u.pathname}`);
    if (u.pathname === '/v1/attest') return json(200, { token: 'tok', expires_in: 86400, install_cert: 'c1' });
    if (u.pathname === '/v1/register') return json(200, {});
    if (u.pathname === '/v1/events') { st.events++; return json(202, {}); }
    if (u.pathname === '/v1/issues') return json(202, {});
    if (u.pathname === '/v1/config') {
      const now = Math.floor(Date.now() / 1000);
      const body = new TextEncoder().encode(JSON.stringify({ v: 1, issued_at: now, expires_at: now + 86400, flags }));
      return new Response(body, { status: 200, headers: { 'x-qlab-signature': 'ed25519=' + b64u(edSignBytes(body)), 'x-qlab-key-id': hex(sha256(pub).subarray(0, 8)), date: new Date().toUTCString() } });
    }
    return json(404, { error: 'not_found' });
  };
  return { fetch, st, trustedKey: hex(pub) };
}

async function client(api, extra = {}) {
  return new QuranLab4({ key: 'qlk_v1_apps-one_aaaaaaaaaaaaaaaaaaaaaa', site: 'https://app.example', apiUrl: 'https://api.test', fetch: api.fetch,
    trustedKeys: [api.trustedKey], state: await StateStore.open(new MemoryKV()), keys: await InstallKeys.create(), autoSend: false, ...extra });
}

test('an analytics option given to the frame\'s client is never read: the day\'s counts are kept and sent', async () => {
  for (const extra of [{ analytics: 'off' }, { analytics: false }, {}]) {
    const api = stand({ analytics: true, issues: true });
    const ql = await client(api, extra);
    assert.equal(ql.analyticsOn, true, JSON.stringify(extra));
    assert.equal(ql.telemetry.enabled, true);
    await ql.launch();
    assert.equal(ql.config.v, 1);
    await ql.launchSent; // 4.0.1: the launch's telemetry goes in the background
    assert.ok(api.st.events >= 1, `the delta was sent (${api.st.calls.join(', ')})`);
  }
});

test('the signed config\'s flags.analytics false is the only off switch: nothing is kept or sent', async () => {
  const api = stand({ analytics: false, issues: true });
  const ql = await client(api);
  await ql.launch();
  assert.equal(ql.telemetry.enabled, false);
  assert.equal(api.st.events, 0);
});

// 4.0.1 (E7, 11-20): the frame's start waits for register and the config, never for its telemetry. A backup host answers
// events and issues 503 (it keeps no reports, ENDPOINTS_40.md 28.9), so with the first hosts silent that send crossed
// every host of the order, 20 s and more, and the start waited for it
test('the launch never waits for its telemetry: an events request that does not answer holds up nothing', async () => {
  const api = stand({ analytics: true, issues: true });
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetch = async (url, init) => { if (String(url).includes('/v1/events')) await gate; return api.fetch(url, init); };
  const ql = await client({ ...api, fetch });
  await ql.launch();
  assert.equal(ql.config.v, 1, 'the config is in');
  assert.equal(api.st.events, 0, 'the delta is still on its way');
  release();
  await ql.launchSent;
  assert.ok(api.st.events >= 1, 'and it went');
});
