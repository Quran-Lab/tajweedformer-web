// The lease's data piece and the engine_load_failed
// issue (docs/server-for-web-4.md 5). Under fix 16 the frame hands a lease answer's piece to the Core right after
// qlc_lease_accept, always; the Core keeps it pending in its saved state and puts it in force at the next model open; a
// piece is last good only once a lease asked under it was accepted and a model opened after that; a refusal while the
// piece in force is not the last good one sends the next ask back to the last good one. The frame keeps no piece of its
// own: the Core's saved state carries them across page loads (lease-store.js). An engine build that does not load is
// reported, and the previous build runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { fakeServer, vector, edSignBytes, signerPub, unb64u, b64u } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';
import { createCore, CoreError } from '../../sdk4/frame/core.js';
import { InstallKeys } from '../../sdk4/frame/keys.js';
import { loadEngine as loadHostedEngine } from '../../sdk4/frame/engine-loader.js';
import { engineIndexText } from '../../sdk4/shared/engine-index.js';
import { hex, sha256Hex, utf8 } from '../../sdk4/shared/bytes.js';

const P = vector('piece.json');
const engine = await loadEngine();
const dir = testBuild();
const skip = engine ? false : 'no packaged engine';
const skipFlow = engine && dir ? false : 'no packaged engine or test build';
const CH = 'c1.1790000300.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB';
// a Core with the grace calls is c3 or later: the piece rule of spec fix 16
const fix16 = engine ? await (async () => { const M = await engine.factory({ instantiateWasm: (i, done) => { WebAssembly.instantiate(engine.wasm, i).then((r) => done(r.instance, r.module)); return {}; } }); return typeof M._qlc_lease_grace === 'function'; })() : false;
const skipFix16 = skipFlow || (fix16 ? false : 'the engine is a Core before c3 (the piece rule before spec fix 16)');

test('piece.json through this binding: the Core takes the signed pieces and refuses the others; a piece handed over is pending, never in force before a model opens', { skip }, async () => {
  const core = await createCore({ factory: engine.factory, wasm: engine.wasm, files: new MemoryFiles(), keys: await InstallKeys.create() });
  assert.equal((await core.leaseAsk(CH, 'aa'.repeat(20))).core.piece, 0, 'no piece: 0');
  for (const c of P.pieces) core.piece(unb64u(c.b64u));
  if (fix16) assert.equal((await core.leaseAsk(CH, 'aa'.repeat(20))).core.piece, 0, 'pending: the ask is under the piece in force, none');
  const before = (await core.leaseAsk(CH, 'aa'.repeat(20))).core.piece;
  for (const c of P.refused) {
    assert.throws(() => core.piece(Buffer.from(c.bytes_hex, 'hex')), CoreError, c.name);
    assert.equal((await core.leaseAsk(CH, 'aa'.repeat(20))).core.piece, before, `${c.name}: nothing changed`);
  }
  core.destroy();
});

async function session(srv, kv, files = new MemoryFiles(), { leaseStore } = {}) {
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch, files, kv, engine,
    trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false, ...(leaseStore === false ? { leaseStore: false } : {}) });
  await c.init();
  return c;
}
const piece7 = P.pieces.find((x) => x.expect.id === 7).b64u;
const piece8 = P.server.pieces.pieces['8'].piece;
const pieceBad = b64u(Buffer.from(P.refused.find((x) => x.refused === 'signature').bytes_hex, 'hex'));
async function reopen(c) { c.closeModel(); await c.openModel(); }
// one lease request answered as planned (st.plan); a failed one is expected
async function ask(c, plan, { fails = false } = {}) {
  c.ql.config = c.ql.config || null;
  const src = await c._source(null);
  if (fails) await assert.rejects(c._lease(src)); else await c._lease(src);
}

