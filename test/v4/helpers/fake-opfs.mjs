// An origin private file system in memory, for the Node tests of the frame's file store (sdk4/frame/stores.js): the
// parts of the File System Access API the store uses, as browsers behave.
//   - A file has at most one sync access handle or one writable at a time. Another one, and getFile() while a sync
//     access handle is open, is refused with NoModificationAllowedError (Chrome's answer to a file another page of
//     the site holds).
//   - A writable writes to a swap copy, which replaces the file at close().
//   - `quota`: the bytes of every file and swap copy together. A write past it throws QuotaExceededError.
//   - `fault(op, name)`: an error to throw from that operation on that entry, or null. The ops: getDirectory,
//     getDirectoryHandle, getFileHandle, removeEntry, getFile, createSyncAccessHandle, sync.read, sync.write,
//     sync.truncate, sync.flush, sync.getSize, createWritable, writable.write, writable.close.
// install(fs) puts it in place of the runtime's (navigator.storage.getDirectory, FileSystemFileHandle) and returns
// the function that takes it out again.
export const dom = (name, message = name) => new DOMException(message, name);

export function fakeOpfs({ quota = Infinity, fault = () => null } = {}) {
  const ops = [];
  const roots = { dirs: new Map(), files: new Map() };
  const swaps = new Set();
  const used = () => {
    let n = 0;
    const walk = (d) => { for (const f of d.files.values()) n += f.data.length; for (const s of d.dirs.values()) walk(s); };
    walk(roots);
    for (const s of swaps) n += s.data.length;
    return n;
  };
  const hit = (op, name) => { ops.push(`${op} ${name}`); const e = fault(op, name); if (e) throw e; };
  const room = (grow) => { if (grow > 0 && used() + grow > quota) throw dom('QuotaExceededError', 'The quota has been exceeded.'); };
  const grown = (a, n) => { if (n <= a.length) return a; const b = new Uint8Array(n); b.set(a); return b; };

  class SyncHandle {
    constructor(node, name) { this.node = node; this.name = name; this.open = true; }
    _live(op) { hit(op, this.name); if (!this.open) throw dom('InvalidStateError', 'the handle is closed'); }
    read(dst, { at = 0 } = {}) {
      this._live('sync.read');
      const src = this.node.data.subarray(at, at + dst.length);
      dst.set(src);
      return src.length;
    }
    write(src, { at = 0 } = {}) {
      this._live('sync.write');
      const end = at + src.length;
      room(end - this.node.data.length);
      this.node.data = grown(this.node.data, end);
      this.node.data.set(src, at);
      return src.length;
    }
    truncate(n) {
      this._live('sync.truncate');
      room(n - this.node.data.length);
      this.node.data = n <= this.node.data.length ? this.node.data.slice(0, n) : grown(this.node.data, n);
    }
    flush() { this._live('sync.flush'); }
    getSize() { this._live('sync.getSize'); return this.node.data.length; }
    close() { if (this.open) { this.open = false; this.node.lock = null; } }
  }

  class Writable {
    constructor(node, name) { this.node = node; this.name = name; this.swap = { data: new Uint8Array(0) }; swaps.add(this.swap); }
    async write(x) {
      hit('writable.write', this.name);
      const b = typeof x === 'string' ? new TextEncoder().encode(x) : x instanceof Uint8Array ? x : new Uint8Array(x);
      room(b.length);
      const n = this.swap.data.length;
      this.swap.data = grown(this.swap.data, n + b.length);
      this.swap.data.set(b, n);
    }
    async close() {
      try {
        hit('writable.close', this.name);
        this.node.data = this.swap.data;
      } finally { swaps.delete(this.swap); this.node.lock = null; }
    }
    async abort() { swaps.delete(this.swap); this.node.lock = null; }
  }

  class FileHandle {
    constructor(node, name) { this.node = node; this.name = name; this.kind = 'file'; }
    async getFile() {
      hit('getFile', this.name);
      if (this.node.lock === 'sync') throw dom('NoModificationAllowedError', 'the file is held by an access handle');
      const data = this.node.data.slice();
      return { size: data.length, arrayBuffer: async () => data.buffer, text: async () => new TextDecoder().decode(data) };
    }
    async createSyncAccessHandle() {
      hit('createSyncAccessHandle', this.name);
      if (this.node.lock) throw dom('NoModificationAllowedError', 'the file is held');
      this.node.lock = 'sync';
      return new SyncHandle(this.node, this.name);
    }
    async createWritable() {
      hit('createWritable', this.name);
      if (this.node.lock) throw dom('NoModificationAllowedError', 'the file is held');
      this.node.lock = 'writable';
      return new Writable(this.node, this.name);
    }
  }

  class DirHandle {
    constructor(d, name) { this.d = d; this.name = name; this.kind = 'directory'; }
    async getDirectoryHandle(name, { create = false } = {}) {
      hit('getDirectoryHandle', name);
      if (!this.d.dirs.has(name)) { if (!create) throw dom('NotFoundError'); this.d.dirs.set(name, { dirs: new Map(), files: new Map() }); }
      return new DirHandle(this.d.dirs.get(name), name);
    }
    async getFileHandle(name, { create = false } = {}) {
      hit('getFileHandle', name);
      if (!this.d.files.has(name)) { if (!create) throw dom('NotFoundError'); this.d.files.set(name, { data: new Uint8Array(0), lock: null }); }
      return new FileHandle(this.d.files.get(name), name);
    }
    async removeEntry(name) {
      hit('removeEntry', name);
      const f = this.d.files.get(name);
      if (!f) throw dom('NotFoundError');
      if (f.lock) throw dom('NoModificationAllowedError', 'the file is held');
      this.d.files.delete(name);
    }
    async *keys() { yield* this.d.dirs.keys(); yield* this.d.files.keys(); }
  }

  return {
    ops, used, FileHandle,
    getDirectory: async () => { hit('getDirectory', '/'); return new DirHandle(roots, '/'); },
    /** The files of a directory under the root, by name (their bytes). */
    files: (dir) => { const d = roots.dirs.get(dir); return d ? new Map([...d.files].map(([k, v]) => [k, v.data])) : new Map(); },
    /** Hold a file as another page of the site would (a sync access handle); returns the release. */
    hold: (dir, name) => { const f = roots.dirs.get(dir).files.get(name); f.lock = 'sync'; return () => { f.lock = null; }; },
  };
}

export function install(fs) {
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const fhDesc = Object.getOwnPropertyDescriptor(globalThis, 'FileSystemFileHandle');
  const nav = globalThis.navigator || {};
  const copy = {};
  for (const k of ['userAgent', 'hardwareConcurrency', 'language', 'languages', 'platform', 'onLine']) { try { if (nav[k] !== undefined) copy[k] = nav[k]; } catch (_) { /* not readable */ } }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { ...copy, storage: { getDirectory: () => fs.getDirectory() } } });
  Object.defineProperty(globalThis, 'FileSystemFileHandle', { configurable: true, writable: true, value: fs.FileHandle });
  return () => {
    if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc); else delete globalThis.navigator;
    if (fhDesc) Object.defineProperty(globalThis, 'FileSystemFileHandle', fhDesc); else delete globalThis.FileSystemFileHandle;
  };
}
