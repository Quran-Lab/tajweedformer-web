// The engine of the Node path: the same signed engine the web frame runs (docs/server-for-web-4.md "Engine files"),
// from the same host (https://web.quranlab.ai/4/engine/<engine id>/), never a copy inside the npm package.
//
//   - which build: the signed config's web.engine when it names one (a pin in force, else current; the server
//     applied the rollout), then its previous, then the build this package was published with (BUILTIN_ENGINE);
//   - its index.json is verified with Quran Lab's pinned Ed25519 key, each file by SHA-256 and size;
//   - the verified files are kept in the storage folder (`engine/<id>/`) and verified again at every start, so a start
//     with no network runs the kept build; a kept file that does not verify is fetched again (and refused when the
//     network gives no good copy);
//   - the WebAssembly is instantiated from the verified bytes; the glue (an ES module that reads its own URL in Node,
//     so it cannot be imported from a data: URL) is written beside them under its SHA-256 and imported from that file
//     only after its bytes on disk verify again.
// One thread (Node: the Core runs in this package's worker_threads Worker).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyEngineIndex, variantFiles, checkEngineFile, chooseEngine } from '../shared/engine-index.js';
import { sha256Hex } from '../shared/bytes.js';
import { writeAtomic } from './machine.js';
import { SdkError } from '../frame/controller.js';

/** The engine build this package was published with (set at publish by the release tool; null in a source tree). */
export const BUILTIN_ENGINE = null;
export const ENGINE_BASE = 'https://web.quranlab.ai/4/engine/';

// the error reports' reason of each cause (ERRORS_40.md 24.3, stage runtime), as the frame's engine-loader.js
const REASON = { fetch: 'wasm_fetch', index: 'wasm_fetch', signature: 'signature', sha256: 'hash', compile: 'wasm_compile' };
class EngineFailure extends SdkError {
  constructor(code, cause, message) { super(code, message, { stage: 'runtime', why: REASON[cause] || 'other' }); this.cause = cause; }
}

async function fetchBytes(fetch, url) {
  const r = await fetch(url, { redirect: 'error' });
  if (r.status !== 200) throw new Error(`${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * { factory, wasm, id, why, core, failures } of the engine to run, or throws (with `failures`) when no build loads.
 * @param {object} o  { dir (storage folder), config, pinned (Ed25519 public keys), base, builtIn, fetch, importModule }
 */
export async function loadNodeEngine({ dir, config, pinned, base = ENGINE_BASE, builtIn = BUILTIN_ENGINE, fetch = globalThis.fetch,
  importModule = (url) => import(url) }) {
  const ch = chooseEngine(config && config.web, { threads: 'off', fallback: builtIn });
  const kept = fs.existsSync(path.join(dir, 'engine')) ? fs.readdirSync(path.join(dir, 'engine')).filter((x) => /^\d{8}\.[0-9a-f]{12}$/.test(x)).sort().reverse() : [];
  // the build named, its previous, the package's own, then the newest build kept in the folder (an offline start
  // whose config could not be read)
  const order = [ch.id, ch.previous, builtIn, ...kept].filter((x, i, a) => x && a.indexOf(x) === i);
  if (!order.length) throw new EngineFailure('runtime_unsupported', 'index', 'no engine build is named (no config, no kept build, none in the package)');
  const failures = [];
  let first = null;
  for (const id of order) {
    try {
      const r = await one(id);
      r.why = id === ch.id ? ch.why : id === ch.previous ? 'previous' : id === builtIn ? 'built-in' : 'kept';
      r.failures = failures;
      return r;
    } catch (e) {
      if (!first) first = e;
      failures.push({ id, cause: e.cause || 'fetch' });
    }
  }
  first.failures = failures;
  throw first;

  async function one(id) {
    const d = path.join(dir, 'engine', id);
    const readKept = (name) => { try { return new Uint8Array(fs.readFileSync(path.join(d, name))); } catch (_) { return null; } };
    // the index: kept, else fetched; verified either way
    let json = null, fromNet = false;
    try { const k = readKept('index.json'); json = k ? JSON.parse(new TextDecoder().decode(k)) : null; } catch (_) { json = null; }
    let idx = json ? await verifyEngineIndex(json, pinned).catch(() => null) : null;
    if (!idx || idx.engine !== id) {
      try { json = JSON.parse(new TextDecoder().decode(await fetchBytes(fetch, `${base}${id}/index.json`))); } catch (e) { throw new EngineFailure('download_failed', 'index', `engine ${id}: ${e.message}`); }
      idx = await verifyEngineIndex(json, pinned).catch((e) => { throw new EngineFailure('signature_invalid', 'signature', `engine ${id}: ${e.code || e.message}`); });
      if (idx.engine !== id) throw new EngineFailure('signature_invalid', 'signature', `engine ${id}: the index names ${idx.engine}`);
      fromNet = true;
    }
    const files = variantFiles(idx, 'st');
    if (!files) throw new EngineFailure('signature_invalid', 'index', `engine ${id}: no one-thread build`);
    const get = async (entry) => {
      const k = readKept(entry.name);
      if (k && (await checkEngineFile(entry, k).then(() => true, () => false))) return { bytes: k, fresh: false };
      let b;
      try { b = await fetchBytes(fetch, `${base}${id}/${entry.name}`); } catch (e) { throw new EngineFailure('download_failed', 'fetch', `engine ${id}: ${e.message}`); }
      await checkEngineFile(entry, b).catch((e) => { throw new EngineFailure('signature_invalid', 'sha256', e.message); });
      return { bytes: b, fresh: true };
    };
    const js = await get(files.js), wasm = await get(files.wasm);
    fs.mkdirSync(d, { recursive: true });
    if (fromNet) writeAtomic(path.join(d, 'index.json'), JSON.stringify(json), 0o644);
    if (js.fresh) writeAtomic(path.join(d, files.js.name), js.bytes, 0o644);
    if (wasm.fresh) writeAtomic(path.join(d, files.wasm.name), wasm.bytes, 0o644);
    try { await WebAssembly.compile(wasm.bytes); } catch (e) { throw new EngineFailure('runtime_unsupported', 'compile', `engine ${id}: ${e.message}`); }
    // the glue from a file named by its verified hash, its bytes checked once more right before the import
    const glue = path.join(d, `glue.${files.js.sha256.slice(0, 16)}.mjs`);
    if (!fs.existsSync(glue) || (await sha256Hex(new Uint8Array(fs.readFileSync(glue)))) !== files.js.sha256) writeAtomic(glue, js.bytes, 0o644);
    if ((await sha256Hex(new Uint8Array(fs.readFileSync(glue)))) !== files.js.sha256) throw new EngineFailure('signature_invalid', 'sha256', `engine ${id}: the glue changed on disk`);
    let factory;
    try { factory = (await importModule(pathToFileURL(glue).href)).default; } catch (e) { throw new EngineFailure('runtime_unsupported', 'compile', `engine ${id}: ${e.message}`); }
    return { factory, wasm: wasm.bytes, id, variant: 'st', core: idx.core };
  }
}
