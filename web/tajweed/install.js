// The install record (SPEC section 15.2, SDK 3.1.0): the Client opens only a model build it downloaded itself.
//
// When the Client starts downloading a build it writes a record for that build with the state `downloading`,
// before the first request for a file; when every file of the download profile is verified it rewrites it with
// the state `installed`. The record is bound to the device:
//
//   mac = HMAC-SHA256(device key, "quranlab-model-install 1\n" + <build id, 40 hex> + "\n" + <state> + "\n")
//
// A build in the cache without a valid record is not the Client's: it is never opened, none of its files is
// reused or resumed, it is deleted, and the build is downloaded. The cache is keyed by content (a file shared by
// builds is stored once), so a cached file counts only when the manifest of a build with a valid record lists it.
//
// The record lives in the delivery store under "install/<build id>" (never a file a manifest lists). The device
// key:
//   a browser:  a non-extractable HMAC CryptoKey kept in IndexedDB (database "quranlab-install"). Code of the
//               same origin can use that key; files copied into the cache cannot carry it.
//               A browser whose IndexedDB is there and BLOCKED has no place for the key (3.1.2, contract 1.14.0):
//               it gets a key for the page load, as a runtime with no IndexedDB does. What "blocked" is, as real
//               browsers answered on 2026-11-13, is at browserDeviceKey below.
//   Node:       no such store exists. The key is SHA-256("quranlab-model-install-key 1\n" + machine id + "\n" +
//               user id): the machine id of the system (/etc/machine-id, the registry's MachineGuid, the Mac's
//               platform UUID), the user id of the process. Since 3.1.2:
//               - no machine id can be read (a container without /etc/machine-id): the key is 32 random bytes
//                 in a file of the store ("device/key", mode 0600), made at first need. Never the host name: a
//                 container's host name is new at every start, so a key made from it was new at every start.
//                 A copied store carries this file.
//               - a machine id that a command reads (`reg`, `ioreg`: it can fail or time out): a read that works
//                 wins and its answer is kept in the store ("device/machine"); the kept answer is used only
//                 when a later read fails, and only when this store's own key file vouches for it. A read that
//                 works and differs from the kept answer means the store came from another machine: its
//                 records are not valid here (nothing is reported; a restored backup is the ordinary cause).
//   a runtime with no IndexedDB and no Node: a key for this page load only, so nothing kept from an earlier load
//               counts.
// The key store answers "there is no key": no record can be valid. It fails in another way (IndexedDB opened
// and cannot be read, a key file that cannot be read): InstallKeyError; the caller opens nothing, deletes
// nothing and downloads nothing.

import { node, isNode } from '../platform/node-hook.js';
import { CACHE_NAME, cacheApiStore, indexedDbStore, memoryStore, cacheStorageState, isSecurityError } from './delivery.js';

/** The prefix of the records in the delivery store. */
export const INSTALL_PREFIX = 'install/';
/** Every entry of a delivery store that belongs to a model: the files, the ranges of a partial download, the
 * stored manifests, the install records. Nothing else lives in that store. */
export const MODEL_PREFIXES = Object.freeze(['sha256/', 'part/', 'manifest/', INSTALL_PREFIX]);

/** Deletes every model entry of one store; returns how many. Throws when the store fails. */
export async function removeModelEntries(store) {
  let n = 0;
  for (const p of MODEL_PREFIXES) for (const k of await store.keys(p)) { await store.delete(k); n++; }
  return n;
}

/**
 * Every model the SDK holds, in every store it wrote (SPEC 15.3, contract 1.10.0; what removeModels removes):
 * `store`, and in a browser the other kind of store under the SDK's name when one exists (the Cache API and
 * IndexedDB; a store is only opened when it is there, so none is made by looking). The device key (its own
 * IndexedDB database), the state and the sharing queue are other stores and are never touched. Returns the
 * number of entries deleted. Throws when a store fails (the caller owes the removal and tries again).
 */
