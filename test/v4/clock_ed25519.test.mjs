// The two safeguards of 3.1.6 in the 4.0 frame. Ed25519: the frame never depends on WebCrypto's Ed25519 (the signed
// engine index and the signed config verify with the vendored @noble/ed25519 where it is missing; the Core verifies
// its own signatures). Clock: a device clock days off changes nothing: the config's expires_at is judged by the
// server's time (the answer's Date header), the lease by the Core's clock (anchored at the lease's iat), and the
// lease's refresh is timed by the Core's clock, never the device's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { fakeServer, edSignBytes, signerPub } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';
import { verify, verifyFallback } from '../../sdk4/shared/ed25519.js';
import { engineIndexText, verifyEngineIndex } from '../../sdk4/shared/engine-index.js';
import { ed25519Mode, resetEd25519ForTests } from '../../web/platform/ed25519.js';
import { b64u, utf8, hex } from '../../sdk4/shared/bytes.js';

const engine = await loadEngine();
const dir = testBuild();
const skip = !engine ? 'no packaged engine (python scripts/build_web4.py engine)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;
const DAY = 86_400_000;

// WebCrypto without Ed25519, as Chrome before 137 and Safari before 17: NotSupportedError (DOMException code 9)
function withoutEd25519() {
  const s = globalThis.crypto.subtle;
  const saved = {};
  for (const [f, i] of [['importKey', 2], ['generateKey', 0], ['verify', 0]]) {
    saved[f] = s[f];
    const real = s[f].bind(s);
    s[f] = (...a) => (a[i] === 'Ed25519' || (a[i] && a[i].name === 'Ed25519') ? Promise.reject(new DOMException('Unrecognized name', 'NotSupportedError')) : real(...a));
  }
  resetEd25519ForTests();
  return () => { Object.assign(s, saved); resetEd25519ForTests(); };
}

async function session(srv, { off = 0, timers = null } = {}) {
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch,
    files: new MemoryFiles(), kv: new MemoryKV(), engine, trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false,
    clock: () => Date.now() + off, coreClock: { wall: () => Date.now() + off, boot: () => performance.now() }, ...(timers ? { timers } : {}) });
  await c.init();
  return c;
}
// the frame's timers, kept and never run: the waits it asked for, in ms
const heldTimers = () => { const waits = []; return { waits, setTimeout: (f, ms) => { waits.push(ms); return { ms }; }, clearTimeout: () => {} }; };

test('the signed engine index verifies without WebCrypto Ed25519; the vendored verifier is the one of web/platform', async () => {
  const PUB = signerPub();
  const files = [{ name: 'qlcore.wasm', sha256: 'ab'.repeat(32), size: 3 }, { name: 'qlcore.mjs', sha256: 'cd'.repeat(32), size: 2 }];
  const text = engineIndexText({ engine: '20261115.0123456789ab', core: { release: '4.0.0-c1', commit: '4a5663c' }, files });
  const kid = hex(new Uint8Array(await webcrypto.subtle.digest('SHA-256', PUB))).slice(0, 16);
  const undo = withoutEd25519();
  try {
    const idx = await verifyEngineIndex({ text, kid, sig: b64u(edSignBytes(utf8(text))) }, [hex(PUB)]);
    assert.equal(idx.engine, '20261115.0123456789ab');
    assert.equal(await ed25519Mode(), 'fallback');
    const bad = edSignBytes(utf8(text)); bad[9] ^= 1;
    await assert.rejects(verifyEngineIndex({ text, kid, sig: b64u(bad) }, [hex(PUB)]));
    await assert.rejects(verifyEngineIndex({ text: text.replace('4a5663c', '4a5663d'), kid, sig: b64u(edSignBytes(utf8(text))) }, [hex(PUB)]));
    // RFC 8032 7.1 test 2 on both entry points
    const p = Uint8Array.from(Buffer.from('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', 'hex'));
    const s = Uint8Array.from(Buffer.from('92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00', 'hex'));
    assert.equal(await verify(p, Uint8Array.of(0x72), s), true);
    assert.equal(await verifyFallback(p, Uint8Array.of(0x72), s), true);
    assert.equal(await verifyFallback(p, Uint8Array.of(0x73), s), false);
  } finally { undo(); }
});

test('without WebCrypto Ed25519 a page session runs: the config verifies, the lease, install and open', { skip }, async () => {
  const undo = withoutEd25519();
  try {
    const srv = await fakeServer({ cdnDir: dir });
    const c = await session(srv);
    assert.equal(c.ql.config && c.ql.config.v, 1, 'the signed config verified with the vendored verifier');
    const info = await c.openModel();
    assert.equal(info.build, srv.build);
    assert.equal(srv.state.leases, 1);
    assert.equal(await ed25519Mode(), 'fallback');
    assert.ok(!srv.state.issues.some((x) => JSON.stringify(x).includes('config:')), 'no config issue reported');
    await c.close();
  } finally { undo(); }
});

for (const [name, off] of [['two days ahead', 2 * DAY], ['two days behind', -2 * DAY]]) {
  test(`a device clock ${name}: the config is accepted, the lease held, and its refresh waits for refresh_after by the Core's clock`, { skip }, async () => {
    const srv = await fakeServer({ cdnDir: dir });
    const timers = heldTimers();
    const c = await session(srv, { off, timers });
    assert.equal(c.ql.config && c.ql.config.v, 1, 'the config (before: config_expired two days ahead)');
    const skew = c.state.get('config').skew;
    assert.ok(Math.abs(skew + off) < 5000, `the skew is kept with the config (${skew})`);
    await c.openModel();
    assert.equal(srv.state.leases, 1);
    const st = c.core.tick();
    assert.ok(st.valid && Math.abs(st.now * 1000 - Date.now()) < 5000, 'the Core judges the lease by the server\'s time');
    // the fake API's lease: refresh_after = iat + 43201 s; the wait is that, never 0 (ahead) nor two days more (behind)
    // (the timers also hold each download's 30 s stall limit; the refresh is the longest wait)
    const wait = Math.max(...timers.waits);
    assert.ok(wait > 43_000_000 && wait < 43_300_000, `the refresh waits ${wait} ms`);
    // the same page session's next open rides on the same lease
    c.closeModel();
    await c.openModel();
    assert.equal(srv.state.leases, 1);
    await c.close();
  });
}

test('a config the server\'s Date calls expired is refused in the frame, whatever the device clock says', { skip }, async () => {
  // a stale body (expired two days ago by the server's clock) that a device three days behind would take as valid
  const stale = Math.floor((Date.now() - 2 * DAY) / 1000);
  const srv = await fakeServer({ cdnDir: dir, configPatch: (cfg) => ({ ...cfg, expires_at: stale }) });
  const c = await session(srv, { off: -3 * DAY });
  assert.equal(c.ql.config, null);
  assert.equal(c.ql.lastError && c.ql.lastError.code, 'config_expired');
  // ERRORS_40.md 24.4 (sdk-4.0.0 e5982da): a config the server answered and that has expired is download_failed
  // naming the expiry; only no answer at all is needs_connection
  await assert.rejects(c.openModel(), { code: 'download_failed', why: 'expired' });
  assert.equal(srv.state.leases, 0);
  await c.close();
});
