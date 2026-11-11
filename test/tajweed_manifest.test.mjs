// Model folder loading: the signed text against the shared vector (tajweedformer-coreml
// publish/testdata/manifest_v2_vector.json, copied to test/tajweed/), and synthetic V4 folders
// (good, tampered, no calibration, min_sdk 3.0.1, the model version, ...) in memory and on disk.
// Run: npm test
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  signedText, verifyManifestSignature, ModelFolder, ModelFolderError, openTajweedFolder, memoryReader,
  versionAtLeast, sha256Hex, hexToBytes, bytesToHex, isSafePath, parseTokens, SDK_VERSION, QURANLAB_PUBLIC_KEY_HEX,
} from '../web/tajweed/manifest.js';
import { dirReader } from '../web/tajweed/node.js';

import { vector, sign, testKeyHex, enc, TOKENS, v4Folder, opts } from './tajweed/folder.mjs';
import { build3 } from './helpers/model3.mjs';
const rejects = (p, code) => assert.rejects(p, (e) => {
  assert.ok(e instanceof ModelFolderError, `not a ModelFolderError: ${e && e.stack}`);
  assert.equal(e.code, code, e.message);
  return true;
});

test('signed text matches the shared vector byte for byte', () => {
  assert.equal(signedText(vector.manifest), vector.signed_text);
});

test('the vector signature verifies with WebCrypto Ed25519, and is reproduced from the seed', async () => {
  assert.equal(await verifyManifestSignature(vector.manifest, [testKeyHex]), true);
  assert.equal(await sign(vector.signed_text), vector.manifest.signature); // Ed25519 is deterministic
  // the production key does not sign the test vector
  assert.equal(await verifyManifestSignature(vector.manifest), false);
  // any signed field or file line changed: no longer verifies
  for (const mut of [
    (m) => { m.min_sdk_version = '0.9.0'; },
    (m) => { m.engine_format = 2; },
    (m) => { m.files[0].size += 1; },
    (m) => { m.files[5].sha256 = '7'.repeat(64); },
    (m) => { m.files.push({ path: 'extra.bin', size: 1, sha256: '8'.repeat(64) }); },
  ]) {
    const m = JSON.parse(JSON.stringify(vector.manifest));
    mut(m);
    assert.equal(await verifyManifestSignature(m, [testKeyHex]), false);
  }
  // reordering the files or uppercase hex does not change the text
  const m = JSON.parse(JSON.stringify(vector.manifest));
  m.files.reverse();
  m.files[0].sha256 = m.files[0].sha256.toUpperCase();
  assert.equal(signedText(m), vector.signed_text);
});

test('format 1 signed text is the legacy one', () => {
  const m = { format: 1, model: 'v3.1', revision: 'r', coreml: 'zf.mlmodelc', sidecar: 'engine.zfs', keeps: 'k.bin',
    tokens: 'tokens.txt', files: [{ path: 'b', size: 2, sha256: 'AB'.repeat(32) }, { path: 'a', size: 1, sha256: 'cd'.repeat(32) }] };
  assert.equal(signedText(m), 'quranlab-model-manifest 1\nmodel v3.1\nrevision r\ncoreml zf.mlmodelc\nsidecar engine.zfs\n' +
    `keeps k.bin\ntokens tokens.txt\nfile ${'cd'.repeat(32)} 1 a\nfile ${'ab'.repeat(32)} 2 b\n`);
});

test('the production key is the one the Swift SDK compiles in', () => {
  assert.equal(QURANLAB_PUBLIC_KEY_HEX.length, 64);
  assert.equal(bytesToHex(hexToBytes(QURANLAB_PUBLIC_KEY_HEX)), QURANLAB_PUBLIC_KEY_HEX);
});

test('good 3.0 folder, signed: opens, every file checked, version, build and tokens read', async () => {
  const b = await build3();
  const reads = [];
  const reader = memoryReader(b.files);
  const spy = { read: (p) => { reads.push(p); return reader.read(p); } };
  const r = await openTajweedFolder(spy, opts);
  assert.equal(r.folder.modelId, 'v4.0');
  assert.equal(r.folder.engineFormat, 3);
  assert.deepEqual(r.contexts, ['c16_l64', 'c8_l64', 'c24_l72']);
  assert.equal(r.version, '4.0.0');
  assert.equal(r.build, (await sha256Hex(b.files['manifest.json'])).slice(0, 40));
  assert.equal(r.build, r.folder.build);
  assert.equal(r.tokens.length, 38);
  assert.equal(r.tokens[0], '<blk>');
  assert.deepEqual(r.folder.under('c16_l64'), ['c16_l64/frames.zfw', 'c16_l64/model_engine2.onnx', 'c16_l64/model_engine2.onnx.zfg']);
  assert.deepEqual(r.folder.withRole('calibration'), ['calibration.json']);
  assert.equal(r.folder.entry('layers.zfw').stored.path, 'layers.zfw.gz');
  for (const p of Object.keys(b.files)) assert.ok(reads.includes(p), `${p} was checked`);
  // the expected table of 2.x is not needed (this build lists none), nor the calibration, nor the reference data
  const bare = await build3({ calibration: false, reference: false, selftest: false });
  await openTajweedFolder(memoryReader(bare.files), opts);
});

