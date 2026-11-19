// The install keys and the lease of the Node path, kept in its storage folder across runs of the app (the desktop
// class: 24 h leases, contract 18.4.7). The same shape as the frame's lease-store.js, so the Controller takes it as its
// lease store, with the desktop row of 18.4.2 in place of a non-extractable WebCrypto key (Node cannot keep one):
//
//   keys.bin   the install keys' PKCS8 and public keys, sealed (AES-256-GCM) under the machine key (machine.js) with
//              the developer key and app id as associated data; mode 0600. Made once per folder; imported for use as
//              non-extractable CryptoKeys, so the bytes live in memory only while they are imported.
//   lease.bin  the Core's saved state (already sealed by the Core under its release key), the certificate, what the
//              Controller needs beside the Core (build, base, exp, refresh_after, the lease's public ephemeral key,
//              the build's source), the piece mirror; sealed under the same key with the install hash added.
//
// A folder copied to another machine or user: keys.bin does not open, a new install starts (new keys, attest, a new
// lease), never a crash. A device clock set back by more than an hour against the lease's own anchor offset hands back
// no Core state (the rule of lease-store.js: every run is a new boot of the Core's clock).
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { InstallKeys } from '../frame/keys.js';
import { CLOCK_BACK_S, certField } from '../frame/lease-store.js';
import { hex, sha256 } from '../shared/bytes.js';
import { machineKey, seal, open, writeAtomic } from './machine.js';

