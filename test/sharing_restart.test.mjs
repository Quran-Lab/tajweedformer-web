// R5 (SDK 3.0.2; SPEC 11.7 and the `restart_cases` of test/vectors30/sharing_off.json, whose case names and
// assertion keys this file uses): a recording made under an earlier consent is never uploaded, whatever happened
// in between; it is deleted at the next launch and before every upload pass; and the change of consent is on
// the device before anything else is done about it.
//
// Driven through the consent controller (web/consent), which is where a launch and the learner's switch are:
// the learner's consent lives in the client's state store, the queue in a real folder. Nine recordings wait in
// the queue (the uploads are refused by the network until the call). From the moment of the call every deletion
// of a recording fails (a storage that refuses). Where the case says the process ends, everything the old
// process holds stops answering (its storage and its network) and a new client opens the same state and the
// same folder. The stub notes every upload request with the recording it is for.
//
// Many runs in a row: RACE_RUNS=20 node test/sharing_restart.test.mjs
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enableSharing } from '../web/consent/index.js';
import { SharingState } from '../web/consent/state.js';
import { memoryState, localState } from '../web/platform/index.js';
import { dirStorage, resetSharingForTests, outbox as pageOutbox } from '../web/sharing/index.js';
import { stubApi, client, clip16k, listen } from './sharing_stub_api.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const vector = JSON.parse(readFileSync(path.join(root, 'test', 'vectors30', 'sharing_off.json'), 'utf8'));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const RUNS = Math.max(1, Number(process.env.RACE_RUNS) || 1);
const BOUND = vector.off_bound_ms;
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));
const pcm = have ? clip16k(3) : null;

// the contributor key's lookup can be made to take a moment (a slow key store): its WebCrypto export waits
const keyGate = { hold: false, wait: null, open: () => {} };
{
  const subtle = globalThis.crypto.subtle;
  const exportKey = subtle.exportKey.bind(subtle);
  subtle.exportKey = async (...a) => { if (keyGate.hold) await keyGate.wait; return exportKey(...a); };
}
const holdKey = () => { keyGate.hold = true; keyGate.wait = new Promise((r) => { keyGate.open = r; }); };
const releaseKey = () => { keyGate.hold = false; keyGate.open(); };

test('sharing_off.json: five restart situations (one optional), nine recordings each', () => {
  assert.equal(vector.restart_cases.length, 5);
  assert.equal(vector.restart_cases.every((c) => c.left === 9), true);
  assert.equal(vector.restart_cases.filter((c) => c.optional).length, 1);
});

// the recordings on the device that are not uploaded: every folder of the queue that still holds audio
async function unsent(storage) {
  const out = [];
  for (const id of await storage.sessions()) if ((await storage.list(id)).some((f) => f.endsWith('.opus'))) out.push(id);
  return out;
}

