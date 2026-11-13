// SDK 3.1.2 (SPEC 15.2 as of contract 1.14.0): the install key stores never keep a device from the model for good.
//
//   Node, no machine id can be read (a container without /etc/machine-id): the device key is 32 random bytes in a
//     file of the store, made at first need; the host name is never part of a key.
//   Node, a machine id read by a command that can fail or time out (`reg` on Windows, `ioreg` on a Mac): a read
//     that works wins and is kept in the store; the kept answer is used only when a later read fails, and only as
//     part of the store that kept it; a read that works and differs means the store came from another machine.
//   A browser whose IndexedDB is there and blocked counts as no store; a store that opened and then fails, and
//     any failure that is not "blocked", stays an error.
//
// WHERE THIS RUNS: Node. The store is a real folder in the system's temp folder (the key file is a real file).
// The machine is a STAND-IN: the readers of the machine id (/etc/machine-id, `reg`, `ioreg`), the host name and
// the user id are injected, so one test process can be a container, a Windows PC whose `reg` times out, or two
// machines. The browser part at the end runs the browser's key store against STAND-INS for IndexedDB and Cache
// Storage that answer what real browsers were seen to answer (Chrome 157, Edge 157, Firefox 150; the real
// browser is test/install_blocked_browser.test.mjs). The server is the stub of test/helpers/model3.mjs and the
// engine is the fake host.
import test, { after } from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TajweedError } from '../web/index.js';
import { createClient, resetClientForTests } from '../web/api/client.js';
import { memoryState } from '../web/platform/storage.js';
import * as delivery from '../web/tajweed/delivery.js';
import * as install from '../web/tajweed/install.js';
import { dirStore } from '../web/tajweed/node.js';
import { MemoryStorage } from '../web/sharing/outbox.js';
import { build3, stubPlatform, seamsFor, KEY } from './helpers/model3.mjs';

const { INSTALL_PREFIX, installText, InstallKeyError } = install;
const build = await build3();
const code = (c) => (e) => e instanceof TajweedError && e.code === c;
const tmp = mkdtempSync(path.join(tmpdir(), 'tf-install-key-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// A storage volume: what stays when a container or a process ends (the state and the store's folder).
let volumes = 0;
function volume(dir = path.join(tmp, `volume-${++volumes}`)) {
  return { dir, models: path.join(dir, 'models'), state: memoryState(), store: dirStore(path.join(dir, 'models')), sharing: new MemoryStorage() };
}
const keyFile = (vol) => path.join(vol.models, 'device', 'key');
const keptFile = (vol) => path.join(vol.models, 'device', 'machine');
const record = (vol) => { try { return JSON.parse(readFileSync(path.join(vol.models, 'install', build.build), 'utf8')); } catch (_) { return null; } };
// every file of the folder, with its size (to see that nothing was deleted or written)
function listing(dir) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { out.push(`${path.relative(dir, f)}/`); walk(f); } else out.push(`${path.relative(dir, f)} ${statSync(f).size}`); } };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}
// the whole volume carried to another place (a restored backup, a copied folder, a cloned machine's disk)
function copyOf(vol) {
  const to = volume();
  cpSync(vol.dir, to.dir, { recursive: true });
  for (const k of ['model.last', 'config']) to.state.set(k, vol.state.get(k));
  return to;
}

/**
 * A machine as the SDK can read it (a stand-in).
 *   platform   'linux', 'win32' or 'darwin'
 *   fileId     what /etc/machine-id holds, or null: no such file
 *   commandId  what `reg` (win32) or `ioreg` (darwin) prints as the machine id
 *   fails      true: the command does not answer in time (it throws, as execFileSync does on a timeout)
 *   host, uid  the host name and the user id
 * `calls` counts what was asked. (On the code before 3.1.2 the platform cannot be injected: there the command is
 * asked on Windows and on a Mac whatever `platform` says, so a machine without `commandId` makes it fail.)
 */
