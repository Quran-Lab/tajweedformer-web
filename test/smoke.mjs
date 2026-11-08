// Loads the built module in Node and exercises the runtime plumbing without the (gated) model:
// the WASM instantiates, ccall/FS work, the ZfToken layout is what the JS wrapper assumes, and a
// create against a missing model fails cleanly rather than trapping. Run: node test/smoke.mjs
import createZipformer from '../dist/zipformer.mjs';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails++; };

const m = await createZipformer();
ok(typeof m._malloc === 'function', 'module instantiated, _malloc present');

const tb = m.ccall('zfw_token_bytes', 'number', [], []);
ok(tb === 48, `zfw_token_bytes == 48 (got ${tb}); matches the JS token layout (runner-up and run peak fields)`);

// FS round-trip: the model staging path the wrapper relies on.
m.FS.mkdir('/model');
m.FS.writeFile('/model/probe.bin', new Uint8Array([1, 2, 3, 4]));
const back = m.FS.readFile('/model/probe.bin');
ok(back.length === 4 && back[3] === 4, 'MEMFS write/read round-trips');

// create against a graph that is not there: must return 0, not trap.
const h = m.ccall('zfw_create', 'number', ['string', 'number', 'number', 'number', 'number'], ['/model/missing.onnx', 0, 1, 0, 0]);
ok(h === 0, 'zfw_create returns 0 for a missing model (clean failure, no trap)');
ok(m.UTF8ToString(m._zfw_error()).length > 0, `zfw_error explains it ("${m.UTF8ToString(m._zfw_error())}")`);

// The evidence record the wrapper reads (src/zfw_api.c ZfwEvidence): 23 four-byte fields.
const eb = m.ccall('zfw_evidence_record_bytes', 'number', [], []);
ok(eb === 92, `zfw_evidence_record_bytes == 92 (got ${eb}); matches the JS evidence layout`);

// A chunk length other than 160, 320 or 480 ms is refused before the model is read.
const h2 = m.ccall('zfw_create2', 'number', ['string', 'number', 'number', 'number', 'number', 'number', 'number'],
  ['/model/missing.onnx', 0, 1, 0, 0, 200, 1]);
ok(h2 === 0 && m.UTF8ToString(m._zfw_error()).includes('chunk_ms'),
  `zfw_create2 refuses chunk_ms 200 ("${m.UTF8ToString(m._zfw_error())}")`);

// A malloc/HEAPF32/free cycle, the hot path the wrapper uses every push.
const p = m._malloc(16 * 4);
m.HEAPF32.set(new Float32Array([1, 2, 3, 4]), p >> 2);
ok(m.HEAPF32[p >> 2] === 1 && m.HEAPF32[(p >> 2) + 3] === 4, 'HEAPF32 view write/read works');
m._free(p);

console.log(fails ? `\n${fails} check(s) failed` : '\nall smoke checks passed');
process.exit(fails ? 1 : 0);