export async function removeAllModels(store) {
  let n = await removeModelEntries(store);
  // a browser that blocks storage (the page load's memory store): its other stores refuse every call, and the SDK
  // can have written nothing to them in this state
  if (store.blocked) return n;
  const g = globalThis;
  if (store.kind !== 'cache-api' && g.caches && typeof g.caches.has === 'function' && await g.caches.has(CACHE_NAME)) {
    n += await removeModelEntries(cacheApiStore());
  }
  if (store.kind !== 'indexeddb' && g.indexedDB && typeof g.indexedDB.databases === 'function'
    && (await g.indexedDB.databases()).some((d) => d && d.name === CACHE_NAME)) {
    n += await removeModelEntries(indexedDbStore());
  }
  return n;
}
/** The states of a record. */
export const INSTALL_STATES = Object.freeze(['downloading', 'installed']);
const BUILD_RE = /^[0-9a-f]{40}$/;
const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const subtle = () => globalThis.crypto.subtle;
const HMAC = { name: 'HMAC', hash: 'SHA-256' };

/** The text a record's MAC is made over. */
export const installText = (build, state) => `quranlab-model-install 1\n${build}\n${state}\n`;

/** The device key cannot be reached (not "there is none"): nothing is opened, deleted or downloaded. */
export class InstallKeyError extends Error {
  constructor(message, options) { super(message, options); this.name = 'InstallKeyError'; this.code = 'key_store_failed'; }
}

const signerOf = (key) => ({ async mac(text) { return hex(await subtle().sign('HMAC', key, enc.encode(text))); } });

/**
 * Whether a failure of `indexedDB.open` means that the browser BLOCKS storage here (no store: a key for the page
 * load), and not that a store failed (InstallKeyError). The list is what real browsers answered on 2026-11-13 and
 * nothing more:
 *   - SecurityError, thrown by open() or given on its request. Firefox 150 with cookies blocked, and in a
 *     third-party frame with third-party cookies blocked, throws it; Chrome 157 and Edge 157 throw it in a frame
 *     without an origin. No browser gives this name for a store that failed.
 *   - UnknownError on the request, ONLY while Cache Storage of the same context refuses with SecurityError.
 *     Chrome 157 and Edge 157 with the site's cookies and site data blocked answer indexedDB.open with
 *     UnknownError ("The user denied permission to access the database."), the name they also give a real
 *     internal failure, so the name alone decides nothing, and the message's text is never read. In that state
 *     the same browsers reject every call of CacheStorage with SecurityError, which a store that merely failed
 *     never does. And the model cache is then blocked too (memory for the page load), so a wrong call here
 *     could not cost a cached model.
 * Anything else (QuotaExceededError, AbortError, VersionError, a blocked version change, an UnknownError while
 * Cache Storage works, any failure after the database opened) is a store that failed.
 * Not blocked, by the same runs: private windows of Chrome, Edge and Firefox, and a third-party frame in Chrome
 * and Edge (its storage is partitioned and works).
 */
async function openBlocked(e, cacheStorage) {
  if (isSecurityError(e)) return true;
  if (!e || e.name !== 'UnknownError') return false;
  return (await cacheStorageState(cacheStorage)) === 'blocked';
}

const AT_OPEN = Symbol('indexedDB.open failed');

/**
 * The device key of a browser: a non-extractable HMAC key in IndexedDB.
 * key({ create }): the signer, or null when there is no key and none is to be made. Throws InstallKeyError when
 * IndexedDB fails: it cannot be opened for a reason that is not "blocked", or it opened and cannot be read or
 * written. An IndexedDB that is blocked (openBlocked above) is no store: the key is then one for this page load
 * (`blocked` is true from then on), so nothing kept from an earlier load counts.
 * @param {{ cacheStorage?: () => any }} [o]  how Cache Storage is read (tests)
 */
