// Model folder loading: the signed text against the shared vector (tajweedformer-coreml
// publish/testdata/manifest_v2_vector.json, copied to test/tajweed/), and synthetic V4 folders
// (good, tampered, missing calibration, min_sdk 3.0.0, ...) in memory and on disk.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  signedText, verifyManifestSignature, ModelFolder, ModelFolderError, openTajweedFolder, memoryReader,
  versionAtLeast, sha256Hex, hexToBytes, bytesToHex, isSafePath, parseTokens, SDK_VERSION, QURANLAB_PUBLIC_KEY_HEX,
} from '../web/tajweed/manifest.js';
import { dirReader } from '../web/tajweed/node.js';

import { vector, calFixture, sign, testKeyHex, enc, TOKENS, v4Folder, opts } from './tajweed/folder.mjs';
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

test('good V4 folder, signed: opens, every file checked, calibration and tokens read', async () => {
  const { files } = await v4Folder();
  const reads = [];
  const reader = memoryReader(files);
  const spy = { read: (p) => { reads.push(p); return reader.read(p); } };
  const r = await openTajweedFolder(spy, opts);
  assert.equal(r.folder.modelId, 'v4.0');
  assert.equal(r.folder.engineFormat, 2);
  assert.deepEqual(r.contexts, ['c16_l64', 'c24_l72']);
  assert.equal(r.calibration.default_context, 'c16_l64');
  assert.equal(r.tokens.length, 38);
  assert.equal(r.tokens[0], '<blk>');
  assert.deepEqual(r.folder.under('c16_l64'), ['c16_l64/layers.zfw', 'c16_l64/model_engine2.onnx.zfg']);
  for (const p of Object.keys(files)) assert.ok(reads.includes(p), `${p} was checked`);
});

test('a file on disk the manifest does not list is never read', async () => {
  const { files } = await v4Folder({ after: (f) => { f['c16_l64/stray.bin'] = enc('not listed'); } });
  const reads = [];
  const reader = memoryReader(files);
  const r = await openTajweedFolder({ read: (p) => { reads.push(p); return reader.read(p); } }, opts);
  assert.ok(!reads.includes('c16_l64/stray.bin'));
  await rejects(r.folder.read('c16_l64/stray.bin'), 'not_listed');
});

test('unsigned folder: opens unless a signature is required', async () => {
  const { files } = await v4Folder({ signed: false });
  await openTajweedFolder(memoryReader(files), opts);
  await rejects(openTajweedFolder(memoryReader(files), { ...opts, requireSignature: true }), 'signature_required');
});

test('signed by a key that is not trusted: refused', async () => {
  const { files } = await v4Folder();
  await rejects(openTajweedFolder(memoryReader(files)), 'signature_invalid'); // default: Quran Lab's key only
});

test('tampered file (same size): checksum_mismatch, now or when read', async () => {
  const { files } = await v4Folder({ after: (f) => { f['c16_l64/layers.zfw'] = f['c16_l64/layers.zfw'].slice(); f['c16_l64/layers.zfw'][10] ^= 1; } });
  await rejects(openTajweedFolder(memoryReader(files), opts), 'checksum_mismatch');
  const lazy = await openTajweedFolder(memoryReader(files), { ...opts, verify: 'on-read' });
  await rejects(lazy.folder.read('c16_l64/layers.zfw'), 'checksum_mismatch');
  assert.equal((await lazy.folder.read('c24_l72/model_engine2.onnx.zfg')).length, 9);
});

test('tampered manifest after signing (a field or a file line): signature_invalid', async () => {
  const a = await v4Folder({ after: (f, m) => { m.min_sdk_version = '1.0.0'; f['manifest.json'] = enc(JSON.stringify(m)); } });
  await rejects(openTajweedFolder(memoryReader(a.files), opts), 'signature_invalid');
  const b = await v4Folder({ after: (f, m) => {
    f['c16_l64/layers.zfw'] = new Uint8Array(5);
    m.files.find((x) => x.path === 'c16_l64/layers.zfw').size = 5;
    f['manifest.json'] = enc(JSON.stringify(m));
  } });
  await rejects(openTajweedFolder(memoryReader(b.files), opts), 'signature_invalid');
});

