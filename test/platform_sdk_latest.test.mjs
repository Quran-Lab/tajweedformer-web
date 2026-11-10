// The signed config's sdk_latest (2.0.1): one console.warn per launch for the developer when a newer SDK exists,
// never in production, malformed fields ignored without a throw; and the config parser ignoring unknown top-level
// fields while the signature still covers the exact bytes (an added field never breaks verification, a changed
// byte always does).
import test from 'node:test';
import assert from 'node:assert/strict';
import { QuranLab, verifySignedConfig, keyId, memoryState, SDK_VERSION, compareVersions, sdkLatestOf, resetSdkLatestNoticeForTests } from '../web/platform/index.js';

const enc = new TextEncoder();
const URL_OK = 'https://www.npmjs.com/package/@quran-lab/tajweedformer';

async function signer() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const kid = await keyId(pub);
  const sign = async (extra) => {
    const now = Math.floor(Date.now() / 1000);
    const cfg = { v: 1, app: 'web:https://app.example', channel: 'stable', issued_at: now, expires_at: now + 86400, models: {}, recommended: null,
      denylist: [], flags: { analytics: true }, tajweed: { v: 1, preset: 'sensitive' }, ...extra };
    const bytes = enc.encode(JSON.stringify(cfg));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, bytes));
    return { bytes, sig: `ed25519=${Buffer.from(sig).toString('base64url')}` };
  };
  return { pub, kid, sign };
}

/** A stub API whose /v1/config carries `extra` (changed between calls through `api.extra`). */
async function stub(extra) {
  const s = await signer();
  const api = { extra, etag: 1, pub: s.pub };
  api.fetch = async (url) => {
    const u = new URL(url);
    const json = (st, o) => new Response(JSON.stringify(o), { status: st });
    if (u.pathname === '/v1/attest') return json(200, { token: 'qlt_v1.x.y', expires_in: 86400, attested: false });
    if (u.pathname === '/v1/register') return json(200, { ok: true });
    if (u.pathname === '/v1/config') {
      const { bytes, sig } = await s.sign(api.extra);
      return new Response(bytes, { status: 200, headers: { 'x-qlab-signature': sig, 'x-qlab-key-id': s.kid, etag: `"v${api.etag++}"` } });
    }
    return json(202, { ok: true });
  };
  return api;
}
const launch = (api, extra = {}) => QuranLab.configure({ key: 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa', bundleId: 'https://app.example', origin: 'https://app.example',
  fetch: api.fetch, trustedKeys: [api.pub], state: memoryState(), apiUrl: 'https://api.test', autoSend: false, ...extra });

/** Runs fn with console.warn captured and NODE_ENV set (undefined: unset), as a fresh launch. */
async function capture(fn, nodeEnv) {
  const lines = [];
  const realWarn = console.warn, had = 'NODE_ENV' in process.env, realEnv = process.env.NODE_ENV;
  console.warn = (...a) => lines.push(a.join(' '));
  if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  resetSdkLatestNoticeForTests();
  try { await fn(); } finally {
    console.warn = realWarn;
    if (had) process.env.NODE_ENV = realEnv; else delete process.env.NODE_ENV;
  }
  return lines;
}

test('a newer SDK: one console.warn per launch with the exact line (two configs and two clients still one)', async () => {
  assert.equal(SDK_VERSION, '2.0.1');
  const api = await stub({ sdk_latest: { version: '2.0.2', severity: 'recommended', url: URL_OK } });
  const lines = await capture(async () => {
    const ql = await launch(api);
    assert.equal(ql.lastError, undefined);
    await ql.refreshConfig(); // a second config in the same launch
    await launch(api, { debug: true }); // a second client in the same launch
  }, 'development');
  assert.deepEqual(lines, [`Quran Lab SDK 2.0.2 is available (recommended), you have 2.0.1: ${URL_OK}`]);
  // a new launch warns again; a dotted version longer or shorter compares numerically
  api.extra = { sdk_latest: { version: '2.1', severity: 'required', url: URL_OK } };
  assert.deepEqual(await capture(() => launch(api), undefined), [`Quran Lab SDK 2.1 is available (required), you have 2.0.1: ${URL_OK}`],
    'Node without NODE_ENV is a development run');
});

