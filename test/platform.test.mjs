// The platform client (web/platform) against a mock qlab-api that follows the platform client spec:
// token, register, the signed config (pinned kid, exact bytes, tamper, expiry, ETag/304), the tajweed
// block into a model's settings, telemetry v2 (closed body, 202/400 handling, kill switch), issues
// (no free text, deduped), the error table's stop codes, and the sharing state machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { QuranLab, verifySignedConfig, keyId, memoryState, Telemetry, bucket } from '../web/platform/index.js';
import { SharingState, MAX_ASKS, REASK_GAP, copyFor } from '../web/consent/index.js';

const enc = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString('base64url');

async function mockApi({ tamper = false, expired = false, flags = { analytics: true, issues: true, contributions: false }, tajweed = { v: 1, preset: 'sensitive' } } = {}) {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const kid = await keyId(pub);
  const log = [];
  const state = { flags, tajweed, configVersion: 1, eventsStatus: 202 };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(init.body) : null;
    log.push({ method: init.method || 'GET', path: u.pathname, query: u.search, headers: h, body });
    const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (u.pathname === '/v1/attest') {
      if (h['x-qlab-key'] !== 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa') return json(401, { error: 'invalid_key' });
      return json(200, { token: 'qlt_v1.test.sig', expires_in: 86400, attested: false });
    }
    if (h.authorization !== 'Bearer qlt_v1.test.sig') return json(401, { error: 'invalid_token' });
    if (u.pathname === '/v1/register') return json(200, { ok: true, app_id: `${body.platform}:${body.bundle_id}`, store_status: 'pending' });
    if (u.pathname === '/v1/config') {
      const etag = `"v${state.configVersion}"`;
      if (h['if-none-match'] === etag) return new Response(null, { status: 304 });
      const now = Math.floor(Date.now() / 1000);
      const cfg = { v: 1, app: 'web:https://app.example', channel: 'stable', issued_at: now, expires_at: expired ? now - 10 : now + 86400,
        models: {}, recommended: { model: 'Quran-Lab/tajweedformer-v4', model_id: 'v4.0', folder: 'sdk/v4.0', revision: 'abc123', source: 'stable' },
        denylist: [], flags: state.flags, tajweed: state.tajweed };
      const bytes = enc.encode(JSON.stringify(cfg));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, bytes));
      const sent = tamper ? enc.encode(JSON.stringify({ ...cfg, channel: 'beta' })) : bytes;
      return new Response(sent, { status: 200, headers: { 'x-qlab-signature': `ed25519=${b64u(sig)}`, 'x-qlab-key-id': kid, etag } });
    }
    if (u.pathname === '/v1/events') return json(state.eventsStatus, state.eventsStatus === 202 ? { ok: true, points: 1 } : { error: 'invalid_body' });
    if (u.pathname === '/v1/issues') return json(202, { ok: true });
    return json(404, { error: 'not_found' });
  };
  return { fetch, log, pub, kid, state };
}

const opts = (api, extra = {}) => ({ key: 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa', bundleId: 'https://app.example', origin: 'https://app.example',
  appVersion: '1.0', fetch: api.fetch, trustedKeys: [api.pub], state: memoryState(), apiUrl: 'https://api.test', ...extra });

