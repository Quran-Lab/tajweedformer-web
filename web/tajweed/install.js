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
//   Node:       no such store exists. The key is SHA-256("quranlab-model-install-key 1\n" + machine id + "\n" +
//               user id): the machine id of the system (/etc/machine-id, the registry's MachineGuid, the Mac's
//               platform UUID; the host name where none can be read), the user id of the process.
//   a runtime with no IndexedDB and no Node: a key for this page load only, so nothing kept from an earlier load
//               counts.
// The key store answers "there is no key": no record can be valid. It fails in another way (IndexedDB is there
// and cannot be opened or read): InstallKeyError; the caller opens nothing, deletes nothing and downloads nothing.

import { node, isNode } from '../platform/node-hook.js';
import { CACHE_NAME, cacheApiStore, indexedDbStore } from './delivery.js';

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
 * The device key of a browser: a non-extractable HMAC key in IndexedDB.
 * key({ create }): the signer, or null when there is no key and none is to be made. Throws InstallKeyError when
 * IndexedDB cannot be opened, read or written.
 */
export function browserDeviceKey(idb = globalThis.indexedDB, name = 'quranlab-install') {
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const q = idb.open(name, 1);
    q.onupgradeneeded = () => q.result.createObjectStore('keys');
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
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
  return {
    kind: 'indexeddb',
    async key({ create = false } = {}) {
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
        throw new InstallKeyError(`the device key store cannot be used: ${(e && e.message) || e}`, { cause: e });
      }
    },
  };
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

// the system's machine id, as far as Node can read one without a native module
function machineId({ fs, os, execFileSync }) {
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch (_) { /* not this system */ }
  }
  try {
    if (process.platform === 'win32' && execFileSync) {
      const out = String(execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
      const m = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out);
      if (m) return m[1];
    }
    if (process.platform === 'darwin' && execFileSync) {
      const out = String(execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      if (m) return m[1];
    }
  } catch (_) { /* no such tool: the host name */ }
  return `host:${os.hostname()}`;
}

/** The device key of Node: derived from the machine id and the user id (no secure store exists there). */
export function derivedDeviceKey(parts = node()) {
  let signer = null;
  return {
    kind: 'derived',
    async key() {
      if (signer) return signer;
      try {
        const u = parts.os.userInfo();
        const user = typeof u.uid === 'number' && u.uid >= 0 ? String(u.uid) : String(u.username);
        const raw = await subtle().digest('SHA-256', enc.encode(`quranlab-model-install-key 1\n${machineId(parts)}\n${user}\n`));
        signer = signerOf(await subtle().importKey('raw', raw, HMAC, false, ['sign']));
        return signer;
      } catch (e) {
        throw new InstallKeyError(`the device key cannot be derived: ${(e && e.message) || e}`, { cause: e });
      }
    },
  };
}

/** The device key of this runtime. */
export function defaultDeviceKey() {
  if (isNode()) return derivedDeviceKey();
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
