// Storage of the engine Worker, on Quran Lab's origin (partitioned by the browser per top-level site):
//
//   Files     the model's ciphertext by form and decoded path (the CDN form while installing, then the device form
//             the Core writes; contract 18.2.1) and the plain calibration. The Core reads and writes them
//             synchronously, so in a browser they are in the origin private file system through
//             FileSystemSyncAccessHandle (dedicated Workers only), opened before each Core call that uses them.
//             MemoryFiles is the fallback where the browser blocks storage (a private window): the model is then
//             downloaded at every visit, as in 3.x. No plaintext model file is ever stored.
//   KV        the SDK's small state (telemetry days and sealed reports, the take journal, the config, the stop)
//             and the Core's own journal file (QLC_FORM_CORE, "r1"), in IndexedDB. Every change of one step is
//             written in ONE transaction (flush), so a kill leaves either the step or nothing.
//
// The lease across page loads (lease-store.js) is one KV record: the install keys as non-extractable CryptoKeys, the
// certificate, and the Core's saved state sealed under a non-extractable AES-GCM key. Never stored: a private key's
// bytes, the build key, the app token (per page load).
//
// When the browser's storage fails (R402-3, the hosted patch on 4.0.2; Gate C 11-23: iOS answered UnknownError, macOS
// Safari NotSupportedError "Backend does not support this operation", Chrome NoModificationAllowedError and
// InvalidStateError, and each escaped the frame's call as a raw DOMException: engine_failed, reported session/other):
//   - every failure of a store is tagged (storeFailure): stage storage, reason quota (a full store), read or write,
//     error_code the call that failed, the DOMException's name kept as error_name; the app gets storage_full or
//     storage_failed (ERRORS_40.md 24.4 rule 5);
//   - the OPFS store is probed when it opens, on a file of its own; a browser that refuses any part of it gets the
//     memory store for the page load (openFiles names the probe that failed, for a silent report);
//   - put() and get() ask again for a file another page of the site holds, as open() does;
//   - the SDK's own records (the state, the file index) never fail a call: a write that failed is said through the
//     store's onFailure (set by the controller: a silent report) and written again later.
import { QLC } from './core.js';

const keyOf = (form, path) => `${form}\n${path}`;

/**
 * A failure of one of the frame's stores, readable by the error reports and the app (error-reports.js classify, and
 * web/api/errors.js toTajweedError read `qlReport`): stage `storage`, reason `quota` for a full store
 * (QuotaExceededError), else `reason` (read or write), and error_code `call`, the call that failed (opfs_put,
 * idb_write, ...). The error keeps its name and message; one tagged already keeps its tag (the innermost call names it).
 * Returns the error to throw.
 */
export function storeFailure(e, call, reason = 'write') {
  if (e && typeof e === 'object' && e.qlReport) return e;
  const tag = { stage: 'storage', reason: e && e.name === 'QuotaExceededError' ? 'quota' : reason, error_code: call };
  if (e && typeof e === 'object') {
    try { e.qlReport = tag; } catch (_) { /* a frozen error: wrapped below */ }
    if (e.qlReport === tag) return e;
  }
  const w = new Error(e && e.message ? String(e.message) : String(e));
  w.name = e && typeof e.name === 'string' ? e.name : 'Error';
  w.cause = e;
  w.qlReport = tag;
  return w;
}

const told = (store, e) => { if (typeof store.onFailure === 'function') { try { store.onFailure(e); } catch (_) { /* never in the way */ } } };

class Growing {
  constructor() { this.a = new Uint8Array(1 << 16); this.n = 0; }
  write(off, b) {
    if (off + b.length > this.a.length) { const c = new Uint8Array(Math.max(2 * this.a.length, off + b.length)); c.set(this.a.subarray(0, this.n)); this.a = c; }
    this.a.set(b, off);
    this.n = Math.max(this.n, off + b.length);
  }
  bytes() { return this.a.slice(0, this.n); }
}