test('launch: unattested token, register (new install once), signed config verified and stored, ETag 304', async () => {
  const api = await mockApi();
  const st = memoryState();
  const ql = await QuranLab.configure(opts(api, { state: st }));
  assert.equal(ql.lastError, undefined);
  assert.equal(ql.config.tajweed.preset, 'sensitive');
  const attest = api.log.find((x) => x.path === '/v1/attest');
  assert.deepEqual(attest.body, { platform: 'web', bundle_id: 'https://app.example' });
  assert.equal(attest.headers.origin, 'https://app.example');
  const reg = api.log.find((x) => x.path === '/v1/register');
  assert.equal(reg.body.new_install, true);
  assert.equal(reg.body.sdk_version, '2.0.0');
  const cfgReq = api.log.find((x) => x.path === '/v1/config');
  assert.match(cfgReq.query, /sdk=2\.0\.0/);
  assert.match(cfgReq.query, /bucket=\d+/);
  // second launch on the same storage: not a new install; config answered 304 from the stored ETag
  api.log.length = 0;
  const ql2 = await QuranLab.configure(opts(api, { state: st }));
  assert.equal(api.log.find((x) => x.path === '/v1/register').body.new_install, false);
  assert.equal(api.log.find((x) => x.path === '/v1/config').headers['if-none-match'], '"v1"');
  assert.equal(ql2.config.tajweed.preset, 'sensitive');
  assert.equal(api.log.filter((x) => x.path === '/v1/attest').length, 0, 'the stored token is reused');
  // the model source from the recommended model
  const src = await ql2.modelSource();
  assert.equal(src.url, 'https://cdn.quranlab.ai/hf/Quran-Lab/tajweedformer-v4/abc123/sdk/v4.0/');
  assert.equal(src.headers['x-qlab-key'], 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa');
});

test('config: a tampered body, an unknown kid, an expired config are refused; the last good one stays', async () => {
  for (const [what, api, trusted] of [
    ['tampered', await mockApi({ tamper: true }), null],
    ['unknown kid', await mockApi(), [new Uint8Array(32).fill(7)]],
    ['expired', await mockApi({ expired: true }), null],
  ]) {
    const ql = await QuranLab.configure(opts(api, trusted ? { trustedKeys: trusted } : {}));
    assert.equal(ql.config, null, what);
    assert.ok(ql.lastError && ['signature_invalid', 'config_expired'].includes(ql.lastError.code), `${what}: ${ql.lastError}`);
    assert.ok(what === 'expired' || api.log.some((x) => x.path === '/v1/issues' && x.body.kind === 'signature_invalid'), `${what}: issue sent`);
  }
  // keyId: first 8 bytes of SHA-256 of the raw key
  const k = new Uint8Array(32);
  assert.equal(await keyId(k), '66687aadf862bd77');
  await assert.rejects(() => verifySignedConfig(enc.encode('{}'), null, 'x', [k]), (e) => e.code === 'signature_invalid');
});

test('telemetry v2: closed body, sent for completed days only, 202 drops, 400 drops, kill switch clears', async () => {
  const api = await mockApi();
  let now = Date.parse('2026-11-06T12:00:00Z');
  const ql = await QuranLab.configure(opts(api, { clock: () => now }));
  const fakeTf = { context: 'c16_l64', sampleRate: 16000, info: { chunkMs: 320 }, folder: { manifest: { model_id: 'v4.0', revision: 'abc' } },
    settings: { effective: () => ({ preset: 'balanced', sites: { vowel_sub: { enabled: true } }, madd: { enabled: true }, gemination: { enabled: false },
      qalqalah: { enabled: false }, lazim: { enabled: false } }), app: {}, remote: null, wordLevel: () => null } };
  ql.telemetry.session(fakeTf, { seconds: 30, chunkMs: [12, 30, 400], firstMs: 900 });
  ql.telemetry.scored(fakeTf, { surah: 1, sites: [{ class: 'vowel_sub', flagged: true }, { class: 'cons_sub', flagged: false }], summary: { sites: 2, flagged: 1 },
    madd: [{ count: 2, flagged: false }], words: [{ score: 1, flagged: false }, { score: null, flagged: null }] });
  ql.telemetry.decoded(fakeTf, { tokens: [{ margin: 3, confidence: 0.97 }, { margin: 0.2, confidence: null }] });
  assert.deepEqual(ql.telemetry.pending(), [], 'today is not sent');
  now = Date.parse('2026-11-07T08:00:00Z');
  const [p] = ql.telemetry.pending();
  assert.deepEqual(Object.keys(p), ['v', 'day', 'product', 'platform', 'sdk_version', 'app_version', 'device', 'cohorts', 'coverage']);
  assert.equal(p.v, 2); assert.equal(p.product, 'web'); assert.equal(p.day, '2026-11-06');
  const c = p.cohorts[0];
  assert.equal(c.sessions, 1); assert.equal(c.minutes, 0.5); assert.equal(c.chunks, 3);
  assert.deepEqual(c.latency_ms, { le_20: 1, le_40: 1, gt_320: 1 });
  assert.deepEqual(c.classes, { vowel_sub: { sites: 1, flagged: 1 }, cons_sub: { sites: 1, flagged: 0 } });
  assert.deepEqual(c.session_flag_pct, { gt_20: 1 });
  assert.deepEqual(c.margin, { le_4: 1, le_0_5: 1 });
  assert.deepEqual(c.confidence, { gt_0_95: 1 });
  assert.deepEqual(c.words, { scored: 1, flagged: 0 });
  assert.deepEqual(p.coverage, { 1: 1 });
  assert.equal(c.word_level, 'off');
  const json = JSON.stringify(p);
  assert.ok(!/https?:|qlk_|qlt_|contributor/.test(json), 'no identifiers, no URLs');
  assert.ok(json.length < 32 * 1024);
  // sent and dropped on 202
  assert.equal(await ql.flush(), 1);
  assert.deepEqual(ql.telemetry.pending(), []);
  // a refused body (400) is dropped, never retried
  ql.telemetry.session(fakeTf, { seconds: 1 });
  now = Date.parse('2026-11-08T08:00:00Z');
  api.state.eventsStatus = 400;
  await ql.flush();
  assert.deepEqual(ql.telemetry.pending(), []);
  // kill switch: flags.analytics false in the signed config clears and stops it
  ql.telemetry.session(fakeTf, { seconds: 1 });
  api.state.flags = { analytics: false, issues: true, contributions: false };
  api.state.configVersion++;
  await ql.refreshConfig();
  assert.equal(ql.telemetry.enabled, false);
  ql.telemetry.session(fakeTf, { seconds: 1 });
  now = Date.parse('2026-11-09T08:00:00Z');
  assert.deepEqual(ql.telemetry.pending(), []);
  // analytics: 'off' in code: nothing recorded
  const off = new QuranLab(opts(api, { analytics: 'off' }));
  off.telemetry.session(fakeTf, { seconds: 1 });
  assert.equal(off.state.get('telemetry.days'), null);
  assert.equal(bucket('rtf', 0.3), 'le_0_5');
});

test('issues: no free text, deduped per day; error table: invalid_key stops the network for the launch', async () => {
  const api = await mockApi();
  const ql = await QuranLab.configure(opts(api));
  assert.equal(ql.reportIssue('model_load', 'stage:ENOSPC /home/user/x'), true);
  assert.equal(ql.reportIssue('model_load', 'stage:ENOSPC /home/user/x'), false);
  const q = ql.state.get('issues.queue');
  assert.equal(q[0].code, 'stage:ENOSPC__home_user_x');
  assert.ok(!('message' in q[0]));
  await ql.flush();
  assert.equal(api.log.filter((x) => x.path === '/v1/issues').length, 1);
  const bad = await QuranLab.configure(opts(api, { key: 'qlk_v1_bad_bbbbbbbbbbbbbbbbbbbbbb' }));
  assert.equal(bad.stopped, 'invalid_key');
  const before = api.log.length;
  await bad.refreshConfig().catch(() => {});
  assert.equal(api.log.length, before, 'no request after a stop code');
});

test('sharing state: never before a session with feedback; first ask, two re-asks 7 sessions apart, then never; guardian; settings', () => {
  const st = memoryState();
  let enabled = true;
  const s = new SharingState(st, { enabled: () => enabled, consentVersion: 'en-1' });
  assert.equal(s.sessionCompleted({ feedback: false }), null, 'no feedback: no ask');
  assert.deepEqual(s.sessionCompleted({ feedback: true }), { variant: 'first', guardian: false });
  assert.equal(s.answer(false), 'declined');
  const asks = [];
  for (let i = 0; i < 40; i++) { const a = s.sessionCompleted({ feedback: true }); if (a) { asks.push(s.s.sessions); s.answer(false); } }
  assert.deepEqual(asks, [2 + REASK_GAP, 2 + 2 * REASK_GAP]);
  assert.equal(s.s.consent, 'final');
  assert.equal(s.s.asks, MAX_ASKS);
  assert.equal(s.sharing, false);
  s.setSharing(true);
  assert.equal(s.sharing, true);
  enabled = false;
  assert.equal(s.sharing, false, 'the signed config can switch it off');
  enabled = true;
  assert.equal(s.takeThanks(), true);
  assert.equal(s.takeThanks(), false);
  s.setSharing(false);
  assert.equal(s.s.consent, 'final');
  // guardian variant: a yes needs the confirmation
  const g = new SharingState(memoryState(), { enabled: () => true, audience: 'children' });
  assert.deepEqual(g.sessionCompleted({ feedback: true }), { variant: 'first', guardian: true });
  assert.throws(() => g.answer(true));
  assert.equal(g.answer(true, { guardianConfirmed: true }), 'granted');
  assert.equal(g.s.guardian, true);
  // copy: the portal team's decks; RTL for Arabic and Urdu; the consent version; plural impact lines; {days}
  const ar = copyFor('ar-EG');
  assert.equal(ar.lang, 'ar'); assert.equal(ar.dir, 'rtl'); assert.equal(copyFor('ur').dir, 'rtl'); assert.equal(copyFor('en').dir, 'ltr');
  assert.equal(copyFor('xx').lang, 'en');
  assert.equal(ar.consentVersion, 'share-2026-11-07');
  assert.ok(copyFor('en').t('sheet.hadith').length > 20 && copyFor('en').t('sheet.hadith_ref') === 'Sahih Muslim 1631');
  assert.match(copyFor('en').minutes(1), /1 minute of/);
  assert.match(copyFor('en').minutes(12), /12 minutes/);
  assert.ok(!copyFor('fr').t('delete.confirm').includes('{days}'));
  for (const l of ['en', 'ar', 'id', 'ur', 'tr', 'ms', 'fr', 'bn']) {
    const c = copyFor(l);
    assert.equal(c.lang, l);
    for (const k of ['sheet.title', 'sheet.what', 'sheet.who', 'sheet.control', 'sheet.share', 'sheet.not_now', 'thanks', 'settings.toggle', 'what.detail']) {
      assert.ok(typeof c.t(k) === 'string' && c.t(k).length, `${l} ${k}`);
      assert.ok(!/[–—]/.test(c.t(k)), `${l} ${k}: no en or em dashes`);
    }
  }
});

test('contributor key material: recovery codes and hashes (the shared sharing vectors/recovery.json), deletion message bytes (signing.json), a non-extractable P-256 key', async () => {
  const { recoveryCodeFromBytes, normaliseRecoveryCode, recoveryHash, deletionMessage, contributorKey, forgetContributorKey } = await import('../web/platform/index.js');
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const dir = process.env.SHARING_VECTORS || fileURLToPath(new URL('./sharing/vectors', import.meta.url));
  const rec = JSON.parse(fs.readFileSync(`${dir}/recovery.json`, 'utf8'));
  let n = 0;
  for (const c of rec.cases) {
    if (c.bytes_hex) {
      const b = Uint8Array.from(c.bytes_hex.match(/../g).map((x) => parseInt(x, 16)));
      assert.equal(recoveryCodeFromBytes(b), c.code);
    }
    if (c.normalised) assert.equal(normaliseRecoveryCode(c.code || c.typed), c.normalised);
    if (c.recovery_hash) assert.equal(await recoveryHash(c.code || c.typed), c.recovery_hash);
    for (const t of c.typed || c.spellings || []) assert.equal(normaliseRecoveryCode(t), c.normalised);
    n++;
  }
  const sig = JSON.parse(fs.readFileSync(`${dir}/signing.json`, 'utf8'));
  for (const c of sig.cases) {
    const f = c.fields;
    const m = new TextDecoder().decode(deletionMessage({ app: f.app, contributor: f.contributor, nonce: f.nonce, timestamp: f.timestamp }));
    assert.equal(m, c.message);
  }
  const k = await contributorKey('0123456789abcdef0123456789abcdef');
  assert.equal(k.extractable, false);
  assert.equal(k.publicKeyRaw.length, 65);
  const pub = await crypto.subtle.importKey('raw', k.publicKeyRaw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const msg = new TextEncoder().encode(sig.cases[0].message);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, await k.sign(msg), msg));
  await forgetContributorKey('0123456789abcdef0123456789abcdef');
  assert.ok(n >= 3);
});

