// The offline grace: an expired lease keeps opening the model for up
// to 24 hours after its own exp while Quran Lab cannot be reached; a refusal ends it at once. The frame classifies each
// lease attempt that brought no lease (grace.json's 40 outcomes), tells the Core (qlc_lease_attempt), makes one attempt
// at a model open past exp and waits at most 10 s for it, lets the Core decide (qlc_lease_grace), and reports each open
// in grace (ERRORS_40: lease, grace, code none). Through the frame and the c3 test Core, with the lease kept across page
// loads (lease-store.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer, vector } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller, answerOutcome, attemptOutcome, SdkError } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';
import { PlatformError } from '../../web/platform/client.js';

const G = vector('grace.json');
const engine = await loadEngine();
const dir = testBuild();
const c3 = engine ? await (async () => { const M = await engine.factory({ instantiateWasm: (i, done) => { WebAssembly.instantiate(engine.wasm, i).then((r) => done(r.instance, r.module)); return {}; } }); return typeof M._qlc_lease_grace === 'function'; })() : false;
const skip = !engine ? 'no packaged engine' : !dir ? 'no protected test build (QL_TEST_BUILD)' : !c3 ? 'the engine is a Core before c3 (no grace)' : false;
const H = 3_600_000;

test('grace.json outcomes: the answer that ended each attempt classifies it as the contract does (40 cases)', () => {
  assert.equal(G.outcomes.length, 40);
  for (const o of G.outcomes) assert.equal(answerOutcome(o.answers.at(-1)), o.outcome, o.name);
});

test('the frame\'s errors classify as the answers do: refused only for the API\'s own 4xx refusals', () => {
  const pe = (status, code) => new PlatformError(status, code, '');
  assert.equal(attemptOutcome(pe(401, 'invalid_token')), 'refused', 'a stop or refusal on the token route');
  assert.equal(attemptOutcome(pe(403, 'http_403')), 'unreachable', 'a 403 that is not the API\'s (no error string)');
  assert.equal(attemptOutcome(pe(503, 'service_unavailable')), 'unreachable');
  assert.equal(attemptOutcome(pe(429, 'rate_limited')), 'unreachable');
  assert.equal(attemptOutcome(pe(0, 'invalid_answer')), 'unreachable');
  assert.equal(attemptOutcome(new TypeError('fetch failed')), 'unreachable');
  assert.equal(attemptOutcome(new SdkError('model_invalid', 'the lease was refused by the Core')), 'unreachable', 'a 2xx that is not a lease the Core accepts');
  assert.equal(attemptOutcome(Object.assign(new SdkError('server_rejected', ''), { attempt: 'refused' })), 'refused');
  assert.equal(attemptOutcome(Object.assign(new SdkError('invalid_key', ''), { attempt: 'stop' })), 'stop');
});

function page(srv, { kv, files, clock, attemptWaitMs } = {}) {
  return new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch, files, kv, engine,
    trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false, ...(attemptWaitMs ? { attemptWaitMs } : {}),
    clock: () => Date.now() + clock.off, coreClock: { wall: () => Date.now() + clock.off, boot: () => performance.now() } });
}
async function load(srv, o) { const c = page(srv, o); await c.init(); return c; }
// a site whose lease was taken at off 0, its files on the device; then the clock moves on
async function leased(extra = {}) {
  const clock = { off: 0 };
  const srv = await fakeServer({ cdnDir: dir, now: () => Math.floor((Date.now() + clock.off) / 1000), ...extra });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await load(srv, { kv, files, clock });
  const info = await a.openModel();
  await a.close();
  return { srv, kv, files, clock, exp: info.lease.exp };
}
async function graceReports(c, srv) {
  await c.ql.flushErrors().catch(() => {});
  return srv.state.issues.filter((i) => i.kind === 'error' && i.error && i.error.stage === 'lease' && i.error.reason === 'grace');
}

test('past exp with the lease route answering 503: the open makes one attempt, the Core opens in grace, and the open is reported', { skip }, async () => {
  const s = await leased();
  s.clock.off = 25 * H;
  s.srv.state.plan.push('busy', 'busy', 'busy');
  const b = await load(s.srv, s);
  const info = await b.openModel();
  assert.equal(info.lease.graceUntil, s.exp + 86400, 'in grace until exp + 24 h');
  assert.equal(s.srv.state.unavailableAnswers || s.srv.state.askedPieces.length - 1, 1, 'one attempt');
  const r = await graceReports(b, s.srv);
  assert.equal(r.length, 1);
  assert.equal(r[0].code, 'none');
  assert.equal(r[0].error.http_status, 503);
  assert.equal(r[0].error.error_code, 'lease_unavailable', '1c971ab: a grace after 503 lease_unavailable names it');
  // a take runs in grace
  await b.start({ context: 'c16_l64', sampleRate: 16000, heads: ['log_probs'] });
  await b.push(new Float32Array(16000));
  await b.finish();
  await b.close();
});

