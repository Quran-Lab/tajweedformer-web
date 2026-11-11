// The model-backed proof, one command: npm run proof
//
// With a real 3.0 model folder (not in this repository: the model is gated) it runs, through the public API:
//   Node             test/conformance.test.mjs, twice: on the folder `full` and on `prod` (the shape of the
//                    production build: tokens-only self-test files, no tolerance). Each run: the 35 conformance
//                    clips in every context the expected rows cover, bit for bit (every value of all 12 outputs
//                    of every chunk), and every sample clip through listen({ from: clip }) against the folder's
//                    self-test tokens
//   headless Chrome  test/browser/proof.html: the same comparison (the same module) on `full` with the engine
//                    in a module Worker, as a page runs it (PROOF_CHROME=0 leaves it out)
// and prints clips, chunks, values compared, mismatches, wall time and peak memory for each.
//
//   TAJWEED_MODEL_30   the folder that holds full/sdk/v4.0, prod/sdk/v4.0 and local30.json (the throwaway key the
//                      folders are signed with; never Quran Lab's key, and no key of an app is used or needed)
//   TAJWEED_V4_AUDIO   the folder of <clip>.pcm (16 kHz float32)
//   CHROME             the browser's executable, when it is not in its usual place
//
// Without the two folders it says so and exits 0 (as on CI). Bounds: the Node part runs with a 2 GB heap and
// PROOF_SECONDS (default 1200) of wall time, after which its whole process tree is killed; the browser is closed
// when the page is done or after the same time. Needs dist/tajweedformer.mjs (npm run build) and, for the
// browser part, puppeteer-core (a dev dependency). Exits 1 on any mismatch or failure.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const MODELS = process.env.TAJWEED_MODEL_30 || '';
const AUDIO = process.env.TAJWEED_V4_AUDIO || '';
const SECONDS = Number(process.env.PROOF_SECONDS) || 1200;
if (!MODELS || !AUDIO || !existsSync(path.join(MODELS, 'full', 'sdk', 'v4.0', 'manifest.json')) || !existsSync(path.join(MODELS, 'local30.json')) || !existsSync(AUDIO)) {
  console.log('proof: skipped (set TAJWEED_MODEL_30 and TAJWEED_V4_AUDIO to a 3.0 model folder and the conformance audio)');
  process.exit(0);
}
if (!existsSync(path.join(root, 'dist', 'tajweedformer.mjs'))) { console.error('proof: dist/tajweedformer.mjs is missing (npm run build)'); process.exit(1); }

// a child's whole process tree
function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { child.kill('SIGKILL'); } }
}

async function nodePart(variant) {
  const child = spawn(process.execPath, ['--max-old-space-size=2048', `--test-timeout=${SECONDS * 1000}`, 'test/conformance.test.mjs'],
    { cwd: root, env: { ...process.env, REQUIRE_V4: '1', TAJWEED_MODEL_VARIANT: variant }, stdio: ['ignore', 'pipe', 'inherit'], detached: process.platform !== 'win32' });
  let text = '';
  child.stdout.on('data', (d) => { text += d; });
  const timer = setTimeout(() => { console.error(`proof: the Node part ran over ${SECONDS} s; killing its process tree`); killTree(child); }, SECONDS * 1000);
  const code = await new Promise((r) => child.on('close', r));
  clearTimeout(timer);
  const m = /PROOF node (\{.*\})/.exec(text);
  const fail = /^# fail (\d+)/m.exec(text);
  if (code !== 0) for (const l of text.split(/\r?\n/)) if (/^not ok/.test(l)) console.error(l);
  return { variant, ...(m ? JSON.parse(m[1]) : {}), failedTests: fail ? Number(fail[1]) : null, exit: code };
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.jsonl': 'text/plain' };
function serve() {
  const mounts = [['/model30/', path.resolve(MODELS)], ['/audio/', path.resolve(AUDIO)], ['/', root]];
  const server = createServer(async (req, res) => {
    try {
      const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const [prefix, base] = mounts.find(([p]) => url.startsWith(p));
      const file = path.join(base, url.slice(prefix.length));
      if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
      if (!(await stat(file)).isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(file));
    } catch (_) { res.writeHead(404).end(); }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function chromePart() {
  const usual = process.platform === 'win32' ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  if (process.env.PROOF_CHROME === '0') return { skipped: 'PROOF_CHROME=0' };
  const exe = process.env.CHROME || usual.find((p) => existsSync(p));
  if (!exe) return { skipped: 'no Chrome found (set CHROME)' };
  let puppeteer;
  try { puppeteer = (await import('puppeteer-core')).default; } catch (_) { return { skipped: 'puppeteer-core is not installed (npm install)' }; }
  const server = await serve();
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-first-run', '--disable-extensions'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)));
    await page.goto(`http://127.0.0.1:${server.address().port}/test/browser/proof.html`);
    await page.waitForFunction(() => window.__proof, { timeout: SECONDS * 1000, polling: 1000 });
    const out = await page.evaluate(() => window.__proof);
    if (errors.length && !out.error) out.error = errors.join('; ');
    out.browser = await browser.version();
    return out;
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

const line = (name, r) => `${name}: ${r.clips} clip takes (35 clips x ${r.clips / 35} contexts), ${r.chunks} chunks, ${r.values} values compared, ${r.mismatches} mismatches; `
  + `${r.sampleClips} sample clip takes through listen({ from: clip }), ${r.sampleClipMismatches} mismatches; ${r.wallS} s`;
const nodes = [];
for (const variant of existsSync(path.join(MODELS, 'prod', 'sdk', 'v4.0', 'manifest.json')) ? ['full', 'prod'] : ['full']) {
  const n = await nodePart(variant);
  console.log('PROOF node ' + JSON.stringify(n));
  nodes.push(n);
}
let chrome;
try { chrome = await chromePart(); } catch (e) { chrome = { error: String(e && e.message ? e.message : e).slice(0, 400) }; }
console.log('PROOF chrome ' + JSON.stringify(chrome));
console.log('');
const good = (node) => node.exit === 0 && node.failedTests === 0 && node.clips > 0 && node.mismatches === 0 && node.sampleClips > 0 && node.sampleClipMismatches === 0;
for (const node of nodes) {
  console.log(good(node) || node.clips ? line(`Node, ${node.variant}`, node) + `; peak memory ${node.peakRssMB} MB (resident, the test process)` : `Node, ${node.variant}: failed before the comparison`);
}
const nodeOk = nodes.every(good) && nodes.length > 0;
let chromeOk = true;
if (chrome.skipped) console.log(`Chrome: skipped, ${chrome.skipped}`);
else {
  chromeOk = !chrome.error && chrome.host === 'worker' && chrome.clips > 0 && chrome.mismatches === 0 && chrome.sampleClips > 0 && chrome.sampleClipMismatches === 0;
  console.log(chrome.clips ? line(`Chrome (${chrome.browser}, engine in a ${chrome.host})`, chrome) + `; peak JS heap of the page ${chrome.peakJsHeapMB} MB` : `Chrome: failed: ${chrome.error}`);
  if (chrome.error) console.log(`Chrome error: ${chrome.error}`);
  for (const b of chrome.bad || []) console.log(`  differs: ${b}`);
}
console.log(nodeOk && chromeOk ? 'proof: every value equal' : 'proof: FAILED');
process.exit(nodeOk && chromeOk ? 0 : 1);