export function browserDeviceKey(idb = globalThis.indexedDB, name = 'quranlab-install', o = {}) {
  const cacheStorage = o.cacheStorage || (() => globalThis.caches);
  let dbp = null;
  let pageLoad = null; // the key of this page load, once the store was found blocked
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const failed = (error) => rej({ [AT_OPEN]: true, error });
    let q;
    try { q = idb.open(name, 1); } catch (e) { failed(e); return; }
    q.onupgradeneeded = () => q.result.createObjectStore('keys');
    q.onsuccess = () => res(q.result);
    q.onerror = () => failed(q.error);
    // another page holds the database at an older version: a store that failed for now, not blocked storage
    q.onblocked = () => rej(new Error('the database is blocked'));
  }).catch((e) => { dbp = null; throw e; }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('keys', mode);
      const r = fn(t.objectStore('keys'));
      t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  const self = {
    kind: 'indexeddb',
    blocked: false,
    async key({ create = false } = {}) {
      if (pageLoad) return pageLoad.key({ create });
      try {
        let k = await tx('readonly', (s) => s.get('device'));
        if (!k && create) {
          const made = await subtle().generateKey({ ...HMAC, length: 256 }, false, ['sign', 'verify']);
          // another page of this origin may have made one meanwhile: the first one stored stays
          await tx('readwrite', (s) => s.add(made, 'device')).catch(() => {});
          k = await tx('readonly', (s) => s.get('device'));
        }
        return k ? signerOf(k) : null;
      } catch (e) {
        const atOpen = !!(e && e[AT_OPEN]);
        const cause = atOpen ? e.error : e;
        if (atOpen && await openBlocked(cause, cacheStorage)) {
          // no store: a key for this page load (decided once; the same key for the whole load)
          pageLoad = pageLoad || memoryDeviceKey();
          self.blocked = true;
          return pageLoad.key({ create });
        }
        throw new InstallKeyError(`the device key store cannot be used: ${(cause && cause.message) || cause}`, { cause });
      }
    },
  };
  return self;
}

/** A key for this page load only (a runtime with no IndexedDB): nothing kept from an earlier load counts. */
export function memoryDeviceKey() {
  let signer = null;
  return {
    kind: 'memory',
    async key({ create = false } = {}) {
      if (!signer && create) signer = signerOf(await subtle().generateKey({ ...HMAC, length: 256 }, false, ['sign', 'verify']));
      return signer;
    },
  };
}

/** The store's key file (Node): 32 random bytes; and the kept answer of a machine id that a command read. Neither
 * is a model entry (MODEL_PREFIXES): a removal of the models and a sweep leave both. */
export const KEY_FILE = 'device/key';
export const KEPT_MACHINE = 'device/machine';
/** The text the store's key file signs to vouch for a kept machine id. */
export const machineText = (id) => `quranlab-model-install-machine 1\n${id}\n`;

// The system's machine id, as far as Node can read one without a native module: { id, byCommand } when one was
// read, { id: null, commandFailed } when none was. A file gives it on Linux; on Windows and a Mac a command of
// the system does, which can fail or time out (5 s). The host name is not a machine id and is never read.
function readMachineId({ fs, execFileSync }, platform) {
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return { id: t, byCommand: false }; } catch (_) { /* not this system */ }
  }
  if (platform !== 'win32' && platform !== 'darwin') return { id: null, commandFailed: false };
  try {
    if (platform === 'win32' && execFileSync) {
      const out = String(execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
      const m = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out);
      if (m) return { id: m[1], byCommand: true };
    }
    if (platform === 'darwin' && execFileSync) {
      const out = String(execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      if (m) return { id: m[1], byCommand: true };
    }
  } catch (_) { /* the command failed or did not answer in time */ }
  return { id: null, commandFailed: true };
}

const hmacKey = (raw) => subtle().importKey('raw', raw, HMAC, false, ['sign']);

