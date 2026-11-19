// The install keys of the frame: a WebCrypto ECDH P-256 agreement key and an ECDSA P-256
// signing key, both made with extractable false, in the engine Worker. Never sent anywhere but as public keys.
//
// Kept across page loads (owner, 11-18: "web keeps a lease across page loads, for 24 h, stored with a non-extractable
// WebCrypto key"): the CryptoKey objects themselves go into the frame's IndexedDB (lease-store.js), which keeps
// them non-extractable (a structured clone of a CryptoKey keeps `extractable: false`; no script, the frame's own
// included, can read the private bytes). The lease is wrapped to the agreement key, so a stored lease is usable
// only through this origin's WebCrypto and the Core. A page with no stored record makes new keys.
//
// The Core asks for one agreement per lease and one signature per request synchronously (core.js says why);
// prepareAgree and prepareSign compute them ahead, and agreeSync / signSync answer only for exactly that input.
import { hex, sha256, equal, b64u } from '../shared/bytes.js';

export class InstallKeys {
  static async create(subtle = globalThis.crypto.subtle) {
    const agree = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const sign = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const spki = new Uint8Array(await subtle.exportKey('spki', agree.publicKey));
    const signSpki = new Uint8Array(await subtle.exportKey('spki', sign.publicKey));
    return new InstallKeys(subtle, agree, sign, spki, signSpki, hex(await sha256(spki)));
  }

  /**
   * The keys a record of lease-store.js holds ({ agree, sign: CryptoKey private keys, spki, signSpki }), or null when
   * they are not usable: either private key extractable or of another algorithm, or a public key that is not the
   * stored one's (the install hash is SHA-256 of `spki`).
   */
  static async restore(s, subtle = globalThis.crypto.subtle) {
    try {
      const ok = (k, name, usage) => k && typeof k === 'object' && k.type === 'private' && k.extractable === false && k.algorithm
        && k.algorithm.name === name && k.algorithm.namedCurve === 'P-256' && Array.isArray(k.usages) && k.usages.includes(usage);
      if (!ok(s.agree, 'ECDH', 'deriveBits') || !ok(s.sign, 'ECDSA', 'sign')) return null;
      const spki = new Uint8Array(s.spki), signSpki = new Uint8Array(s.signSpki);
      if (spki.length < 64 || signSpki.length < 64) return null;
      // the stored signing key must sign for the stored public key: one signature, verified, before the keys are used
      const pub = await subtle.importKey('spki', signSpki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const probe = new TextEncoder().encode('quranlab-web-keys 1\n');
      const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, s.sign, probe);
      if (!(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, probe))) return null;
      // and the stored agreement key must be the private half of `spki`: one agreement each way with a throwaway key
      const t = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const apub = await subtle.importKey('spki', spki, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const z1 = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: t.publicKey }, s.agree, 256));
      const z2 = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: apub }, t.privateKey, 256));
      if (!equal(z1, z2)) return null;
      return new InstallKeys(subtle, { privateKey: s.agree }, { privateKey: s.sign }, spki, signSpki, hex(await sha256(spki)));
    } catch (_) { return null; }
  }

  /** What lease-store.js keeps: the two private CryptoKeys (not extractable) and the public keys' SPKI. */
  stored() { return { agree: this._agree.privateKey, sign: this._sign.privateKey, spki: this.spki, signSpki: this.signSpki }; }

  constructor(subtle, agree, sign, spki, signSpki, installHex) {
    this.subtle = subtle;
    this._agree = agree;
    this._sign = sign;
    /** SubjectPublicKeyInfo DER of the agreement key; its SHA-256 is the install hash. */
    this.spki = spki;
    this.signSpki = signSpki;
    this.installHex = installHex;
    this.hw = 0; // a browser's key store is software: the certificate says hw 0 (a signal, never a trust decision)
    this._sig = null; // { msg, sig } prepared for the next Core call
    this._zs = []; // [{ eph, z }] of the lease the Core holds and the one being taken
  }

  /** Prepare the one signature the next Core call will ask for (ECDSA P-256 SHA-256, 64-byte r || s). */
  async prepareSign(msg) {
    const sig = new Uint8Array(await this.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this._sign.privateKey, msg));
    this._sig = { msg, sig };
  }

  /**
   * Prepare the agreement for a lease's ephemeral key (65-byte uncompressed point): the x coordinate, 32 bytes. The
   * agreements of the two newest leases are held: a refresh in the background prepares its new lease's agreement
   * before the Core takes that lease, and a model open or install in between still uses the lease the Core holds.
   */
  async prepareAgree(eph) {
    if (!eph || eph.length !== 65) return;
    if (this._zs.some((x) => equal(x.eph, eph))) return;
    const pub = await this.subtle.importKey('raw', eph, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const z = new Uint8Array(await this.subtle.deriveBits({ name: 'ECDH', public: pub }, this._agree.privateKey, 256));
    this._zs.push({ eph: new Uint8Array(eph), z });
    while (this._zs.length > 2) this._zs.shift().z.fill(0);
  }

  /**
   * install_sig of POST /v1/attest (18.4.3): over "quranlab-attest 1", the challenge (or "-"), the install hash,
   * each line ended by one LF. Signed here, not through the Core, because the attest comes before the engine is
   * chosen (the engine build is named by the signed config, which needs the app token). The same text as the
   * Core's qlc_attest_sig (test/v4/vectors.test.mjs checks both against the contract's attest_proof).
   */
  async attestSig(challenge = null) {
    const msg = new TextEncoder().encode(`quranlab-attest 1\n${challenge || '-'}\n${this.installHex}\n`);
    return b64u(new Uint8Array(await this.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this._sign.privateKey, msg)));
  }

  signSync(msg) {
    const p = this._sig;
    this._sig = null; // one use
    return p && equal(p.msg, msg) ? p.sig : null;
  }

  agreeSync(eph) { const x = this._zs.find((p) => equal(p.eph, eph)); return x ? x.z : null; }

  /** The lease is gone (a stop, the page's end): the prepared agreements go with it. */
  forget() { for (const x of this._zs) x.z.fill(0); this._zs = []; this._sig = null; }
}
