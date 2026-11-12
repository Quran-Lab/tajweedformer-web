// The error catalogue (NAMING.md section 7): the embedded copy equals the shared file byte for byte (where the
// shared file is on disk) and its recorded SHA-256 (everywhere); TajweedError carries code, message, fix and
// docs from it; every internal failure maps to one of its codes.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TajweedError } from '../web/index.js';
import { ERRORS_JSON, ERRORS_SHA256 } from '../web/api/errors-catalogue.js';
import { ERROR_CODES, toTajweedError } from '../web/api/errors.js';
import { ModelFolderError } from '../web/tajweed/manifest.js';
import { DeliveryError } from '../web/tajweed/delivery.js';
import { PlatformError } from '../web/platform/client.js';

// the folder of the shared 3.0 contract (errors.json, vectors/), where there is one
const SHARED = process.env.TAJWEED_CONTRACT_30 ? path.join(process.env.TAJWEED_CONTRACT_30, 'errors.json') : '';
// the SHA-256 of the shared catalogue this SDK was built with; changes only together with the embedded copy
const RECORDED_SHA256 = '04b264b9d820f865a0bfd4d695e17a07b2ae6b1be318324c91f3177d322cd510';

test('the embedded catalogue is the shared errors.json, byte for byte', { skip: existsSync(SHARED) ? false : 'TAJWEED_CONTRACT_30 is not set (the folder of the shared 3.0 contract)' }, () => {
  assert.ok(Buffer.from(ERRORS_JSON, 'utf8').equals(readFileSync(SHARED)), 'run: node scripts/gen_errors.mjs <errors.json>');
});

test('the embedded catalogue has the recorded SHA-256', () => {
  const sha = createHash('sha256').update(Buffer.from(ERRORS_JSON, 'utf8')).digest('hex');
  assert.equal(sha, RECORDED_SHA256);
  assert.equal(ERRORS_SHA256, RECORDED_SHA256);
});

test('TajweedError: code, message, fix and docs from the catalogue, placeholders filled; 26 codes', () => {
  const cat = JSON.parse(ERRORS_JSON);
  assert.equal(cat.errors.length, 26);
  assert.deepEqual([...ERROR_CODES], cat.errors.map((e) => e.code));
  for (const entry of cat.errors) {
    const e = new TajweedError(entry.code, { detail: 'D', file: 'F', version: '3.1.0', sdk: '3.0.0', needed: 10, available: 5 });
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'TajweedError');
    assert.equal(e.code, entry.code);
    assert.equal(e.docs, `https://sdk.quranlab.ai/docs/errors#${entry.code}`);
    assert.ok(e.message.length > 0 && e.fix.length > 0);
    assert.ok(!/[{}]/.test(e.message + e.fix), `${entry.code}: a placeholder was left`);
  }
  assert.equal(new TajweedError('sdk_too_old', { version: '3.1.0', sdk: '3.0.0' }).message, 'This key needs SDK 3.1.0 or later; this is 3.0.0.');
  assert.equal(new TajweedError('engine_failed').message, 'The engine failed.');
  assert.throws(() => new TajweedError('not_a_code'), RangeError);
});

test('every internal failure maps to a catalogue code', () => {
  const map = (e, o) => toTajweedError(e, o).code;
  const folder = { manifest_missing: 'model_missing', file_missing: 'model_missing', manifest_invalid: 'model_invalid', not_listed: 'model_invalid',
    tokens_invalid: 'model_invalid', signature_invalid: 'signature_invalid', signature_required: 'signature_invalid', checksum_mismatch: 'checksum_mismatch',
    sdk_too_old: 'model_incompatible', format_unsupported: 'model_incompatible', engine_format_unsupported: 'model_incompatible',
    signature_unsupported: 'runtime_unsupported', version_missing: 'model_incompatible', version_mismatch: 'model_invalid', build_mismatch: 'checksum_mismatch' };
  for (const [from, to] of Object.entries(folder)) assert.equal(map(new ModelFolderError(from, 'x', 'f')), to, from);
  assert.equal(map(new DeliveryError('checksum_mismatch', 'x', { path: 'layers.zfw' })), 'checksum_mismatch');
  assert.match(toTajweedError(new DeliveryError('checksum_mismatch', 'x', { path: 'layers.zfw' })).message, /layers\.zfw/);
  assert.equal(map(new DeliveryError('aborted', 'x')), 'cancelled');
  assert.equal(map(new DeliveryError('http', 'x', { status: 401 })), 'invalid_key');
  assert.equal(map(new DeliveryError('http', 'x', { status: 403 })), 'server_rejected');
  assert.equal(map(new DeliveryError('http', 'x', { status: 500 })), 'download_failed');
  assert.equal(map(new DeliveryError('offline', 'x')), 'download_failed');
  assert.equal(map(Object.assign(new DeliveryError('offline', 'x'), { nothingCached: true })), 'needs_connection');
  assert.equal(map(new PlatformError(401, 'invalid_key', '')), 'invalid_key');
  const old = toTajweedError(new PlatformError(403, 'sdk_too_old', 'this key needs SDK 3.2.0 or later'), { sdk: '3.0.0' });
  assert.equal(old.code, 'sdk_too_old');
  assert.match(old.message, /3\.2\.0.*3\.0\.0/);
  assert.match(old.fix, /3\.2\.0/);
  for (const c of ['app_blocked', 'app_not_allowed', 'key_type_mismatch', 'origin_not_allowed', 'developer_not_approved']) {
    assert.equal(map(new PlatformError(403, c, '')), 'server_rejected', c);
  }
  assert.equal(map(new PlatformError(0, 'offline', '')), 'needs_connection');
  assert.equal(map(Object.assign(new Error('x'), { name: 'NotAllowedError' })), 'microphone_denied');
  assert.equal(map(Object.assign(new Error('x'), { name: 'NotFoundError' })), 'microphone_unavailable');
  assert.equal(map(Object.assign(new Error('x'), { name: 'QuotaExceededError' })), 'storage_full');
  assert.equal(map(new RangeError('x')), 'invalid_argument');
  assert.equal(map(new Error('boom')), 'engine_failed');
  assert.equal(map(new Error('boom'), { fallback: 'storage_failed' }), 'storage_failed');
  const same = new TajweedError('cancelled');
  assert.equal(toTajweedError(same), same);
  for (const c of [map(new Error('x')), map(new PlatformError(500, 'http_500', ''))]) assert.ok(ERROR_CODES.includes(c));
});
