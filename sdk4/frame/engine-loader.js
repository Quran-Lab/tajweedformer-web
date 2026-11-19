// The engine for this site: the signed config names the build (pinned or auto, rollout applied by the server),
// the frame fetches its signed index, checks the Ed25519 signature with a pinned key and every file's SHA-256 and
// size, and only then runs it: the WebAssembly is instantiated from the checked bytes, the glue imported from a
// Blob of the checked bytes. A build that fails to load falls back to the config's `previous` build, once.
import { verifyEngineIndex, variantFiles, checkEngineFile, chooseEngine } from '../shared/engine-index.js';
import { SdkError } from './controller.js';

async function bytesOf(fetch, url) {
  const r = await fetch(url, { redirect: 'error', credentials: 'omit' });
  if (r.status !== 200) throw new SdkError('download_failed', `engine file ${url}: ${r.status}`, { stage: 'runtime', why: 'wasm_fetch', http_status: r.status });
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * @param {object} o
 * @param {string} o.base  the engine folder base ("https://web.quranlab.ai/4/engine/")
 * @param {object|null} o.config  the verified signed config
 * @param {Array<string|Uint8Array>} o.pinned  the pinned Ed25519 public keys
 * @param {string|null} o.builtIn  the engine id this frame was published with (used when the config names none)
 */
export async function loadEngine({ base, config, pinned, builtIn = null, fetch = globalThis.fetch.bind(globalThis), threads = 'auto',
  importModule = (url) => import(/* @vite-ignore */ url) }) {
  const isolated = !!globalThis.crossOriginIsolated;
  const cores = (globalThis.navigator && globalThis.navigator.hardwareConcurrency) || 1;
  const ch = chooseEngine(config && config.web, { isolated, cores, threads, fallback: builtIn });
  if (!ch.id) throw new SdkError('runtime_unsupported', 'no engine build is named for this site', { stage: 'runtime', why: 'wasm_unsupported' });
  // the error reports' reason of each cause (ERRORS_40.md 24.3, stage runtime)
  const REASON = { fetch: 'wasm_fetch', index: 'wasm_fetch', signature: 'signature', sha256: 'hash', compile: 'wasm_compile' };
  const fail = (code, cause, message) => Object.assign(new SdkError(code, message, { stage: 'runtime', why: REASON[cause] || 'other' }), { cause });
  const tryOne = async (id) => {
    let r;
    try { r = await fetch(`${base}${id}/index.json`, { redirect: 'error', credentials: 'omit' }); } catch (e) { throw fail('download_failed', 'fetch', `engine ${id}: ${e.message}`); }
    if (r.status !== 200) throw fail('download_failed', 'index', `engine ${id}: the index answered ${r.status}`);
    let json;
    try { json = await r.json(); } catch (_) { throw fail('signature_invalid', 'index', `engine ${id}: the index is not JSON`); }
    const idx = await verifyEngineIndex(json, pinned)
      .catch((e) => { throw fail('signature_invalid', 'signature', `engine ${id}: ${e.code || e.message}`); });
    let variant = ch.variant;
    let files = variantFiles(idx, variant);
    if (!files) { variant = 'st'; files = variantFiles(idx, 'st'); }
    let js, wasm;
    try { [js, wasm] = await Promise.all([bytesOf(fetch, `${base}${id}/${files.js.name}`), bytesOf(fetch, `${base}${id}/${files.wasm.name}`)]); } catch (e) { throw fail('download_failed', 'fetch', e.message); }
    await checkEngineFile(files.js, js).catch((e) => { throw fail('signature_invalid', 'sha256', e.message); });
    await checkEngineFile(files.wasm, wasm).catch((e) => { throw fail('signature_invalid', 'sha256', e.message); });
    // the module compiles here (a browser without what it needs), so a build that cannot run falls back too
    try { await WebAssembly.compile(wasm); } catch (e) { throw fail('runtime_unsupported', 'compile', `engine ${id}: ${e.message}`); }
    const url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
    if (variant === 'mt') globalThis.__qlPthreadUrl = url; // the threads' workers start from the checked glue too
    let factory;
    try { factory = (await importModule(url)).default; } catch (e) { throw fail('runtime_unsupported', 'compile', `engine ${id}: ${e.message}`); }
    return { factory, wasm, id, variant, why: ch.why, core: idx.core };
  };
  // the build named, then the config's previous build, then the build this frame was published with; every build
  // that failed is named with its cause (`failures`), for the engine_load_failed issue the server's rollback reads
  const order = [ch.id, ch.previous, builtIn].filter((x, i, a) => x && a.indexOf(x) === i);
  const failures = [];
  let first = null;
  for (const id of order) {
    try {
      const r = await tryOne(id);
      if (failures.length) r.why = id === ch.previous ? 'previous' : 'built-in';
      r.failures = failures;
      return r;
    } catch (e) {
      if (!first) first = e;
      failures.push({ id, cause: e.cause || 'fetch' });
    }
  }
  first.failures = failures;
  throw first;
}