function machine({ platform = 'linux', fileId = null, commandId = null, fails = false, host = 'host-a', uid = 1000 } = {}) {
  const calls = { hostname: 0, command: 0 };
  const m = { platform, calls, fails, commandId, host };
  m.parts = {
    fs: { readFileSync(f) { if (fileId && f === '/etc/machine-id') return `${fileId}\n`; throw Object.assign(new Error(`ENOENT: no such file or directory, open '${f}'`), { code: 'ENOENT' }); } },
    os: { hostname() { calls.hostname++; return m.host; }, userInfo: () => ({ uid, username: 'learner' }) },
    execFileSync(cmd) {
      calls.command++;
      if (m.fails || !m.commandId) throw Object.assign(new Error(`spawnSync ${cmd} ETIMEDOUT`), { code: 'ETIMEDOUT' });
      if (cmd === 'reg') return `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${m.commandId}\r\n\r\n`;
      return `+-o Root  <class IOPlatformExpertDevice>\n    {\n      "IOPlatformUUID" = "${m.commandId}"\n    }\n`;
    },
  };
  return m;
}

// One start of the app: a new process on `m` with the volume `vol`. Returns what it did.
async function start(vol, m, api) {
  resetClientForTests();
  api.log.length = 0;
  const installKey = install.derivedDeviceKey(m.parts, { store: vol.store, platform: m.platform });
  const client = await createClient({ key: KEY, appVersion: '1.0' }, seamsFor(api, { state: vol.state, store: vol.store, installKey, sharingStorage: vol.sharing }));
  let opened = null, error = null;
  try { opened = (await client.model()).build; } catch (e) { error = e; }
  const files = api.log.filter((x) => x.host === 'cdn' && x.path !== 'manifest.json').map((x) => x.path);
  const cdn = api.log.filter((x) => x.host === 'cdn').length;
  await client.close();
  const issues = api.log.filter((x) => x.host === 'api' && x.path === '/v1/issues').length + ((vol.state.get('issues.queue') || []).length);
  return { opened, error, files, downloaded: files.length > 0, cdn, issues };
}
const opensWithoutDownload = (r, what) => { assert.equal(r.error, null, `${what}: ${r.error && r.error.message}`); assert.equal(r.opened, build.build, what); assert.deepEqual(r.files, [], `${what}: no file is asked for`); };
const downloads = (r, what) => { assert.equal(r.error, null, `${what}: ${r.error && r.error.message}`); assert.equal(r.opened, build.build, what); assert.ok(r.downloaded, `${what}: the model is downloaded`); };

// ------------------------------------------------------------------ W1: no machine id can be read

test('15.2 Node, no machine id can be read: the key is 32 random bytes in a file of the store, made at first need; the next start finds it and opens with no request for a file', async () => {
  const vol = volume(), api = await stubPlatform({ build });
  const first = await start(vol, machine(), api);
  downloads(first, 'the first start');
  assert.ok(existsSync(keyFile(vol)), `the key file ${path.relative(vol.dir, keyFile(vol))} was made`);
  const key = readFileSync(keyFile(vol));
  assert.equal(key.length, 32, 'the key file holds 32 bytes');
  assert.notDeepEqual([...key], new Array(32).fill(0), 'they are not zeros');
  if (process.platform !== 'win32') assert.equal(statSync(keyFile(vol)).mode & 0o777, 0o600, 'mode 0600 where the system has modes');
  // the record's MAC is made with exactly those bytes
  assert.equal(record(vol).mac, createHmac('sha256', key).update(installText(build.build, 'installed')).digest('hex'));
  // it is not a model entry: it is in none of the prefixes a removal or a sweep touches, and no manifest lists it
  assert.equal(install.MODEL_PREFIXES.some((p) => 'device/key'.startsWith(p)), false);
  const second = await start(vol, machine(), api);
  opensWithoutDownload(second, 'the second start');
  assert.deepEqual([...readFileSync(keyFile(vol))], [...key], 'the same key');
  // another volume gets another key
  const other = volume();
  await start(other, machine(), api);
  assert.notDeepEqual([...readFileSync(keyFile(other))], [...key]);
});

