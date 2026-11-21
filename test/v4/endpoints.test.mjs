// ENDPOINTS_40.md (section 28, SDK 4.0.1) replayed on the SDK's own code: vectors/endpoints_40.json's limits, hosts,
// config_lists, requests and attempts through sdk4/shared/endpoints.js (the order and the classes on a fake clock, each
// host answered by a stand-in of the vector's answer), with the routes' own checks: the config's signature
// (web/platform/client.js configAccept), a JSON route's field (acceptJson). The answers, the bases and the downloads go
// through the frame's download code and the platform client in endpoints_replay.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES, SUFFIXES, CONFIG_ROLES, HEAD_MS, PROBE_MS, LOADER_SWITCH_MS, FRAME_SWITCH_MS, FRAME_TIMEOUT_MS, MAX_CONFIG_HOSTS,
  hostAllowed, roleList, baseParts, Endpoints } from '../../sdk4/shared/endpoints.js';
import { configAccept, acceptJson } from '../../web/platform/client.js';
import { answerOutcome, PAUSES_MS } from '../../sdk4/frame/controller.js';
import { hostsFetch, TRUSTED } from './helpers/vector-answers.mjs';

const V = JSON.parse(readFileSync(new URL('../vectors40/endpoints_40.json', import.meta.url), 'utf8'));
const CONTRACT = process.env.QL_CONTRACT;

test('the vector copy is the contract\'s, byte for byte (when QL_CONTRACT is set)', { skip: !CONTRACT || !existsSync(join(String(CONTRACT), 'vectors', 'endpoints_40.json')) }, () => {
  assert.equal(readFileSync(new URL('../vectors40/endpoints_40.json', import.meta.url), 'utf8'), readFileSync(join(CONTRACT, 'vectors', 'endpoints_40.json'), 'utf8'));
});

test('roles, suffixes and limits (28.1, 28.3, 28.6)', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(ROLES)), V.roles);
  assert.deepEqual([...CONFIG_ROLES], V.config_roles);
  assert.deepEqual([...SUFFIXES], V.suffixes);
  const l = V.limits;
  assert.equal(HEAD_MS, l.head_s * 1000);
  assert.equal(PROBE_MS, l.probe_s * 1000);
  assert.equal(LOADER_SWITCH_MS, l.loader_switch_s * 1000);
  assert.equal(FRAME_SWITCH_MS, l.frame_switch_s * 1000);
  assert.equal(FRAME_TIMEOUT_MS, l.frame_timeout_s * 1000);
  assert.equal(MAX_CONFIG_HOSTS, l.max_config_hosts);
  assert.deepEqual([...PAUSES_MS], l.pauses.map((s) => s * 1000));
  assert.equal(PAUSES_MS.length, l.resumes);
  assert.deepEqual(V.web_frame_schedule, ROLES.web_frame.map((host, i) => ({ at_s: (i * FRAME_SWITCH_MS) / 1000, host })));
});

test('hosts: the allow-list (28.1)', () => {
  for (const c of V.hosts) assert.equal(hostAllowed(c.host), c.allowed, c.host);
});

test('config_lists: a config reorders, disables and adds allowed hosts, at most 8, only while in force (28.2)', () => {
  for (const c of V.config_lists) {
    for (const r of CONFIG_ROLES) assert.deepEqual(roleList(r, c.endpoints, c.in_force), c.lists[r], `${c.name}: ${r}`);
    assert.deepEqual(roleList('web_frame', c.endpoints, c.in_force), [...ROLES.web_frame], c.name);
    // and through the endpoint set the SDK uses
    const ep = new Endpoints();
    ep.useConfig(c.endpoints, c.in_force);
    for (const r of CONFIG_ROLES) assert.deepEqual(ep.roles[r].hosts, c.lists[r], `${c.name}: Endpoints ${r}`);
    assert.deepEqual(ep.roles.web_frame.hosts, [...ROLES.web_frame]);
  }
});

test('bases: accepted, refused, and the host and path (28.4)', () => {
  for (const c of V.bases) {
    const p = baseParts(c.base);
    assert.equal(!!p, c.accepted, c.name);
    if (p) assert.deepEqual(p, { host: c.host, path: c.path }, c.name);
    assert.equal(!!new Endpoints().baseOf(c.base), c.accepted, `${c.name}: Endpoints.baseOf`);
  }
});

// the route's own check of a 2xx, as the SDK makes it
const acceptFor = (route) => (route === 'config' ? configAccept(TRUSTED, () => Date.now())
  : route === 'token' || route === 'attest' ? acceptJson('token') : route === 'challenge' ? acceptJson('challenge') : route === 'register' ? acceptJson()
    // the Core stands in for the lease route: it accepts the lease the vector says it accepts
    : route === 'model-key' ? async (res) => { try { const j = await res.json(); return j.core === 'accepted' ? j : null; } catch (_) { return null; } } : null);

