// A static dev server that sets the cross-origin isolation headers the threaded build needs
// (COOP/COEP make SharedArrayBuffer available). The single-thread build works without them, but
// serving with them costs nothing and lets the demo try either.
//
//   node scripts/serve.mjs [port] [--data <dir>]
//
// --data mounts a conformance data directory (the model files, feats/, audio/ and the expected
// .jsonl files) at /data/ for web/conformance.html.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = process.argv.slice(2);
const di = args.indexOf('--data');
const dataDir = di >= 0 ? resolve(args.splice(di, 2)[1]) : null;
const port = Number(args[0]) || 8080;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css',
  '.map': 'application/json', '.txt': 'text/plain', '.jsonl': 'text/plain',
};

createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  try {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    // a redirect, not a rewrite, so the demo's relative imports resolve under /web/
    if (path === '/' || path === '\\') { res.writeHead(302, { Location: '/internal/v3/demo.html' }).end(); return; }
    const base = dataDir && path.startsWith('/data/') ? dataDir : root;
    const file = join(base, base === root ? path : path.slice('/data'.length));
    if (!file.startsWith(base)) { res.writeHead(403).end('forbidden'); return; }
    const info = await stat(file);
    if (info.isDirectory()) { res.writeHead(403).end('directory'); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => {
  console.log(`serving ${root}`);
  console.log(`  http://localhost:${port}/  (demo, cross-origin isolated)`);
});
