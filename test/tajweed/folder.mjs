// A synthetic V4 model folder for the tests: placeholder files, a format 2 manifest built from them
// and signed with the shared test vector's seed (never the production key).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signedText, sha256Hex, hexToBytes } from '../../web/tajweed/manifest.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const vector = JSON.parse(readFileSync(here('./manifest_v2_vector.json'), 'utf8'));
export const calFixture = readFileSync(here('./calibration_fixture.json'), 'utf8');
const subtle = globalThis.crypto.subtle;

// Ed25519 private key from a raw 32-byte seed (PKCS#8 wrapping), as make_manifest.py --sign takes it.
export async function signer(seedHex) {
  const pkcs8 = hexToBytes('302e020100300506032b657004220420' + seedHex);
  const key = await subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  return async (text) => Buffer.from(new Uint8Array(await subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(text)))).toString('base64');
}
export const testKeyHex = vector.public_key_hex;
export const sign = await signer(vector.seed_hex);

export const enc = (s) => new TextEncoder().encode(s);
// 38 placeholder tokens (not the real vocabulary; the loader only counts and hashes them)
export const TOKENS = ['<blk> 0', '| 1', ...Array.from({ length: 36 }, (_, i) => `t${i + 2} ${i + 2}`)].join('\n') + '\n';

/** A synthetic V4 folder: { files, manifest } with the manifest built from the files, signed unless
 * told not to. `edit(manifest)` runs before signing, `after(files)` after. */
export async function v4Folder({ edit, after, signed = true, calibration } = {}) {
  const files = {
    'tokens.txt': enc(TOKENS),
    'calibration.json': enc(calibration || calFixture),
    'expected_tj3.zfx': enc('ZFX1 placeholder expected table'),
    'c16_l64/model_engine2.onnx.zfg': enc('graph c16'),
    'c16_l64/layers.zfw': new Uint8Array(1000).map((_, i) => i & 255),
    'c24_l72/model_engine2.onnx.zfg': enc('graph c24'),
  };
  const list = [];
  for (const [p, d] of Object.entries(files)) list.push({ path: p, size: d.length, sha256: await sha256Hex(d) });
  const m = {
    format: 2, model_id: 'v4.0', family: 'tajweedformer', revision: 'v4.0-test', min_sdk_version: '2.0.0',
    engine_format: 2, coreml_format: 9, tokens_sha256: await sha256Hex(files['tokens.txt']), coreml: '-',
    sidecar: 'c16_l64/model_engine2.onnx.zfg', keeps: '-', tokens: 'tokens.txt', files: list,
  };
  if (edit) edit(m);
  if (signed) m.signature = await sign(signedText(m));
  files['manifest.json'] = enc(JSON.stringify(m, null, 2));
  if (after) after(files, m);
  return { files, manifest: m };
}
export const opts = { trustedKeys: [testKeyHex] };
