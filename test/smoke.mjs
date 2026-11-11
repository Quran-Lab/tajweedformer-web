// Loads the built module in Node and exercises the runtime plumbing without the (gated) model: the WASM
// instantiates, ccall/FS work, the V4 binding (src/zft_api.c) is there, and opening a folder that does not exist
// fails cleanly rather than trapping. Run: node test/smoke.mjs [module.mjs]
// The default module is dist/tajweedformer.mjs (npm run build). A --with-1x build (dist/zipformer.mjs, scripts/build.sh
// --with-1x) also carries the 1.x phoneme stream API, so its layout checks run when those exports are there.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const url = process.argv[2]
  ? pathToFileURL(path.resolve(process.argv[2])).href
  : new URL('../dist/tajweedformer.mjs', import.meta.url).href;
const { default: createModule } = await import(url);

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails++; };

// the glue is built for web and worker; in Node it is handed the wasm file's bytes, as the SDK does
const { readFileSync } = await import('node:fs');
const wasm = readFileSync(new URL(url.replace(/\.mjs$/, '.wasm')));
const m = await createModule({ instantiateWasm(imports, done) { WebAssembly.instantiate(wasm, imports).then((r) => done(r.instance, r.module)); return {}; } });
ok(typeof m._malloc === 'function', 'module instantiated, _malloc present');

// The V4 binding the SDK calls (web/tajweed/engine.js).
ok(typeof m._zft_model_open === 'function' && typeof m._zft_layout === 'function', 'the V4 binding is in the module');
const apiVersion = m.ccall('zft_api_version', 'number', [], []);
ok(apiVersion >= 1, `zft_api_version is set (got ${apiVersion})`);
const layoutCount = m.ccall('zft_layout_count', 'number', [], []);
ok(layoutCount > 0, `zft_layout_count > 0 (got ${layoutCount}); the struct layout table the JS checks against the C side`);

// FS round-trip: the model staging path the wrapper relies on.
m.FS.mkdir('/model');
m.FS.writeFile('/model/probe.bin', new Uint8Array([1, 2, 3, 4]));
const back = m.FS.readFile('/model/probe.bin');
ok(back.length === 4 && back[3] === 4, 'MEMFS write/read round-trips');

// Opening a folder that is not there: must return 0, not trap, and say why.
const h = m.ccall('zft_model_open', 'number', ['string', 'string', 'number', 'number', 'number'], ['/model/missing', null, 0, 1, 0]);
ok(h === 0, 'zft_model_open returns 0 for a missing folder (clean failure, no trap)');
const why = m.UTF8ToString(m._zft_error());
ok(why.length > 0, `zft_error explains it ("${why}")`);

// A malloc/HEAPF32/free cycle, the hot path the wrapper uses every push.
const p = m._malloc(16 * 4);
m.HEAPF32.set(new Float32Array([1, 2, 3, 4]), p >> 2);
ok(m.HEAPF32[p >> 2] === 1 && m.HEAPF32[(p >> 2) + 3] === 4, 'HEAPF32 view write/read works');
m._free(p);

// The 1.x stream API, only in a --with-1x build.
if (typeof m._zfw_token_bytes === 'function') {
  const tb = m.ccall('zfw_token_bytes', 'number', [], []);
  ok(tb === 48, `zfw_token_bytes == 48 (got ${tb}); matches the JS token layout (runner-up and run peak fields)`);
  const h1 = m.ccall('zfw_create', 'number', ['string', 'number', 'number', 'number', 'number'], ['/model/missing.onnx', 0, 1, 0, 0]);
  ok(h1 === 0, 'zfw_create returns 0 for a missing model (clean failure, no trap)');
  ok(m.UTF8ToString(m._zfw_error()).length > 0, `zfw_error explains it ("${m.UTF8ToString(m._zfw_error())}")`);
  // The evidence record the wrapper reads (src/zfw_api.c ZfwEvidence): 23 four-byte fields.
  const eb = m.ccall('zfw_evidence_record_bytes', 'number', [], []);
  ok(eb === 92, `zfw_evidence_record_bytes == 92 (got ${eb}); matches the JS evidence layout`);
  // A chunk length other than 160, 320 or 480 ms is refused before the model is read.
  const h2 = m.ccall('zfw_create2', 'number', ['string', 'number', 'number', 'number', 'number', 'number', 'number'],
    ['/model/missing.onnx', 0, 1, 0, 0, 200, 1]);
  ok(h2 === 0 && m.UTF8ToString(m._zfw_error()).includes('chunk_ms'),
    `zfw_create2 refuses chunk_ms 200 ("${m.UTF8ToString(m._zfw_error())}")`);
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall smoke checks passed');
process.exit(fails ? 1 : 0);