// A file the Core writes into the memory store, in blocks of CHUNK bytes, kept so once committed (the last block
// trimmed): a 66 MB device form costs 66 MB. (4.0.2's doubling buffer and the trimmed copy made at its commit held up
// to three times the file at once: on iOS, where the memory store is the fallback, too much beside the engine.)
const CHUNK = 1 << 20;
class Chunked {
  constructor() { this.chunks = []; this.length = 0; }
  write(off, b) {
    for (let i = 0; i < b.length;) {
      const at = off + i, c = Math.floor(at / CHUNK), o = at % CHUNK, n = Math.min(b.length - i, CHUNK - o);
      while (this.chunks.length <= c) this.chunks.push(null);
      if (!this.chunks[c]) this.chunks[c] = new Uint8Array(CHUNK);
      this.chunks[c].set(b.subarray(i, i + n), o);
      i += n;
    }
    this.length = Math.max(this.length, off + b.length);
  }
  /** Committed: no block past the length, and the last one cut to it. */
  done() {
    const n = Math.ceil(this.length / CHUNK);
    this.chunks.length = n;
    for (let c = 0; c < n; c++) if (!this.chunks[c]) this.chunks[c] = new Uint8Array(CHUNK);
    if (n && this.length % CHUNK) this.chunks[n - 1] = this.chunks[n - 1].slice(0, this.length % CHUNK);
    return this;
  }
  read(off, dst) {
    for (let i = 0; i < dst.length;) {
      const at = off + i, c = Math.floor(at / CHUNK), o = at % CHUNK, n = Math.min(dst.length - i, CHUNK - o);
      dst.set(this.chunks[c].subarray(o, o + n), i);
      i += n;
    }
  }
  bytes() { const out = new Uint8Array(this.length); this.chunks.forEach((b, c) => out.set(b, c * CHUNK)); return out; }
}

/** Files in memory, for one page load (and the tests). onCommit(form, path, bytes) hears of every commit. */
export class MemoryFiles {
  constructor({ onCommit = null } = {}) { this.files = new Map(); this.parts = new Map(); this.onCommit = onCommit; this.kind = 'memory'; }
  size(form, path) { const f = this.files.get(keyOf(form, path)); return f ? f.length : -1; }
  read(form, path, off, dst) {
    const f = this.files.get(keyOf(form, path));
    if (!f || off + dst.length > f.length) return false;
    if (f instanceof Chunked) f.read(off, dst);
    else dst.set(f.subarray(off, off + dst.length));
    return true;
  }
  write(form, path, off, bytes) {
    const k = keyOf(form, path);
    if (!this.parts.has(k) || off === 0) this.parts.set(k, new Chunked());
    this.parts.get(k).write(off, bytes);
    return true;
  }
  commit(form, path) {
    const k = keyOf(form, path), p = this.parts.get(k);
    if (!p) return false;
    this.parts.delete(k);
    this.files.set(k, p.done());
    if (this.onCommit) this.onCommit(form, path, p.bytes());
    return true;
  }
  remove(form, path) {
    if (path === null) { // every device-form file and partial write (a verified stop, 15.3)
      for (const k of [...this.files.keys()]) if (k.startsWith(`${QLC.FORM_DEVICE}\n`)) this.files.delete(k);
      this.parts.clear();
      return true;
    }
    this.files.delete(keyOf(form, path));
    this.parts.delete(keyOf(form, path));
    return true;
  }
  // the async side the controller uses
  async put(form, path, bytes) { this.files.set(keyOf(form, path), bytes); }
  async get(form, path) { const f = this.files.get(keyOf(form, path)); return f instanceof Chunked ? f.bytes() : f || null; }
  async has(form, path) { return this.files.has(keyOf(form, path)); }
  async drop(form, path) { this.remove(form, path); }
  async list() { return [...this.files.keys()].map((k) => { const i = k.indexOf('\n'); return { form: Number(k.slice(0, i)), path: k.slice(i + 1), size: this.files.get(k).length }; }); }
  async clear(forms = [QLC.FORM_PLAIN, QLC.FORM_CDN, QLC.FORM_DEVICE]) { for (const k of [...this.files.keys()]) if (forms.includes(Number(k.split('\n')[0]))) this.files.delete(k); }
  async open() {}
  async close() {}
}

// Another page of the same site (its own frame and Worker, the same storage) holds every committed file's handle for
// the length of its Core call, and a sync access handle is exclusive: createSyncAccessHandle refuses the file meanwhile
// (NoModificationAllowedError; InvalidStateError in some engines). open() asks such a file again every BUSY_STEP_MS, up
// to BUSY_MS for the whole open, and names any it still could not take in `busy`.
const BUSY_MS = 5000, BUSY_STEP_MS = 50;
const lockedOut = (e) => !!e && (e.name === 'NoModificationAllowedError' || e.name === 'InvalidStateError');