/**
 * The device key of Node (no secure store exists there), kept with the Client's store (SPEC 15.2 as of contract
 * 1.14.0).
 *   - A machine id can be read: SHA-256("quranlab-model-install-key 1\n" + machine id + "\n" + user id), as since
 *     3.1.0.
 *   - It is read by a command (Windows, a Mac): a read that works wins, and its answer is kept in the store
 *     (KEPT_MACHINE, with a MAC made with the store's key file). When a later read fails, the kept answer is
 *     used, so a slow start cannot change the key. A kept answer counts only when this store's key file vouches
 *     for it: one copied in without its store is not used. A read that works and differs from the kept answer
 *     wins too: the store came from another machine, its records are not valid here, and nothing is reported.
 *   - No machine id can be read and no kept answer counts: the key is the store's key file (KEY_FILE): 32
 *     random bytes, mode 0600 where the system has modes, made at first need by an exclusive create. A copied
 *     store carries it. A key file that cannot be read is InstallKeyError; one of another length is no key and is
 *     replaced when a key is to be made.
 * key({ create }): the signer; null when the key would be the key file, there is none and none is to be made.
 * @param {object} [parts]  Node's parts: { fs, os, execFileSync }
 * @param {{ store?: object, platform?: string, getuid?: (() => number)|null }} [o]  the store that holds the key
 *   file and the kept answer (the Client's delivery store; without one, a store that lasts as long as this
 *   object); the platform and the process's uid (tests)
 */
export function derivedDeviceKey(parts = node(), o = {}) {
  const store = o.store || memoryStore();
  const proc = globalThis.process;
  const platform = o.platform || (proc && proc.platform);
  const getuid = o.getuid !== undefined ? o.getuid : (proc && typeof proc.getuid === 'function' ? () => proc.getuid() : null);
  let signer = null;

  // the user id of the process; where the system cannot name the user (a container whose uid has no passwd
  // entry), the uid itself
  const userId = () => {
    try {
      const u = parts.os.userInfo();
      return typeof u.uid === 'number' && u.uid >= 0 ? String(u.uid) : String(u.username);
    } catch (e) {
      if (typeof getuid === 'function') return String(getuid());
      throw e;
    }
  };
  // the store's key file: its 32 bytes, or null when there is none (or one of another length) and none is made.
  // Throws when it cannot be read.
  const keyFile = async (create) => {
    let b = await store.get(KEY_FILE);
    if (b && b.length === 32) return b;
    if (!create) return null;
    if (b) await store.delete(KEY_FILE); // another length: no key; replaced
    await store.put(KEY_FILE, globalThis.crypto.getRandomValues(new Uint8Array(32)), { mode: 0o600, exclusive: true });
    b = await store.get(KEY_FILE); // another process may have made one meanwhile: the first one's bytes stay
    if (!b || b.length !== 32) throw new Error('the key file of the store could not be written');
    return b;
  };
  const vouch = async (secret, id) => hex(await subtle().sign('HMAC', await hmacKey(secret), enc.encode(machineText(id))));
  // the kept answer, when this store's key file vouches for it; else null
  const kept = async (secret) => {
    const raw = await store.get(KEPT_MACHINE);
    if (!raw || !secret) return null;
    let rec = null;
    try { rec = JSON.parse(new TextDecoder().decode(raw)); } catch (_) { rec = null; }
    if (!rec || typeof rec.id !== 'string' || !rec.id || typeof rec.mac !== 'string') return null;
    return (await vouch(secret, rec.id)) === rec.mac ? rec.id : null;
  };
  // a read that worked is kept (written only when it is not what is kept already)
  const keep = async (id) => {
    const secret = await keyFile(true);
    if ((await kept(secret)) === id) return;
    await store.put(KEPT_MACHINE, enc.encode(JSON.stringify({ v: 1, id, mac: await vouch(secret, id) })));
  };

  // one call at a time: two calls that find no key file (model() and prefetch() started together) must not each
  // make one
  let queue = Promise.resolve();
  const oneAtATime = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
  return {
    kind: 'derived',
    key: ({ create = false } = {}) => oneAtATime(async () => {
      if (signer) return signer;
      try {
        const read = readMachineId(parts, platform);
        let id = read.id;
        // a command's answer is kept; the store being unwritable does not change which key this start has
        if (id && read.byCommand) await keep(id).catch(() => {});
        if (!id && read.commandFailed) id = await kept(await keyFile(false));
        if (id) {
          const raw = await subtle().digest('SHA-256', enc.encode(`quranlab-model-install-key 1\n${id}\n${userId()}\n`));
          signer = signerOf(await hmacKey(raw));
          return signer;
        }
        const bytes = await keyFile(create);
        if (!bytes) return null; // there is no key
        signer = signerOf(await hmacKey(bytes));
        return signer;
      } catch (e) {
        throw new InstallKeyError(`the device key cannot be made: ${(e && e.message) || e}`, { cause: e });
      }
    }),
  };
}