// One run of one situation: the failed assertion keys, with what was seen.
async function run(c) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-restart-'));
  const failed = [];
  const check = (key, ok, seen = '') => { if (!ok && !failed.some((f) => f.startsWith(key))) failed.push(seen ? `${key} (${seen})` : key); };
  failed.audio = 0; // bytes of audio uploaded from recordings that were in the queue at the call
  const api = await stubApi({ contributions: true });
  // the device's state store: what a new process finds. `disk.full()`: the device refuses to store the
  // learner's answer (a full quota, a folder that refuses the write)
  const mem = memoryState();
  const disk = { full: () => false, refused: 0 };
  const consent = { kind: 'memory', get: (k) => mem.get(k),
    set: (k, v) => { if (k === 'sharing.v1' && disk.full()) { disk.refused++; throw Object.assign(new Error('the quota has been exceeded'), { name: 'QuotaExceededError' }); } mem.set(k, v); } };
  // what a page that loads now reads as the learner's answer
  const newPageReads = () => new SharingState(consent, {}).s.consent;
  const net = { down: true, called: false, holdDelete: false, deleteAsked: false };
  const seen = []; // upload requests after the call: { kind, id, bytes }
  const sw = { fail: false }; // every deletion of a recording fails
  const processes = [];
  const inspect = await dirStorage(dir);
  try {
    // a process: a client on the device's state and folder; when it has ended nothing of it answers any more
    const launch = async () => {
      const life = { alive: true };
      processes.push(life);
      const dead = () => new Promise(() => {});
      const fetch = async (url, init = {}) => {
        if (!life.alive) return dead();
        const u = new URL(url);
        const kind = u.host === 'r2.test' ? 'put' : u.pathname === '/v1/uploads' ? 'start' : /\/urls$/.test(u.pathname) ? 'urls' : /\/takes$/.test(u.pathname) ? 'takes' : null;
        if (kind) {
          if (net.down) throw new TypeError('fetch failed');
          const id = kind === 'start' ? Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]))['x-qlab-id'] : (/([0-9a-f]{32})/.exec(u.pathname) || [])[1];
          if (net.called) seen.push({ kind, id, bytes: kind === 'put' && init.body ? init.body.length : 0 });
        }
        if (u.pathname === '/v1/contributions/delete' && net.holdDelete) {
          // held: never answered, or (the extra) answered later with an error
          net.deleteAsked = true;
          const how = await new Promise((r) => { net.answer = r; });
          if (how === 'accept') return api.fetch(url, init);
          return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
        }
        return api.fetch(url, init);
      };
      resetSharingForTests();
      const ql = await client({ fetch, pub: api.pub }, { state: consent });
      const real = await dirStorage(dir);
      const storage = Object.create(real);
      for (const name of ['sessions', 'list', 'read', 'write', 'append', 'truncate', 'remove', 'getGlobal', 'setGlobal']) {
        storage[name] = (...a) => (life.alive ? real[name](...a) : dead());
      }
      storage.removeSession = async (id) => {
        if (!life.alive) return dead();
        if (sw.fail) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; }
        return real.removeSession(id);
      };
      ql.sharingStorage = storage;
      const ctl = enableSharing(ql, { ask: async () => ({ yes: true }) });
      return { ql, ctl };
    };
    const end = () => { for (const p of processes) p.alive = false; };
    const record = async (ctl) => { await listen(ctl, pcm, { complete: false }); await ctl.closeRecording(); };
    const passes = async (_ctl, ms) => {
      for (const until = Date.now() + ms; Date.now() < until;) {
        // a later pass, when every retry time has come (the nine failed to upload while the network was away)
        const pipe = await pageOutbox.sharing();
        if (pipe) await Promise.race([pipe.outbox.drain({ ignoringBackoff: true }).catch(() => {}), tick(250)]);
        await tick(20);
      }
    };

    let { ctl } = await launch();
    await ctl.setSharing(true);
    for (let i = 0; i < c.left; i++) await record(ctl);
    let old = [];
    for (let i = 0; i < 200 && old.length < c.left; i++) { old = await unsent(inspect); await tick(10); }
    assert.equal(old.length, c.left, `${c.left} recordings wait in the queue`);

    let loaded = null;
    if (c.action === 'off_in_a_later_page') {
      // the page is closed, opened (its launch looks at the queue once), closed, and opened again
      end();
      ({ ctl } = await launch());
      await tick(400);
      end();
      ({ ctl } = await launch());
      await tick(200);
      loaded = !!ctl.outbox;
    }
    // the call: from here every deletion of a recording fails, and the network is there again
    const storeRow = ['delete_cannot_store_accepted', 'delete_cannot_store_refused', 'delete_cannot_write_back'].includes(c.action);
    sw.fail = c.action !== 'off_in_a_later_page' && !storeRow; net.down = false; net.called = true;
    const t0 = Date.now();
    let threw = null;
    const held = c.action === 'delete_unanswered' || c.action === 'delete_refused_late' || c.action === 'delete_accepted_late' || storeRow;
    const oldOnDevice = () => old.some((id) => existsSync(path.join(dir, 'outbox', id)));
    // the off cannot be stored: while the queue's recordings are on the device (accepted), or at all (refused)
    if (c.action === 'delete_cannot_store_accepted') disk.full = oldOnDevice;
    if (c.action === 'delete_cannot_store_refused') disk.full = () => true;
    if (c.cannotStore) disk.full = () => true;
    // what the calling page sees: isOn (the Client's sharing.isOn is this) and the listeners of the consent state
    const isOn = () => ctl.state.s.consent === 'granted';
    const events = [];
    ctl.state.onChange((s) => events.push(s.consent));
    if (held) net.holdDelete = true;
    const answerBefore = JSON.stringify(consent.get('sharing.v1'));
    const slowKey = c.action === 'delete_slow_key';
    const pipeNow = slowKey ? await pageOutbox.sharing() : null;
    if (slowKey) holdKey();
    const call = Promise.resolve(c.action === 'off' || c.action === 'off_in_a_later_page' ? ctl.setSharing(false) : ctl.deleteShared()).catch((e) => { threw = String((e && e.message) || e).slice(0, 80); });
    if (slowKey) {
      // an upload pass asked for in the same tick as the call (a retry timer, a segment that closed)
      const meanwhile = pipeNow ? pipeNow.outbox.drain({ ignoringBackoff: true }).catch(() => {}) : null;
      await tick(400);
      const stored = (consent.get('sharing.v1') || {}).consent;
      check('extra_off_is_written_before_any_wait', stored !== 'granted', `while the delete waits for the key the learner's stored answer is "${stored}"`);
      const early = seen.filter((e) => old.includes(e.id));
      check('extra_queue_held_before_any_wait', early.length === 0,
        `${early.length} upload requests for ${new Set(early.map((e) => e.id)).size} of the ${c.left} while the delete waited for the key: ${early.filter((e) => e.kind === 'put').length} PUTs, ${early.reduce((n, e) => n + e.bytes, 0)} bytes of audio`);
      releaseKey();
      await Promise.race([call, tick(BOUND + 2000)]);
      if (meanwhile) await Promise.race([meanwhile, tick(1000)]);
    }
    if (held) {
      for (let i = 0; i < 1500 && !net.deleteAsked; i++) await tick(2);
      assert.equal(net.deleteAsked, true, 'the server is being asked');
    }
    if (c.action === 'delete_cannot_store_accepted' || c.action === 'delete_cannot_store_refused') {
      // the server is being asked although the off could not be stored; nothing was thrown, nothing is visible
      check('extra_server_asked_although_the_off_was_not_stored', net.deleteAsked && disk.refused > 0 && newPageReads() === 'granted' && isOn() && events.length === 0 && !threw,
        `asked ${net.deleteAsked}, ${disk.refused} writes refused, a new page reads "${newPageReads()}", isOn ${isOn()}, ${events.length} change events${threw ? ', the call failed: ' + threw : ''}`);
    }
    if (c.action === 'delete_cannot_store_accepted') {
      net.answer('accept');
      await Promise.race([call, tick(BOUND + 2000)]);
      const left = (await inspect.sessions()).filter((id) => old.includes(id)).length;
      check('extra_off_in_this_page_and_the_queue_gone', !threw && !isOn() && events.join(' ') === 'final' && left === 0,
        `${threw ? 'the call failed: ' + threw : 'the call returned'}, isOn ${isOn()}, change events: ${events.join(' ') || 'none'}, ${left} of ${c.left} left`);
      check('extra_the_off_is_stored_once_the_queue_is_gone', newPageReads() === 'final', `a new page reads "${newPageReads()}"`);
      return failed;
    }
    if (c.action === 'delete_cannot_store_refused') {
      net.answer('refuse');
      await Promise.race([call, tick(5000)]);
      const left = (await unsent(inspect)).filter((id) => old.includes(id)).length;
      check('a_refused_delete_changes_nothing', !!threw && isOn() && events.length === 0 && JSON.stringify(mem.get('sharing.v1')) === answerBefore && newPageReads() === 'granted' && left === c.left,
        `${threw ? 'the call reported the failure' : 'the call did not fail'}, isOn ${isOn()}, ${events.length} change events, the stored answer is ${JSON.stringify(mem.get('sharing.v1')) === answerBefore ? 'as before' : 'changed'}, ${left} of ${c.left} left`);
      // the device stores again: a later write of the answer stores the learner's own, not an off nobody gave
      disk.full = () => false;
      ctl.state.sessionCompleted({ feedback: false });
      check('extra_no_mark_left_behind', newPageReads() === 'granted' && isOn(), `after a later write a new page reads "${newPageReads()}", isOn ${isOn()}`);
      return failed;
    }
    if (c.action === 'delete_cannot_write_back') {
      // the off was stored; the server does not take the deletion, and the write that puts the earlier answer
      // back is refused by the device
      check('extra_stored_off_while_the_server_is_asked', newPageReads() === 'final', `a new page reads "${newPageReads()}"`);
      disk.full = () => true;
      net.answer('refuse');
      await Promise.race([call, tick(5000)]);
      check('extra_this_page_has_the_right_answer', !!threw && isOn() && events.length === 0, `${threw ? 'the call reported the failure' : 'the call did not fail'}, isOn ${isOn()}, ${events.length} change events`);
      // (until the device stores again a new page reads the off form: the window this SDK cannot close)
      disk.full = () => false;
      ctl.state.sessionCompleted({ feedback: false });
      const now = mem.get('sharing.v1') || {};
      check('extra_written_back_at_the_next_write', now.consent === 'granted' && (now.changes || 0) === (JSON.parse(answerBefore).changes || 0) && isOn(),
        `after the next write of the answer a new page reads "${newPageReads()}" with the count ${now.changes} (${JSON.parse(answerBefore).changes} before), isOn ${isOn()}`);
      return failed;
    }
    if (c.action === 'delete_refused_late' || c.action === 'delete_accepted_late') {
      // while the server is asked: the stored answer says off, and the page has seen nothing of it
      const stored = (consent.get('sharing.v1') || {}).consent;
      check('extra_stored_off_while_the_server_is_asked', stored !== 'granted', `the stored answer is "${stored}"`);
      check('extra_nothing_visible_while_the_server_is_asked', isOn() && events.length === 0, `isOn ${isOn()}, ${events.length} change events (${events.join(' ')})`);
    }
    if (c.action === 'delete_accepted_late') {
      // another write of the answer while the server is asked (a session ends and is counted): what is stored
      // keeps the off form, with the new count of sessions, and the page still sees sharing on
      const sessions = (consent.get('sharing.v1') || {}).sessions;
      ctl.state.sessionCompleted({ feedback: false });
      const now = consent.get('sharing.v1') || {};
      check('extra_other_writes_keep_the_stored_off', now.consent === 'final' && now.sessions === sessions + 1 && isOn() && events.join(' ') === 'granted',
        `stored "${now.consent}" with ${now.sessions} sessions (${sessions} before), isOn ${isOn()}, the page's listeners saw: ${events.join(' ')}`);
      events.length = 0;
      net.answer('accept');
      await Promise.race([call, tick(BOUND + 2000)]);
      check('extra_exactly_one_off_after_an_acceptance', !threw && !isOn() && events.length === 1 && events[0] === 'final',
        `${threw ? 'the call failed' : 'the call returned'}, isOn ${isOn()}, ${events.length} change events (${events.join(' ')})`);
      check('sharing_is_off_after_an_accepted_delete', (consent.get('sharing.v1') || {}).consent === 'final', `the stored answer is "${(consent.get('sharing.v1') || {}).consent}"`);
      return failed;
    }
    if (c.action === 'delete_refused_late') {
      // a look at the queue while the server is asked (an app that lists what waits): nothing is deleted.
      // (Deleting works here, so a delete that is tried shows.)
      sw.fail = false;
      const pipe = await pageOutbox.sharing();
      if (pipe) await Promise.race([pipe.outbox.items().catch(() => {}), tick(1000)]);
      const still = (await unsent(inspect)).filter((id) => old.includes(id)).length;
      check('extra_nothing_deleted_while_the_server_is_asked', still === c.left, `${still} of ${c.left} left`);
      // the server does not take it
      net.answer('refuse');
      await Promise.race([call, tick(5000)]);
      const left = (await unsent(inspect)).filter((id) => old.includes(id)).length;
      check('extra_nothing_visible_after_a_refusal', isOn() && events.length === 0, `isOn ${isOn()}, ${events.length} change events (${events.join(' ')})`);
      check('a_refused_delete_changes_nothing', !!threw && JSON.stringify(consent.get('sharing.v1')) === answerBefore && left === c.left,
        `${threw ? 'the call reported the failure' : 'the call did not fail'}, the stored answer is ${JSON.stringify(consent.get('sharing.v1')) === answerBefore ? 'as before' : 'changed'}, ${left} of ${c.left} left`);
      sw.fail = false;
      await passes(ctl, 2500);
      const up = new Set(seen.filter((e) => e.kind === 'put' && old.includes(e.id)).map((e) => e.id)).size;
      check('queue_resumes', up === c.left, `${up} of ${c.left} went up`);
      return failed;
    }
    if (!held) {
      const returned = await Promise.race([call.then(() => true), tick(BOUND + 500).then(() => false)]);
      const took = Date.now() - t0;
      if (!c.ends && !slowKey) check('returns_within_bound', returned && !threw && took <= BOUND, threw ? `the call failed: ${threw}` : `${returned ? took : 'more than ' + took} ms`);
      // (without an end of the process the run goes on when the call is over, however long it took)
      if (!c.ends && !returned) await Promise.race([call, tick(60000)]);
    }

    if (c.action === 'off_in_a_later_page') {
      const left = (await inspect.sessions()).filter((id) => old.includes(id)).length;
      check('nothing_unsent_on_device', left === 0, `${left} of ${c.left} still on the device when the call returned (the sharing module was ${loaded ? '' : 'not '}loaded in this page)`);
      await ctl.setSharing(true);
      await record(ctl);
      await passes(ctl, 1500);
    }
    if (c.ends) {
      end();
      // "nine left by off, the process ends, sharing off": at the next launch deleting works
      if (!c.then) sw.fail = false;
      ({ ctl } = await launch());
      // (the learner's stored answer itself, not `sharing`, which also needs the signed config to be loaded)
      const stored = ctl.state.s.consent;
      check('off_is_on_disk_first', stored !== 'granted', `the new process finds the learner's answer "${stored}": sharing on`);
      if (!c.then) {
        // right after the launch, with no upload pass asked for
        let left = c.left;
        for (let i = 0; i < 100 && left; i++) { left = (await unsent(inspect)).filter((id) => old.includes(id)).length; await tick(20); }
        check('earlier_consent_deleted', left === 0, `${left} of ${c.left} still on the device after the launch`);
        await passes(ctl, 300);
      }
    }

    if (c.then === 'on') {
      // the learner turns sharing on while the recordings still cannot be deleted, and records
      await ctl.setSharing(true);
      await record(ctl);
      await passes(ctl, 1500);
      const fresh = seen.filter((e) => !old.includes(e.id));
      check('on_again_works', fresh.some((e) => e.kind === 'put') && seen.every((e) => !old.includes(e.id)) && new Set(fresh.map((e) => e.id)).size === 1,
        `${fresh.filter((e) => e.kind === 'put').length} segments of a new recording went up, requests for ${new Set(seen.map((e) => e.id)).size} recordings in all`);
      // deleting works again: they are gone before the next upload pass does anything else
      sw.fail = false;
      await passes(ctl, 400);
      const left = (await inspect.sessions()).filter((id) => old.includes(id)).length;
      check('earlier_consent_deleted', left === 0, `${left} of ${c.left} still on the device once deleting works`);
    }
    if (c.cannotStore) {
      // nothing of the off and the on could be stored: the page holds the answer in force and its count (the
      // recording made after on again went up above, the nine of before did not)
      check('extra_the_page_holds_the_answer_in_force', isOn() && events.join(' ') === 'final granted' && disk.refused >= 2 && JSON.stringify(mem.get('sharing.v1')) === answerBefore,
        `isOn ${isOn()}, the page's listeners saw: ${events.join(' ') || 'nothing'}, ${disk.refused} writes refused, the stored answer is ${JSON.stringify(mem.get('sharing.v1')) === answerBefore ? 'as before the off' : 'changed'}`);
      // the device stores again: the next write of the answer stores the one in force, with its count
      disk.full = () => false;
      ctl.state.sessionCompleted({ feedback: false });
      const now = mem.get('sharing.v1') || {};
      const was = JSON.parse(answerBefore).changes || 0;
      check('extra_stored_as_soon_as_the_device_can', now.consent === 'granted' && now.changes === was + 2, `stored "${now.consent}" with the count ${now.changes} (${was} before the off)`);
    }
    const theirs = seen.filter((e) => old.includes(e.id));
    failed.audio = theirs.reduce((n, e) => n + e.bytes, 0);
    check('earlier_consent_never_uploaded', theirs.length === 0,
      `${theirs.length} requests for ${new Set(theirs.map((e) => e.id)).size} of the ${c.left}: ${theirs.filter((e) => e.kind === 'put').length} PUTs, ${failed.audio} bytes of audio`);
    return failed;
  } finally {
    releaseKey();
    for (const p of processes) p.alive = false;
    resetSharingForTests();
    for (let i = 0; i < 20; i++) { try { rmSync(dir, { recursive: true, force: true }); break; } catch (_) { await tick(25); } }
  }
}

