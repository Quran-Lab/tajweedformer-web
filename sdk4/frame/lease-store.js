// The web lease across page loads (owner, 11-18: "web keeps a lease across page loads, ... stored with a
// non-extractable WebCrypto key, instead of one lease per page"; contract 18.4.9 as amended for it). The lease is kept
// for as long as the server made it (its exp, set by Quran Lab) and its grace; the frame sets no length of its own.
//
// One record per site and developer key in the frame's KV (IndexedDB on Quran Lab's frame origin, partitioned by the
// browser per top-level site), written whole in one transaction:
//
//   keys    the install keys as CryptoKey objects, `extractable: false` (keys.js): a structured clone keeps them so,
//           and no script can read their private bytes; the public keys' SPKI beside them
//   seal    an AES-GCM 256 CryptoKey made here, `extractable: false`, that seals `blob`
//   blob    the Core's own saved state (qlc_create's `state`: the clock's anchor and floor, a verified stop, the usage,
//           and the lease part: the binary lease, its build, exp, refresh_after and the data pieces), already sealed
//           by the Core under its release's key; sealed again here under `seal` with the site, the key and the
//           install hash as associated data, so a record never opens for another site, key or install
//   cert    the install certificate the lease rides on (signed by the server, public)
//   lease   what the frame needs beside the Core to use the lease: build, base, exp, refresh_after (server times), the
//           lease's ephemeral public key (public), the build's source (version, model id, key id)
//   mirror  the piece mirror (piece.js) as it stood when the Core's state was saved
//   made, wall, coreNow   when the keys were made, the device clock and the Core's clock at the last save
//
// What is never stored: a private key's bytes, the build key, any plaintext of the model, the app token.
//
// Rules at load (each is a plain fall back to what a page did before: new keys, attest, Turnstile, a new lease):
//   - a record of another site or key is never read (the record's name and the seal's associated data);
//   - keys that are extractable, of another algorithm, or not the stored public keys: the record is dropped;
//   - keys older than KEYS_MAX_MS (an unattested certificate's life): a new install, at the first page load
//     whose record holds no lease in force (its exp and the grace after it, on the device clock corrected
//     by the lease's anchor, below). A lease in force is never dropped for the keys' age: until 4.0.1 a lease given
//     on the keys' 20th day was gone on their 30th, however long the server had made it;
//   - a device clock set back: the device clock corrected by the lease's anchor (the Core's clock minus the device
//     clock, taken once right after the lease was accepted, when the Core's clock is the server's iat: `anchorD`)
//     more than CLOCK_BACK_S behind the Core's clock at the last save means the clock was set back since: the Core's
//     state is not handed back (the lease is asked for again; keys and certificate are kept). On the web
//     performance.now() does not count the time between page loads, so without this a clock set back while no page
//     is open would let the Core count only the time pages were open. The offset is the lease's, never one taken at
//     a later save (a clock set back to the same time before every page load would move a later offset with it), so
//     at most CLOCK_BACK_S of a lease's life can go uncounted however often the clock is set back. A clock that is
//     simply wrong, ahead or behind, changes nothing: the anchor corrects it.
// The Core judges the lease itself (its clock, exp, the site it names, the install key, the release).
import { utf8, hex, sha256 } from '../shared/bytes.js';
import { InstallKeys } from './keys.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const LEASE_RECORD = 'lease.v1';
export const KEYS_MAX_MS = 30 * 86_400_000;
export const CLOCK_BACK_S = 3600;
// the grace after a lease's exp while Quran Lab cannot be reached (18.4.7.1): the Core's, a record holds its lease that long
export const LEASE_GRACE_S = 86_400;

/** Whether a record's lease is still in force at `nowMs` (device clock): before its exp plus the grace, on the device
 * clock corrected by the lease's anchor (`anchorD`, the Core's clock minus the device clock when it was accepted). The
 * Core judges the lease itself; this only decides whether the record is kept. */
export function leaseInForce(rec, nowMs) {
  const l = isObj(rec) ? rec.lease : null;
  if (!isObj(l) || !Number.isFinite(l.exp)) return false;
  return nowMs / 1000 + (Number.isFinite(l.anchorD) ? l.anchorD : 0) < l.exp + LEASE_GRACE_S;
}

/** The KV name of the record of one site and developer key. */
export async function recordName(site, key) { return `${LEASE_RECORD}.${hex(await sha256(utf8(`${site}\n${key}`))).slice(0, 32)}`; }

/** A field of a certificate's text (`exp`, `att`, `install`), or null. */
export function certField(cert, field) {
  try {
    const b64 = String(cert).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const text = new TextDecoder().decode(Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0)));
    const line = text.split('\n').find((l) => l.startsWith(field + ' '));
    return line ? line.slice(field.length + 1) : null;
  } catch (_) { return null; }
}