test('contract piece_order.json "busy": a 429 or 503 reaches no Core call, the piece in force unchanged (through the frame and the c3 Core)', { skip: skipFix16 }, async () => {
  // open ask0 accept p:piece7 close open ask7 busy ask7 busy ask7 accept p:piece8 close open ask8 refuse ask7
  const V = vector('piece_order.json').sequences.find((s) => /^busy/.test(s.name));
  const srv = await fakeServer({ cdnDir: dir, turnstile: 'off' });
  const kv = new MemoryKV(), files = new MemoryFiles();
  srv.state.pieces.push(piece7);
  const c = await session(srv, kv, files);
  await c.openModel(); // ask0, accepted, piece7 handed over (pending), the open puts it in force
  await reopen(c);
  srv.state.plan.push('busy', 'busy');
  await ask(c, null, { fails: true }); // ask7, busy
  await ask(c, null, { fails: true }); // ask7, busy
  srv.state.pieces.push(piece8);
  await ask(c); // ask7, accepted, piece8 pending
  await reopen(c); // 8 in force
  srv.state.plan.push('refuse_core', 'busy');
  await ask(c, null, { fails: true }); // ask8 refused: back to the last good 7, asked once more (answered busy)
  assert.deepEqual(srv.state.askedPieces, V.asks);
  await c.close();
});

test('contract piece_order.json "a restart in the middle": the pending piece, the acceptance and a refusal come back with the Core\'s saved state', { skip: skipFix16 }, async () => {
  // ask0 accept p:piece7 restart ask0 open ask7 accept p:piece8 restart open ask8 refuse restart ask7 open ask7
  const V = vector('piece_order.json').sequences.find((s) => /restart/.test(s.name));
  const srv = await fakeServer({ cdnDir: dir, turnstile: 'off' });
  const kv = new MemoryKV(), files = new MemoryFiles();
  srv.state.pieces.push(piece7);
  let c = await session(srv, kv, files);
  await ask(c); // ask0, accepted, piece7 pending
  await c.close();
  c = await session(srv, kv, files); // restart
  srv.state.plan.push('busy');
  await ask(c, null, { fails: true }); // ask0: 7 is still pending
  await c.openModel(); // the open puts 7 in force
  srv.state.pieces.push(piece8);
  await ask(c); // ask7, accepted, piece8 pending
  await c.close();
  c = await session(srv, kv, files); // restart
  await c.openModel(); // 8 in force
  srv.state.plan.push('refuse');
  await ask(c, null, { fails: true }); // ask8, refused (not asked again): back to 7
  await c.close();
  c = await session(srv, kv, files); // restart
  srv.state.plan.push('busy', 'busy');
  await ask(c, null, { fails: true }); // ask7
  await c.openModel();
  await ask(c, null, { fails: true }); // ask7
  assert.deepEqual(srv.state.askedPieces, V.asks);
  await c.close();
});

test('a lease the Core refuses: the answer\'s piece is not handed over; a piece that does not verify changes nothing', { skip: skipFix16 }, async () => {
  const srv = await fakeServer({ cdnDir: dir, turnstile: 'off' });
  const kv = new MemoryKV();
  srv.state.pieces.push(piece7);
  const c = await session(srv, kv);
  await c.openModel(); // ask0, 7 pending, in force at the open
  srv.state.pieces.push(piece8);
  srv.state.corruptLease = true;
  await assert.rejects(c._lease(await c._source(null)), (e) => e.code === 'model_invalid' || e.code === 'engine_failed');
  srv.state.pieces.push(pieceBad);
  await c._lease(await c._source(null)); // ask7, accepted; the bad piece changes nothing
  await reopen(c);
  await c._lease(await c._source(null)); // still 7: 8 was never handed over, the bad piece never taken
  assert.deepEqual(srv.state.askedPieces, [0, 7, 7, 7]);
  const v = Object.values(c.state.get('telemetry.days'))[0].v4;
  assert.deepEqual(v.lease_failed, { other: 1 }, 'the lease the Core refused is counted');
  assert.equal(c.state.get('core.piece'), null, 'the frame keeps no piece of its own');
  await c.close();
});