// this SDK's extra, in the same harness
const EXTRA = { name: 'extra: the server is asked and does not take the deletion', left: 9, action: 'delete_refused_late', ends: false, then: null,
  assert: ['extra_stored_off_while_the_server_is_asked', 'extra_nothing_visible_while_the_server_is_asked', 'extra_nothing_deleted_while_the_server_is_asked',
    'extra_nothing_visible_after_a_refusal', 'a_refused_delete_changes_nothing', 'queue_resumes'] };
const EXTRA4 = { name: 'extra: the server is asked and takes the deletion: the page sees one off, and only then', left: 9, action: 'delete_accepted_late', ends: false, then: null,
  assert: ['extra_stored_off_while_the_server_is_asked', 'extra_nothing_visible_while_the_server_is_asked', 'extra_other_writes_keep_the_stored_off',
    'extra_exactly_one_off_after_an_acceptance',
    'sharing_is_off_after_an_accepted_delete'] };
const EXTRA2 = { name: 'extra: off in a later page that has not loaded the sharing module', left: 9, action: 'off_in_a_later_page', ends: false, then: null,
  assert: ['returns_within_bound', 'nothing_unsent_on_device', 'earlier_consent_never_uploaded'] };
const EXTRA3 = { name: 'extra: the delete waits for the contributor key and an upload pass is asked for meanwhile', left: 9, action: 'delete_slow_key', ends: false, then: null,
  assert: ['extra_off_is_written_before_any_wait', 'extra_queue_held_before_any_wait', 'earlier_consent_never_uploaded'] };