/**
 * Files in the origin private file system (a dedicated Worker only: createSyncAccessHandle). A file counts once its
 * name is in the committed index (`index.json`, rewritten after each commit), so a write cut by a kill never counts.
 */
export class OpfsFiles {
  static async create(name = 'quranlab-sdk4') {
    let dir;
    try { dir = await (await globalThis.navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true }); } catch (e) { throw storeFailure(e, 'opfs_probe_dir'); }
    const f = new OpfsFiles(dir);
    await f.probe();
    try {
      const h = await dir.getFileHandle('index.json');
      f.index = new Map(Object.entries(JSON.parse(await (await h.getFile()).text())));
    } catch (_) { f.index = new Map(); }
    return f;
  }
  constructor(dir) { this.dir = dir; this.index = new Map(); this.handles = new Map(); this.kind = 'opfs'; this._dirty = false; this.onFailure = null; }
  _name(form, path) { return `${form}_${encodeURIComponent(path)}`; }

  /**
   * R402-3: whether this browser's OPFS works here, on a file of this store's own (a name no other page uses, gone
   * after): a sync access handle (open, truncate, write, flush, size, read, close: the Core's files), a writable
   * (put() and the index) and getFile (get()). Throws the first failure, tagged with its step (opfs_probe_sync, ...).
   * WebKit on a backend without file handles answers NotSupportedError ("Backend does not support this operation"),
   * iOS UnknownError; Chrome before 108 has a sync access handle whose calls return promises.
   */
  async probe() {
    const n = `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.tmp`;
    const step = async (call, f) => { try { return await f(); } catch (e) { throw storeFailure(e, call); } };
    let h = null;
    try {
      const fh = await step('opfs_probe_file', () => this.dir.getFileHandle(n, { create: true }));
      h = await step('opfs_probe_sync', () => fh.createSyncAccessHandle());
      await step('opfs_probe_sync_io', () => {
        const b = new Uint8Array([113, 108]), r = new Uint8Array(2);
        h.truncate(0);
        const wrote = h.write(b, { at: 0 });
        h.flush();
        const size = h.getSize(), got = h.read(r, { at: 0 });
        if (wrote !== 2 || size !== 2 || got !== 2 || r[0] !== 113 || r[1] !== 108) throw new Error('the sync access handle did not read back what it wrote');
        const x = h;
        h = null;
        x.close();
      });
      await step('opfs_probe_writable', async () => { const w = await fh.createWritable(); await w.write(new Uint8Array([1])); await w.close(); });
      await step('opfs_probe_read', async () => { if ((await (await fh.getFile()).arrayBuffer()).byteLength !== 1) throw new Error('getFile did not read back what was written'); });
    } finally {
      if (h) { try { h.close(); } catch (_) { /* closed */ } }
      await Promise.resolve().then(() => this.dir.removeEntry(n)).catch(() => {});
    }
  }

  async _handle(form, path, write) {
    const n = this._name(form, path);
    if (this.handles.has(n)) return this.handles.get(n);
    try {
      const fh = await this.dir.getFileHandle(n, { create: write });
      const h = await fh.createSyncAccessHandle();
      this.handles.set(n, h);
      return h;
    } catch (e) { throw storeFailure(e, 'opfs_open', write ? 'write' : 'read'); }
  }

  // R402-3: `op` asked again while another page of the site holds the file (BUSY_MS, as open()); its failure tagged
  async _busy(call, reason, op) {
    const until = Date.now() + BUSY_MS;
    for (;;) {
      try { return await op(); } catch (e) {
        if (!lockedOut(e) || Date.now() >= until) throw storeFailure(e, call, reason);
        await new Promise((r) => setTimeout(r, BUSY_STEP_MS));
      }
    }
  }
  /** Open sync handles for every committed file, and for `writes` ([form, path]) to be written. Before a Core call.
   * A file another page of the site holds is waited for (BUSY_MS); one still held after that is named in `busy`. */
  async open(writes = []) {
    this.busy = [];
    const until = Date.now() + BUSY_MS;
    const take = async (form, path, write) => {
      for (;;) {
        try { return await this._handle(form, path, write); } catch (e) {
          if (!lockedOut(e) || Date.now() >= until) { if (lockedOut(e)) this.busy.push(this._name(form, path)); throw e; }
          await new Promise((r) => setTimeout(r, BUSY_STEP_MS));
        }
      }
    };
    for (const k of this.index.keys()) { const i = k.indexOf('\n'); await take(Number(k.slice(0, i)), k.slice(i + 1), false).catch(() => {}); }
    for (const [form, path] of writes) await take(form, path, true);
  }
  /** Close every handle and write the index. After a Core call. */
  async close() {
    for (const h of this.handles.values()) { try { h.flush(); h.close(); } catch (_) { /* closed */ } }
    this.handles.clear();
    // the index is this store's record for the next page load: one that cannot be written fails no call (this page
    // load counts its files from memory); it is said, and written at the next close (R402-3: 4.0.2's raw failure here,
    // from the `finally` after an install, replaced the call's own outcome)
    if (this._dirty) {
      try {
        const h = await (await this.dir.getFileHandle('index.json', { create: true })).createWritable();
        await h.write(JSON.stringify(Object.fromEntries(this.index)));
        await h.close();
        this._dirty = false;
      } catch (e) { told(this, storeFailure(e, 'opfs_index')); }
    }
    for (const n of this._doomed || []) await this.dir.removeEntry(n).catch(() => {});
    this._doomed = [];
  }
  size(form, path) { const s = this.index.get(keyOf(form, path)); return s === undefined ? -1 : s; }
  // the Core's calls: a failure is thrown tagged, and the Core's guard keeps it as the cause of its status (core.js)
  read(form, path, off, dst) {
    const h = this.handles.get(this._name(form, path));
    if (!h) return false;
    try { return h.read(dst, { at: off }) === dst.length; } catch (e) { throw storeFailure(e, 'opfs_read', 'read'); }
  }
  write(form, path, off, bytes) {
    const h = this.handles.get(this._name(form, path));
    if (!h) return false;
    try {
      if (off === 0) { h.truncate(0); this.index.delete(keyOf(form, path)); this._dirty = true; }
      return h.write(bytes, { at: off }) === bytes.length;
    } catch (e) { throw storeFailure(e, 'opfs_write'); }
  }
  commit(form, path) {
    const h = this.handles.get(this._name(form, path));
    if (!h) return false;
    try {
      h.flush();
      this.index.set(keyOf(form, path), h.getSize());
    } catch (e) { throw storeFailure(e, 'opfs_commit'); }
    this._dirty = true;
    return true;
  }
  remove(form, path) {
    const doomed = path === null ? [...this.index.keys()].filter((k) => k.startsWith(`${QLC.FORM_DEVICE}\n`)) : [keyOf(form, path)];
    this._doomed = this._doomed || [];
    for (const k of doomed) {
      const i = k.indexOf('\n'), n = this._name(Number(k.slice(0, i)), k.slice(i + 1));
      this.index.delete(k);
      this._doomed.push(n);
    }
    this._dirty = true;
    return true;
  }
  async put(form, path, bytes) {
    const n = this._name(form, path);
    await this._busy('opfs_put', 'write', async () => {
      const w = await (await this.dir.getFileHandle(n, { create: true })).createWritable();
      try { await w.write(bytes); await w.close(); } catch (e) { await Promise.resolve().then(() => w.abort()).catch(() => {}); throw e; }
    });
    this.index.set(keyOf(form, path), bytes.length);
    this._dirty = true;
    await this.close();
  }
  async get(form, path) {
    if (!this.index.has(keyOf(form, path))) return null;
    return this._busy('opfs_get', 'read', async () => new Uint8Array(await (await (await this.dir.getFileHandle(this._name(form, path))).getFile()).arrayBuffer()));
  }
  async has(form, path) { return this.index.has(keyOf(form, path)); }
  async drop(form, path) { this.remove(form, path); await this.close(); }
  async list() { return [...this.index.entries()].map(([k, size]) => { const i = k.indexOf('\n'); return { form: Number(k.slice(0, i)), path: k.slice(i + 1), size }; }); }
  async clear(forms = [QLC.FORM_PLAIN, QLC.FORM_CDN, QLC.FORM_DEVICE]) {
    for (const { form, path } of await this.list()) if (forms.includes(form)) this.remove(form, path);
    await this.close();
  }
}