test('15.2 Node, two containers with different host names on one kept volume: one download in all, and the host name is never read', async () => {
  const vol = volume(), api = await stubPlatform({ build });
  const a = machine({ host: '3f9c2d7e1a44' }), b = machine({ host: 'b81e60c4d2a9' }), c = machine({ host: '3f9c2d7e1a44' });
  const runs = [await start(vol, a, api), await start(vol, b, api), await start(vol, c, api)];
  assert.deepEqual(runs.map((r) => [r.opened === build.build, r.downloaded]), [[true, true], [true, false], [true, false]],
    'the first container downloads, the next two open what it left');
  assert.deepEqual([a.calls.hostname, b.calls.hostname, c.calls.hostname], [0, 0, 0], 'no start asked for the host name');
  // changing the host name changes nothing: the same key signs the same text to the same MAC
  const mac = async (m) => (await install.derivedDeviceKey(m.parts, { store: vol.store, platform: m.platform }).key({ create: false })).mac('text');
  assert.equal(await mac(machine({ host: 'one' })), await mac(machine({ host: 'another' })));
});

test('15.2 Node, a key file that cannot be read is "the store failed": storage_failed, nothing is deleted or downloaded, and the next call tries again', async () => {
  const vol = volume(), api = await stubPlatform({ build });
  downloads(await start(vol, machine(), api), 'the first start');
  // the key file cannot be read (here: a folder sits where the file was, so the read fails with an error of the
  // system that is not "no such file")
  const key = readFileSync(keyFile(vol));
  rmSync(keyFile(vol));
  mkdirSync(keyFile(vol));
  const before = listing(vol.dir);
  const r = await start(vol, machine(), api);
  assert.ok(r.error && code('storage_failed')(r.error), `the call fails with storage_failed (got ${r.error ? r.error.code || r.error.message : 'a model'})`);
  assert.equal(r.cdn, 0, 'nothing was asked of the CDN');
  assert.deepEqual(listing(vol.dir), before, 'nothing was deleted or written');
  // the key store itself says which of its two answers this is
  await assert.rejects(install.derivedDeviceKey(machine().parts, { store: vol.store, platform: 'linux' }).key({ create: true }), (e) => e instanceof InstallKeyError);
  // readable again: the same records are valid, no download
  rmSync(keyFile(vol), { recursive: true });
  writeFileSync(keyFile(vol), key);
  opensWithoutDownload(await start(vol, machine(), api), 'with the key file back');
});

test('15.2 Node, calls that make the key at the same moment end with one key: eight calls on one key store, and eight key stores on one folder', async () => {
  // one process, one key store, eight calls at once (client.model() and client.prefetch() started together)
  const vol = volume();
  const one = install.derivedDeviceKey(machine().parts, { store: vol.store, platform: 'linux' });
  const macs = await Promise.all(Array.from({ length: 8 }, async () => (await one.key({ create: true })).mac('text')));
  assert.equal(new Set(macs).size, 1, 'one key');
  assert.deepEqual(readdirSync(path.join(vol.models, 'device')), ['key'], 'one key file and no temp file left');
  // eight key stores on one folder at once (a stand-in for eight processes that start together): the first
  // one's file stays, and every one of them reads that file
  const shared = volume();
  const many = await Promise.all(Array.from({ length: 8 }, async () => (await install.derivedDeviceKey(machine().parts, { store: dirStore(shared.models), platform: 'linux' }).key({ create: true })).mac('text')));
  assert.equal(new Set(many).size, 1, 'the same key in all eight');
  assert.deepEqual(readdirSync(path.join(shared.models, 'device')), ['key']);
  assert.equal(readFileSync(keyFile(shared)).length, 32);
});