// SPEC 11.7, "When the device cannot store the off"
const EXTRA5 = { name: 'extra: the off cannot be stored and the server takes the deletion', left: 9, action: 'delete_cannot_store_accepted', ends: false, then: null,
  assert: ['extra_server_asked_although_the_off_was_not_stored', 'extra_off_in_this_page_and_the_queue_gone', 'extra_the_off_is_stored_once_the_queue_is_gone'] };
const EXTRA6 = { name: 'extra: the off cannot be stored and the server does not take the deletion', left: 9, action: 'delete_cannot_store_refused', ends: false, then: null,
  assert: ['extra_server_asked_although_the_off_was_not_stored', 'a_refused_delete_changes_nothing', 'extra_no_mark_left_behind'] };
const EXTRA7 = { name: 'extra: the server does not take the deletion and the earlier answer cannot be written back', left: 9, action: 'delete_cannot_write_back', ends: false, then: null,
  assert: ['extra_stored_off_while_the_server_is_asked', 'extra_this_page_has_the_right_answer', 'extra_written_back_at_the_next_write'] };
const EXTRA8 = { name: 'extra: off and on again while the device cannot store the answer', left: 9, action: 'off', ends: false, then: 'on', cannotStore: true,
  assert: ['returns_within_bound', 'earlier_consent_never_uploaded', 'earlier_consent_deleted', 'on_again_works', 'extra_the_page_holds_the_answer_in_force',
    'extra_stored_as_soon_as_the_device_can'] };

