// 3.1.6: every Ed25519 signature the SDK checks (the signed config, the model manifest) verifies where WebCrypto has
// no Ed25519 (the vendored @noble/ed25519 2.3.0, decided once), a runtime with no WebCrypto at all is
// runtime_unsupported (never needs_connection), and a config's expiry is judged by the server's time (the answer's
// Date header) when the device clock is off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { verifyEd25519, verifyFallback, ed25519Mode, resetEd25519ForTests } from '../web/platform/ed25519.js';
import { QuranLab, verifySignedConfig, memoryState, keyId } from '../web/platform/index.js';
import { configNow } from '../web/platform/client.js';
import { verifyManifestSignature } from '../web/tajweed/manifest.js';
import { toTajweedError } from '../web/api/errors.js';

const hex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
// RFC 8032 section 7.1, tests 1 to 3 (pub, msg, sig)
const RFC = [
  ['d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '',
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'],
  ['3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72',
    '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'],
  ['fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025', 'af82',
    '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'],
];

// WebCrypto without Ed25519 (as Chrome before 137, Safari before 17): importKey answers NotSupportedError (code 9)
function withoutEd25519() {
  const s = globalThis.crypto.subtle;
  const importKey = s.importKey.bind(s);
  s.importKey = async (fmt, key, alg, ...rest) => {
    if (alg === 'Ed25519' || (alg && alg.name === 'Ed25519')) throw new DOMException('Algorithm: Unrecognized name', 'NotSupportedError');
    return importKey(fmt, key, alg, ...rest);
  };
  resetEd25519ForTests();
  return () => { s.importKey = importKey; resetEd25519ForTests(); };
}
// no WebCrypto at all (an insecure context)
function withoutWebCrypto() {
  const d = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
  resetEd25519ForTests();
  return () => { Object.defineProperty(globalThis, 'crypto', d); resetEd25519ForTests(); };
}

test('RFC 8032 vectors: WebCrypto where it has Ed25519, the vendored verifier where it does not; a changed byte fails', async () => {
  for (const variant of ['webcrypto', 'fallback']) {
    const undo = variant === 'fallback' ? withoutEd25519() : (resetEd25519ForTests(), () => {});
    try {
      assert.equal(await ed25519Mode(), variant);
      for (const [p, m, s] of RFC) {
        assert.equal(await verifyEd25519(hex(p), hex(s), hex(m)), true, `${variant} ${m}`);
        const bad = hex(s); bad[3] ^= 1;
        assert.equal(await verifyEd25519(hex(p), bad, hex(m)), false);
        assert.equal(await verifyEd25519(hex(p), hex(s), Uint8Array.of(...hex(m), 0)), false);
      }
      // the fallback agrees with Node's Ed25519 on fresh keys and messages
      for (let i = 0; i < 6; i++) {
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        const pub = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
        const msg = Buffer.from(`message ${i} `.repeat(i * 7));
        const sig = new Uint8Array(edSign(null, msg, privateKey));
        assert.equal(await verifyEd25519(pub, sig, new Uint8Array(msg)), true);
        assert.equal(await verifyFallback(pub, sig, new Uint8Array(msg)), true);
        const other = new Uint8Array(msg.length + 1); other.set(msg);
        assert.equal(await verifyFallback(pub, sig, other), false);
      }
      // RFC 8032 strict (ZIP 215 off): S at or above the group order L is refused by both paths
      const [p1, , s1] = RFC[0];
      const big = hex(s1); big.set(hex('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010'), 32);
      assert.equal(await verifyEd25519(hex(p1), big, new Uint8Array(0)), false);
      assert.equal(await verifyFallback(hex(p1), big, new Uint8Array(0)), false);
    } finally { undo(); }
  }
});

test('the contract\'s signed configs and a signed V4 manifest verify without WebCrypto Ed25519', async () => {
  const fx = JSON.parse(readFileSync(new URL('./platform_client_fixtures.json', import.meta.url), 'utf8'));
  const man = JSON.parse(readFileSync(new URL('./tajweed/manifest_vectors/manifest_v4.0_build519235d0_signed.json', import.meta.url), 'utf8'));
  const undo = withoutEd25519();
  try {
    let n = 0;
    for (const e of fx.exchanges.filter((x) => x.request.path.startsWith('/v1/config') && x.response.status === 200)) {
      const body = new TextEncoder().encode(e.response.body);
      const at = (JSON.parse(e.response.body).issued_at + 60) * 1000;
      const cfg = await verifySignedConfig(body, e.response.headers['x-qlab-signature'], e.response.headers['x-qlab-key-id'], [fx.local_public_key_hex], at);
      assert.equal(cfg.v, 1);
      const t = body.slice(); t[10] ^= 1;
      await assert.rejects(verifySignedConfig(t, e.response.headers['x-qlab-signature'], e.response.headers['x-qlab-key-id'], [fx.local_public_key_hex], at), { code: 'signature_invalid' });
      n++;
    }
    assert.ok(n >= 1);
    assert.equal(await ed25519Mode(), 'fallback');
    assert.equal(await verifyManifestSignature(man.manifest || man), true, 'the production-signed V4 manifest');
  } finally { undo(); }
});

test('no WebCrypto at all: runtime_unsupported with the catalogue\'s message, never needs_connection', async () => {
  const undo = withoutWebCrypto();
  let err;
  try { await verifySignedConfig(new Uint8Array(4), 'ed25519=AAAA', '00'.repeat(8), ['00'.repeat(32)]); } catch (e) { err = e; } finally { undo(); }
  assert.equal(err && err.code, 'runtime_unsupported');
  const t = toTajweedError(err);
  assert.equal(t.code, 'runtime_unsupported');
  assert.match(t.fix, /WebCrypto/);
  // through the client: the config cannot be verified, the model source says runtime_unsupported (before 3.1.6 the
  // learner saw needs_connection), and no signature_invalid issue is reported for it
  const a = await api();
  const ql = client(a, Date.now());
  const issues = [];
  ql.reportIssue = (kind, detail) => { issues.push([kind, detail]); };
  const undo2 = withoutWebCrypto();
  let e2;
  try { await ql.modelSource(); } catch (e) { e2 = e; } finally { undo2(); }
  assert.equal(e2 && e2.code, 'runtime_unsupported');
  assert.equal(toTajweedError(e2).code, 'runtime_unsupported');
  assert.deepEqual(issues, []);
});

// a stand-in API: a config signed now (by the server's clock), answered with a Date header
async function api({ serverNow = Date.now(), issuedAt = Math.floor(Date.now() / 1000), date = true } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
  const kid = await keyId(pub);
  const st = { configs: 0, inm: [] };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const json = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...(date ? { date: new Date(serverNow).toUTCString() } : {}) } });
    if (u.pathname === '/v1/attest') return json(200, { token: 'tok', expires_in: 86400 });
    if (u.pathname === '/v1/register') return json(200, {});
    if (u.pathname === '/v1/events' || u.pathname === '/v1/issues') return json(202, {});
    if (u.pathname === '/v1/config') {
      st.configs++;
      st.inm.push(h['if-none-match'] || null);
      const body = Buffer.from(JSON.stringify({ v: 1, issued_at: issuedAt, expires_at: issuedAt + 86400, flags: {}, recommended: null }));
      return new Response(body, { status: 200, headers: { 'x-qlab-signature': 'ed25519=' + Buffer.from(edSign(null, body, privateKey)).toString('base64url'),
        'x-qlab-key-id': kid, etag: '"e1"', ...(date ? { date: new Date(serverNow).toUTCString() } : {}) } });
    }
    return json(404, { error: 'not_found' });
  };
  return { fetch, pub, st };
}
const client = (a, clockMs, state = memoryState()) => new QuranLab({ key: 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa', platform: 'linux', bundleId: 'org.example.app',
  apiUrl: 'https://api.test', fetch: a.fetch, trustedKeys: [a.pub], state, clock: () => clockMs, autoSend: false });