test('15.2 Node, a key file of the wrong length is "no key": it is replaced, and the model is downloaded once', async () => {
  const vol = volume(), api = await stubPlatform({ build });
  downloads(await start(vol, machine(), api), 'the first start');
  writeFileSync(keyFile(vol), Buffer.alloc(7, 1));
  // no key: no record can be valid (asked without making one)
  assert.equal(await install.derivedDeviceKey(machine().parts, { store: vol.store, platform: 'linux' }).key({ create: false }), null);
  downloads(await start(vol, machine(), api), 'the start that finds 7 bytes');
  assert.equal(readFileSync(keyFile(vol)).length, 32, 'a new key of 32 bytes');
  opensWithoutDownload(await start(vol, machine(), api), 'the start after');
});

test('15.2 Node, the update from 3.1.0 or 3.1.1 on a machine without a machine id (its key was made from the host name): the model is downloaded once more, then never again', async () => {
  const vol = volume(), api = await stubPlatform({ build });
  const m = machine({ host: 'old-container', uid: 1000 });
  downloads(await start(vol, m, api), 'the download');
  // the record as 3.1.1 wrote it there: HMAC with SHA-256("quranlab-model-install-key 1\nhost:<host name>\n<user id>\n")
  const old = createHash('sha256').update('quranlab-model-install-key 1\nhost:old-container\n1000\n').digest();
  writeFileSync(path.join(vol.models, 'install', build.build), JSON.stringify({ v: 1, build: build.build, state: 'installed',
    mac: createHmac('sha256', old).update(installText(build.build, 'installed')).digest('hex') }));
  rmSync(path.join(vol.models, 'device'), { recursive: true, force: true }); // 3.1.1 kept no key file
  downloads(await start(vol, m, api), 'the first start of 3.1.2');
  opensWithoutDownload(await start(vol, m, api), 'the second start of 3.1.2');
  opensWithoutDownload(await start(vol, machine({ host: 'new-container' }), api), 'the next container');
});

test('15.2 Node, a machine id that a file gives (Linux): the key is SHA-256("quranlab-model-install-key 1\\n" + machine id + "\\n" + user id), as in 3.1.0; no command is run, nothing is kept, no key file is made', async () => {
  const vol = volume(), api = await stubPlatform({ build });
  const m = machine({ platform: 'linux', fileId: '0123456789abcdef0123456789abcdef', uid: 1000 });
  downloads(await start(vol, m, api), 'the first start');
  const key = createHash('sha256').update('quranlab-model-install-key 1\n0123456789abcdef0123456789abcdef\n1000\n').digest();
  assert.equal(record(vol).mac, createHmac('sha256', key).update(installText(build.build, 'installed')).digest('hex'));
  assert.equal(m.calls.command, 0, 'no command was run');
  assert.equal(existsSync(path.join(vol.models, 'device')), false, 'nothing was kept beside the records');
  opensWithoutDownload(await start(vol, machine({ platform: 'linux', fileId: '0123456789abcdef0123456789abcdef', host: 'renamed' }), api), 'the second start');
});

// ------------------------------------------------------------------ W2: a machine id read by a command

for (const [platform, name] of [['win32', 'Windows (reg)'], ['darwin', 'a Mac (ioreg)']]) {
  test(`15.2 Node on ${name}: the machine id read fails at one start and works at the next, and the other way round: the kept answer is used, the key does not change, the model is downloaded once in all`, async () => {
    const vol = volume(), api = await stubPlatform({ build });
    const pc = (fails) => machine({ platform, commandId: '8D5B2A6E-1F0C-4E7B-9A3D-6C2F1E0B7A54', fails, uid: 501 });
    downloads(await start(vol, pc(false), api), 'start 1 (the read works)');
    // the key is the one 3.1.0 made on this machine: an install that updates keeps its model
    const key = createHash('sha256').update('quranlab-model-install-key 1\n8D5B2A6E-1F0C-4E7B-9A3D-6C2F1E0B7A54\n501\n').digest();
    const mac = createHmac('sha256', key).update(installText(build.build, 'installed')).digest('hex');
    assert.equal(record(vol).mac, mac);
    const slow = pc(true);
    opensWithoutDownload(await start(vol, slow, api), 'start 2 (the read times out)');
    assert.ok(slow.calls.command >= 1, 'the command was asked and failed');
    assert.equal(slow.calls.hostname, 0, 'the host name was not read');
    opensWithoutDownload(await start(vol, pc(false), api), 'start 3 (the read works again)');
    opensWithoutDownload(await start(vol, pc(true), api), 'start 4 (it fails again)');
    assert.equal(record(vol).mac, mac, 'the same record all along');
    // the answer is kept in the store, beside the records
    assert.ok(existsSync(keptFile(vol)), 'the answer was kept in the store');
    assert.equal(JSON.parse(readFileSync(keptFile(vol), 'utf8')).id, '8D5B2A6E-1F0C-4E7B-9A3D-6C2F1E0B7A54');
  });
}

