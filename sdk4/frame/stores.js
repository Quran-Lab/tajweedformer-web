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
import { QLC } from './core.js';

const keyOf = (form, path) => `${form}\n${path}`;

class Growing {
  constructor() { this.a = new Uint8Array(1 << 16); this.n = 0; }
  write(off, b) {
    if (off + b.length > this.a.length) { const c = new Uint8Array(Math.max(2 * this.a.length, off + b.length)); c.set(this.a.subarray(0, this.n)); this.a = c; }
    this.a.set(b, off);
    this.n = Math.max(this.n, off + b.length);
  }
  bytes() { return this.a.slice(0, this.n); }
}

/** Files in memory, for one page load (and the tests). onCommit(form, path, bytes) hears of every commit. */
export class MemoryFiles {
  constructor({ onCommit = null } = {}) { this.files = new Map(); this.parts = new Map(); this.onCommit = onCommit; this.kind = 'memory'; }
  size(form, path) { const f = this.files.get(keyOf(form, path)); return f ? f.length : -1; }
  read(form, path, off, dst) {
    const f = this.files.get(keyOf(form, path));
    if (!f || off + dst.length > f.length) return false;
    dst.set(f.subarray(off, off + dst.length));
    return true;
  }
  write(form, path, off, bytes) {
    const k = keyOf(form, path);
    if (!this.parts.has(k) || off === 0) this.parts.set(k, new Growing());
    this.parts.get(k).write(off, bytes);
    return true;
  }
  commit(form, path) {
    const k = keyOf(form, path), p = this.parts.get(k);
    if (!p) return false;
    this.parts.delete(k);
    const b = p.bytes();
    this.files.set(k, b);
    if (this.onCommit) this.onCommit(form, path, b);
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
  async get(form, path) { return this.files.get(keyOf(form, path)) || null; }
  async has(form, path) { return this.files.has(keyOf(form, path)); }
  async drop(form, path) { this.remove(form, path); }
  async list() { return [...this.files.keys()].map((k) => { const i = k.indexOf('\n'); return { form: Number(k.slice(0, i)), path: k.slice(i + 1), size: this.files.get(k).length }; }); }
  async clear(forms = [QLC.FORM_PLAIN, QLC.FORM_CDN, QLC.FORM_DEVICE]) { for (const k of [...this.files.keys()]) if (forms.includes(Number(k.split('\n')[0]))) this.files.delete(k); }
  async open() {}
  async close() {}
}

/**
 * Files in the origin private file system (a dedicated Worker only: createSyncAccessHandle). A file counts once its
 * name is in the committed index (`index.json`, rewritten after each commit), so a write cut by a kill never counts.
 */
export class OpfsFiles {
  static async create(name = 'quranlab-sdk4') {
    const root = await globalThis.navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(name, { create: true });
    const f = new OpfsFiles(dir);
    try {
      const h = await dir.getFileHandle('index.json');
      f.index = new Map(Object.entries(JSON.parse(await (await h.getFile()).text())));
    } catch (_) { f.index = new Map(); }
    return f;
  }
  constructor(dir) { this.dir = dir; this.index = new Map(); this.handles = new Map(); this.kind = 'opfs'; this._dirty = false; }
  _name(form, path) { return `${form}_${encodeURIComponent(path)}`; }
  async _handle(form, path, write) {
    const n = this._name(form, path);
    if (this.handles.has(n)) return this.handles.get(n);
    const fh = await this.dir.getFileHandle(n, { create: write });
    const h = await fh.createSyncAccessHandle();
    this.handles.set(n, h);
    return h;
  }
  /** Open sync handles for every committed file, and for `writes` ([form, path]) to be written. Before a Core call. */
  async open(writes = []) {
    for (const k of this.index.keys()) { const i = k.indexOf('\n'); await this._handle(Number(k.slice(0, i)), k.slice(i + 1), false).catch(() => {}); }
    for (const [form, path] of writes) await this._handle(form, path, true);
  }
  /** Close every handle and write the index. After a Core call. */
  async close() {
    for (const h of this.handles.values()) { try { h.flush(); h.close(); } catch (_) { /* closed */ } }
    this.handles.clear();
    if (this._dirty) {
      const h = await (await this.dir.getFileHandle('index.json', { create: true })).createWritable();
      await h.write(JSON.stringify(Object.fromEntries(this.index)));
      await h.close();
      this._dirty = false;
    }
    for (const n of this._doomed || []) await this.dir.removeEntry(n).catch(() => {});
    this._doomed = [];
  }
  size(form, path) { const s = this.index.get(keyOf(form, path)); return s === undefined ? -1 : s; }
  read(form, path, off, dst) {
    const h = this.handles.get(this._name(form, path));
    return !!h && h.read(dst, { at: off }) === dst.length;
  }
  write(form, path, off, bytes) {
    const h = this.handles.get(this._name(form, path));
    if (!h) return false;
    if (off === 0) { h.truncate(0); this.index.delete(keyOf(form, path)); this._dirty = true; }
    return h.write(bytes, { at: off }) === bytes.length;
  }
  commit(form, path) {
    const h = this.handles.get(this._name(form, path));
    if (!h) return false;
    h.flush();
    this.index.set(keyOf(form, path), h.getSize());
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
    const w = await (await this.dir.getFileHandle(n, { create: true })).createWritable();
    await w.write(bytes);
    await w.close();
    this.index.set(keyOf(form, path), bytes.length);
    this._dirty = true;
    await this.close();
  }
  async get(form, path) {
    if (!this.index.has(keyOf(form, path))) return null;
    return new Uint8Array(await (await (await this.dir.getFileHandle(this._name(form, path))).getFile()).arrayBuffer());
  }
  async has(form, path) { return this.index.has(keyOf(form, path)); }
  async drop(form, path) { this.remove(form, path); await this.close(); }
  async list() { return [...this.index.entries()].map(([k, size]) => { const i = k.indexOf('\n'); return { form: Number(k.slice(0, i)), path: k.slice(i + 1), size }; }); }
  async clear(forms = [QLC.FORM_PLAIN, QLC.FORM_CDN, QLC.FORM_DEVICE]) {
    for (const { form, path } of await this.list()) if (forms.includes(form)) this.remove(form, path);
    await this.close();
  }
}

/** The best file store this runtime allows: OPFS in a browser Worker, else memory. */
export async function openFiles(name) {
  try {
    if (globalThis.navigator && globalThis.navigator.storage && typeof globalThis.navigator.storage.getDirectory === 'function' &&
        typeof globalThis.FileSystemFileHandle === 'function' && 'createSyncAccessHandle' in globalThis.FileSystemFileHandle.prototype) {
      return await OpfsFiles.create(name);
    }
  } catch (_) { /* storage blocked: memory for this page load */ }
  return new MemoryFiles();
}

// ---------------------------------------------------------------- KV: the state and the Core's journal

/** A synchronous key-value view (the 3.x platform client's `state`: get/set of JSON values) over a backend that
 * writes the dirty keys in one transaction on flush(). */
export class StateStore {
  constructor(backend, initial = new Map()) { this.backend = backend; this.m = initial; this.dirty = new Set(); this._q = Promise.resolve(); }
  static async open(backend) { return new StateStore(backend, await backend.load()); }
  get(k) { return this.m.has(k) ? structuredClone(this.m.get(k)) : null; }
  set(k, v) { if (v === null || v === undefined) this.m.delete(k); else this.m.set(k, structuredClone(v)); this.dirty.add(k); this._soon(); }
  _soon() { if (!this._timer) this._timer = setTimeout(() => { this._timer = null; this.flush().catch(() => {}); }, 0); }
  /** Write every change since the last flush in one transaction. */
  flush() {
    const keys = [...this.dirty];
    this.dirty.clear();
    if (!keys.length) return this._q;
    const put = keys.map((k) => [k, this.m.has(k) ? this.m.get(k) : null]);
    this._q = this._q.then(() => this.backend.write(put));
    return this._q;
  }
  async clear(prefix) { for (const k of [...this.m.keys()]) if (k.startsWith(prefix)) this.set(k, null); await this.flush(); }
}

export class MemoryKV {
  constructor(m = new Map()) { this.m = m; this.writes = 0; }
  async load() { return new Map([...this.m].map(([k, v]) => [k, structuredClone(v)])); }
  async write(entries) { this.writes++; for (const [k, v] of entries) { if (v === null) this.m.delete(k); else this.m.set(k, structuredClone(v)); } }
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
  constructor(db) { this.db = db; }
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
}

/** IndexedDB where the browser allows it, else memory (the page load only). */
export async function openKV(name) {
  try { if (globalThis.indexedDB) return await IndexedDbKV.open(name); } catch (_) { /* blocked */ }
  return new MemoryKV();
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
