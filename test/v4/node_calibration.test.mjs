// model.calibration and model.sampleClips through the Node SDK (sdk4/node, TajweedClient) when the build stores them as
// production's builds do: calibration.json.gz and a gzip self-test set (fakeServer plainGzip). 4.0.2 gave null and []
// there (developer report fb_f5da03d55e58a8ea, 11-23); test builds store the calibration plain, so no test saw it.
// Against the fake API and CDN on a local port (test keys only) and the c1 test engine; nothing reaches Quran Lab.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeServer, PLAIN_CLIP } from './helpers/fake-api.mjs';
import { ROOT, testBuild } from './helpers/env.mjs';
import { TajweedClient } from '../../sdk4/node/index.js';

process.env.QL_NODE_TEST = '1';
const dir = testBuild();
const LATEST = path.join(ROOT, 'dist', 'engine', 'LATEST');
const ENGINE_ID = fs.existsSync(LATEST) ? fs.readFileSync(LATEST, 'utf8').trim() : null;
const ENGINES = path.join(ROOT, 'dist', 'engine');
const skip = !ENGINE_ID ? 'no packaged engine (python scripts/build_web4.py engine --test-key)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;
const TMP = process.env.QL_TMP || os.tmpdir();
const sha = (s) => createHash('sha256').update(s).digest('hex');

let srv = null, API = null, server = null, storage = null;
const clients = [];
before(async () => {
  if (skip) return;
  server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const m = /^\/4\/engine\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const p = path.join(ENGINES, m[1], m[2]);
      if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200); res.end(fs.readFileSync(p)); return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let r;
    try { r = await srv.fetch(`${API}${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined }); } catch (_) { req.socket.destroy(); return; }
    const h = {};
    r.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(r.status, h);
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  API = `http://127.0.0.1:${server.address().port}`;
  srv = await fakeServer({ cdnDir: dir, cdnBase: `${API}/models`, engineId: ENGINE_ID, turnstile: 'required', plainGzip: true });
  storage = fs.mkdtempSync(path.join(TMP, 'qlnode-cal-'));
});
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  if (server) server.close();
  if (storage) { try { fs.rmSync(storage, { recursive: true, force: true }); } catch (_) { /* a file still held */ } }
});

const create = async () => {
  const c = await TajweedClient.create({ key: srv.apiKey, appId: 'org.example.live', storage,
    _test: { apiUrl: API, modelsUrl: `${API}/models`, pins: [srv.trustedKey], engineBase: `${API}/4/engine/`, builtIn: ENGINE_ID, machineId: 'machine-A' } });
  clients.push(c);
  return c;
};

test('Node: a build that stores the calibration and the self-test set gzip gives model.calibration (its signed sha256) and model.sampleClips; a sample clip plays', { skip }, async () => {
  const entry = srv.manifest.files.find((f) => f.role === 'calibration');
  assert.deepEqual([entry.path, entry.encoding, entry.decoded.path], ['calibration.json.gz', 'gzip', 'calibration.json'], 'the build stores it as production does');
  for (const run of ['first run (install)', 'next run (the kept files)']) {
    const c = await create();
    const model = await c.model();
    assert.ok(model.calibration, `${run}: model.calibration is there`);
    assert.equal(model.calibration.sha256, entry.decoded.sha256, `${run}: the signed calibration.json's sha256`);
    assert.equal(sha(model.calibration.text), entry.decoded.sha256, `${run}: its text is the signed bytes`);
    assert.ok(model.sampleClips.length > 0, `${run}: model.sampleClips is not empty`);
    assert.deepEqual(model.sampleClips.map((x) => [x.name, x.kind, x.durationMs]), [[PLAIN_CLIP.id, PLAIN_CLIP.kind, 500]], run);
    const s = await model.listen({ from: model.sampleClips[0], pace: 'fast', heads: ['log_probs'] });
    for await (const ch of s.chunks) void ch;
    const heads = await s.finish();
    assert.ok(heads.get('log_probs').frames > 0, `${run}: the clip's take has frames`);
    await c.close();
  }
});