test('a file on disk the manifest does not list is never read', async () => {
  const b = await build3();
  b.files['c16_l64/stray.bin'] = enc('not listed');
  const reads = [];
  const reader = memoryReader(b.files);
  const r = await openTajweedFolder({ read: (p) => { reads.push(p); return reader.read(p); } }, opts);
  assert.ok(!reads.includes('c16_l64/stray.bin'));
  await rejects(r.folder.read('c16_l64/stray.bin'), 'not_listed');
});

test('unsigned folder: opens unless a signature is required', async () => {
  const { files } = await build3({ signed: false });
  await openTajweedFolder(memoryReader(files), opts);
  await rejects(openTajweedFolder(memoryReader(files), { ...opts, requireSignature: true }), 'signature_required');
});

test('signed by a key that is not trusted: refused', async () => {
  const { files } = await build3();
  await rejects(openTajweedFolder(memoryReader(files)), 'signature_invalid'); // default: Quran Lab's key only
});

test('tampered file (same size): checksum_mismatch, now or when read', async () => {
  const { files } = await build3();
  files['frontend.zfw'] = files['frontend.zfw'].slice();
  files['frontend.zfw'][3] ^= 1;
  await rejects(openTajweedFolder(memoryReader(files), opts), 'checksum_mismatch');
  const lazy = await openTajweedFolder(memoryReader(files), { ...opts, verify: 'on-read' });
  await rejects(lazy.folder.read('frontend.zfw'), 'checksum_mismatch');
  assert.equal((await lazy.folder.read('c24_l72/model_engine2.onnx.zfg')).length, 13);
  // a gzip transport file: the stored bytes are checked before they are inflated
  const gz = await build3();
  gz.files['layers.zfw.gz'] = gz.files['layers.zfw.gz'].slice();
  gz.files['layers.zfw.gz'][20] ^= 1;
  const l2 = await openTajweedFolder(memoryReader(gz.files), { ...opts, verify: 'on-read' });
  await rejects(l2.folder.read('layers.zfw'), 'checksum_mismatch');
});

test('tampered manifest after signing (a field, the version or a file line): signature_invalid', async () => {
  const again = (m) => enc(JSON.stringify(m));
  const a = await build3();
  a.manifest.min_sdk_version = '1.0.0';
  await rejects(openTajweedFolder(memoryReader({ ...a.files, 'manifest.json': again(a.manifest) }), opts), 'signature_invalid');
  const v = await build3();
  v.manifest.version = '4.0.1';
  await rejects(openTajweedFolder(memoryReader({ ...v.files, 'manifest.json': again(v.manifest) }), opts), 'signature_invalid');
  const b = await build3();
  b.manifest.files.find((x) => x.path === 'frontend.zfw').size = 5;
  await rejects(openTajweedFolder(memoryReader({ ...b.files, 'frontend.zfw': new Uint8Array(5), 'manifest.json': again(b.manifest) }), opts), 'signature_invalid');
});

test('the calibration is not needed to open (SDK 3.0); a listed file that is absent is file_missing', async () => {
  const none = await build3({ calibration: false });
  const r = await openTajweedFolder(memoryReader(none.files), opts);
  assert.deepEqual(r.folder.withRole('calibration'), []);
  const absent = await build3();
  delete absent.files['calibration.json.gz'];
  await rejects(openTajweedFolder(memoryReader(absent.files), opts), 'file_missing');
});

test('min_sdk_version 3.0.1: refused by this SDK (3.0.0)', async () => {
  assert.equal(SDK_VERSION, '3.0.0');
  const { files } = await build3({ minSdk: '3.0.1' });
  await rejects(openTajweedFolder(memoryReader(files), opts), 'sdk_too_old');
  for (const ok of ['3.0.0', '2.0.1', '1.9.9']) await openTajweedFolder(memoryReader((await build3({ minSdk: ok })).files), opts);
});

test('the model version (SPEC 2a): a manifest without one is refused; the signed text has the version line; the config\'s version and build are checked', async () => {
  const b = await build3();
  assert.ok(signedText(b.manifest).startsWith('quranlab-model-manifest 3\nmodel_id v4.0\nfamily tajweedformer\nrevision v4.0-test\nversion 4.0.0\nmin_sdk_version 3.0.0\n'));
  const none = await build3({ version: null });
  assert.ok(!signedText(none.manifest).includes('\nversion '), 'no version line without the field: the 2.0.x text, byte for byte');
  await rejects(openTajweedFolder(memoryReader(none.files), opts), 'version_missing');
  await ModelFolder.open(memoryReader(none.files), opts); // the generic loader reads it; a 3.0 model it is not
  for (const bad of ['4.0', '04.0.0', '4.0.0-beta', '4.0.0+1', 'v4.0.0', '4.0.00', ' 4.0.0', 4]) {
    const f = await build3({ version: bad });
    await rejects(openTajweedFolder(memoryReader(f.files), opts), 'manifest_invalid');
  }
  for (const good of ['4.0.0', '0.0.1', '10.20.30']) assert.equal((await openTajweedFolder(memoryReader((await build3({ version: good })).files), opts)).version, good);
  await openTajweedFolder(memoryReader(b.files), { ...opts, expect: { version: '4.0.0', build: b.build } });
  await openTajweedFolder(memoryReader(b.files), { ...opts, expect: { build: b.build.toUpperCase() } });
  await rejects(openTajweedFolder(memoryReader(b.files), { ...opts, expect: { version: '4.0.1', build: b.build } }), 'version_mismatch');
  await rejects(openTajweedFolder(memoryReader(b.files), { ...opts, expect: { version: '4.0.0', build: '0'.repeat(40) } }), 'build_mismatch');
});

