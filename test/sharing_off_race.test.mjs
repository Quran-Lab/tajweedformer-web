// Sharing turned off, or "delete what I shared", while a recording is being uploaded (SDK 3.0.1; SPEC 11.7 and
// the shared vector test/vectors30/sharing_off.json, whose case names and assertion keys this file uses). Until
// 3.0.0 the web outbox could write a session's state, and send a segment, after the learner had turned sharing
// off: a request to Quran Lab's API that was in flight could not be aborted, and the pass went on with its answer.
//
// The rules: R1 after the off call no byte of audio leaves the device, whatever was in flight; R2 the call
// returns within 3000 ms even when a request hangs; R3 nothing unsent is left on the device, also after the held
// request came back; R4 turning sharing on again afterwards works in the same run. And the delete rule: the
// queue stands still before the server is asked; an accepted delete turns sharing off; a delete the server does
// not take changes nothing.
//
// The queue is a real folder (dirStorage in a temporary directory), the server a stub that HOLDS one request in
// flight: a segment PUT to storage, or a call to Quran Lab's API (the start of an upload, a batch of URLs, the
// take list). On the web the outbox runs on the page's own thread (the engine's Worker has no part in uploads):
// the request in flight is what is "inside" a session when the learner turns sharing off. This file drives the
// sharing pipeline (web/sharing); what the learner's switch and the contributor do after a delete is in
// test/sharing_consent_persist.test.mjs. Extra cases of this SDK, beyond the vector's: the app's token callback
// never answers; sharing turned on again while the off call is still at work; a read, and a write, of the queue's
// storage that does not come back (what the SDK cannot abort).
//
// Many runs in a row: RACE_RUNS=20 node test/sharing_off_race.test.mjs
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharing, loadOpus, dirStorage, segmentName } from '../web/sharing/index.js';
import * as outboxModule from '../web/sharing/outbox.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const vector = JSON.parse(readFileSync(path.join(root, 'test', 'vectors30', 'sharing_off.json'), 'utf8'));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const opus = have ? await loadOpus() : null;
const RUNS = Math.max(1, Number(process.env.RACE_RUNS) || 1);
const BOUND = vector.off_bound_ms;
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));
const UPLOAD = ['put', 'start', 'urls', 'takes']; // the requests that carry or announce a recording

test('sharing_off.json: twelve situations, 20 runs each, a bound of 3000 ms; the SDK waits that long for a pass and no longer', () => {
  assert.deepEqual([vector.cases.length, vector.runs, vector.off_bound_ms], [12, 20, 3000]);
  // (the constant came with the fix: on the released 3.0.0 code this is the one check that fails by name)
  assert.equal(outboxModule.STOP_WAIT_MS, vector.off_bound_ms);
});