test('15.2 Node, a store carried to another machine whose machine id can be read: its records are not valid there, the model is downloaded once, and nothing is reported', async () => {
  const home = volume(), api = await stubPlatform({ build });
  const a = () => machine({ platform: 'win32', commandId: 'AAAAAAAA-0000-4000-8000-000000000001' });
  const b = () => machine({ platform: 'win32', commandId: 'BBBBBBBB-0000-4000-8000-000000000002' });
  downloads(await start(home, a(), api), 'the download on machine A');
  const carried = copyOf(home);
  assert.ok(existsSync(keptFile(carried)) && existsSync(keyFile(carried)), 'the copy carries the kept answer and the key file');
  const first = await start(carried, b(), api);
  downloads(first, 'the first start on machine B');
  assert.equal(first.issues, 0, 'no issue report: a restored backup or a cloned machine is the ordinary cause');
  assert.equal(JSON.parse(readFileSync(keptFile(carried), 'utf8')).id, 'BBBBBBBB-0000-4000-8000-000000000002', 'the kept answer is now this machine\'s');
  const second = await start(carried, b(), api);
  opensWithoutDownload(second, 'the second start on machine B');
  assert.equal(second.issues, 0);
  // and machine B with a read that fails afterwards keeps its own records
  opensWithoutDownload(await start(carried, machine({ platform: 'win32', commandId: 'BBBBBBBB-0000-4000-8000-000000000002', fails: true }), api), 'machine B, the read fails');
  // machine A's own store is as it was
  opensWithoutDownload(await start(home, a(), api), 'machine A again');
});

test('15.2 Node, a kept answer counts only as part of the store that kept it: copied without its store it is not used', async () => {
  const api = await stubPlatform({ build });
  const a = (fails = false) => machine({ platform: 'win32', commandId: 'AAAAAAAA-0000-4000-8000-000000000001', fails });
  const unreadable = () => machine({ platform: 'win32', commandId: null }); // `reg` never answers on this machine
  const home = volume();
  downloads(await start(home, a(), api), 'the download on machine A');
  // (1) the kept answer of A's store dropped into the store of a machine whose id cannot be read: that store did
  // not keep it, so it is not used, and the machine's own records (made with its key file) stay valid
  const other = volume();
  downloads(await start(other, unreadable(), api), 'the other machine\'s own download');
  cpSync(keptFile(home), keptFile(other));
  opensWithoutDownload(await start(other, unreadable(), api), 'the other machine with A\'s kept answer dropped in');
  // (2) A's records, files and kept answer carried WITHOUT the store's key file to a machine whose id cannot be
  // read: the kept answer is not vouched for, so A's records are not valid there and the model is downloaded
  const partial = copyOf(home);
  rmSync(keyFile(partial));
  downloads(await start(partial, unreadable(), api), 'A\'s records and kept answer without the store\'s key');
  opensWithoutDownload(await start(partial, unreadable(), api), 'the start after');
  // (3) a kept answer written by hand (no MAC of the store) is not used either
  const forged = copyOf(home);
  rmSync(keyFile(forged));
  writeFileSync(keptFile(forged), JSON.stringify({ v: 1, id: 'AAAAAAAA-0000-4000-8000-000000000001' }));
  downloads(await start(forged, unreadable(), api), 'a kept answer without a MAC');
  // the control: in the store that kept it, with the read failing, the same answer IS used (no download)
  opensWithoutDownload(await start(home, a(true), api), 'machine A, the read fails, its own store');
});

