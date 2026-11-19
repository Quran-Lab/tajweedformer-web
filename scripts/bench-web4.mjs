// Open time and per-chunk time of SDK 4.0's engine Worker code under Node (the real Core, one thread, the fake API
// and CDN in memory, a protected TEST build):
//   install    the first model of a site: lease, ciphertext from memory, the Core's install (CDN to device form)
//   session    a new page session on a site that has the files: install keys, attest, config, lease, open, warm
//   open       qlc_model_open of the installed device forms (decrypt with ChaCha20 into the heap) and one warm chunk
//   chunk      the Core's compute per 320 ms chunk over a clip (16 kHz float32), R takes
//
//   QL_TEST_BUILD=<sdk/v4.0> node scripts/bench-web4.mjs <clip.f32> [takes]
import { readFileSync } from 'node:fs';
import { fakeServer } from '../test/v4/helpers/fake-api.mjs';
import { loadEngine, testBuild } from '../test/v4/helpers/env.mjs';
import { Controller } from '../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../sdk4/frame/stores.js';

const clipPath = process.argv[2];
const takes = Number(process.argv[3] || 3);
const b = readFileSync(clipPath);
const clip = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const engine = await loadEngine();
const srv = await fakeServer({ cdnDir: testBuild() });
const files = new MemoryFiles(), kv = new MemoryKV();
const mk = () => new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch,
  files, kv, engine, trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false });
const ms = (t) => Math.round((performance.now() - t) * 10) / 10;

let t = performance.now();
const a = mk(); await a.init(); const first = await a.openModel();
const install = ms(t);
await a.close();
t = performance.now();
const c = mk(); await c.init(); await c.openModel();
const session = ms(t);
const opens = [];
for (let i = 0; i < 3; i++) { c.closeModel(); c.model = null; t = performance.now(); await c.openModel(); opens.push(ms(t)); }
const chunk = [];
for (let r = 0; r < takes; r++) {
  await c.start({ context: 'c16_l64', sampleRate: 16000, heads: ['log_probs', 'timing_log_probs', 'conf'] });
  let n = 0, sum = 0;
  for (let i = 0; i < clip.length; i += 1600) { const x = await c.push(clip.slice(i, i + 1600)); if (x.chunks.length) { n += x.chunks.length; sum += x.computeMs; } }
  await c.finish();
  chunk.push(Math.round((sum / n) * 100) / 100);
}
await c.close();
console.log(JSON.stringify({ sdk: '4.0.0', core: c.core.version, install_ms: install, install_core_ms: first.installMs, session_ms: session,
  open_ms: opens, chunk_ms_mean_per_take: chunk, chunks_per_take: Math.round(clip.length / 5120) }));