/**
 * The device key of this runtime. `store`: the Client's delivery store (Node keeps its key file and the kept
 * machine id there).
 */
export function defaultDeviceKey(store) {
  if (isNode()) return derivedDeviceKey(node(), { store });
  if (globalThis.indexedDB) return browserDeviceKey();
  return memoryDeviceKey();
}

/**
 * The install records of one delivery store.
 * @param {{ store: object, deviceKey: { key(o?: {create?: boolean}): Promise<{mac(text: string): Promise<string>}|null> } }} o
 */
export class Installs {
  constructor({ store, deviceKey }) { this.store = store; this.deviceKey = deviceKey; }

  /** The state of a build's record: 'downloading', 'installed', or null (no record, or not a valid one). Throws
   * InstallKeyError when the key store fails. */
  async state(build) {
    if (!BUILD_RE.test(String(build))) return null;
    const raw = await this.store.get(INSTALL_PREFIX + build);
    if (!raw) return null;
    let rec = null;
    try { rec = JSON.parse(new TextDecoder().decode(raw)); } catch (_) { rec = null; }
    if (!rec || rec.build !== build || !INSTALL_STATES.includes(rec.state) || typeof rec.mac !== 'string') return null;
    const signer = await this.deviceKey.key({ create: false });
    if (!signer) return null; // there is no key: no record can be valid
    return (await signer.mac(installText(build, rec.state))) === rec.mac ? rec.state : null;
  }

  /** Writes the record of a build (the key is made at first need). */
  async write(build, state) {
    const signer = await this.deviceKey.key({ create: true });
    const rec = { v: 1, build, state, mac: await signer.mac(installText(build, state)) };
    await this.store.put(INSTALL_PREFIX + build, enc.encode(JSON.stringify(rec)));
  }

  /**
   * Deletes what is not the Client's: every record that is not valid, every cached manifest of a build without a
   * valid record, and every cached file and range that no manifest of a build with a valid record lists.
   * Returns how many entries were deleted. Throws InstallKeyError (and deletes nothing) when the key store fails.
   */
  async sweep() {
    const store = this.store;
    // every answer of the key store first: nothing is deleted when it fails
    const valid = new Set(), stale = [];
    for (const k of await store.keys(INSTALL_PREFIX)) {
      const build = k.slice(INSTALL_PREFIX.length);
      if (await this.state(build)) valid.add(build); else stale.push(k);
    }
    const keep = new Set(), drop = [...stale];
    for (const k of await store.keys('manifest/')) {
      const raw = await store.get(k);
      let m = null;
      const build = raw ? hex(await subtle().digest('SHA-256', raw)).slice(0, 40) : null;
      if (build && valid.has(build)) { try { m = JSON.parse(new TextDecoder().decode(raw)); } catch (_) { m = null; } }
      if (!m || !Array.isArray(m.files)) { drop.push(k); continue; }
      for (const f of m.files) {
        if (f && typeof f.sha256 === 'string') keep.add(f.sha256.toLowerCase());
        if (f && f.decoded && typeof f.decoded.sha256 === 'string') keep.add(f.decoded.sha256.toLowerCase());
      }
    }
    for (const k of await store.keys('sha256/')) if (!keep.has(k.slice(7))) drop.push(k);
    for (const k of await store.keys('part/')) if (!keep.has(k.split('/')[1])) drop.push(k);
    for (const k of drop) await store.delete(k);
    return drop.length;
  }

  /** Forgets every record (removeModels). */
  async clear() { for (const k of await this.store.keys(INSTALL_PREFIX)) await this.store.delete(k); }
}
