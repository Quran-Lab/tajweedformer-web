// Folder layout 3 (manifest format 3, engine_format 3; contract LAYOUT.md v2): one shared
// layers.zfw and frontend.zfw, <ctx>/frames.zfw overlays, big files stored gzip. Served over HTTP as the
// CDN would, through TajweedFormer.load: only the web profile is fetched (the stored .gz bytes, checked,
// inflated, checked again, cached decoded), then V4 conformance at c16_l64 on all 35 clips (every
// output of every chunk against ONNX Runtime armv7), and a second context from the same cache.
//
// Needs the signed test folder: TAJWEED_V4_L3 and its
// test public key TAJWEED_V4_L3_PUB; skipped without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bindTajweed, memoryStore } from '../web/tajweed/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const L3 = process.env.TAJWEED_V4_L3 || '';
const PUB = process.env.TAJWEED_V4_L3_PUB || 'ebea3bcf5c3e3a62e7d72cd837ca77bc0825ab484007978658914c4963a7aa6b';
const AUDIO = process.env.TAJWEED_V4_AUDIO || '';
const have = existsSync(path.join(L3, 'manifest.json')) && existsSync(path.join(root, 'dist', 'tajweedformer.mjs')) && existsSync(AUDIO);
const OUTPUTS = ['attr_face', 'attr_ghunna', 'attr_qalqalah', 'attr_tafkheem', 'boundary', 'conf', 'gem',
  'id_log_probs', 'inter1_log_probs', 'inter4_log_probs', 'log_probs', 'timing_log_probs'];
// FNV-1a 64 from the engine's start value (as tajweed_conformance.test.mjs; not imported, so its tests do not run twice)
const H0 = [0x14650fb0, 0x739d0383];
function fnv1a64(bytes, h = H0) {
  let hi = h[0], lo = h[1];
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]) >>> 0;
    const t = lo * 0x1b3;
    hi = (Math.imul(hi, 0x1b3) + ((lo << 8) >>> 0) + Math.floor(t / 4294967296)) >>> 0;
    lo = t >>> 0;
  }
  return [hi, lo];
}
const camel = (n) => n.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const hex = ([hi, lo]) => hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
const bytesOf = (f) => new Uint8Array(f.buffer, f.byteOffset, f.byteLength);

test('layout 3 over HTTP: the web profile only, gzip transport, c16_l64 conformance 35/35, a second context from the cache', {
  skip: have ? false : `needs ${L3} (the layout 3 test folder) and the audio`, timeout: 1800000,
}, async (t) => {
  const served = [];
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    const f = path.join(L3, ...p.split('/'));
    if (!f.startsWith(L3.replace(/\//g, path.sep)) && !f.startsWith(L3) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404).end(); return; }
    const b = readFileSync(f);
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const lo = m ? +m[1] : 0, hi = m ? Math.min(+m[2], b.length - 1) : b.length - 1;
    served.push({ p, n: hi - lo + 1 });
    res.writeHead(m ? 206 : 200, m ? { 'content-range': `bytes ${lo}-${hi}/${b.length}` } : {});
    res.end(b.subarray(lo, hi + 1));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  try {
    const { default: f } = await import(pathToFileURL(path.join(root, 'dist', 'tajweedformer.mjs')).href);
    const TF = bindTajweed(f);
    const store = memoryStore();
    const t0 = Date.now();
    const tf = await TF.load({ url, requireSignature: true, trustedKeys: [PUB], cache: store, context: 'c16_l64' });
    const bytes = served.reduce((n, x) => n + x.n, 0);
    const paths = [...new Set(served.map((x) => x.p))].sort();
    t.diagnostic(`load ${Date.now() - t0} ms: ${bytes} bytes over HTTP (${paths.join(', ')}); inflated ${tf.delivery.bytesInflated} bytes`);
    assert.equal(tf.folder.manifest.format, 3);
    assert.ok(paths.every((p) => p === 'manifest.json' || p === 'tokens.txt' || p.endsWith('.gz')));
    assert.ok(!paths.some((p) => p.startsWith('npu/') || p.startsWith('c24_') || p.includes('model_engine2.onnx.gz')), 'only the web profile');
    const expected = readFileSync(path.join(root, 'test/tajweed/conformance/v4_c16_l64_audio_expected.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let chunks = [];
    const s = tf.createStream({ allHeads: true, onChunk: (h) => chunks.push(h) });
    const bad = [];
    for (const e of expected) {
      const pcmBuf = readFileSync(path.join(AUDIO, `${e.clip}.pcm`));
      const pcm = new Float32Array(pcmBuf.buffer.slice(pcmBuf.byteOffset, pcmBuf.byteOffset + pcmBuf.byteLength));
      s.reset(); chunks = [];
      for (let at = 0; at < pcm.length; at += 320) s.pushAudio(pcm.subarray(at, at + 320));
      s.finish();
      let why = null;
      if (chunks.length !== e.chunks) why = 'chunks';
      else if (JSON.stringify(s.greedy()) !== JSON.stringify(e.tokens)) why = 'tokens';
      else for (const k of OUTPUTS) if (e.out_fnv[k].some((x, i) => hex(fnv1a64(bytesOf(chunks[i][camel(k)]))) !== x)) { why = k; break; }
      if (why) bad.push(`${e.clip}: ${why}`);
    }
    s.free();
    tf.free();
    t.diagnostic(`layout 3 c16_l64: ${expected.length - bad.length}/${expected.length} clips bit-identical to ONNX Runtime armv7 (all 12 outputs, every chunk)`);
    assert.deepEqual(bad, []);
    // another context: only its three small files are new
    served.length = 0;
    const tf2 = await TF.load({ url, requireSignature: true, trustedKeys: [PUB], cache: store, context: 'c24_l72' });
    const more = [...new Set(served.map((x) => x.p))].filter((p) => p !== 'manifest.json').sort();
    t.diagnostic(`c24_l72 after c16_l64: fetched ${more.join(', ')} (${served.reduce((n, x) => n + x.n, 0)} bytes)`);
    assert.ok(more.every((p) => p.startsWith('c24_l72/')));
    const s2 = tf2.createStream();
    s2.pushAudio(new Float32Array(16000));
    s2.finish();
    s2.free();
    tf2.free();
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