test('the portal team fixtures (quranlab-local e2e:client recordings): the recorded signed configs verify with the local key pinned; our telemetry, issue and register bodies use only the recorded fields', async () => {
  const fs = await import('node:fs');
  const fx = JSON.parse(fs.readFileSync(new URL('./platform_client_fixtures.json', import.meta.url), 'utf8'));
  assert.equal(await keyId(fx.local_public_key_hex), fx.local_key_id);
  let verified = 0;
  for (const e of fx.exchanges.filter((x) => x.request.path.startsWith('/v1/config') && x.response.status === 200)) {
    const body = new TextEncoder().encode(e.response.body);
    const cfg = await verifySignedConfig(body, e.response.headers['x-qlab-signature'], e.response.headers['x-qlab-key-id'], [fx.local_public_key_hex],
      (JSON.parse(e.response.body).issued_at + 60) * 1000);
    assert.equal(cfg.v, 1);
    // one changed byte fails
    const t = body.slice(); t[10] ^= 1;
    await assert.rejects(() => verifySignedConfig(t, e.response.headers['x-qlab-signature'], e.response.headers['x-qlab-key-id'], [fx.local_public_key_hex], (cfg.issued_at + 60) * 1000));
    verified++;
  }
  assert.ok(verified >= 4, `verified ${verified}`);
  // field sets: every key we send appears in the recorded request of the same route (closed schemas)
  const keysOf = (o, at = '', out = new Set()) => { if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) { const p = at ? `${at}.${k}` : k; out.add(p); keysOf(v, p, out); } else if (Array.isArray(o)) o.forEach((v) => keysOf(v, `${at}[]`, out)); return out; };
  const rec = (name) => keysOf(fx.exchanges.find((x) => x.name === name).request.body);
  const api = await mockApi();
  let now = Date.parse('2026-11-06T12:00:00Z');
  const ql = await QuranLab.configure(opts(api, { clock: () => now, appName: 'Client e2e' }));
  const fakeTf = { context: 'c16_l64', sampleRate: 16000, info: { chunkMs: 320 }, folder: { manifest: { model_id: 'v4.0', revision: 'abc' } },
    settings: { effective: () => ({ preset: 'balanced', sites: { vowel_sub: { enabled: true } }, madd: { enabled: true }, gemination: { enabled: false },
      qalqalah: { enabled: false }, lazim: { enabled: false } }), app: {}, remote: null, wordLevel: () => null } };
  ql.telemetry.session(fakeTf, { seconds: 30, chunkMs: [12], firstMs: 900 });
  ql.telemetry.scored(fakeTf, { surah: 1, sites: [{ class: 'vowel_sub', flagged: true }], summary: { sites: 1, flagged: 1 }, madd: [], words: [] });
  ql.telemetry.download({ revision: 'v4.0+abc', profile: 'web-cpu', bytes: 1, success: true, resumed: false });
  now = Date.parse('2026-11-07T12:00:00Z');
  const ours = keysOf(ql.telemetry.pending()[0]);
  const theirs = rec('events v2 (web)');
  const extra = [...ours].filter((k) => !theirs.has(k) && !/^cohorts\[\]\.(latency_ms|rtf|cold_start_ms|model_load_ms|session_flag_pct|margin|confidence|fallbacks|self_test|checks_on|classes)\./.test(k));
  assert.deepEqual(extra, [], 'telemetry fields the recording does not have');
  ql.reportIssue('model_load', 'x');
  const issue = keysOf(ql.state.get('issues.queue')[0]);
  assert.deepEqual([...issue].filter((k) => !rec('issue (web)').has(k)), []);
  const reg = api.log.find((x) => x.path === '/v1/register').body;
  assert.deepEqual([...keysOf(reg)].filter((k) => !rec('register (web)').has(k)), []);
});
