// SDK 4.0.2, STEERING_40.md 34.6: per models host per UTC day, the download counts (files, bytes,
// requests, unreachable, hedged and slow_switches always 0, time to first status and rate histograms), measured in the
// frame's download code (Controller._get; the Node path is the same code) and kept in the day's telemetry record from
// the first page load, and sent with the day's telemetry (qlab-api takes `hosts` on POST /v1/events from 2026-11-21; the
// switch SEND_HOSTS is on, and these tests set it per instance). The body sent is checked against
// vectors/steering_40.json `telemetry` (the accepted bodies, and none of the refused ones).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Telemetry4, hostsValid, SEND_HOSTS, HOST_TTFB_MS, HOST_KBPS } from '../../sdk4/frame/telemetry4.js';
import { Controller } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV, StateStore } from '../../sdk4/frame/stores.js';
import { ROLES } from '../../sdk4/shared/endpoints.js';

const V = JSON.parse(readFileSync(new URL('../vectors40/steering_40.json', import.meta.url), 'utf8')).telemetry;
const [C1, C2] = ROLES.models;
const KEY = 'qlk_v1_apps-one_aaaaaaaaaaaaaaaaaaaaaa';
const memState = () => { const m = new Map(); return { m, get: (k) => (m.has(k) ? structuredClone(m.get(k)) : null), set: (k, v) => { if (v === null || v === undefined) m.delete(k); else m.set(k, structuredClone(v)); } }; };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('34.6: the bucket edges are the contract\'s; the switch is on in 4.0.2, and a Telemetry4 made as the SDK makes it sends hosts', () => {
  assert.deepEqual([...HOST_TTFB_MS], V.ttfb_buckets_ms);
  assert.deepEqual([...HOST_KBPS], V.kbps_buckets);
  assert.equal(SEND_HOSTS, true, 'the server takes hosts from 2026-11-21');
  assert.equal(new Telemetry4({ state: memState(), platform: 'web', sdkVersion: '4.0.2' }).sendHosts, true);
});

test('34.6 vectors: the body check takes every accepted case and none of the refused ones', () => {
  for (const c of V.cases) assert.equal(hostsValid(c.hosts), c.accepted, c.name);
});

// a frame download set: the controller's _get on a fake clock, a Telemetry4 on memory (the switch as asked)
async function downloader(fetch, clock, { sendHosts = true } = {}) {
  const c = new Controller({ key: KEY, site: 'https://app.example', files: new MemoryFiles(), kv: new MemoryKV(), clock, download: { pausesMs: [1, 1, 1, 1, 1], stallMs: 60_000 }, endpoints: { headMs: 60_000 } });
  c.state = await StateStore.open(new MemoryKV());
  const state = memState();
  const telemetry = new Telemetry4({ state, platform: 'web', sdkVersion: '4.0.2', clock, sendHosts });
  c.ql = { modelHeaders: async () => ({}), rawFetch: fetch, noteModelServed() {}, noteModelRefusal() {}, _token: null, telemetry };
  return { c, telemetry, state };
}

