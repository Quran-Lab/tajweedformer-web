// Bundle size of what an app ships and loads, raw, gzip and brotli (what a CDN or bundler serves), and
// Node cold start: import, model load from a local folder, first chunk. The model itself is fetched
// lazily on load() (see the delivery profile); none of it is in the bundle.
//   node scripts/size.mjs            (cold start needs the staged V4 files, as the tests)
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const rel = (p) => path.join(root, p);
const sizes = (files) => {
  let raw = 0, gz = 0, br = 0;
  for (const f of files) {
    const b = readFileSync(rel(f));
    raw += b.length;
    gz += gzipSync(b, { level: 9 }).length;
    br += brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  }
  return { files: files.length, raw, gzip: gz, brotli: br };
};
// the static import graph of an entry (relative imports only)
function graph(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = readFileSync(rel(entry), 'utf8');
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"](\.[^'"]+)['"]/g)) {
    graph(path.posix.normalize(path.posix.join(path.posix.dirname(entry), m[1])), seen);
  }
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g)) graph(path.posix.normalize(path.posix.join(path.posix.dirname(entry), m[1])), seen);
  return seen;
}
const out = {};
const js = (e) => [...graph(e)].filter((f) => !f.startsWith('dist/'));
out['main entry JS (web/index.js graph, no glue)'] = sizes(js('web/index.js'));
out['engine glue dist/tajweedformer.mjs'] = sizes(['dist/tajweedformer.mjs']);
out['engine dist/tajweedformer.wasm (fetched on first load())'] = sizes(['dist/tajweedformer.wasm']);
out['scorer entry JS + glue'] = sizes([...js('web/scorer.js'), 'dist/tajweedformer-scorer.mjs']);
out['scorer wasm'] = sizes(['dist/tajweedformer-scorer.wasm']);
out['platform client (web/platform)'] = sizes(js('web/platform/index.js'));
out['consent (web/consent, incl. element)'] = sizes(js('web/consent/index.js'));
if (existsSync(rel('dist/tajweedformer-opus.wasm'))) out['sharing opus wasm + glue (lazy)'] = sizes(['dist/tajweedformer-opus.mjs', 'dist/tajweedformer-opus.wasm']);
console.log('size (bytes):');
for (const [k, v] of Object.entries(out)) console.log(`  ${k}: ${v.files} files, raw ${v.raw}, gzip ${v.gzip}, brotli ${v.brotli}`);

// Node cold start
const ENGINE = process.env.TAJWEED_V4_ENGINE || '';
const CAL = process.env.TAJWEED_V4_CALIBRATION || '';
const TOKENS = process.env.TAJWEED_V4_TOKENS || '';
if (existsSync(path.join(ENGINE, 'c16_l64', 'layers.zfw'))) {
  const files = { 'calibration.json': readFileSync(CAL), 'tokens.txt': readFileSync(TOKENS), 'expected_tj3.zfx': readFileSync(path.join(ENGINE, 'expected_tj3.zfx')) };
  for (const f of readdirSync(path.join(ENGINE, 'c16_l64'))) files[`c16_l64/${f}`] = readFileSync(path.join(ENGINE, 'c16_l64', f));
  const { sha256Hex } = await import(pathToFileURL(rel('web/tajweed/manifest.js')).href);
  const list = [];
  for (const [p, b] of Object.entries(files)) list.push({ path: p, size: b.length, sha256: await sha256Hex(b) });
  files['manifest.json'] = Buffer.from(JSON.stringify({ format: 2, model_id: 'v4.0', family: 'tajweedformer', revision: 'size', min_sdk_version: '2.0.0',
    engine_format: 2, coreml_format: 9, tokens_sha256: await sha256Hex(files['tokens.txt']), coreml: '-', sidecar: 'c16_l64/layers.zfw', keeps: '-',
    tokens: 'tokens.txt', files: list }));
  let t = performance.now();
  const { TajweedFormer } = await import(pathToFileURL(rel('web/index.js')).href);
  const imp = performance.now() - t;
  t = performance.now();
  const tf = await TajweedFormer.load({ files, context: 'c16_l64' });
  const load = performance.now() - t;
  const s = tf.createStream();
  t = performance.now();
  const pcm = new Float32Array(16000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.1 * Math.sin(i / 7);
  let first = null;
  for (let at = 0; at < pcm.length && first === null; at += 320) if (s.pushAudio(pcm.subarray(at, at + 320)) > 0) first = performance.now() - t;
  s.free(); tf.free();
  console.log(`Node ${process.versions.node} cold start: import ${imp.toFixed(0)} ms, load (verify + wasm + engine, files in memory) ${load.toFixed(0)} ms, first chunk after ${first.toFixed(0)} ms of compute from the first push`);
}
