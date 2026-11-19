// Sets the Node entry's built-in engine to a published engine build, at npm publish (the publish workflow runs it):
//
//   node scripts/stamp-engine.mjs <engine id> [--check]
//
// sdk4/node/engine.js names the engine build the package was published with (BUILTIN_ENGINE): the Node path's last
// choice after the signed config's web.engine and its previous, so a desktop app starts even when the config names
// none it can load. In a source tree it is null. The id must be a build Quran Lab serves for API 4: its index.json is
// fetched from https://web.quranlab.ai/4/engine/<id>/, verified with the pinned key (the same check the Node path
// makes), must name this id and carry the one-thread variant the Node path runs. Only then is the one line
// `export const BUILTIN_ENGINE = ...;` rewritten. --check verifies and writes nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_ID_RE, verifyEngineIndex, variantFiles } from '../sdk4/shared/engine-index.js';
import { QURANLAB_PUBLIC_KEY_HEX } from '../web/tajweed/manifest.js';
import { ENGINE_BASE } from '../sdk4/node/engine.js';

const ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
export const ENGINE_FILE = path.join(ROOT, 'sdk4', 'node', 'engine.js');
const LINE = /^export const BUILTIN_ENGINE = (?:null|'[^']*');$/m;

/** engine.js's text with BUILTIN_ENGINE set to `id`; throws unless the file has exactly one such line. */
export function stampSource(text, id) {
  if (!ENGINE_ID_RE.test(id)) throw new Error(`${id} is not an engine id (yyyymmdd.<12 hex>)`);
  const n = (text.match(new RegExp(LINE.source, 'gm')) || []).length;
  if (n !== 1) throw new Error(`sdk4/node/engine.js has ${n} BUILTIN_ENGINE lines, one expected`);
  return text.replace(LINE, `export const BUILTIN_ENGINE = '${id}';`);
}

/** The verified index of a served engine build, or throws. */
export async function verifyServedEngine(id, { base = ENGINE_BASE, pinned = [QURANLAB_PUBLIC_KEY_HEX], fetch = globalThis.fetch } = {}) {
  if (!ENGINE_ID_RE.test(id)) throw new Error(`${id} is not an engine id (yyyymmdd.<12 hex>)`);
  const url = `${base}${id}/index.json`;
  const r = await fetch(url, { redirect: 'error' });
  if (r.status !== 200) throw new Error(`${url} answered ${r.status}`);
  const idx = await verifyEngineIndex(await r.json(), pinned);
  if (idx.engine !== id) throw new Error(`${url} is the index of ${idx.engine}, not of ${id}`);
  if (!variantFiles(idx, 'st')) throw new Error(`engine ${id} has no one-thread variant, which the Node path runs`);
  return idx;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.argv[2];
  if (!id || id.startsWith('--')) { console.error('usage: node scripts/stamp-engine.mjs <engine id> [--check]'); process.exit(2); }
  try {
    const idx = await verifyServedEngine(id);
    const text = readFileSync(ENGINE_FILE, 'utf8');
    const out = stampSource(text, id);
    if (process.argv.includes('--check')) console.log(`engine ${id} verified (API ${idx.api}); nothing written`);
    else { writeFileSync(ENGINE_FILE, out); console.log(`sdk4/node/engine.js: BUILTIN_ENGINE = '${id}' (verified, API ${idx.api})`); }
  } catch (e) {
    console.error(`stamp-engine: ${e.message}`);
    process.exit(1);
  }
}