// a CDN with known timings on a fake clock: `ttfb` ms to the status, then the body in 64 KiB chunks at `kBps` kB/s; a
// `cutAt` ends the body there (the connection ends); `status` other than 200 and 206 answers that, with no body
const MiB = 1024 * 1024;
function timedAnswer(now, { ttfb = 0, size = MiB, kBps = 1000, cutAt = null, from = 0, status = 200 } = {}) {
  now.t += ttfb;
  if (status !== 200 && status !== 206) return json(status, { error: 'unavailable' });
  const end = cutAt === null ? size : cutAt;
  let at = from;
  const body = new ReadableStream({
    pull(ctl) {
      if (at >= end) { if (cutAt === null) ctl.close(); else ctl.error(new TypeError('terminated')); return; }
      const n = Math.min(end - at, 64 * 1024);
      now.t += n / kBps; // ms for n bytes at kBps kB/s (bytes per ms)
      ctl.enqueue(new Uint8Array(n));
      at += n;
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: from ? 206 : 200, headers: from ? { 'content-range': `bytes ${from}-${size - 1}/${size}` } : {} });
}

const path = (f) => `/models/m/b/sdk/v4.0/c16_l64/${f}`;
const entry = (state, host) => { const d = Object.values(state.get('telemetry.days'))[0]; return d.v4.hosts[host]; };

test('34.6 counts on a stand-in CDN with known timings: a whole file, a resumed one, one failed over to the next host', async () => {
  const now = { t: Date.UTC(2026, 10, 22, 9) };
  const plan = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const step = plan.shift();
    assert.ok(step, `an answer for ${u.host}${u.pathname}`);
    assert.equal(u.host, step.host);
    const from = /^bytes=(\d+)-$/.exec(String((init.headers || {}).range || ''));
    return timedAnswer(now, { ...step.a, from: from ? Number(from[1]) : 0 });
  };
  const { c, state, telemetry } = await downloader(fetch, () => now.t);
  // a whole file: 300 ms to the status, 4 MiB at 1500 kB/s
  plan.push({ host: C1, a: { ttfb: 300, size: 4 * MiB, kBps: 1500 } });
  await c._get(`https://${C1}${path('a.qle')}`, { size: 4 * MiB });
  let e = entry(state, C1);
  assert.deepEqual([e.files, e.bytes, e.requests, e.unreachable], [1, 4 * MiB, 1, 0]);
  assert.deepEqual(e.ttfb, [0, 0, 1, 0, 0, 0, 0, 0, 0], '300 ms: the 250 to 500 bucket');
  assert.deepEqual(e.kbps, [0, 0, 0, 0, 0, 0, 1, 0, 0, 0], '1500 kB/s: the 1024 to 2048 bucket');
  // a file cut at 1 MiB (80 ms to the status, 200 kB/s), resumed (the resume goes to the next host, 28.4: C2) at 40 kB/s
  plan.push({ host: C1, a: { ttfb: 80, size: 2 * MiB, kBps: 200, cutAt: MiB } });
  plan.push({ host: C2, a: { ttfb: 2000, size: 2 * MiB, kBps: 40 } });
  await c._get(`https://${C1}${path('b.qle')}`, { size: 2 * MiB });
  e = entry(state, C1);
  assert.deepEqual([e.files, e.bytes, e.requests, e.unreachable], [1, 5 * MiB, 2, 1], 'the cut request: its bytes, and unreachable');
  assert.deepEqual(e.ttfb, [1, 0, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(e.kbps, [0, 0, 0, 1, 0, 0, 1, 0, 0, 0], 'the cut transfer (1 MiB at 200 kB/s) is rated too');
  let e2 = entry(state, C2);
  assert.deepEqual([e2.files, e2.bytes, e2.requests, e2.unreachable], [1, MiB, 1, 0], 'the last byte came from the second host');
  assert.deepEqual(e2.ttfb, [0, 0, 0, 0, 0, 1, 0, 0, 0], '2000 ms: the 1500 to 3000 bucket');
  assert.deepEqual(e2.kbps, [0, 1, 0, 0, 0, 0, 0, 0, 0, 0], '40 kB/s: the 32 to 64 bucket');
  // a 503 on the second host (now P), the file served whole by the host after it; a small file is not rated (under 256 KiB)
  const next = c.ep.roles.models.order(now.t).order.find((h) => h !== C2);
  const before = structuredClone(entry(state, next) || { files: 0, bytes: 0, requests: 0, unreachable: 0, kbps: Array(10).fill(0) });
  plan.push({ host: C2, a: { ttfb: 12_000, status: 503 } });
  plan.push({ host: next, a: { ttfb: 50, size: 100 * 1024, kBps: 5000 } });
  await c._get(`https://${C1}${path('c.qle')}`, { size: 100 * 1024 });
  e2 = entry(state, C2);
  assert.deepEqual([e2.files, e2.requests, e2.unreachable], [1, 2, 1]);
  assert.deepEqual(e2.ttfb, [0, 0, 0, 0, 0, 1, 0, 0, 1], 'over 10000 ms: the last bucket');
  const e3 = entry(state, next);
  assert.deepEqual([e3.files - before.files, e3.bytes - before.bytes, e3.requests - before.requests, e3.unreachable - before.unreachable],
    [1, 100 * 1024, 1, 0], `the file served by ${next}`);
  assert.deepEqual(e3.kbps, before.kbps, 'a transfer under 256 KiB is not rated');
  // the body it would send (the switch on here): the contract's shape, and what the vectors accept
  const body = Telemetry4.wire(Object.values(state.get('telemetry.days'))[0], new Set(), { hosts: true });
  assert.ok(hostsValid(body.hosts), JSON.stringify(body.hosts));
  assert.ok(body.hosts.every((h) => h.hedged === 0 && h.slow_switches === 0), 'no hedge, no slow switch in 4.0.2');
  assert.equal(body.hosts.reduce((n, h) => n + h.files, 0), 3, 'three files, each counted once, where its last byte came from');
  assert.equal(body.hosts.reduce((n, h) => n + h.requests, 0), 5);
  assert.equal(telemetry.sendHosts, true);
});

test('34.6: kept from the first page load; in the sealed body, valid, with the switch on; not in it with the switch off', async () => {
  const now = { t: Date.UTC(2026, 10, 22, 9) };
  for (const on of [false, true]) {
    const fetch = async () => timedAnswer(now, { ttfb: 120, size: MiB, kBps: 800 });
    const { c, state } = await downloader(fetch, () => now.t, { sendHosts: on });
    await c._get(`https://${C1}${path('a.qle')}`, { size: MiB });
    assert.equal(entry(state, C1).files, 1, 'kept in the day\'s record (the telemetry state)');
    // the next page load reads the same state
    const again = new Telemetry4({ state, platform: 'web', sdkVersion: '4.0.2', clock: () => now.t + 86_400_000, sendHosts: on });
    again.recordTake({ samples: 16000 * 5, sampleRate: 16000 }); // something else to report that day
    assert.ok(again.seal() >= 1);
    const sealed = state.get('telemetry.sealed').map((r) => JSON.parse(r.body));
    const withHosts = sealed.filter((b) => b.hosts);
    if (!on) assert.equal(withHosts.length, 0, 'off: no body carries hosts');
    else { assert.equal(withHosts.length, 1); assert.ok(hostsValid(withHosts[0].hosts)); assert.equal(withHosts[0].hosts[0].host, C1); }
  }
});

test('34.6: whatever is counted, the body is one the server takes: a host off the allow-list never counted, at most 8 hosts a day, each once', () => {
  const state = memState();
  const t = new Telemetry4({ state, platform: 'web', sdkVersion: '4.0.2', clock: () => Date.UTC(2026, 10, 22, 9), sendHosts: true });
  for (const h of ['cdn.example.com', 'evilquranlab.ai', 'CDN2.QuranLab.ai', 'cdn2.quranlab.ai', ...Array.from({ length: 9 }, (_, i) => `n${i}.quranlab.ai`)]) {
    t.recordHost(h, { requests: 1, ttfbMs: 90, bytes: 300 * 1024, transfer: { bytes: 300 * 1024, ms: 1000 }, files: 1 });
  }
  t.recordHost('cdn2.quranlab.ai', { requests: 1, bytes: -5, unreachable: 1 });
  const body = Telemetry4.wire(Object.values(state.get('telemetry.days'))[0], new Set(), { hosts: true });
  assert.ok(hostsValid(body.hosts), JSON.stringify(body.hosts));
  assert.equal(body.hosts.length, 8);
  assert.deepEqual(body.hosts[0], { role: 'models', host: 'cdn2.quranlab.ai', files: 2, bytes: 600 * 1024, requests: 3, unreachable: 1, hedged: 0, slow_switches: 0,
    ttfb_ms: [2, 0, 0, 0, 0, 0, 0, 0, 0], kbps: [0, 0, 0, 0, 2, 0, 0, 0, 0, 0] });
  assert.ok(!body.hosts.some((h) => /example|evil/.test(h.host)));
});

test('34.6 how each count is read: a host that only failed has its entry; a 429 is a request with a status, never unreachable; nothing is counted with telemetry off', async () => {
  const now = { t: Date.UTC(2026, 10, 22, 9) };
  // no answer from the first host, the second serves the file
  let first = true;
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.host === C1 && first) { first = false; now.t += 700; throw new TypeError('fetch failed'); }
    return timedAnswer(now, { ttfb: 90, size: 512 * 1024, kBps: 300 });
  };
  const { c, state } = await downloader(fetch, () => now.t);
  await c._get(`https://${C1}${path('a.qle')}`, { size: 512 * 1024 });
  assert.deepEqual(entry(state, C1), { files: 0, bytes: 0, requests: 1, unreachable: 1, ttfb: Array(9).fill(0), kbps: Array(10).fill(0) }, 'the failed host: its own entry, no status, no rate');
  assert.deepEqual([entry(state, C2).files, entry(state, C2).requests, entry(state, C2).kbps[4]], [1, 1, 1], '512 KiB at 300 kB/s: the 256 to 512 bucket');
  // a 429 (a slow down): a request with a status, not unreachable
  const slow = await downloader(async () => { now.t += 40; return json(429, { error: 'rate_limited' }); }, () => now.t);
  await slow.c._get(`https://${C1}${path('b.qle')}`, { size: 10 }).catch(() => {});
  assert.deepEqual([entry(slow.state, C1).requests, entry(slow.state, C1).unreachable, entry(slow.state, C1).ttfb[0]], [1, 0, 1]);
  // telemetry off in the signed config (Telemetry4.enabled false): nothing counted
  const off = await downloader(async () => timedAnswer(now, { ttfb: 90, size: 300 * 1024, kBps: 300 }), () => now.t);
  off.telemetry.enabled = false;
  await off.c._get(`https://${C1}${path('c.qle')}`, { size: 300 * 1024 });
  assert.equal(off.state.get('telemetry.days'), null, 'no day record, no host counted');
});