// Quran Lab's API and the storage as one fetch. `hold`: the kind of request that is held in flight (the first
// of that kind) until it is let go; an abort ends it as fetch does. `refuse`: the delete is answered with an
// error. Every request notes the phase it STARTED in ('on': before the call; 'called': the call was made;
// 'answered': the server answered the delete; 'on-again': the learner turned sharing on again), which recording
// it belongs to, how many bytes of audio it carried and whether it was completed.
function stubServer({ hold = null, batch = 20, refuse = false } = {}) {
  const s = { seen: [], held: null, phase: 'on', objects: 0, stored: new Set() };
  const res = (status, obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status });
  const urls = (id, from) => ({ id, urls: Array.from({ length: batch }, (_, i) => from + i).map((n) => ({ n, expires_at: Math.floor(Date.now() / 1000) + 604800,
    url: `https://r2.test/v1/${id}/${segmentName(n)}.opus?X-Amz-Signature=s${n}` })) });
  s.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const kind = u.host === 'r2.test' ? 'put' : u.pathname === '/v1/uploads' ? 'start' : /\/urls$/.test(u.pathname) ? 'urls' : /\/takes$/.test(u.pathname) ? 'takes' : 'other';
    const id = kind === 'start' ? (init.headers || {})['x-qlab-id'] : (/([0-9a-f]{32})/.exec(u.pathname) || [])[1] || null;
    const entry = { kind, id, phase: s.phase, audioBytes: kind === 'put' && init.body ? init.body.length : 0, done: false, donePhase: null,
      contributor: kind === 'start' ? JSON.parse(init.body).contributor : null };
    s.seen.push(entry);
    if (kind === hold && !s.held) {
      await new Promise((resolve, reject) => {
        s.held = { resolve, id };
        if (init.signal) init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    entry.done = true;
    entry.donePhase = s.phase;
    if (kind === 'start') return res(201, urls(id, 1));
    if (kind === 'urls') return res(200, urls(id, Number(u.searchParams.get('from'))));
    if (kind === 'takes') return res(200, { ok: true });
    if (kind === 'put') { s.objects++; s.stored.add(`${id}/${u.pathname.split('/').pop()}`); return res(200, ''); }
    if (u.pathname === '/v1/contributions/challenge') return res(200, { nonce: 'd1.1790000000.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB', expires_in: 300 });
    if (u.pathname === '/v1/contributions/delete') {
      if (s.phase === 'called') s.phase = 'answered';
      return refuse ? res(503, { error: 'unavailable' }) : res(202, { ok: true });
    }
    return res(404, { error: 'not_found' });
  };
  return s;
}

// What of the queue is unsent on disk. A recording that is not uploaded: every file of it (audio, state, the
// item). One that was uploaded while sharing was on keeps its item, session JSON and markers: of it only audio
// or a take list that still waits counts.
function unsentOnDisk(dir) {
  const box = path.join(dir, 'outbox');
  if (!existsSync(box)) return [];
  const out = [];
  for (const id of readdirSync(box)) {
    let item = null;
    try { item = JSON.parse(readFileSync(path.join(box, id, 'item.json'), 'utf8')); } catch (_) { item = null; }
    const uploaded = item && item.state === 'uploaded';
    // (a temporary name is a write that did not end: it counts wherever it is)
    for (const f of readdirSync(path.join(box, id))) if (!uploaded || f.endsWith('.opus') || f === 'takes.json' || f.endsWith('.tmp')) out.push(`${id.slice(0, 6)}/${f}`);
  }
  return out.sort();
}

// The files of the 12 s recording at the moment the learner acts, by what is held: nothing of it uploaded yet;
// its first segment uploaded (the URLs of the second are asked for); all of it uploaded and its take list
// on the way. A write of the SDK is atomic (a temporary name beside the file, renamed onto it): no such name
// may be left when the writes have settled.
const WHOLE = ['capture.json', 'end.json', 'item.json', 'seg-00001.json', 'seg-00001.opus', 'seg-00002.json', 'seg-00002.opus', 'session.json'];
const EXPECTED_FILES = { put: WHOLE, start: WHOLE, token: WHOLE, storage: WHOLE, write: WHOLE,
  urls: WHOLE.filter((f) => f !== 'seg-00001.opus'),
  takes: ['end.json', 'item.json', 'seg-00001.json', 'seg-00002.json', 'session.json', 'takes.json'] };

// The names in a recording's folder once they stand still (the same in five looks 2 ms apart, 2 s at most).
async function settledNames(folder) {
  let last = null;
  for (let i = 0, same = 0; i < 1000 && same < 5; i++) {
    const now = (existsSync(folder) ? readdirSync(folder) : []).sort().join(' ');
    same = now === last ? same + 1 : 0;
    last = now;
    await tick(2);
  }
  return last;
}

async function record(sharing, seconds, takes = 1) {
  const block = Float32Array.from({ length: 16000 }, (_, i) => 0.2 * Math.sin(i / 7));
  for (let k = 0; k < takes; k++) {
    const s = await sharing.startSession({ inputSampleRate: 16000, inputRoute: 'built_in', decode: { backend: 'exact', modelRevision: '4.0.0' } });
    for (let i = 0; i < seconds / takes; i++) s.push(block);
    await s.finish();
  }
  await sharing.closeRecording();
}

// One run of one situation. `held`: 'put', 'start', 'urls', 'takes' (the stub holds that request), or the extras
// 'token' (the app's token callback never answers), 'storage' (a read of the queue's folder does not come
// back) and 'write' (a write of the recording's state does not come back); `action`: 'off', 'delete' (the server accepts) or 'delete_refused'; `then`: 'on' (sharing on again as
// soon as the call returned) or 'on-during' (on again while the call is at work). Returns the failed assertion
// keys, with what was seen.
async function run({ held, action, then = null, bound = BOUND }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-off-race-'));
  const refused = action === 'delete_refused';
  const server = stubServer({ hold: held, batch: held === 'urls' ? 1 : 20, refuse: refused });
  const state = { on: true };
  const stuck = { token: false, storage: false, armed: false, release: () => {} };
  // 'storage', 'write': uploads wait for the token until the recording is whole, so the call that is held is
  // one of the upload pass and not one of the capture that writes the recording
  let openGate = () => {};
  const gate = held === 'storage' || held === 'write' ? new Promise((r) => { openGate = r; }) : null;
  const failed = [];
  const check = (key, ok, seen = '') => { if (!ok) failed.push(seen ? `${key} (${seen})` : key); };
  failed.audioAfter = null; // bytes of audio that left after the call (null where the queue is to go on)
  // a wait for the SDK with a bound: what never comes back fails the run under `what`, and the run goes on
  const within = async (p, what, ms = bound + 2000) => {
    const ok = await Promise.race([Promise.resolve(p).then(() => true, () => true), tick(ms).then(() => false)]);
    if (!ok && what && !failed.some((f) => f.startsWith(what))) failed.push(`${what} (never came back)`);
    return ok;
  };
  try {
    const real = await dirStorage(dir);
    const hold = () => new Promise((r) => { stuck.storage = true; stuck.release = r; });
    const storage = held === 'storage' ? { ...real, read: async (id, name) => {
      if (name.endsWith('.opus') && stuck.armed && !stuck.storage) await hold();
      return real.read(id, name);
    } } : held === 'write' ? { ...real, write: async (id, name, bytes) => {
      // the pass's write of the recording's state before it asks for the upload's start
      if (name === 'item.json' && stuck.armed && !stuck.storage) await hold();
      return real.write(id, name, bytes);
    } } : real;
    const tokenProvider = async () => {
      if (gate) await gate;
      if (held === 'token' && !stuck.token) await new Promise((r) => { stuck.token = true; stuck.release = r; });
      return { token: 't', attested: false };
    };
    const sharing = await createSharing({ api: 'https://api.test', fetch: server.fetch, tokenProvider, storage,
      consentVersion: 'deck-1', contributor: 'c'.repeat(32), enabled: () => state.on, flags: () => ({ contributions: true, upload_trust: { web: 'capped' } }),
      opus: async () => opus, device: { deviceClass: 'browser', osMajor: 14 }, lifecycle: {}, log: () => {} });
    // a recording of 12 s (two segments); for the take list, two takes in a row
    await record(sharing, 12, held === 'takes' ? 2 : 1);
    const old = readdirSync(path.join(dir, 'outbox'))[0];
    stuck.armed = true;
    openGate();
    const passes = [sharing.outbox.drain({ ignoringBackoff: true }).catch(() => {})];
    const inFlight = () => (held === 'token' ? stuck.token : held === 'storage' || held === 'write' ? stuck.storage : server.held);
    for (let i = 0; i < 2000 && !inFlight(); i++) await tick(1);
    assert.equal(!!inFlight(), true, `${held} is in flight`);
    assert.equal(unsentOnDisk(dir).length > 0, true, 'the recording is in the queue on disk');
    // the files of the recording when the learner acts: the upload pass waits for what is held and the capture
    // has ended, so every write has settled. Exactly the expected names: one more, one less or a temporary
    // name that stayed fails here, by name.
    const settled = await settledNames(path.join(dir, 'outbox', old));
    assert.equal(settled, EXPECTED_FILES[held].join(' '), `the files of the recording with ${held} in flight`);
    const oldNames = settled.split(' ');
    const upload = (phases) => server.seen.filter((e) => phases.includes(e.phase) && UPLOAD.includes(e.kind));

    // the learner turns sharing off, or deletes what they shared, while that is in flight
    server.phase = 'called';
    if (action === 'off') state.on = false; // "delete what I shared" is asked for with sharing on
    let threw = null;
    const t0 = Date.now();
    const call = Promise.resolve(action === 'off' ? sharing.stop()
      : sharing.deleteShared({ app: 'web:https://app.example', sign: async () => new Uint8Array(64) }))
      .catch((e) => { threw = `${(e && e.code) || ''} ${String((e && e.message) || e).slice(0, 80)}`.trim(); });
    if (then === 'on-during') { state.on = true; passes.push(Promise.resolve(sharing.outbox.resume()).catch(() => {})); }
    passes.push(sharing.outbox.drain({ ignoringBackoff: true }).catch(() => {})); // a pass asked for meanwhile (a segment closed, a timer)
    const returned = await Promise.race([call.then(() => true), tick(bound + 500).then(() => false)]);
    const elapsed = Date.now() - t0;
    if (server.phase === 'called') server.phase = 'answered';

    if (refused) {
      // the server did not take the delete: the call reports the failure, and nothing changed
      check('returns_within_bound', returned && !!threw && elapsed <= bound, threw ? `${elapsed} ms` : 'the call did not report the failure');
      check('queue_stopped_before_the_server_is_asked', upload(['called']).length === 0, upload(['called']).map((e) => e.kind).join(' '));
      // nothing was deleted: a file of the recording that is gone is a segment the queue, which goes on at once,
      // has uploaded since (it removes a segment when the storage has it)
      const left = existsSync(path.join(dir, 'outbox', old)) ? readdirSync(path.join(dir, 'outbox', old)) : [];
      const lost = oldNames.filter((f) => !left.includes(f) && !server.stored.has(`${old}/${f}`));
      check('a_refused_delete_changes_nothing', sharing.outbox.uploadAllowed().ok && lost.length === 0,
        `sharing ${sharing.outbox.uploadAllowed().ok ? 'on' : 'off'}, gone without being uploaded: ${lost.join(' ') || 'nothing'} (before: ${oldNames.join(' ')})`);
      if (server.held) server.held.resolve();
      stuck.release();
      for (let i = 0; i < 200 && (server.objects < 2 || unsentOnDisk(dir).length); i++) { await within(sharing.outbox.drain({ ignoringBackoff: true }), null, 500); await tick(5); }
      check('queue_resumes', server.objects >= 2 && unsentOnDisk(dir).length === 0 && server.seen.some((e) => e.kind === 'put' && e.id === old && e.done),
        `${server.objects} segments went up, unsent on disk: ${unsentOnDisk(dir).join(' ') || 'nothing'}`);
      await within(Promise.all(passes), 'extra_the_upload_task_returns');
      return failed;
    }

    check('returns_within_bound', returned && !threw && elapsed <= bound, threw ? `the call failed: ${threw}` : `${returned ? elapsed : 'more than ' + elapsed} ms`);
    if (returned) check('nothing_unsent_on_device', unsentOnDisk(dir).length === 0, unsentOnDisk(dir).join(' '));
    else check('nothing_unsent_on_device', false, 'the call had not returned');
    if (action === 'delete') {
      check('queue_stopped_before_the_server_is_asked', returned && upload(['called']).length === 0, upload(['called']).map((e) => e.kind).join(' ') || 'the call had not returned');
      // off: the pipeline refuses to upload, and a take made now is not recorded at all
      const before = server.seen.length;
      await record(sharing, 3);
      check('sharing_is_off_after_an_accepted_delete', !sharing.outbox.uploadAllowed().ok && unsentOnDisk(dir).length === 0 && server.seen.length === before,
        `uploads ${sharing.outbox.uploadAllowed().ok ? 'allowed' : 'refused'}, on disk: ${unsentOnDisk(dir).join(' ') || 'nothing'}`);
    }

    if (then !== 'on') {
      // the held request is let go (it answers 200), and the upload task returns
      if (server.held) server.held.resolve();
      stuck.release();
      await within(call, 'extra_the_call_returns_after_release');
      await within(Promise.all(passes), 'extra_the_upload_task_returns');
      await tick(30);
      await within(sharing.outbox.drain({ ignoringBackoff: true }), 'extra_the_upload_task_returns');
      if (!then) check('still_nothing_after_release', unsentOnDisk(dir).length === 0, unsentOnDisk(dir).join(' '));
    }
    // what started after the call was made, and what was completed after it although it was in flight before
    const after = upload(['called', 'answered']);
    check('no_request_after', after.length === 0, after.map((e) => e.kind).join(' '));
    const rest = server.seen.filter((e) => e.kind === 'put' && e.phase === 'on' && e.done && e.donePhase !== 'on');
    const bytes = after.reduce((n, e) => n + e.audioBytes, 0) + rest.reduce((n, e) => n + e.audioBytes, 0);
    check('no_audio_after', bytes === 0, `${bytes} bytes (${after.filter((e) => e.kind === 'put').length} PUTs started after the call, ${rest.length} in flight were completed)`);
    failed.audioAfter = bytes;

    if (action === 'delete' || then) {
      // the learner turns sharing on with the switch; a recording made now is uploaded in the same run
      server.phase = 'on-again';
      state.on = true;
      if (action === 'delete') sharing.update({ contributor: 'd'.repeat(32) }); // the controller makes a new contributor after a delete
      await within(sharing.outbox.resume(), null, 500);
      const before = server.objects;
      await record(sharing, 3);
      for (let i = 0; i < 60 && server.objects === before; i++) { await within(sharing.outbox.drain({ ignoringBackoff: true }), null, 250); await tick(5); }
      const fresh = server.seen.filter((e) => e.phase === 'on-again' && e.kind === 'start');
      const went = server.objects > before && unsentOnDisk(dir).filter((f) => !f.startsWith(old.slice(0, 6))).length === 0
        && (action !== 'delete' || fresh.every((e) => e.contributor === 'd'.repeat(32)));
      check('on_again_works', went, `${server.objects - before} segments went up`);
      if (then) {
        const oldAgain = server.seen.filter((e) => e.phase === 'on-again' && e.id === old && UPLOAD.includes(e.kind)).length;
        check('the_old_recording_is_gone', oldAgain === 0 && !existsSync(path.join(dir, 'outbox', old)), `${oldAgain} requests for it, its folder ${existsSync(path.join(dir, 'outbox', old)) ? 'still there' : 'gone'}`);
      }
      if (server.held) server.held.resolve();
      await within(call, 'extra_the_call_returns_after_release');
      await within(Promise.all(passes), 'extra_the_upload_task_returns');
    }
    return failed;
  } finally {
    if (server.held) server.held.resolve();
    stuck.release();
    openGate();
    // the test's own folder: do not let a late write of a failing run stop the next run
    for (let i = 0; i < 20; i++) { try { rmSync(dir, { recursive: true, force: true }); break; } catch (_) { await tick(25); } }
  }
}

function situation(name, c, asserts) {
  test(`${name}: ${asserts.join(', ')}`, { skip, timeout: 900000 }, async () => {
    let bad = 0;
    const why = [];
    const keys = new Map();
    let audioRuns = 0, mostBytes = 0, counted = false;
    for (let i = 0; i < RUNS; i++) {
      const failed = await run(c);
      if (failed.length) { bad++; if (why.length < 3) why.push(`run ${i + 1}: ${failed.join('; ')}`); }
      for (const f of failed) { const k = f.split(' (')[0]; keys.set(k, (keys.get(k) || 0) + 1); }
      if (failed.audioAfter !== null) { counted = true; if (failed.audioAfter > 0) { audioRuns++; mostBytes = Math.max(mostBytes, failed.audioAfter); } }
    }
    const audio = counted ? ` | audio after the call in ${audioRuns} runs, at most ${mostBytes} bytes` : '';
    const tally = keys.size ? ` | failed: ${[...keys].map(([k, n]) => `${k} ${n}`).join(', ')}` : '';
    if (RUNS > 1) console.log(`RACE | ${name} | ${RUNS - bad} of ${RUNS} runs passed${audio}${tally}`);
    assert.equal(bad, 0, `${bad} of ${RUNS} runs failed: ${why.join(' || ')}`);
  });
}

// the situations of the shared vector, by its names and its assertion keys
for (const c of vector.cases) situation(c.name, { held: c.held, action: c.action, then: c.then }, c.assert.map((a) => a.split(':')[0]));

// this SDK's extras
const BASE = ['returns_within_bound', 'no_request_after', 'no_audio_after', 'nothing_unsent_on_device', 'still_nothing_after_release'];
situation('extra: the app\'s token callback never answers, off', { held: 'token', action: 'off' }, BASE);
situation('extra: the app\'s token callback never answers, delete', { held: 'token', action: 'delete' },
  [...BASE, 'queue_stopped_before_the_server_is_asked', 'sharing_is_off_after_an_accepted_delete', 'on_again_works']);
for (const held of ['put', 'start']) {
  situation(`extra: ${held} held, off, on again while the off call is at work`, { held, action: 'off', then: 'on-during' },
    ['returns_within_bound', 'no_request_after', 'no_audio_after', 'nothing_unsent_on_device', 'on_again_works', 'the_old_recording_is_gone']);
}

// What the SDK cannot abort: a call into the queue's storage that does not come back. The off call waits for
// the pass its 3 s, deletes, and returns; the pass that comes back later finds its session gone, writes nothing
// and sends nothing. (One run each: it takes the 3 s.)
// The same with a WRITE of the recording's state: when it comes back after the off call it has made the
// recording's folder anew (with its temporary name, then the file), and the SDK deletes the recording again:
// still_nothing_after_release, which counts a temporary name too.
for (const action of ['off', 'delete']) {
  test(`extra: a write of the queue's storage does not come back, ${action}: the call returns at its bound, and what the late write brings back is deleted again`,
    { skip, timeout: 120000 }, async () => {
      const t0 = Date.now();
      assert.equal((await run({ held: 'write', action, bound: BOUND + 400 })).join(' || '), '');
      assert.equal(Date.now() - t0 >= BOUND - 50, true, 'the call waited for the pass');
    });
}
for (const action of ['off', 'delete']) {
  test(`extra: a read of the queue's storage does not come back, ${action}: the call returns at its bound, and the late pass writes and sends nothing`,
    { skip, timeout: 120000 }, async () => {
      const t0 = Date.now();
      // (the measured time includes the delete itself: allow the bound and the time of a few file removals)
      assert.equal((await run({ held: 'storage', action, bound: BOUND + 400 })).join(' || '), '');
      assert.equal(Date.now() - t0 >= BOUND - 50, true, 'the call waited for the pass');
    });
}
