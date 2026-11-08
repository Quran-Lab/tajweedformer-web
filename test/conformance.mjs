// The SDK's zf_stream_check run, on this package's WebAssembly build under Node: the same pushes and
// the same JSON lines, so test/conformance_check.mjs compares them with the conformance set bit for
// bit (every phoneme id and the FNV-1a of every chunk's log-probs).
//
//   node test/conformance.mjs <module.mjs> <data dir> <list.txt> <threads> <out.jsonl>
//        [--piece N] [--rate HZ] [--lead N] [--complete-runs] [--max-out N] [--recreate]
//        [--evidence] [--chunk-ms MS] [--model-dir DIR]
//
// <module.mjs> is a build (dist/zipformer.mjs, zipformer-mt.mjs, zipformer-scalar.mjs). <data dir>
// holds model_engine2.onnx's .zfg and .zfg.bin and the .zfw files (every such file there is staged,
// so MODEL.c160 / .c320 graphs and their overlays too); list entries are relative to it. An entry
// ending in .pcm is float32 audio (16 kHz unless --rate) pushed 10 ms at a time, then finished as
// audio; anything else is [n, 80] float32 features pushed 1, 7, 13, 3, 29 frames in turn (or
// --piece N at a time), then finished as frames. Prints ms per chunk at the end.
// --evidence sets the evidence callback and adds zf_stream_check --evidence's ev_fnv and ev_bad to
// each line; --chunk-ms asks for that step; --model-dir takes the model files from DIR instead.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_TOKENS = 4096;

const argv = process.argv.slice(2);
if (argv.length < 5) {
  console.error('usage: node test/conformance.mjs <module.mjs> <data dir> <list.txt> <threads> <out.jsonl> [--piece N] [--rate HZ] [--lead N] [--complete-runs] [--max-out N] [--recreate]');
  process.exit(2);
}
const [modPath, dataDir, listPath, threadsArg, outPath] = argv;
let piece = 0, rate = 0, lead = 1, completeRuns = 0, maxOut = -1, recreate = false;
let evidence = false, chunkMs = 0, modelDir = dataDir;
for (let i = 5; i < argv.length; ++i) {
  if (argv[i] === '--piece') piece = +argv[++i];
  else if (argv[i] === '--rate') rate = +argv[++i];
  else if (argv[i] === '--lead') lead = +argv[++i];
  else if (argv[i] === '--complete-runs') completeRuns = 1;
  else if (argv[i] === '--max-out') maxOut = +argv[++i];
  else if (argv[i] === '--recreate') recreate = true;
  else if (argv[i] === '--evidence') evidence = true;
  else if (argv[i] === '--chunk-ms') chunkMs = +argv[++i];
  else if (argv[i] === '--model-dir') modelDir = argv[++i];
  else { console.error(`unknown option ${argv[i]}`); process.exit(2); }
}

const { default: createZipformer } = await import(pathToFileURL(resolve(modPath)).href);
const M = await createZipformer();
M.FS.mkdir('/model');
for (const f of readdirSync(modelDir).filter((f) => /\.(zfg|zfg\.bin|zfw)$/.test(f)))
  M.FS.writeFile('/model/' + f, new Uint8Array(readFileSync(join(modelDir, f))));
const EV_FINGERPRINT = 2; // src/zfw_api.c
function create() {
  const h = M.ccall('zfw_create2', 'number', ['string', 'number', 'number', 'number', 'number', 'number', 'number'],
    ['/model/model_engine2.onnx', +threadsArg, lead, completeRuns, rate, chunkMs, evidence ? EV_FINGERPRINT : 0]);
  if (!h) throw new Error(M.UTF8ToString(M._zfw_error()));
  return h;
}

const TOK = M._zfw_token_bytes();
const toks = M._malloc(TOK * MAX_TOKENS);
const room = (n) => { const left = MAX_TOKENS - n; return maxOut >= 0 && maxOut < left ? maxOut : left; };

const t0 = performance.now();
let h = create();
const tCreate = performance.now() - t0;
const lines = [];
let totalChunks = 0, engineMs = 0;
const clips = readFileSync(listPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
for (const clip of clips) {
  const buf = readFileSync(resolve(dataDir, clip));
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
  if (recreate) { M._zfw_destroy(h); h = create(); } else M._zfw_reset(h);
  const p = M._malloc(data.byteLength);
  M.HEAPF32.set(data, p >> 2);
  let n = 0;
  const step = (got, what) => { if (got < 0) throw new Error(`${what} failed on ${clip}`); n += got; };
  const ts = performance.now();
  if (clip.endsWith('.pcm')) {
    const tenMs = (rate || 16000) / 100;
    for (let at = 0; at < data.length; at += tenMs)
      step(M._zfw_push_audio(h, p + at * 4, Math.min(tenMs, data.length - at), toks + n * TOK, room(n)), 'audio push');
    step(M._zfw_finish_audio(h, toks + n * TOK, room(n)), 'finish');
  } else {
    const pattern = [1, 7, 13, 3, 29];
    const frames = data.length / 80;
    for (let at = 0, k = 0; at < frames;) {
      let m = piece > 0 ? piece : pattern[k++ % 5];
      if (m > frames - at) m = frames - at;
      step(M._zfw_push_frames(h, p + at * 320, m, toks + n * TOK, room(n)), 'push');
      at += m;
    }
    step(M._zfw_finish_frames(h, toks + n * TOK, MAX_TOKENS - n), 'finish');
  }
  step(M._zfw_read(h, toks + n * TOK, MAX_TOKENS - n), 'read');
  engineMs += performance.now() - ts;
  M._free(p);
  const chunks = M._zfw_chunks(h);
  totalChunks += chunks;
  const ids = [];
  for (let t = 0; t < n; ++t) ids.push(M.HEAP32[(toks + t * TOK) >> 2]);
  const ev = evidence ? `, "ev_fnv": "${M.UTF8ToString(M._zfw_evidence_fnv(h))}", "ev_bad": ${M._zfw_evidence_bad(h)}` : '';
  lines.push(`{"features": "${clip}", "chunks": ${chunks}, "tokens": [${ids.join(', ')}], "logp_fnv": "${M.UTF8ToString(M._zfw_logp_fnv(h))}"${ev}}`);
}
writeFileSync(outPath, lines.join('\n') + '\n');
console.error(`${clips.length} clips, ${totalChunks} chunks, ${(engineMs / totalChunks).toFixed(2)} ms a chunk (${threadsArg} threads), stream created in ${tCreate.toFixed(0)} ms`);
M._zfw_destroy(h);
process.exit(0);