for (const c of [...vector.restart_cases, EXTRA, EXTRA2, EXTRA3, EXTRA4, EXTRA5, EXTRA6, EXTRA7, EXTRA8]) {
  const keys = c.assert.map((a) => a.split(':')[0]);
  test(`${c.name}${c.optional ? ' (optional)' : ''}: ${keys.join(', ')}`, { skip, timeout: 3600000 }, async () => {
    let bad = 0, audioRuns = 0, most = 0;
    const why = [];
    const tally = new Map();
    for (let i = 0; i < RUNS; i++) {
      const failed = await run(c);
      if (failed.length) { bad++; if (why.length < 3) why.push(`run ${i + 1}: ${failed.join('; ')}`); }
      for (const f of failed) { const k = f.split(' (')[0]; tally.set(k, (tally.get(k) || 0) + 1); }
      if (failed.audio > 0) { audioRuns++; most = Math.max(most, failed.audio); }
    }
    console.log(`RESTART | ${c.name} | ${RUNS - bad} of ${RUNS} runs passed | audio of an earlier consent uploaded in ${audioRuns} runs, at most ${most} bytes`
      + (tally.size ? ` | failed: ${[...tally].map(([k, n]) => `${k} ${n}`).join(', ')}` : ''));
    // (the optional case is held too: this SDK writes the off before it asks the server to delete)
    assert.equal(bad, 0, `${bad} of ${RUNS} runs failed: ${why.join(' || ')}`);
  });
}

