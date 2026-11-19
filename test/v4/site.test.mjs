// The web lease bound to its site (spec fix 15, quranlab-core 88e06c9, lease version 2): the frame hands the Core the
// site it verified (qlc_set_site), and the Core accepts a web lease only for that site. The Core's own vectors
// (docs/spec-fixes/15/lease_site.json) through this binding, then the flow against the fake server: a lease for site A
// refused under site B, and a version 1 web lease refused. Also what 4a5663c adds that the frame reads: the vocabulary
// (R4) and the reference data (R3) from the Core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { fakeServer, vector, unb64u, sha256 } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { createCore, CoreError, QLC_D_LEASE_SITE } from '../../sdk4/frame/core.js';
import { InstallKeys } from '../../sdk4/frame/keys.js';
import { Controller, SdkError, KNOWN_VOCABULARIES } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';
import { hex } from '../../sdk4/shared/bytes.js';

const engine = await loadEngine();
const dir = testBuild();
const CORE = process.env.QL_CORE || '';
const SITE_V = join(CORE, 'docs', 'spec-fixes', '15', 'lease_site.json');
const subtle = webcrypto.subtle;

test('lease_site.json through this binding: a web lease only on the site it names, never without a site', { skip: engine && existsSync(SITE_V) ? false : 'no engine or Core worktree' }, async () => {
  const V = JSON.parse(readFileSync(SITE_V, 'utf8'));
  const L = vector('lease.json');
  const manifest = new TextEncoder().encode(JSON.stringify(vector('manifest_40.json').manifest));
  const der = unb64u(L.install_ecdh.pkcs8_b64u), spki = unb64u(L.install_ecdh.spki_b64u);
  const keys = new InstallKeys(subtle, { privateKey: await subtle.importKey('pkcs8', der, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) },
    { privateKey: await subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) }, spki, spki, hex(sha256(spki)));
  let n = 0;
  for (const c of V.cases) {
    const core = await createCore({ factory: engine.factory, wasm: engine.wasm, files: new MemoryFiles(), keys, clock: { wall: () => V.now * 1000, boot: () => 0 } });
    if (c.set_site) assert.equal(core.setSite(c.set_site), true);
    const lease = Uint8Array.from(Buffer.from(c.lease_hex, 'hex'));
    if (c.expect === 'accept') await core.leaseAccept(lease, manifest, V.build);
    else await assert.rejects(core.leaseAccept(lease, manifest, V.build), (e) => e instanceof CoreError && e.detail === QLC_D_LEASE_SITE && e.detailName === 'site', c.name);
    core.destroy();
    n++;
  }
  assert.equal(n, 5);
});

const skip = engine && dir ? false : 'no packaged engine or test build';
const mk = async (srv, o = {}) => {
  const c = new Controller({ key: srv.apiKey, site: o.site || srv.site, apiUrl: 'https://api.test', fetch: srv.fetch, files: new MemoryFiles(), kv: new MemoryKV(), engine,
    trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false });
  await c.init();
  return c;
};

test('the site the frame verified binds the lease: a lease for site A is refused under site B', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  srv.state.leaseSite = 'https://a.example'; // the server issued the lease for site A
  const c = await mk(srv, { site: srv.site }); // this frame verified site B (srv.site)
  await assert.rejects(c.openModel(), (e) => e instanceof SdkError && e.code === 'server_rejected' && /another site/.test(e.message));
  assert.deepEqual(Object.values(c.state.get('telemetry.days'))[0].v4.lease_failed, { refused: 1 });
  await c.close();
  // the same server and lease, on the site it names: accepted
  const ok = await fakeServer({ cdnDir: dir, site: 'https://a.example' });
  const d = await mk(ok, { site: 'https://a.example' });
  await d.openModel();
  await d.close();
});

test('a version 1 web lease (no site) is refused by the 4a5663c Core', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir, leaseVersion: 1 });
  const c = await mk(srv);
  await assert.rejects(c.openModel(), (e) => e.code === 'server_rejected' && /another site/.test(e.message));
  await c.close();
});

test('the vocabulary and the reference data from the Core (R4, R3)', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const c = await mk(srv);
  const info = await c.openModel();
  assert.deepEqual(info.tokens, [...KNOWN_VOCABULARIES[info.tokensSha256]], 'the Core\'s names are the V4 vocabulary');
  assert.equal(info.reference, true);
  const r = c.reference({ surah: 1, ayah: 1 });
  assert.ok(r.units.length > 4 && r.wordCount >= 4, JSON.stringify(r).slice(0, 120));
  assert.equal(r.words.length, r.units.length);
  assert.ok(r.units.includes(1), 'the word bar between words');
  assert.equal(c.reference({ surah: 1, ayah: 99 }), null, 'an ayah the table does not have');
  assert.throws(() => c.reference({ surah: 0, ayah: 1 }), (e) => e.code === 'invalid_argument');
  await c.close();
});