test('15.2 Node, the first start ever with a read that fails uses the key file; when the read works later that answer wins: one more download, then stable in both directions', async () => {
  // This is what the rule costs in its one corner: "only when the read fails and nothing is kept does the key
  // file apply", and "a read that works wins".
  const vol = volume(), api = await stubPlatform({ build });
  const pc = (fails) => machine({ platform: 'win32', commandId: 'CCCCCCCC-0000-4000-8000-000000000003', fails });
  downloads(await start(vol, pc(true), api), 'start 1 (the read fails, nothing is kept: the key file)');
  opensWithoutDownload(await start(vol, pc(true), api), 'start 2 (fails again: the same key file)');
  downloads(await start(vol, pc(false), api), 'start 3 (the read works for the first time: its answer wins)');
  opensWithoutDownload(await start(vol, pc(true), api), 'start 4 (fails: the kept answer)');
  opensWithoutDownload(await start(vol, pc(false), api), 'start 5 (works)');
});

test('15.2 Node, a user id that the system cannot name (a container whose uid has no passwd entry): the key file needs no user id, and a machine id is bound with the process\'s uid', async () => {
  const noUser = (m) => { m.parts.os.userInfo = () => { throw Object.assign(new Error('ENOENT: no such file or directory, uv_os_get_passwd'), { code: 'ENOENT' }); }; return m; };
  const vol = volume(), api = await stubPlatform({ build });
  downloads(await start(vol, noUser(machine()), api), 'no machine id and no user name');
  opensWithoutDownload(await start(vol, noUser(machine()), api), 'the second start');
  // with a machine id: the uid of the process stands in where the system has one, else the store fails (as before)
  const m = noUser(machine({ fileId: 'feedfacefeedfacefeedfacefeedface' }));
  const key = install.derivedDeviceKey(m.parts, { store: volume().store, platform: 'linux', getuid: () => 4242 });
  const want = createHmac('sha256', createHash('sha256').update('quranlab-model-install-key 1\nfeedfacefeedfacefeedfacefeedface\n4242\n').digest()).update('text').digest('hex');
  assert.equal(await (await key.key({ create: true })).mac('text'), want);
  await assert.rejects(install.derivedDeviceKey(m.parts, { store: volume().store, platform: 'linux', getuid: null }).key({ create: true }), (e) => e instanceof InstallKeyError);
});

// ------------------------------------------------------------------ W3: the browser's key store against stand-ins

// What real browsers were seen to answer (the probe of 2026-11-13; Chrome 157.0.8103.52, Edge 157.0.4341.46,
// Firefox 150.0.3), as stand-ins for IndexedDB and Cache Storage:
const dom = (name, message) => new DOMException(message, name);
const SEEN = {
  // Firefox, cookies blocked (and a third-party frame with third-party cookies blocked): open() throws
  firefoxBlocked: () => ({ open() { throw dom('SecurityError', 'IDBFactory.open: The operation is insecure'); } }),
  // Chrome and Edge, a frame without an origin: open() throws
  chromeOpaque: () => ({ open() { throw dom('SecurityError', "Failed to execute 'open' on 'IDBFactory': access to the Indexed Database API is denied in this context."); } }),
  // Chrome and Edge, site data blocked: the request fails later, with the name a real internal failure has too
  chromeBlocked: () => requestFails(dom('UnknownError', 'The user denied permission to access the database.')),
};
function requestFails(error) { return { open() { const q = {}; setTimeout(() => { q.error = error; if (q.onerror) q.onerror(); }, 0); return q; } }; }
const cachesBlocked = () => ({
  async has() { throw dom('SecurityError', "Failed to execute 'has' on 'CacheStorage': An attempt was made to break through the security policy of the user agent."); },
  async open() { throw dom('SecurityError', "Failed to execute 'open' on 'CacheStorage': An attempt was made to break through the security policy of the user agent."); },
});
const cachesWorking = () => ({ async has() { return false; }, async open() { return {}; } });
// an IndexedDB that opens; `failing` makes every transaction on it fail
function workingIdb({ failing = null } = {}) {
  const kept = new Map();
  return {
    kept,
    open() {
      const q = {};
      setTimeout(() => {
        q.result = { transaction() {
          const t = {};
          const done = (fn) => setTimeout(() => { if (failing) { t.error = failing; if (t.onerror) t.onerror(); } else { fn(); if (t.oncomplete) t.oncomplete(); } }, 0);
          t.objectStore = () => ({
            get(k) { const r = {}; done(() => { r.result = kept.get(k); }); return r; },
            add(v, k) { const r = {}; done(() => { if (!kept.has(k)) kept.set(k, v); }); return r; },
          });
          return t;
        } };
        if (q.onsuccess) q.onsuccess();
      }, 0);
      return q;
    },
  };
}

