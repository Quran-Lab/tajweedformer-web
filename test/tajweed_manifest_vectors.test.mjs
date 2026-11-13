// The real signed manifests of model V4 (test/tajweed/manifest_vectors/, the cross-SDK vectors, verbatim):
// build 519235d0 (revision v4.0-2026-11-10, SDK 2.0.1 and later, with golden_tolerance) and build d4644956
// (revision v4.0-2026-11-09, SDK 2.0.0 and later, no golden_tolerance). Both verify with the pinned key (key id
// 660a07197c4808da); one changed byte in a header value, a tolerance value or a file line is refused; the
// golden_tolerance lines sit after the header lines, sorted by the build key's UTF-8 bytes (make_manifest3.py
// signed_text); a manifest signed without them still verifies with its tolerance ignored; and the delivery path
// (cachedReader, ModelFolder.open, openTajweedFolder) verifies the 519235d0 manifest.
// Run: npm test
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  signedText, verifyManifestSignature, checkManifestSignature, parseGoldenTolerance, ModelFolder, ModelFolderError,
  QURANLAB_PUBLIC_KEY_HEX, SDK_VERSION,
  openTajweedFolder,
} from '../web/tajweed/manifest.js';
import { cachedReader } from '../web/tajweed/delivery.js';
import { openModel } from '../web/api/model.js';
import { memoryReader } from './helpers/readers.mjs';
import { keyId } from '../web/platform/client.js';

const DIR = new URL('./tajweed/manifest_vectors/', import.meta.url);
const RAW = {
  '519235d0': readFileSync(new URL('manifest_v4.0_build519235d0_signed.json', DIR)),
  d4644956: readFileSync(new URL('manifest_v4.0_build_d4644956_signed.json', DIR)),
};
const load = (b) => JSON.parse(RAW[b].toString('utf8'));
const enc = new TextEncoder();

// the golden_tolerance lines of build 519235d0, in the reference order (the build key's UTF-8 bytes)
const TOLERANCE_LINES = [
  'golden_tolerance coreml 0 1 1',
  'golden_tolerance coreml-compact 0 1 1',
  'golden_tolerance npu:exynos2500:c16_l64 0 1 1',
  'golden_tolerance npu:exynos2600:c16_l64 0 1 1',
  'golden_tolerance npu:tensor_g3:c16_l64 0 1 1',
  'golden_tolerance npu:tensor_g4:c16_l64 0 1 1',
  'golden_tolerance npu:tensor_g5:c16_l64 0 1 1',
];

// one ASCII character of a string replaced by another: one byte of the signed text
const flip = (s, i = s.length - 1) => s.slice(0, i) + (s[i] === '0' ? '1' : '0') + s.slice(i + 1);

// the signed texts of two manifests differ in exactly one byte
function oneByteApart(a, b) {
  const x = enc.encode(signedText(a)), y = enc.encode(signedText(b));
  assert.equal(x.length, y.length);
  let n = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n++;
  assert.equal(n, 1, 'one byte of the signed text changed');
}

test('the pinned key is key id 660a07197c4808da', async () => {
  assert.equal(await keyId(QURANLAB_PUBLIC_KEY_HEX), '660a07197c4808da');
});

for (const build of ['519235d0', 'd4644956']) {
  test(`build ${build}: verifies with the pinned key`, async () => {
    const m = load(build);
    assert.equal(await verifyManifestSignature(m), true);
    assert.equal(await verifyManifestSignature(m, [QURANLAB_PUBLIC_KEY_HEX]), true);
    assert.deepEqual(await checkManifestSignature(m), { valid: true, toleranceSigned: build === '519235d0' });
  });

  test(`build ${build}: one changed byte in a header value or a file line is refused`, async () => {
    const muts = {
      'revision': (m) => { m.revision = flip(m.revision); },
      'tokens_sha256': (m) => { m.tokens_sha256 = flip(m.tokens_sha256, 0); },
      'a file sha256': (m) => { m.files[3].sha256 = flip(m.files[3].sha256, 10); },
      'a decoded size': (m) => { const d = m.files.find((f) => f.decoded).decoded; d.size = Number(flip(String(d.size))); },
    };
    for (const [what, mut] of Object.entries(muts)) {
      const m = load(build);
      mut(m);
      oneByteApart(load(build), m);
      assert.equal(await verifyManifestSignature(m), false, what);
      await assert.rejects(ModelFolder.open(memoryReader({ 'manifest.json': enc.encode(JSON.stringify(m)) }), { verify: 'on-read' }),
        (e) => e instanceof ModelFolderError && e.code === 'signature_invalid', what);
    }
  });
}