test('a 2.x folder (manifest format 2) is not a 3.0 TajweedFormer folder', async () => {
  const { files } = await v4Folder();
  await rejects(openTajweedFolder(memoryReader(files), opts), 'version_missing');
  await ModelFolder.open(memoryReader(files), opts); // but a valid folder for the generic loader
  const f3 = await v4Folder({ edit: (m) => { m.engine_format = 3; } });
  await rejects(openTajweedFolder(memoryReader(f3.files), opts), 'version_missing');
  const f4 = await v4Folder({ edit: (m) => { m.engine_format = 4; } });
  await rejects(ModelFolder.open(memoryReader(f4.files), opts), 'engine_format_unsupported');
});

test('bad paths, duplicate entries, tokens mismatch: refused', async () => {
  for (const bad of ['../x', '/abs', 'a//b', 'a\\b', 'C:/x', './a', 'a/./b', '']) {
    assert.equal(isSafePath(bad), false, bad);
    const f = await v4Folder({ edit: (m) => { m.files.push({ path: bad, size: 0, sha256: '0'.repeat(64) }); } });
    await rejects(ModelFolder.open(memoryReader(f.files), opts), 'manifest_invalid');
  }
  const dup = await v4Folder({ edit: (m) => { m.files.push({ ...m.files[0] }); } });
  await rejects(ModelFolder.open(memoryReader(dup.files), opts), 'manifest_invalid');
  const tsha = await v4Folder({ edit: (m) => { m.tokens_sha256 = 'a'.repeat(64); } });
  await rejects(ModelFolder.open(memoryReader(tsha.files), opts), 'manifest_invalid');
  // a format 3 manifest without format 3's fields (contexts, tags) is malformed; format 4 is unknown
  const fmt = await v4Folder({ edit: (m) => { m.format = 3; }, signed: false });
  await rejects(ModelFolder.open(memoryReader(fmt.files), opts), 'manifest_invalid');
  const fmt4 = await v4Folder({ edit: (m) => { m.format = 4; }, signed: false });
  await rejects(ModelFolder.open(memoryReader(fmt4.files), opts), 'format_unsupported');
  await rejects(ModelFolder.open(memoryReader({}), opts), 'manifest_missing');
  await rejects(ModelFolder.open(memoryReader({ 'manifest.json': enc('{') }), opts), 'manifest_invalid');
});

test('tokens.txt without 38 entries: tokens_invalid', async () => {
  const short = enc(TOKENS.split('\n').slice(0, 37).join('\n') + '\n');
  const sum = await sha256Hex(short);
  const b = await build3({ signed: false, edit: (m, files) => {
    files['tokens.txt'] = short;
    const t = m.files.find((f) => f.path === 'tokens.txt');
    t.size = short.length; t.sha256 = sum; m.tokens_sha256 = sum;
  } });
  await rejects(openTajweedFolder(memoryReader(b.files), opts), 'tokens_invalid');
  assert.deepEqual(parseTokens('a 1\nb 0\n'), ['b', 'a']);
});

test('on disk through dirReader: good folder opens, links and ".." never leave it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tjf-folder-'));
  try {
    const { files } = await build3();
    for (const [p, d] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      writeFileSync(path.join(dir, p), d);
    }
    const r = await openTajweedFolder(dirReader(dir), opts);
    assert.equal(r.version, '4.0.0');
    assert.equal(await dirReader(dir).read('../x'), null);
    assert.equal(await dirReader(dir).read('nope.bin'), null);
    // the same folder at min_sdk 3.0.1 on disk
    const old = await build3({ minSdk: '3.0.1' });
    writeFileSync(path.join(dir, 'manifest.json'), old.files['manifest.json']);
    await rejects(openTajweedFolder(dirReader(dir), opts), 'sdk_too_old');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('versionAtLeast compares as the Swift SDK does', () => {
  const t = [['2.0.0', '2.0.0', true], ['2.0.0', '3.0.0', false], ['2.0.0', '1.9.9', true], ['2.0.0', '2.0.1', false],
    ['2.10.0', '2.9.0', true], ['2.0', '2.0.0', true], ['2.0.0-beta.1', '2.0.0', true], ['x', '1.0.0', false],
    ['2.0.0', '', false]];
  for (const [v, min, want] of t) assert.equal(versionAtLeast(v, min), want, `${v} >= ${min}`);
});