test('missing calibration: refused (not listed, or listed and absent)', async () => {
  const notListed = await v4Folder({ edit: (m) => { m.files = m.files.filter((f) => f.path !== 'calibration.json'); } });
  await rejects(openTajweedFolder(memoryReader(notListed.files), opts), 'not_listed');
  const absent = await v4Folder({ after: (f) => { delete f['calibration.json']; } });
  await rejects(openTajweedFolder(memoryReader(absent.files), opts), 'file_missing');
});

test('min_sdk_version 3.0.0: refused by this SDK (2.0.1)', async () => {
  assert.equal(SDK_VERSION, '2.0.1');
  const { files } = await v4Folder({ edit: (m) => { m.min_sdk_version = '3.0.0'; } });
  await rejects(openTajweedFolder(memoryReader(files), opts), 'sdk_too_old');
  const ok = await v4Folder({ edit: (m) => { m.min_sdk_version = '1.9.9'; } });
  await openTajweedFolder(memoryReader(ok.files), opts);
});

test('engine format 1 (a v3 folder) is not a TajweedFormer folder', async () => {
  const { files } = await v4Folder({ edit: (m) => { m.engine_format = 1; } });
  await rejects(openTajweedFolder(memoryReader(files), opts), 'engine_format_unsupported');
  await ModelFolder.open(memoryReader(files), opts); // but a valid folder for the generic loader
  // engine_format 3 belongs to manifest format 3 (layout 3); a format 2 manifest claiming it is refused
  const f3 = await v4Folder({ edit: (m) => { m.engine_format = 3; } });
  await rejects(openTajweedFolder(memoryReader(f3.files), opts), 'format_unsupported');
  const f4 = await v4Folder({ edit: (m) => { m.engine_format = 4; } });
  await rejects(ModelFolder.open(memoryReader(f4.files), opts), 'engine_format_unsupported');
});

test('expected table missing, bad paths, duplicate entries, tokens mismatch: refused', async () => {
  const noExp = await v4Folder({ edit: (m) => { m.files = m.files.filter((f) => f.path !== 'expected_tj3.zfx'); } });
  await rejects(openTajweedFolder(memoryReader(noExp.files), opts), 'not_listed');
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

test('calibration for another model, or not a calibration: calibration_invalid', async () => {
  const other = JSON.parse(calFixture); other.model_id = 'v4.1';
  const a = await v4Folder({ calibration: JSON.stringify(other) });
  await rejects(openTajweedFolder(memoryReader(a.files), opts), 'calibration_invalid');
  const b = await v4Folder({ calibration: '{"format": "x"}' });
  await rejects(openTajweedFolder(memoryReader(b.files), opts), 'calibration_invalid');
  const wrongTok = JSON.parse(calFixture); wrongTok.tokens_sha256 = 'b'.repeat(64);
  const c = await v4Folder({ calibration: JSON.stringify(wrongTok) });
  await rejects(openTajweedFolder(memoryReader(c.files), opts), 'calibration_invalid');
});

test('tokens.txt without 38 entries: tokens_invalid', async () => {
  const short = await v4Folder({ after: () => {}, edit: () => {} });
  // rebuild with 37 tokens
  const files = { ...short.files, 'tokens.txt': enc(TOKENS.split('\n').slice(0, 37).join('\n') + '\n') };
  const m = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  delete m.signature;
  const t = m.files.find((f) => f.path === 'tokens.txt');
  t.size = files['tokens.txt'].length; t.sha256 = await sha256Hex(files['tokens.txt']); m.tokens_sha256 = t.sha256;
  files['manifest.json'] = enc(JSON.stringify(m));
  await rejects(openTajweedFolder(memoryReader(files), opts), 'tokens_invalid');
  assert.deepEqual(parseTokens('a 1\nb 0\n'), ['b', 'a']);
});

test('on disk through dirReader: good folder opens, links and ".." never leave it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tjf-folder-'));
  try {
    const { files } = await v4Folder();
    for (const [p, d] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      writeFileSync(path.join(dir, p), d);
    }
    const r = await openTajweedFolder(dirReader(dir), opts);
    assert.equal(r.calibration.model_id, 'v4.0');
    assert.equal(await dirReader(dir).read('../x'), null);
    assert.equal(await dirReader(dir).read('nope.bin'), null);
    // the same folder at min_sdk 3.0.0 on disk
    const old = await v4Folder({ edit: (m) => { m.min_sdk_version = '3.0.0'; } });
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