test('build 519235d0: one changed byte in a tolerance value is refused (with the lines and without them)', async () => {
  for (const [b, k] of [['coreml', 'token_diffs'], ['npu:tensor_g5:c16_l64', 'word_flag_diffs'], ['coreml-compact', 'site_flag_diffs']]) {
    const m = load('519235d0');
    m.golden_tolerance[b][k] = Number(flip(String(m.golden_tolerance[b][k])));
    oneByteApart(load('519235d0'), m);
    assert.equal(await verifyManifestSignature(m), false, `${b} ${k}`);
    assert.deepEqual(await checkManifestSignature(m), { valid: false, toleranceSigned: false });
  }
  // the field taken away: the signature covers its lines
  const m = load('519235d0');
  delete m.golden_tolerance;
  assert.equal(await verifyManifestSignature(m), false);
});

test('build 519235d0: the signed text has the golden_tolerance lines after the header, in the reference order', () => {
  const m = load('519235d0');
  const lines = signedText(m).split('\n');
  assert.equal(lines[0], 'quranlab-model-manifest 3');
  assert.equal(lines[10], 'contexts c16_l64,c24_l72,c24_l256,c8_l64');
  assert.deepEqual(lines.slice(11, 11 + TOLERANCE_LINES.length), TOLERANCE_LINES);
  assert.ok(lines[11 + TOLERANCE_LINES.length].startsWith('file '));
  assert.equal(lines.filter((l) => l.startsWith('golden_tolerance ')).length, TOLERANCE_LINES.length);
  assert.equal(lines.filter((l) => l.startsWith('file ')).length, m.files.length);
  // the JSON's key order does not matter: the lines are sorted by the build key's bytes
  const shuffled = { ...m, golden_tolerance: Object.fromEntries(Object.entries(m.golden_tolerance).reverse()) };
  assert.equal(signedText(shuffled), signedText(m));
  // without the lines: the 2.0.0 shape (header then files), which this signature does not cover
  const bare = signedText(m, { tolerance: false }).split('\n');
  assert.ok(bare[11].startsWith('file '));
  assert.equal(bare.length, lines.length - TOLERANCE_LINES.length);
});

test('build d4644956: no golden_tolerance field, no such lines', () => {
  const m = load('d4644956');
  assert.equal(m.golden_tolerance, undefined);
  const t = signedText(m);
  assert.ok(!t.includes('golden_tolerance'));
  assert.equal(t, signedText(m, { tolerance: false }));
  assert.ok(t.split('\n')[11].startsWith('file '));
});

test('fallback: golden_tolerance not covered by the signature verifies without its lines, the tolerance ignored', async () => {
  // build d4644956 was signed without tolerance lines; a field added after signing is not signed
  const m = load('d4644956');
  m.golden_tolerance = { coreml: { token_diffs: 5, site_flag_diffs: 5, word_flag_diffs: 5 } };
  assert.deepEqual(await checkManifestSignature(m), { valid: true, toleranceSigned: false });
  const f = await ModelFolder.open(memoryReader({ 'manifest.json': enc.encode(JSON.stringify(m)) }), { verify: 'on-read', requireSignature: true });
  assert.equal(f.goldenTolerance, null);
  assert.deepEqual(f.toleranceFor('coreml'), { token_diffs: 0, site_flag_diffs: 0, word_flag_diffs: 0 });
  // and the signed one carries its tolerance
  const g = await ModelFolder.open(memoryReader({ 'manifest.json': RAW['519235d0'] }), { verify: 'on-read', requireSignature: true });
  assert.deepEqual(g.goldenTolerance, parseGoldenTolerance(load('519235d0').golden_tolerance));
  assert.equal(Object.keys(g.goldenTolerance).length, 7);
  assert.deepEqual(g.toleranceFor('npu:exynos2500:c16_l64'), { token_diffs: 0, site_flag_diffs: 1, word_flag_diffs: 1 });
  assert.deepEqual(g.toleranceFor('npu:exynos2400:c16_l64'), { token_diffs: 0, site_flag_diffs: 0, word_flag_diffs: 0 });
});

