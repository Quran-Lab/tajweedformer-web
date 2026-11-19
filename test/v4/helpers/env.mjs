// Where the Node tests find the packaged engine and the test build (both outside the repository's tracked files).
//
//   QL_ENGINE_DIR  a folder with qlcore.mjs and qlcore.wasm (default: dist/engine/<dist/engine/LATEST>, made by
//                  `python scripts/build_web4.py engine`)
//   QL_TEST_BUILD  a protected TEST build's CDN folder, sdk/v4.0 with manifest.json and the .qle files (made by
//                  quranlab-core tools/make_test_build.py with the contract's test keys)
// A test that needs one of them and does not find it says so and is skipped.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function engineDir() {
  if (process.env.QL_ENGINE_DIR) return process.env.QL_ENGINE_DIR;
  const latest = join(ROOT, 'dist', 'engine', 'LATEST');
  return existsSync(latest) ? join(ROOT, 'dist', 'engine', readFileSync(latest, 'utf8').trim()) : null;
}

export function testBuild() {
  const d = process.env.QL_TEST_BUILD;
  return d && existsSync(join(d, 'manifest.json')) ? d : null;
}

/** { factory, wasm } of the one-thread engine, or null. */
export async function loadEngine(variant = 'st') {
  const d = engineDir();
  const suf = variant === 'mt' ? '-mt' : '';
  if (!d || !existsSync(join(d, `qlcore${suf}.mjs`))) return null;
  const factory = (await import(pathToFileURL(join(d, `qlcore${suf}.mjs`)).href)).default;
  return { factory, wasm: new Uint8Array(readFileSync(join(d, `qlcore${suf}.wasm`))), dir: d };
}