// a signed engine index for two builds served from memory; one of them with a wasm that is not the signed bytes
async function engineServer({ corrupt = [], missing = [] } = {}) {
  const js = new Uint8Array(readFileSync(join(engine.dir, 'qlcore.mjs')));
  const wasm = new Uint8Array(readFileSync(join(engine.dir, 'qlcore.wasm')));
  const kid = hex(new Uint8Array(await webcrypto.subtle.digest('SHA-256', signerPub()))).slice(0, 16);
  const files = [{ name: 'qlcore.mjs', sha256: await sha256Hex(js), size: js.length }, { name: 'qlcore.wasm', sha256: await sha256Hex(wasm), size: wasm.length }];
  const index = (id) => { const text = engineIndexText({ engine: id, core: { release: '4.0.0-c1', commit: '932f419' }, files }); return { text, kid, sig: b64u(edSignBytes(utf8(text))) }; };
  const fetch = async (url) => {
    const m = /\/4\/engine\/([^/]+)\/(.+)$/.exec(url);
    if (!m || missing.includes(m[1])) return new Response('', { status: 404 });
    if (m[2] === 'index.json') return new Response(JSON.stringify(index(m[1])), { status: 200 });
    const b = m[2] === 'qlcore.mjs' ? js : wasm.slice();
    if (m[2] === 'qlcore.wasm' && corrupt.includes(m[1])) b[100] ^= 1;
    return new Response(b, { status: 200 });
  };
  return { fetch, pinned: [hex(signerPub())] };
}
const CUR = '20261114.aaaaaaaaaaaa', PREV = '20261107.bbbbbbbbbbbb';
const cfg = { web: { api: 4, engine: { current: CUR, previous: PREV } } };

test('engine_load_failed: a build that is not the signed bytes is reported, and the previous build runs', { skip: skipFlow }, async () => {
  const es = await engineServer({ corrupt: [CUR] });
  const srv = await fakeServer({ cdnDir: dir });
  const loader = () => loadHostedEngine({ base: 'https://web.test/4/engine/', config: cfg, pinned: es.pinned, fetch: es.fetch,
    importModule: async () => ({ default: engine.factory }) });
  const direct = await loader(cfg);
  assert.equal(direct.id, PREV);
  assert.equal(direct.why, 'previous');
  assert.deepEqual(direct.failures, [{ id: CUR, cause: 'sha256' }]);
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch, files: new MemoryFiles(), kv: new MemoryKV(),
    loadEngine: loader, trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false });
  const init = await c.init();
  assert.equal(init.engine.id, PREV);
  await c.ql.flush();
  const issue = srv.state.issues.find((i) => i.code && i.code.startsWith('engine_load_failed'));
  assert.ok(issue, JSON.stringify(srv.state.issues));
  assert.equal(issue.kind, 'engine_failed', 'a kind qlab-api accepts (ISSUE_KINDS)');
  assert.equal(issue.code, `engine_load_failed:${CUR}:sha256`);
  assert.match(issue.code, /^[A-Za-z0-9_.:-]{1,64}$/, 'the issue code form qlab-api accepts');
  assert.equal(issue.sdk_version, '4.0.1');
  await c.close();
});

test('engine_load_failed: when no build loads, each is reported and sent before the start fails', { skip: skipFlow }, async () => {
  const es = await engineServer({ corrupt: [CUR], missing: [PREV] });
  const srv = await fakeServer({ cdnDir: dir });
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch, files: new MemoryFiles(), kv: new MemoryKV(),
    loadEngine: () => loadHostedEngine({ base: 'https://web.test/4/engine/', config: cfg, pinned: es.pinned, fetch: es.fetch, importModule: async () => ({ default: engine.factory }) }),
    trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false });
  await assert.rejects(c.init(), (e) => e.code === 'signature_invalid');
  assert.deepEqual(srv.state.issues.map((i) => i.code).sort(), [`engine_load_failed:${CUR}:sha256`, `engine_load_failed:${PREV}:index`].sort());
});