/**
 * The best file store this runtime allows: OPFS in a browser Worker where its probe passes, else memory (the model is
 * then downloaded at every page load; the lease is still kept in IndexedDB). A memory store that stands in for OPFS
 * says why in `unavailable`: { error_code (opfs_absent: no OPFS in this runtime; else the probe that failed),
 * error_name } for the controller's silent report (storage/unavailable).
 */
export async function openFiles(name) {
  const g = globalThis;
  if (!(g.navigator && g.navigator.storage && typeof g.navigator.storage.getDirectory === 'function' &&
        typeof g.FileSystemFileHandle === 'function' && 'createSyncAccessHandle' in g.FileSystemFileHandle.prototype)) {
    return Object.assign(new MemoryFiles(), { unavailable: { error_code: 'opfs_absent' } });
  }
  try { return await OpfsFiles.create(name); } catch (e) {
    // storage blocked or refused (a private window, a browser whose OPFS fails): memory for this page load
    const t = (e && e.qlReport) || {};
    const named = e && typeof e.name === 'string' && e.name !== 'Error' ? { error_name: e.name } : {};
    return Object.assign(new MemoryFiles(), { unavailable: { ...named, error_code: t.error_code || 'opfs_open' } });
  }
}

// ---------------------------------------------------------------- KV: the state and the Core's journal