test('parseGoldenTolerance: a malformed entry is left out (exact), an absent field is null', () => {
  assert.equal(parseGoldenTolerance(undefined), null);
  assert.equal(parseGoldenTolerance([1]), null);
  assert.deepEqual(parseGoldenTolerance({
    a: { token_diffs: 0, site_flag_diffs: 1, word_flag_diffs: 2 },
    neg: { token_diffs: -1, site_flag_diffs: 1, word_flag_diffs: 1 },
    frac: { token_diffs: 0.5, site_flag_diffs: 1, word_flag_diffs: 1 },
    missing: { token_diffs: 0, site_flag_diffs: 1 },
    str: { token_diffs: '0', site_flag_diffs: 1, word_flag_diffs: 1 },
  }), { a: { token_diffs: 0, site_flag_diffs: 1, word_flag_diffs: 2 } });
});

// a CDN that serves only manifest.json (the model files are not part of the vectors); requests are logged
function cdn(manifestBytes) {
  const log = [];
  const fetch = async (url) => {
    const p = new URL(url).pathname.replace(/^\/sdk\//, '');
    log.push(p);
    return p === 'manifest.json' ? new Response(manifestBytes, { status: 200 }) : new Response(null, { status: 404 });
  };
  return { fetch, log };
}

test('delivery: cachedReader + ModelFolder.open (signature required) accept the 519235d0 manifest', async () => {
  assert.equal(SDK_VERSION, '3.1.2');
  const { fetch, log } = cdn(RAW['519235d0']);
  const reader = cachedReader({ baseUrl: 'https://cdn.test/sdk/', fetch, store: false });
  const f = await ModelFolder.open(reader, { requireSignature: true, verify: 'on-read' });
  assert.equal(f.manifest.revision, 'v4.0-2026-11-10');
  assert.equal(f.manifest.min_sdk_version, '2.0.1');
  assert.ok(f.has('calibration.json') && f.has('tokens.txt'));
  assert.deepEqual(log, ['manifest.json']);
  // an SDK older than the folder's min_sdk_version is refused after the signature is checked
  await assert.rejects(ModelFolder.open(cachedReader({ baseUrl: 'https://cdn.test/sdk/', fetch, store: false }),
    { requireSignature: true, verify: 'on-read', sdkVersion: '2.0.0' }), (e) => e.code === 'sdk_too_old');
});

test('delivery: the 519235d0 manifest verifies on the 3.0 path and is refused only for having no model version; a tampered one stops at the signature', async () => {
  // a 2.x build: the signature is good, so the refusal is the version rule of SDK 3.0 (SPEC 2a), not the signature
  const good = cdn(RAW['519235d0']);
  await assert.rejects(openTajweedFolder(cachedReader({ baseUrl: 'https://cdn.test/sdk/', fetch: good.fetch, store: false }), { requireSignature: true, verify: 'on-read' }),
    (e) => e instanceof ModelFolderError && e.code === 'version_missing');
  assert.deepEqual(good.log, ['manifest.json']);
  const m = load('519235d0');
  m.golden_tolerance.coreml.site_flag_diffs = 2;
  const bad = cdn(enc.encode(JSON.stringify(m)));
  await assert.rejects(openTajweedFolder(cachedReader({ baseUrl: 'https://cdn.test/sdk/', fetch: bad.fetch, store: false }), { requireSignature: true, verify: 'on-read' }),
    (e) => e instanceof ModelFolderError && e.code === 'signature_invalid');
  assert.deepEqual(bad.log, ['manifest.json']);
  // the same through the SDK's opening of a model (internal since 3.1.0), as catalogue codes
  await assert.rejects(openModel({ reader: memoryReader({ 'manifest.json': RAW['519235d0'] }) }), (e) => e.code === 'model_incompatible');
  await assert.rejects(openModel({ reader: memoryReader({ 'manifest.json': enc.encode(JSON.stringify(m)) }) }), (e) => e.code === 'signature_invalid');
});
