// Storage of the Node path in its folder (the storage folder of TajweedClient.create, sdk4/node/index.js):
//
//   DirFiles  the model's ciphertext by form and decoded path (the CDN form while installing, then the device form the
//             Core writes; contract 18.2.1) and the plain calibration, in `files/`. The same interface as the frame's
//             stores (sdk4/frame/stores.js): the Core's synchronous size/read/write/commit/remove, the controller's
//             asynchronous put/get/has/drop/list/clear and open/close around Core calls. A write goes to a temporary
//             file and counts only once committed (a rename), so a kill never leaves half a file under its name.
//   FileKV    the SDK's small state (the KV backend of stores.js StateStore: load, write of entries in one go) as one
//             JSON file, `state.json`, written whole through a temporary file and a rename. Byte values are kept as
//             {"$b64": ...}.
// No plaintext model file is ever written.
import fs from 'node:fs';
import path from 'node:path';
import { QLC } from '../frame/core.js';
import { writeAtomic } from './machine.js';

const keyOf = (form, p) => `${form}\n${p}`;

export class DirFiles {
  constructor(dir) {
    this.dir = path.join(dir, 'files');
    fs.mkdirSync(this.dir, { recursive: true });
    this.kind = 'folder';
    this.fds = new Map(); // open read descriptors of committed files, closed by close()
    this.parts = new Map(); // name -> write descriptor of the file being written
  }
  _name(form, p) { return path.join(this.dir, `${form}_${encodeURIComponent(p)}`); }
  _closeRead(n) { const fd = this.fds.get(n); if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* closed */ } this.fds.delete(n); } }

  // ---- the Core's side (synchronous) ----
  size(form, p) { try { return fs.statSync(this._name(form, p)).size; } catch (_) { return -1; } }
  read(form, p, off, dst) {
    const n = this._name(form, p);
    try {
      let fd = this.fds.get(n);
      if (fd === undefined) { fd = fs.openSync(n, 'r'); this.fds.set(n, fd); }
      let got = 0;
      while (got < dst.length) {
        const k = fs.readSync(fd, dst, got, dst.length - got, off + got);
        if (k <= 0) return false;
        got += k;
      }
      return true;
    } catch (_) { return false; }
  }
  write(form, p, off, bytes) {
    const n = this._name(form, p);
    try {
      let fd = this.parts.get(n);
      if (fd === undefined || off === 0) {
        if (fd !== undefined) fs.closeSync(fd);
        fd = fs.openSync(`${n}.writing`, 'w', 0o600);
        this.parts.set(n, fd);
      }
      let done = 0;
      while (done < bytes.length) done += fs.writeSync(fd, bytes, done, bytes.length - done, off + done);
      return true;
    } catch (_) { return false; }
  }
  commit(form, p) {
    const n = this._name(form, p);
    const fd = this.parts.get(n);
    if (fd === undefined) return false;
    try {
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      this.parts.delete(n);
      this._closeRead(n);
      fs.renameSync(`${n}.writing`, n);
      return true;
    } catch (_) { return false; }
  }
  remove(form, p) {
    if (p === null) { // every device-form file and partial write (a verified stop, 15.3)
      for (const [n, fd] of this.parts) { try { fs.closeSync(fd); fs.unlinkSync(`${n}.writing`); } catch (_) { /* gone */ } }
      this.parts.clear();
      for (const f of fs.readdirSync(this.dir)) if (f.startsWith(`${QLC.FORM_DEVICE}_`)) { this._closeRead(path.join(this.dir, f)); try { fs.unlinkSync(path.join(this.dir, f)); } catch (_) { /* gone */ } }
      return true;
    }
    const n = this._name(form, p);
    this._closeRead(n);
    try { fs.unlinkSync(n); } catch (_) { /* none */ }
    return true;
  }

  // ---- the controller's side ----
  async put(form, p, bytes) { const n = this._name(form, p); this._closeRead(n); writeAtomic(n, bytes); }
  async get(form, p) { try { return new Uint8Array(fs.readFileSync(this._name(form, p))); } catch (_) { return null; } }
  async has(form, p) { return fs.existsSync(this._name(form, p)); }
  async drop(form, p) { this.remove(form, p); }
  async list() {
    const out = [];
    for (const f of fs.readdirSync(this.dir)) {
      const m = /^(\d)_(.+)$/.exec(f);
      if (!m || f.endsWith('.writing') || f.endsWith('.tmp')) continue;
      out.push({ form: Number(m[1]), path: decodeURIComponent(m[2]), size: fs.statSync(path.join(this.dir, f)).size });
    }
    return out;
  }
  async clear(forms = [QLC.FORM_PLAIN, QLC.FORM_CDN, QLC.FORM_DEVICE]) { for (const { form, path: p } of await this.list()) if (forms.includes(form)) this.remove(form, p); }
  async open() {}
  async close() { for (const n of [...this.fds.keys()]) this._closeRead(n); }
}

const enc = (v) => JSON.stringify(v, (_, x) => (x instanceof Uint8Array ? { $b64: Buffer.from(x).toString('base64') } : x));
const dec = (t) => JSON.parse(t, (_, x) => (x && typeof x === 'object' && typeof x.$b64 === 'string' && Object.keys(x).length === 1 ? new Uint8Array(Buffer.from(x.$b64, 'base64')) : x));

export class FileKV {
  constructor(dir) { this.file = path.join(dir, 'state.json'); fs.mkdirSync(dir, { recursive: true }); this.m = null; }
  async load() {
    let m = new Map();
    try { m = new Map(Object.entries(dec(fs.readFileSync(this.file, 'utf8')))); } catch (_) { m = new Map(); }
    this.m = m;
    return new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
  }
  /** Every change of one step in one write of the whole file. */
  async write(entries) {
    if (!this.m) await this.load();
    for (const [k, v] of entries) { if (v === null) this.m.delete(k); else this.m.set(k, structuredClone(v)); }
    writeAtomic(this.file, enc(Object.fromEntries(this.m)));
  }
}
