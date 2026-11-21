// The requests of the web SDK 4.0 against what the server branch accepts (qlab-api sdk4-server f7c5d2a,
// test/web4.test.js and test/protectedHelpers.js; contract 0a4dcba web_lease.json): the 4.0 config (the build and its
// key id, no base), the attest and lease bodies field for field, x-qlab-site from the frame on every request, and
// Turnstile's cdata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer, vector } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller, turnstileCdata } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';

const engine = await loadEngine();
const dir = testBuild();
const skip = engine && dir ? false : 'no packaged engine or test build';

test('web_lease.json: the Turnstile cdata, byte for byte; the frame\'s hostname is the one siteverify must name', async () => {
  const W = vector('web_lease.json');
  for (const c of W.cdata) assert.equal(await turnstileCdata(c.install_hash_hex, c.challenge), c.cdata, c.challenge);
  assert.equal(W.frame_host, 'web.quranlab.ai');
  // 564c144: every web_frame host Turnstile and siteverify take, in order; the loader opens its frame on these
  if (W.frame_hosts) {
    const { FRAME_BASES } = await import('../../sdk4/loader/client.js');
    const { ROLES } = await import('../../sdk4/shared/endpoints.js');
    assert.deepEqual(W.frame_hosts, [...ROLES.web_frame]);
    assert.deepEqual(FRAME_BASES.map((b) => new URL(b).hostname), W.frame_hosts);
  }
  assert.equal(new URL((await import('../../sdk4/loader/client.js')).FRAME_BASE).hostname, W.frame_host, 'the loader frames the hostname Turnstile is checked on');
});

const mk = async (srv) => {
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch, files: new MemoryFiles(), kv: new MemoryKV(), engine,
    trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false });
  await c.init();
  return c;
};

test('attest and lease bodies are the server\'s, field for field; every request names the site in x-qlab-site', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const c = await mk(srv);
  await c.openModel();
  const reqs = srv.state.requests;
  const attest = reqs.find((r) => r.path === 'POST /v1/attest').body;
  assert.deepEqual(Object.keys(attest).sort(), ['bundle_id', 'install_hw', 'install_key', 'install_sig', 'install_sign_key', 'platform']);
  assert.equal(attest.platform, 'web');
  assert.equal(attest.bundle_id, srv.site, 'the body\'s app is the site the frame verified (web4.test.js refuses another)');
  const lease = reqs.find((r) => r.path === 'POST /v1/model-key').body;
  assert.deepEqual(Object.keys(lease).filter((k) => k !== 'turnstile').sort(),
    ['build', 'challenge', 'core', 'install_cert', 'install_key', 'install_sig', 'install_sign_key', 'key_id', 'model', 'platform', 'v', 'version'].sort());
  assert.deepEqual(Object.keys(lease.core).sort(), ['piece', 'proof', 'release', 'signals', 'target'], 'core.piece as qlc_lease_ask writes it (R9)');
  assert.match(lease.core.target, /^wasm32-simd/);
  assert.equal(lease.key_id, srv.manifest.encryption.key_id, 'the key id from the config, before any file');
  assert.equal(lease.platform, 'web');
  for (const r of reqs) if (!r.path.includes('/models/')) assert.equal(r.headers['x-qlab-site'], srv.site, r.path);
  assert.equal(reqs.filter((r) => r.path.startsWith('GET /models/')).length > 0, true);
  await c.close();
});

test('the 4.0 config: no key id is model_unavailable (a plaintext build); a base in the config is never used', { skip }, async () => {
  const noKey = await fakeServer({ cdnDir: dir, configPatch: (cfg) => { delete cfg.recommended.key_id; return cfg; } });
  const a = await mk(noKey);
  await assert.rejects(a.openModel(), (e) => e.code === 'model_unavailable');
  assert.equal(noKey.state.calls.filter((x) => x === 'POST /v1/model-key').length, 0, 'no lease is asked for a build without a key id');
  await a.close();
  const withBase = await fakeServer({ cdnDir: dir, configPatch: (cfg) => ({ ...cfg, base: 'https://elsewhere.example/models' }) });
  const b = await mk(withBase);
  await b.openModel();
  const files = withBase.state.requests.filter((r) => r.path.includes('/models/'));
  assert.ok(files.every((r) => r.host !== 'elsewhere.example'), 'the config\'s base is never asked');
  // (this page has no modelsUrl: its early fetch asked the production model host's folder for the manifest, which
  // this fake CDN does not serve; the files came from the lease answer's base only)
  const qle = files.filter((r) => r.path.endsWith('.qle'));
  assert.ok(qle.length > 0 && qle.every((r) => r.host === 'cdn.test'), 'the files come from the lease answer base only');
  await b.close();
});
