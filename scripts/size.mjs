// Bundle size of what an app ships and loads, raw, gzip and brotli (what a CDN or bundler serves), and
// Node cold start: import, model open from a local folder, first chunk. The model itself is fetched
// by client.model() (see the delivery profile); none of it is in the bundle.
//   node scripts/size.mjs            (cold start: TAJWEED_MODEL_DIR=<a 3.0 model folder>, TAJWEED_MODEL_KEY=<its signing key, hex>)
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
out['engine worker JS (web/api/worker.js graph, no glue)'] = sizes(js('web/api/worker.js'));
out['engine glue dist/tajweedformer.mjs'] = sizes(['dist/tajweedformer.mjs']);
out['engine dist/tajweedformer.wasm (fetched by the first model())'] = sizes(['dist/tajweedformer.wasm']);
if (existsSync(rel('dist/tajweedformer-opus.wasm'))) out['sharing opus wasm + glue (lazy)'] = sizes(['dist/tajweedformer-opus.mjs', 'dist/tajweedformer-opus.wasm']);
console.log('size (bytes):');
for (const [k, v] of Object.entries(out)) console.log(`  ${k}: ${v.files} files, raw ${v.raw}, gzip ${v.gzip}, brotli ${v.brotli}`);

// Node cold start, from a model folder on disk
const DIR = process.env.TAJWEED_MODEL_DIR || '';
if (DIR && existsSync(path.join(DIR, 'manifest.json'))) {
  let t = performance.now();
  const { openModel } = await import(pathToFileURL(rel('web/api/model.js')).href);
  const { dirReader } = await import(pathToFileURL(rel('test/helpers/readers.mjs')).href);
  const imp = performance.now() - t;
  t = performance.now();
  const keys = process.env.TAJWEED_MODEL_KEY ? { trustedKeys: [process.env.TAJWEED_MODEL_KEY] } : {};
  const model = await openModel({ reader: Object.assign(dirReader(DIR), { fresh: true }), folder: keys });
  const open = performance.now() - t;
  const pcm = new Float32Array(16000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.1 * Math.sin(i / 7);
  t = performance.now();
  let first = null;
  const s = model.session({ onChunk: () => { if (first === null) first = performance.now() - t; } });
  s.push(pcm);
  await s.finish();
  await model.close();
  console.log(`Node ${process.versions.node} cold start: import ${imp.toFixed(0)} ms, open (verify + wasm + engine + warm) ${open.toFixed(0)} ms, first chunk ${first.toFixed(0)} ms after the first push`);
}