/** A synchronous key-value view (the 3.x platform client's `state`: get/set of JSON values) over a backend that
 * writes the dirty keys in one transaction on flush(). */
const kindOf = (backend) => (backend && typeof backend.kind === 'string' ? backend.kind : 'kv');

export class StateStore {
  constructor(backend, initial = new Map()) { this.backend = backend; this.m = initial; this.dirty = new Set(); this._q = Promise.resolve(); this.onFailure = null; this.loadFailed = null; }
  /** R402-3: a backend that cannot be read opens as nothing kept (a first visit), said in `loadFailed`. */
  static async open(backend) {
    try { return new StateStore(backend, await backend.load()); } catch (e) {
      const s = new StateStore(backend, new Map());
      s.loadFailed = storeFailure(e, `${kindOf(backend)}_load`, 'read');
      return s;
    }
  }
  get(k) { return this.m.has(k) ? structuredClone(this.m.get(k)) : null; }
  set(k, v) { if (v === null || v === undefined) this.m.delete(k); else this.m.set(k, structuredClone(v)); this.dirty.add(k); this._soon(); }
  _soon() { if (!this._timer) this._timer = setTimeout(() => { this._timer = null; this.flush().catch(() => {}); }, 0); }
  /**
   * Write every change since the last flush in one transaction. Never rejects (R402-3): the state is this page's, in
   * `m`; a write that failed is said (onFailure) and its keys are written again with the next flush. (4.0.2: one
   * failed write failed every later flush, and a call that awaited one, a take's start, answered engine_failed.)
   */
  flush() {
    const keys = [...this.dirty];
    this.dirty.clear();
    if (!keys.length) return this._q;
    const put = keys.map((k) => [k, this.m.has(k) ? this.m.get(k) : null]);
    this._q = this._q.then(() => this.backend.write(put)).catch((e) => {
      for (const k of keys) this.dirty.add(k);
      told(this, storeFailure(e, `${kindOf(this.backend)}_write`));
    });
    return this._q;
  }
  async clear(prefix) { for (const k of [...this.m.keys()]) if (k.startsWith(prefix)) this.set(k, null); await this.flush(); }

  /**
   * 4.0.2: one record written only when `write(stored)` says so, `stored` read from the backend in the same atomic step
   * (IndexedDB: one readwrite transaction, so the frames of one origin, in other tabs, cannot interleave). After the
   * writes queued before it. Resolves true when it was written (this view then holds it too).
   */
  writeIf(k, v, write) {
    const val = structuredClone(v);
    const p = this._q.then(async () => {
      let ok;
      try {
        if (typeof this.backend.writeIf === 'function') ok = await this.backend.writeIf(k, val, write);
        else { const all = await this.backend.load(); ok = !!write(all.has(k) ? all.get(k) : null); if (ok) await this.backend.write([[k, val]]); }
      } catch (e) { throw storeFailure(e, `${kindOf(this.backend)}_write_if`); }
      if (ok) { this.m.set(k, structuredClone(val)); this.dirty.delete(k); }
      return ok;
    });
    this._q = p.catch(() => {});
    return p;
  }
}