test('15.2 a browser whose IndexedDB is there and blocked counts as no store: a key for the page load (stand-ins for what Firefox and Chrome answer)', async () => {
  for (const [what, idb, caches] of [
    ['Firefox, cookies blocked: open() throws SecurityError', SEEN.firefoxBlocked(), cachesBlocked],
    ['a SecurityError at open() is "blocked" whatever Cache Storage says', SEEN.firefoxBlocked(), cachesWorking],
    ['Chrome, a frame without an origin: open() throws SecurityError', SEEN.chromeOpaque(), () => { throw dom('SecurityError', "Failed to read the 'caches' property from 'Window'"); }],
    ['Chrome, site data blocked: UnknownError on the request while Cache Storage refuses with SecurityError', SEEN.chromeBlocked(), cachesBlocked],
    ['the same, with a Cache Storage whose getter throws SecurityError', SEEN.chromeBlocked(), () => { throw dom('SecurityError', 'denied'); }],
    ['a SecurityError on the request', requestFails(dom('SecurityError', 'denied')), cachesWorking],
  ]) {
    const store = install.browserDeviceKey(idb, 'quranlab-install', { cacheStorage: caches });
    // no key, and none is made by asking
    assert.equal(await store.key({ create: false }).catch((e) => `threw ${e.name}: ${e.message}`), null, what);
    // a key for this page load: made at need, the same for the whole load
    const inst = new install.Installs({ store: delivery.memoryStore(), deviceKey: store });
    await inst.write('b'.repeat(40), 'installed');
    assert.equal(await inst.state('b'.repeat(40)), 'installed', `${what}: the record made in this load is valid in this load`);
    assert.equal(store.blocked, true, `${what}: the store says it is blocked`);
    // another load (another key store object): nothing from before counts
    const next = install.browserDeviceKey(idb, 'quranlab-install', { cacheStorage: caches });
    assert.equal(await new install.Installs({ store: inst.store, deviceKey: next }).state('b'.repeat(40)), null, `${what}: another load has another key`);
  }
});