const aad = (site, key, installHex) => utf8(`quranlab-web-lease 1\n${key}\n${site}\n${installHex}\n`);

export class LeaseStore {
  /**
   * @param {object} state  the frame's StateStore (stores.js)
   * @param {object} o  { key, site, clock (ms), subtle }
   */
  constructor(state, { key, site, clock = () => Date.now(), subtle = globalThis.crypto.subtle } = {}) {
    this.state = state;
    this.key = key;
    this.site = site;
    this.clock = clock;
    this.subtle = subtle;
    this.name = null;
    this.seal = null;
    this.made = null;
    this._q = Promise.resolve();
  }

  async _name() { if (!this.name) this.name = await recordName(this.site, this.key); return this.name; }

  /**
   * The record of this site and key: { keys (InstallKeys), coreState (Uint8Array or null), cert, lease, mirror, why }.
   * `why`: 'none' (no record: new keys), 'restored', 'clock' (keys and certificate, no Core state), 'sealed' (the
   * Core state did not open: keys and certificate only), 'keys' (the keys were not usable: dropped), 'old' (keys older
   * than KEYS_MAX_MS and no lease in force: dropped). Never throws.
   */
  async load() {
    const out = { keys: null, coreState: null, cert: null, lease: null, mirror: null, why: 'none' };
    let rec = null;
    try { rec = this.state.get(await this._name()); } catch (_) { rec = null; }
    if (!isObj(rec) || rec.v !== 1 || rec.site !== this.site || rec.key !== this.key) return out;
    const now = this.clock();
    if (!(Number.isFinite(rec.made) && rec.made - now < 86_400_000) || (now - rec.made >= KEYS_MAX_MS && !leaseInForce(rec, now))) {
      await this.clear();
      out.why = 'old';
      return out;
    }
    const keys = await InstallKeys.restore(rec.keys || {}, this.subtle);
    if (!keys) { await this.clear(); out.why = 'keys'; return out; }
    out.keys = keys;
    this.made = rec.made;
    this.seal = rec.seal && rec.seal.extractable === false ? rec.seal : null;
    out.cert = typeof rec.cert === 'string' && certField(rec.cert, 'install') === keys.installHex ? rec.cert : null;
    out.why = 'restored';
    // the device clock against the time the record has seen pass (the rule above)
    const anchorD = isObj(rec.lease) ? rec.lease.anchorD : null;
    if (Number.isFinite(rec.coreNow) && Number.isFinite(anchorD) && now / 1000 + anchorD < rec.coreNow - CLOCK_BACK_S) {
      out.why = 'clock';
      return out;
    }
    if (this.seal && rec.blob && rec.iv) {
      try {
        const pt = await this.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(rec.iv), additionalData: aad(this.site, this.key, keys.installHex) },
          this.seal, new Uint8Array(rec.blob));
        out.coreState = new Uint8Array(pt);
      } catch (_) { out.why = 'sealed'; return out; }
      if (isObj(rec.lease) && /^[0-9a-f]{40}$/.test(String(rec.lease.build)) && rec.lease.eph && isObj(rec.lease.src)) out.lease = rec.lease;
      if (isObj(rec.mirror)) out.mirror = rec.mirror;
    }
    return out;
  }

  /**
   * Write the record whole (one KV transaction): `keys` (InstallKeys), `coreState` (the Core's saved state, or null),
   * `coreNow` (the Core's clock, seconds, or null), `cert`, `lease`, `mirror`. Saves are serialized; never throws.
   */
  save(o) {
    this._q = this._q.then(() => this._save(o)).catch(() => {});
    return this._q;
  }

  async _save({ keys, coreState = null, coreNow = null, cert = null, lease = null, mirror = null }) {
    const name = await this._name();
    if (!this.seal) this.seal = await this.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const now = this.clock();
    if (this.made === null) this.made = now;
    let iv = null, blob = null;
    if (coreState && coreState.length) {
      iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      blob = new Uint8Array(await this.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(this.site, this.key, keys.installHex) }, this.seal, coreState));
    }
    const prev = this.state.get(name);
    this.state.set(name, {
      v: 1, site: this.site, key: this.key, made: this.made, wall: now,
      coreNow: Number.isFinite(coreNow) ? coreNow : (isObj(prev) && Number.isFinite(prev.coreNow) ? prev.coreNow : null),
      keys: keys.stored(), seal: this.seal, iv, blob, cert: typeof cert === 'string' ? cert : null, lease: lease || null, mirror: mirror || null,
    });
    await this.state.flush();
  }

  /** The record is gone (a verified stop, unusable keys): the next page makes new keys. */
  async clear() {
    try { this.state.set(await this._name(), null); await this.state.flush(); } catch (_) { /* nothing kept */ }
    this.seal = null;
    this.made = null;
  }
}
