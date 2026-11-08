// End-to-end speed of one or more builds on real clips, interleaved so every build sees the same
// machine state: each round decodes the feature clips once per build, and the best round per build
// is reported as ms per 480 ms chunk (the engine's time only, model load excluded).
//
//   node test/bench_e2e.mjs <data dir> <threads> <rounds> <module.mjs> [<module.mjs> ...]
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dataDir, threadsArg, roundsArg, ...mods] = process.argv.slice(2);
if (!mods.length) { console.error('usage: node test/bench_e2e.mjs <data dir> <threads> <rounds> <module.mjs>...'); process.exit(2); }
const MODEL = ['model_engine2.onnx', 'model_engine2.onnx.zfg', 'model_engine2.onnx.zfg.bin', 'frontend.zfw', 'layers.zfw'];
const clips = readdirSync(join(dataDir, 'feats')).filter((f) => f.endsWith('.f32')).sort()
  .map((f) => { const b = readFileSync(join(dataDir, 'feats', f)); return new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2); });

const engines = [];
for (const path of mods) {
  const { default: create } = await import(pathToFileURL(resolve(path)).href);
  const M = await create();
  M.FS.mkdir('/model');
  for (const f of MODEL) M.FS.writeFile('/model/' + f, new Uint8Array(readFileSync(join(dataDir, f))));
  const h = M.ccall('zfw_create', 'number', ['string', 'number', 'number', 'number', 'number'],
    ['/model/model_engine2.onnx', +threadsArg, 1, 0, 0]);
  if (!h) throw new Error(`${path}: ${M.UTF8ToString(M._zfw_error())}`);
  const toks = M._malloc(M._zfw_token_bytes() * 4096);
  const bufs = clips.map((c) => { const p = M._malloc(c.byteLength); M.HEAPF32.set(c, p >> 2); return [p, c.length / 80]; });
  engines.push({ path, M, h, toks, bufs, best: Infinity });
}
function run(e) {
  const { M, h, toks, bufs } = e;
  let chunks = 0, ms = 0;
  for (const [p, frames] of bufs) {
    M._zfw_reset(h);
    const t = performance.now();
    for (let at = 0; at < frames; at += 48) M._zfw_push_frames(h, p + at * 320, Math.min(48, frames - at), toks, 4096);
    ms += performance.now() - t;
    chunks += M._zfw_chunks(h);
  }
  return ms / chunks;
}
for (const e of engines) run(e); // warm up
for (let r = 0; r < +roundsArg; ++r) for (const e of engines) e.best = Math.min(e.best, run(e));
for (const e of engines) console.log(`${e.best.toFixed(2)} ms a chunk  ${threadsArg} thread(s)  ${e.path}`);
process.exit(0);