// one request on `ep`: what the vector's step names (the hosts asked, the class, the host that ended it, fallback, probe)
async function one(ep, role, step, route) {
  const h = hostsFetch(step.answers, route);
  let got;
  try { got = await ep.request(role, '/v1/x', {}, { fetch: h.fetch, accept: acceptFor(route), notModified: route === 'config', stage: 'config' }); } catch (e) {
    got = { cls: 'unreachable', host: null, fallback: e.qlFallback, probe: e.qlProbe };
  }
  return { asked: h.asked, class: got.cls, by: got.cls === 'unreachable' ? null : got.host, fallback: got.fallback, probe: got.probe, got };
}

for (const seq of V.requests) {
  test(`requests: ${seq.name}`, async () => {
    let now = 0;
    const ep = new Endpoints({ clock: () => now, headMs: 40 });
    assert.deepEqual(ep.roles[seq.role].hosts, seq.hosts);
    for (const s of seq.steps) {
      if (s.list) { ep.useConfig({ [seq.role]: s.list }, true); assert.equal(ep.roles[seq.role].p, s.p_after); continue; }
      now = s.at * 1000;
      const r = await one(ep, seq.role, s, s.route);
      for (const k of ['asked', 'class', 'by', 'fallback', 'probe']) assert.deepEqual(r[k], s[k], `at ${s.at}: ${k}`);
      assert.equal(ep.roles[seq.role].p, s.p_after, `at ${s.at}: P`);
    }
  });
}

for (const at of V.attempts) {
  test(`attempts: ${at.name}`, async () => {
    const ep = new Endpoints({ clock: () => 0, headMs: 40 });
    let ended = null, last = null;
    for (const r of at.requests) {
      last = await one(ep, 'api', r, r.route);
      for (const k of ['asked', 'class', 'by', 'fallback']) assert.deepEqual(last[k], r[k], `${r.route}: ${k}`);
      ended = last.by ? { ...r.answers[last.by], route: r.route } : { answer: 'none', route: r.route };
    }
    // the answer the attempt ended on, read by 18.4.7.1's table (the frame's own reading); the Core's stop stands in
    const outcome = answerOutcome(ended);
    assert.equal(outcome, at.outcome);
    const ra = last.got.cls === 'slow_down' || last.got.cls === 'unreachable' ? (last.got.retryAfter ?? null) : null;
    assert.equal(ra, at.retry_after);
  });
}

test('one page, one sticky host per role (28.3): share and adopt carry P and its age between the page\'s endpoint sets', async () => {
  let fnow = 1_000_000;
  const frame = new Endpoints({ clock: () => fnow, headMs: 40 });
  let pnow = 7_000_000; // the page's own clock (another realm: never compared with the frame's)
  const page = new Endpoints({ clock: () => pnow, headMs: 40 });
  const told = [];
  frame.onChange = () => told.push(frame.share());
  const fetch = async (url) => {
    if (new URL(url).host === ROLES.api[0]) throw new TypeError('fetch failed');
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // the frame finds the first api host unreachable: the backup answers, P moves, the page is told once
  await frame.request('api', '/v1/config', {}, { fetch });
  assert.equal(frame.roles.api.p, ROLES.api[1]);
  assert.equal(told.length, 1);
  assert.deepEqual(told[0].api, { hosts: [...ROLES.api], p: ROLES.api[1], age: 0 });
  assert.deepEqual(told[0].models, { hosts: [...ROLES.models], p: ROLES.models[0], age: null });
  // a second answer from the same host moves nothing and tells nothing
  await frame.request('api', '/v1/config', {}, { fetch });
  assert.equal(told.length, 1);
  // the page takes it 2 s later by the frame's clock: its own probe back comes when the frame's does (the age, not a time)
  fnow += 2000; pnow += 2000;
  const st = frame.share();
  assert.equal(st.api.age, 2000);
  const pageTold = [];
  page.onChange = () => pageTold.push(1);
  assert.equal(page.adopt(st), true);
  assert.equal(page.roles.api.p, ROLES.api[1]);
  assert.equal(page.roles.api.since, pnow - 2000);
  assert.equal(pageTold.length, 0, 'an adopted P is never told back (no echo)');
  assert.equal(page.roles.api.order(pnow - 2000 + PROBE_MS - 1).probe, false);
  assert.equal(page.roles.api.order(pnow - 2000 + PROBE_MS).probe, true);
  assert.equal(page.roles.models.p, ROLES.models[0], 'the models P stays the first host');
  // a state for another list in force, or a host not in the list, changes nothing; the first host has no time
  assert.equal(page.adopt({ api: { hosts: [ROLES.api[1], ROLES.api[0]], p: ROLES.api[0], age: 0 } }), false);
  assert.equal(page.adopt({ api: { hosts: [...ROLES.api], p: 'api.example.com', age: 0 } }), false);
  assert.equal(page.adopt(null), false);
  assert.equal(page.roles.api.p, ROLES.api[1]);
  assert.equal(page.adopt({ api: { hosts: [...ROLES.api], p: ROLES.api[0], age: null } }), true);
  assert.deepEqual([page.roles.api.p, page.roles.api.since], [ROLES.api[0], null]);
  // a list change by a config (28.2) starts again at the new first host and tells nothing
  frame.useConfig({ api: [ROLES.api[1], ROLES.api[0]] }, true);
  assert.equal(frame.roles.api.p, ROLES.api[1]);
  assert.equal(told.length, 1);
});