const DAY = 86_400_000;

test('a device clock two days ahead: a fresh config is accepted by the server\'s time, kept, and the stored one reused', async () => {
  const a = await api();
  const state = memoryState();
  const ql = client(a, Date.now() + 2 * DAY, state);
  const cfg = await ql.refreshConfig();
  assert.equal(cfg.v, 1, 'before 3.1.6: config_expired');
  assert.ok(Math.abs(state.get('config').skew + 2 * DAY) < 60_000, 'the skew kept with the config');
  // the next start (same device, same wrong clock): the stored config is in force, and it is not near its expiry
  const next = client(a, Date.now() + 2 * DAY, state);
  assert.ok(next.config && next.config.v === 1);
  await next.refreshConfig();
  assert.equal(a.st.inm.pop(), '"e1"', 'not near expiry by the server\'s time: the ETag is sent');
});

test('a device clock two days behind: accepted (the later of the two clocks)', async () => {
  const a = await api();
  const cfg = await client(a, Date.now() - 2 * DAY).refreshConfig();
  assert.equal(cfg.v, 1);
  assert.equal(configNow(0, 10 * 60_000), 10 * 60_000);
  assert.equal(configNow(0, 60_000), 0, 'within a few minutes the device clock decides');
  assert.equal(configNow(3 * DAY, 0, DAY), 0, 'ahead by more than a config lives: the server\'s time');
  assert.equal(configNow(DAY / 2, 0, DAY), DAY / 2, 'ahead by less: the later clock');
});

test('a body the server\'s clock calls expired is refused, whatever the device clock says', async () => {
  const issued = Math.floor((Date.now() - 3 * DAY) / 1000); // a stale body: expired two days ago
  const a = await api({ issuedAt: issued });
  // the device clock is three days behind (it matches the stale body), the server's Date says now
  const ql = client(a, issued * 1000 + 60_000);
  await assert.rejects(ql.refreshConfig(), { code: 'config_expired' });
  // without a readable Date (a browser before the API exposes it) the device clock decides, as before
  const b = await api({ date: false });
  assert.equal((await client(b, Date.now() + 2 * DAY).refreshConfig().catch((e) => e)).code, 'config_expired');
  assert.equal((await client(b, Date.now()).refreshConfig()).v, 1);
});