export class MemoryKV {
  constructor(m = new Map()) { this.m = m; this.writes = 0; }
  async load() { return new Map([...this.m].map(([k, v]) => [k, structuredClone(v)])); }
  async write(entries) { this.writes++; for (const [k, v] of entries) { if (v === null) this.m.delete(k); else this.m.set(k, structuredClone(v)); } }
  async writeIf(k, v, write) {
    if (!write(this.m.has(k) ? structuredClone(this.m.get(k)) : null)) return false;
    this.writes++;
    this.m.set(k, structuredClone(v));
    return true;
  }
}

export class IndexedDbKV {
  static async open(name = 'quranlab-sdk4') {
    const db = await new Promise((res, rej) => {
      const r = globalThis.indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new IndexedDbKV(db);
  }
  constructor(db) { this.db = db; this.kind = 'idb'; }
  load() {
    return new Promise((res, rej) => {
      const out = new Map();
      const t = this.db.transaction('kv', 'readonly');
      const c = t.objectStore('kv').openCursor();
      c.onsuccess = () => { const x = c.result; if (x) { out.set(x.key, x.value); x.continue(); } else res(out); };
      c.onerror = () => rej(c.error);
    });
  }
  write(entries) {
    return new Promise((res, rej) => {
      const t = this.db.transaction('kv', 'readwrite');
      const s = t.objectStore('kv');
      for (const [k, v] of entries) { if (v === null) s.delete(k); else s.put(v, k); }
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  /** 4.0.2: read, decide (`write(stored)`) and put in ONE readwrite transaction: atomic across the frames of one origin. */
  writeIf(k, v, write) {
    return new Promise((res, rej) => {
      const t = this.db.transaction('kv', 'readwrite');
      const s = t.objectStore('kv');
      let ok = false;
      const g = s.get(k);
      g.onsuccess = () => {
        try { ok = !!write(g.result === undefined ? null : g.result); } catch (_) { ok = false; }
        if (ok) s.put(v, k);
      };
      t.oncomplete = () => res(ok);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
}

/** IndexedDB where the browser allows it, else memory (the page load only; `unavailable` says why, as openFiles). */
export async function openKV(name) {
  if (!globalThis.indexedDB) return Object.assign(new MemoryKV(), { unavailable: { error_code: 'idb_absent' } });
  try { return await IndexedDbKV.open(name); } catch (e) {
    const named = e && typeof e.name === 'string' && e.name !== 'Error' ? { error_name: e.name } : {};
    return Object.assign(new MemoryKV(), { unavailable: { ...named, error_code: 'idb_open' } });
  }
}

/**
 * The Core's own files (QLC_FORM_CORE: the recited journal) live in the KV as `core:<name>`: the Core writes one
 * whole and commits it, and the commit is one KV transaction. Wraps a file store so the Core sees one table.
 */
export class WithCoreFiles {
  constructor(files, state) { this.f = files; this.state = state; this.parts = new Map(); }
  _core(form) { return form === QLC.FORM_CORE; }
  size(form, path) {
    if (!this._core(form)) return this.f.size(form, path);
    const v = this.state.get(`core:${path}`);
    return v ? v.length : -1;
  }
  read(form, path, off, dst) {
    if (!this._core(form)) return this.f.read(form, path, off, dst);
    const v = this.state.m.get(`core:${path}`);
    if (!v || off + dst.length > v.length) return false;
    dst.set(v.subarray(off, off + dst.length));
    return true;
  }
  write(form, path, off, b) {
    if (!this._core(form)) return this.f.write(form, path, off, b);
    if (!this.parts.has(path) || off === 0) this.parts.set(path, new Growing());
    this.parts.get(path).write(off, b);
    return true;
  }
  commit(form, path) {
    if (!this._core(form)) return this.f.commit(form, path);
    const p = this.parts.get(path);
    if (!p) return false;
    this.parts.delete(path);
    this.state.set(`core:${path}`, p.bytes());
    return true;
  }
  remove(form, path) {
    if (!this._core(form)) return this.f.remove(form, path);
    this.state.set(`core:${path}`, null);
    return true;
  }
}