// The browser's store: localStorage over its quota throws, the store keeps the old value there and throws
// nothing, and a read gives the old value back. The page must go by the answer in force all the same.
// `fn(disk, newPage)`: disk.full refuses every write; newPage() is a page that loads now on the same store.
function withBrowserStore(fn) {
  const items = new Map();
  const disk = { full: false };
  const fake = {
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => { if (disk.full) throw Object.assign(new Error('the quota has been exceeded'), { name: 'QuotaExceededError' }); items.set(k, String(v)); },
    removeItem: (k) => { items.delete(k); },
  };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
  try {
    return fn(disk, () => new SharingState(localState(), { enabled: () => true }));
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
  }
}

test('the browser store refuses a write of the answer: this page reads the answer in force, a new page what is stored, and the next write stores it', () => withBrowserStore((disk, newPage) => {
  const page = new SharingState(localState(), { enabled: () => true, consentVersion: 'deck-1' });
  const seen = [];
  page.onChange((s) => seen.push(s.consent));
  page.setSharing(true);
  assert.deepEqual([page.sharing, page.changes, newPage().s.consent], [true, 1, 'granted']);
  disk.full = true;
  page.setSharing(false);
  assert.deepEqual([page.sharing, page.changes], [false, 2], 'the page holds the off, and its count, although the device did not store it');
  assert.equal(newPage().s.consent, 'granted', 'a new page has only what is stored');
  page.setSharing(true);
  assert.deepEqual([page.sharing, page.changes], [true, 3], 'on again, still not stored');
  page.setSharing(false);
  disk.full = false;
  assert.deepEqual([page.sharing, page.changes, newPage().s.consent], [false, 4, 'granted']);
  page.flush();
  assert.deepEqual([newPage().s.consent, newPage().changes], ['final', 4], 'stored as soon as the device can');
  assert.deepEqual(seen, ['granted', 'final', 'granted', 'final']);
}));

test('two pages: an off this page holds unsaved stays in force when another page writes the stored answer, and is stored next; an on held unsaved gives way to what is stored', () => withBrowserStore((disk, newPage) => {
  const page = new SharingState(localState(), { enabled: () => true, consentVersion: 'deck-1' });
  page.setSharing(true);
  page.setSharing(false);
  assert.equal(newPage().s.consent, 'final');
  // an on the device did not take; another page (which reads off) counts a session and writes the stored answer
  disk.full = true;
  page.setSharing(true);
  assert.equal(page.sharing, true);
  disk.full = false;
  newPage().sessionCompleted({ feedback: false });
  assert.equal(page.sharing, false, 'the other page wrote the stored answer: an on held here gives way to it');
  // an off the device did not take; another page (which still reads on) counts a session
  page.setSharing(true);
  assert.equal(newPage().s.consent, 'granted');
  disk.full = true;
  page.setSharing(false);
  disk.full = false;
  newPage().sessionCompleted({ feedback: false });
  assert.equal(page.sharing, false, 'the off held here stays in force: the learner\'s no is never lost');
  page.flush();
  assert.equal(newPage().s.consent, 'final', 'and it is stored');
}));