test('equal, older or pre-release versions: nothing', async () => {
  for (const version of ['2.0.1', '2.0.1.0', '2.0.0', '1.9.9', '2.0.2-beta.1', '2.0.2+build']) {
    const api = await stub({ sdk_latest: { version, severity: 'recommended', url: URL_OK } });
    assert.deepEqual(await capture(() => launch(api, { debug: true })), [], version);
  }
  assert.equal(compareVersions('2.0.1', '2.0.1.0'), 0);
  assert.equal(compareVersions('2.0.10', '2.0.9'), 1);
  assert.equal(compareVersions('2.0.1', 'x'), null);
});

test('production: silent (NODE_ENV production, or debug: false)', async () => {
  const api = await stub({ sdk_latest: { version: '9.0.0', severity: 'required', url: URL_OK } });
  assert.deepEqual(await capture(() => launch(api), 'production'), []);
  assert.deepEqual(await capture(() => launch(api, { debug: false }), 'development'), []);
  assert.deepEqual(await capture(() => launch(api, { debug: true }), 'production').then((l) => l.length), 1, 'an explicit debug build wins');
});

test('malformed sdk_latest: ignored, no throw, the config still in force', async () => {
  const bad = [
    'a string', 42, null, [], ['2.0.2'], {}, { version: 2.2, severity: 'recommended', url: URL_OK },
    { version: 'latest', severity: 'recommended', url: URL_OK }, { version: '2.0.2', url: URL_OK }, { version: '2.0.2', severity: 3, url: URL_OK },
    { version: '2.0.2', severity: 'recommended' }, { version: '2.0.2', severity: 'recommended', url: 'http://example.org' },
    { version: '2.0.2', severity: 'recommended', url: 'not a url' }, { version: '2.0.2', severity: 'recommended', url: { href: URL_OK } },
  ];
  for (const v of bad) {
    const api = await stub({ sdk_latest: v });
    let ql;
    assert.deepEqual(await capture(async () => { ql = await launch(api, { debug: true }); }), [], JSON.stringify(v));
    assert.equal(ql.lastError, undefined, JSON.stringify(v));
    assert.equal(ql.config.tajweed.preset, 'sensitive');
    assert.equal(sdkLatestOf({ sdk_latest: v }), null);
  }
  assert.equal(sdkLatestOf(null), null);
  assert.equal(sdkLatestOf('x'), null);
});

test('unknown top-level config fields are ignored; the signature covers the exact bytes', async () => {
  const s = await signer();
  const { bytes, sig } = await s.sign({ sdk_latest: { version: '2.0.2', severity: 'recommended', url: URL_OK }, some_future_block: { a: [1, 2] }, z: null });
  const cfg = await verifySignedConfig(bytes, sig, s.kid, [s.pub]);
  assert.equal(cfg.v, 1);
  assert.deepEqual(cfg.some_future_block, { a: [1, 2] }, 'kept as data, not refused');
  for (const at of [10, bytes.length - 3]) {
    const t = bytes.slice();
    t[at] ^= 1;
    await assert.rejects(() => verifySignedConfig(t, sig, s.kid, [s.pub]), (e) => e.code === 'signature_invalid', `byte ${at} changed`);
  }
  // re-serialised (the same fields, other bytes) is not what was signed
  const reordered = enc.encode(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(new TextDecoder().decode(bytes))).reverse())));
  await assert.rejects(() => verifySignedConfig(reordered, sig, s.kid, [s.pub]));
  const api = await stub({ some_future_block: { a: 1 }, another: 'x' });
  const ql = await launch(api, { debug: false });
  assert.equal(ql.lastError, undefined);
  assert.equal(ql.config.tajweed.preset, 'sensitive');
});