const subtle = webcrypto.subtle;
const te = new TextEncoder(), td = new TextDecoder();
const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64'));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export class NodeLeaseStore {
  /** @param {string} dir  the storage folder; o: { key, appId, clock (ms), read, user (machine.js seams for tests) } */
  constructor(dir, { key, appId, clock = () => Date.now(), read, user } = {}) {
    this.dir = dir;
    this.key = key;
    this.appId = appId;
    this.clock = clock;
    this.seams = { ...(read ? { read } : {}), ...(user ? { user } : {}) };
    this.mk = null;
    this.made = null;
    this._q = Promise.resolve();
  }

  get keysFile() { return path.join(this.dir, 'keys.bin'); }
  get leaseFile() { return path.join(this.dir, 'lease.bin'); }
  _aad(installHex = '') { return te.encode(`quranlab-node-keys 1\n${this.key}\n${this.appId}\n${installHex}\n`); }
  async _mk() { if (!this.mk) { const m = await machineKey(this.dir, this.seams); this.mk = m.key; this.source = m.source; } return this.mk; }

  async _newKeys() {
    const agree = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const sign = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const rec = { v: 1, made: this.clock(),
      agree: b64(new Uint8Array(await subtle.exportKey('pkcs8', agree.privateKey))), sign: b64(new Uint8Array(await subtle.exportKey('pkcs8', sign.privateKey))),
      spki: b64(new Uint8Array(await subtle.exportKey('spki', agree.publicKey))), signSpki: b64(new Uint8Array(await subtle.exportKey('spki', sign.publicKey))) };
    const plain = te.encode(JSON.stringify(rec));
    writeAtomic(this.keysFile, await seal(await this._mk(), plain, this._aad()));
    plain.fill(0);
    return rec;
  }

  // the keys of a record, imported as non-extractable CryptoKeys and checked against their public keys (keys.js)
  async _import(rec) {
    const pk = (s) => unb64(s);
    const agree = await subtle.importKey('pkcs8', pk(rec.agree), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const sign = await subtle.importKey('pkcs8', pk(rec.sign), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const keys = await InstallKeys.restore({ agree, sign, spki: unb64(rec.spki), signSpki: unb64(rec.signSpki) }, subtle);
    if (keys) keys.hw = 0; // a software key store (18.4.2): the certificate says hw 0
    return keys;
  }

  /**
   * { keys, coreState, cert, lease, mirror, why } as lease-store.js: why 'none' (new keys, a first run), 'restored',
   * 'machine' (keys.bin of another machine, user or folder: new keys), 'clock', 'sealed'. Never throws for a folder's
   * contents; throws only when the folder cannot be written at all.
   */
  async load() {
    const out = { keys: null, coreState: null, cert: null, lease: null, mirror: null, why: 'none' };
    const mk = await this._mk();
    let rec = null;
    if (fs.existsSync(this.keysFile)) {
      const plain = await open(mk, new Uint8Array(fs.readFileSync(this.keysFile)), this._aad());
      if (plain) { try { rec = JSON.parse(td.decode(plain)); } catch (_) { rec = null; } plain.fill(0); }
      if (!rec) out.why = 'machine';
    }
    let keys = rec ? await this._import(rec).catch(() => null) : null;
    if (!keys) {
      if (rec) out.why = 'machine';
      rec = await this._newKeys();
      keys = await this._import(rec);
      try { fs.rmSync(this.leaseFile, { force: true }); } catch (_) { /* none */ }
      out.keys = keys;
      this.made = rec.made;
      return out;
    }
    out.keys = keys;
    this.made = rec.made;
    out.why = 'restored';
    if (!fs.existsSync(this.leaseFile)) return out;
    const plain = await open(mk, new Uint8Array(fs.readFileSync(this.leaseFile)), this._aad(keys.installHex));
    let l = null;
    if (plain) { try { l = JSON.parse(td.decode(plain)); } catch (_) { l = null; } }
    if (!isObj(l)) { out.why = 'sealed'; return out; }
    out.cert = typeof l.cert === 'string' && certField(l.cert, 'install') === keys.installHex ? l.cert : null;
    const anchorD = isObj(l.lease) ? l.lease.anchorD : null;
    if (Number.isFinite(l.coreNow) && Number.isFinite(anchorD) && this.clock() / 1000 + anchorD < l.coreNow - CLOCK_BACK_S) { out.why = 'clock'; return out; }
    if (typeof l.coreState === 'string') out.coreState = unb64(l.coreState);
    if (isObj(l.lease) && /^[0-9a-f]{40}$/.test(String(l.lease.build)) && typeof l.lease.eph === 'string' && isObj(l.lease.src)) {
      out.lease = { ...l.lease, eph: unb64(l.lease.eph) };
    }
    if (isObj(l.mirror)) out.mirror = l.mirror;
    return out;
  }

  /** The record of lease-store.js's save, in lease.bin (keys.bin is written once, at load). Serialized; never throws. */
  save(o) {
    this._q = this._q.then(() => this._save(o)).catch(() => {});
    return this._q;
  }

  async _save({ keys, coreState = null, coreNow = null, cert = null, lease = null, mirror = null }) {
    let prev = null;
    if (!Number.isFinite(coreNow) && fs.existsSync(this.leaseFile)) {
      const p = await open(await this._mk(), new Uint8Array(fs.readFileSync(this.leaseFile)), this._aad(keys.installHex));
      try { prev = p ? JSON.parse(td.decode(p)) : null; } catch (_) { prev = null; }
    }
    const rec = {
      v: 1, wall: this.clock(), coreNow: Number.isFinite(coreNow) ? coreNow : prev && Number.isFinite(prev.coreNow) ? prev.coreNow : null,
      coreState: coreState && coreState.length ? b64(coreState) : null, cert: typeof cert === 'string' ? cert : null,
      lease: lease ? { ...lease, eph: lease.eph ? b64(lease.eph) : null } : null, mirror: mirror || null,
    };
    writeAtomic(this.leaseFile, await seal(await this._mk(), te.encode(JSON.stringify(rec)), this._aad(keys.installHex)));
  }

  /** A verified stop: the lease and the keys are gone; the next run is a new install. */
  async clear() {
    for (const f of [this.leaseFile, this.keysFile]) { try { fs.rmSync(f, { force: true }); } catch (_) { /* gone */ } }
    this.made = null;
  }
}

/** The install hash of a public key (tests). */
export const installHexOf = async (spki) => hex(await sha256(spki));