test('15.2 a failure that is not "blocked" stays "the store failed": nothing is taken for a blocked store by its name alone, and a store that opened and then fails is an error', async () => {
  const fails = async (what, idb, caches) => {
    const store = install.browserDeviceKey(idb, 'quranlab-install', { cacheStorage: caches });
    for (const create of [false, true]) await assert.rejects(store.key({ create }), (e) => e instanceof InstallKeyError && e.code === 'key_store_failed', `${what} (create ${create})`);
    assert.notEqual(store.blocked, true, what);
  };
  // Chrome's name for a real internal failure, while Cache Storage works: not blocked
  await fails('UnknownError while Cache Storage works', requestFails(dom('UnknownError', 'Internal error opening backing store for indexedDB.open.')), cachesWorking);
  // even with Chrome's own sentence for a denied permission: the text is never what decides
  await fails('the denied sentence while Cache Storage works', requestFails(dom('UnknownError', 'The user denied permission to access the database.')), cachesWorking);
  await fails('UnknownError where there is no Cache Storage to ask', requestFails(dom('UnknownError', 'x')), () => undefined);
  await fails('UnknownError while Cache Storage fails in another way', requestFails(dom('UnknownError', 'x')), () => ({ async has() { throw dom('UnknownError', 'Unexpected internal error.'); }, async open() { throw dom('UnknownError', 'Unexpected internal error.'); } }));
  for (const name of ['AbortError', 'QuotaExceededError', 'InvalidStateError', 'VersionError', 'TimeoutError', 'NotFoundError', 'DataError']) {
    await fails(`${name} at open, also while Cache Storage is blocked`, requestFails(dom(name, 'x')), cachesBlocked);
  }
  await fails('an open() that throws something else', { open() { throw new TypeError('not a function'); } }, cachesBlocked);
  // a store that opened and then fails on a read: an error, whatever the error's name and whatever Cache Storage says
  await fails('opened, then the read fails with UnknownError', workingIdb({ failing: dom('UnknownError', 'Internal error.') }), cachesBlocked);
  await fails('opened, then the read fails with SecurityError', workingIdb({ failing: dom('SecurityError', 'x') }), cachesBlocked);
  // and the working store still works, and is not "blocked"
  const idb = workingIdb();
  const store = install.browserDeviceKey(idb, 'quranlab-install', { cacheStorage: cachesBlocked });
  assert.equal(await store.key({ create: false }), null);
  assert.ok(await store.key({ create: true }));
  assert.equal(idb.kept.size, 1, 'the key was stored');
  assert.notEqual(store.blocked, true);
  assert.equal(store.kind, 'indexeddb');
});

test('15.2 the model cache of a browser that blocks storage is memory for the page load; a Cache Storage that fails in another way is not taken for a blocked one', async () => {
  assert.equal(typeof delivery.openDefaultStore, 'function', 'delivery.openDefaultStore');
  // blocked (Chrome, Edge and Firefox answer SecurityError to every call of CacheStorage; a frame without an
  // origin throws it at the getter)
  for (const cacheStorage of [cachesBlocked, () => { throw dom('SecurityError', 'denied'); }]) {
    const store = await delivery.openDefaultStore({ cacheStorage, indexedDB: () => SEEN.chromeBlocked() });
    assert.deepEqual([store.kind, store.blocked], ['memory', true]);
    await store.put('sha256/x', new Uint8Array([1]));
    assert.deepEqual(await store.keys(''), ['sha256/x']);
    // what a removal does there: this load's entries, and it does not ask the stores the browser refuses
    assert.equal(await install.removeAllModels(store), 1);
  }
  // a Cache Storage that works: the Cache API store, as before
  assert.deepEqual([(await delivery.openDefaultStore({ cacheStorage: () => ({ async has() { return false; }, open() {} }), indexedDB: () => undefined })).kind], ['cache-api']);
  // one that fails in another way: still the Cache API store (its own calls will fail as storage errors; a good
  // cache is never set aside for a failure that may pass)
  const odd = await delivery.openDefaultStore({ cacheStorage: () => ({ async has() { throw dom('UnknownError', 'Unexpected internal error.'); }, open() {} }), indexedDB: () => undefined });
  assert.deepEqual([odd.kind, odd.blocked], ['cache-api', undefined]);
  // no Cache Storage at all: IndexedDB, else memory (as before; not "blocked")
  assert.equal((await delivery.openDefaultStore({ cacheStorage: () => undefined, indexedDB: () => ({}) })).kind, 'indexeddb');
  const none = await delivery.openDefaultStore({ cacheStorage: () => undefined, indexedDB: () => undefined });
  assert.deepEqual([none.kind, none.blocked], ['memory', undefined]);
});

test('15.2 the device key of this runtime: Node gets the store\'s key store (and this machine\'s own id, read for real, gives the same key twice)', async () => {
  const vol = volume();
  const a = install.defaultDeviceKey(vol.store), b = install.defaultDeviceKey(vol.store);
  assert.equal(a.kind, 'derived');
  const first = await (await a.key({ create: true })).mac('text');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await (await b.key({ create: false })).mac('text'), first, 'a second process on this machine has the same key');
});