test('past exp with every route answering 503 (the token route ends the attempt): the grace report names the status', { skip }, async () => {
  // Stage B (production, 11-18): a 503 on the token route was reported as error_code http with no http_status
  const s = await leased();
  s.clock.off = 26 * H;
  s.srv.state.status5xx = 503;
  const b = await load(s.srv, s);
  const info = await b.openModel();
  assert.ok(info.lease.graceUntil > 0);
  s.srv.state.status5xx = 0;
  const r = await graceReports(b, s.srv);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].error.http_status, r[0].error.error_code], [503, 'http']);
  await b.close();
});

test('no lease held (a clock set back between page loads) and no answer: needs_connection, never the raw fetch failure', { skip }, async () => {
  // Stage B (production, 11-18, the Node path): the stored config is used, the lease store hands back no Core state for a
  // clock more than an hour behind, and the first attempt's TypeError reached the app as invalid_argument
  const s = await leased();
  s.clock.off = -48 * H;
  s.srv.state.offline = true;
  const b = await load(s.srv, s);
  await assert.rejects(b.openModel(), (e) => e.code === 'needs_connection' && /no lease is held/.test(e.message));
  await b.close();
  // and online again: a new lease, the model opens
  s.srv.state.offline = false;
  const c = await load(s.srv, s);
  const info = await c.openModel();
  assert.ok(info.lease.exp > 0);
  await c.close();
});

test('past exp and offline at the page load: the kept lease names the build, the attempt gets no answer, the open is in grace', { skip }, async () => {
  const s = await leased();
  s.clock.off = 30 * H;
  s.srv.state.offline = true;
  const b = await load(s.srv, s);
  const info = await b.openModel();
  assert.ok(info.lease.graceUntil > 0);
  await b.close();
});

test('a refusal ends the grace at once and for the rest of that lease, whatever comes after', { skip }, async () => {
  const s = await leased();
  s.clock.off = 25 * H;
  s.srv.state.plan.push('refuse');
  const b = await load(s.srv, s);
  await assert.rejects(b.openModel(), (e) => e.code === 'server_rejected' && e.attempt === 'refused');
  await b.close();
  // the next page: Quran Lab unreachable now, but the lease's refusal stands (kept in the Core's saved state)
  s.clock.off = 25 * H + 120_000;
  s.srv.state.offline = true;
  const c = await load(s.srv, s);
  await assert.rejects(c.openModel(), (e) => e.code === 'needs_connection');
  await c.close();
});

test('the grace ends 24 hours after exp: past it, needs_connection', { skip }, async () => {
  const s = await leased();
  s.clock.off = 49 * H; // the 24-hour lease's exp is about 24 h after it was taken; its grace ends 24 h later
  s.srv.state.offline = true;
  const b = await load(s.srv, s);
  await assert.rejects(b.openModel(), (e) => e.code === 'needs_connection');
  await b.close();
});

test('the open waits at most the attempt time: no answer by then is unreachable and the open goes on in grace; the late answer is still used', { skip }, async () => {
  const s = await leased();
  s.clock.off = 25 * H;
  let release;
  s.srv.state.hold = new Promise((r) => { release = r; });
  const b = await load(s.srv, { ...s, attemptWaitMs: 300 });
  const t0 = Date.now();
  const info = await b.openModel();
  assert.ok(Date.now() - t0 < 5000, 'not waiting for the answer');
  assert.ok(info.lease.graceUntil > 0, 'in grace');
  const leases = s.srv.state.leases;
  s.srv.state.hold = null;
  release();
  for (let i = 0; i < 500 && s.srv.state.leases === leases; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.srv.state.leases, leases + 1, 'the late answer\'s lease was taken');
  for (let i = 0; i < 500 && !(b.leaseInfo && b.leaseInfo.exp > s.exp); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(b.leaseInfo.exp > s.exp, 'the new lease is held');
  b.closeModel();
  const again = await b.openModel();
  assert.equal(again.lease.graceUntil, null, 'opened on the new lease');
  await b.close();
});

test('two opens past exp within 60 s make one attempt', { skip }, async () => {
  const s = await leased();
  s.clock.off = 25 * H;
  s.srv.state.plan.push('busy', 'busy', 'busy');
  const b = await load(s.srv, s);
  await b.openModel();
  const asked = s.srv.state.askedPieces.length;
  b.closeModel();
  await b.openModel();
  assert.equal(s.srv.state.askedPieces.length, asked, 'no second attempt within 60 s');
  await b.close();
});

test('past exp with no config at the page\'s start and the API silent at the open: the open does not wait for a config, it is in grace within the attempt time', { skip }, async () => {
  const s = await leased();
  s.clock.off = 25 * H;
  s.srv.state.offline = true; // the page's start gets no answer: no config in this page
  let silent = false;
  const srv = { ...s.srv, fetch: (url, init) => (silent ? new Promise(() => {}) : s.srv.fetch(url, init)) };
  const b = await load(srv, { ...s, attemptWaitMs: 300 });
  assert.equal(b.ql.config, null);
  silent = true; // every request now gets no byte at all (10 s per host before 4.0.1's next host)
  const t0 = Date.now();
  const info = await b.openModel();
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `the open took ${ms} ms (a config refresh first would take 10 s)`);
  assert.ok(info.lease.graceUntil > 0, 'in grace');
  b.closeModel();
  silent = false;
  s.srv.state.offline = true;
  await b.close();
});
