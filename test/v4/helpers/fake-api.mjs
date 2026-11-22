// A stand-in for Quran Lab's API and CDN, for the Node tests: it answers what qlab-api's protected-model branch
// answers, with the contract's TEST keys only (protected40.py: stream(label, n)), so the
// real Core (a test release, 4.0.0-c1) accepts its leases. No production endpoint is ever called.
//
// The lease maker is checked byte for byte against vectors/lease.json (test/v4/vectors.test.mjs).
import { createHash, createPrivateKey, createPublicKey, sign as edSign, webcrypto } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const subtle = webcrypto.subtle;
export const CONTRACT = process.env.QL_CONTRACT || '';
export const vector = (name) => JSON.parse(readFileSync(join(CONTRACT, 'vectors', name), 'utf8'));

export function stream(label, n) {
  const out = [];
  for (let i = 0; out.length < n; i++) {
    const c = Buffer.alloc(4); c.writeUInt32LE(i);
    out.push(...createHash('sha256').update(Buffer.concat([Buffer.from(label, 'ascii'), c])).digest());
  }
  return Uint8Array.from(out.slice(0, n));
}
export const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());
export const b64u = (b) => Buffer.from(b).toString('base64url');
export const unb64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const hex = (b) => Buffer.from(b).toString('hex');
const u8 = (s) => new TextEncoder().encode(s);
const cat = (...p) => { const n = p.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(n); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

export const MODEL_ROOT = stream('quranlab-test-model-root', 32);
export const CORE_ROOT = stream('quranlab-test-core-root', 32);
export const SIGNER_SEED = stream('quranlab-test-signing-seed', 32);
export const RELEASE = '4.0.0-c1';

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
export const signerKey = (seed = SIGNER_SEED) => createPrivateKey({ key: Buffer.concat([ED_PKCS8, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
export const signerPub = (seed = SIGNER_SEED) => new Uint8Array(createPublicKey(signerKey(seed)).export({ format: 'der', type: 'spki' }).subarray(12));
export const edSignBytes = (msg, seed = SIGNER_SEED) => new Uint8Array(edSign(null, Buffer.from(msg), signerKey(seed)));

async function hkdf(salt, ikm, info, n = 32) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, 8 * n));
}
export const buildKey = (keyId, model, version, root = MODEL_ROOT) => hkdf(keyId, root, u8(`quranlab-build-key 1\n${model}\n${version}\n`));
export const kCore = (rel = RELEASE, root = CORE_ROOT) => hkdf(u8('quranlab-core'), root, u8(`quranlab-core-key 1\n${rel}\n`));
export const kMark = (root = MODEL_ROOT) => hkdf(u8('quranlab-mark'), root, u8('quranlab-mark 1\n'));
export async function mark(km, apiKeyId, installHash) {
  const head = cat(sha256(u8(apiKeyId)).subarray(0, 8), installHash.subarray(0, 8));
  const k = await subtle.importKey('raw', km, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return cat(head, new Uint8Array(await subtle.sign('HMAC', k, head)).subarray(0, 8));
}
async function gcm(key, iv, aad, pt) {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, k, pt));
}
const u16 = (n) => Uint8Array.of(n & 255, n >> 8);
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };

/** 18.4.6: the binary lease, wrap 1 (ECDH P-256). `eph`: { privateKey CryptoKey, raw 65 bytes } (fixed for vectors). */
export async function makeLease(f, { bk, kcore, installSpki, eph, seed = SIGNER_SEED }) {
  // version 2 (spec fix 15): a fourth string after the release, the site of a web lease ('' for every other)
  const v2 = f.site !== undefined;
  const head = cat(Uint8Array.of(0x51, 0x4c, 0x4c, 0x31), u16(v2 ? 2 : 1), u16(f.flags), f.lease_id, u64(f.iat), u64(f.exp), u64(f.refresh_after),
    f.key_id, Buffer.from(f.build, 'hex'), f.install_hash, f.mark,
    ...(v2 ? [f.model, f.version, f.release, f.site] : [f.model, f.version, f.release]).map((s) => cat(Uint8Array.of(u8(s).length), u8(s))));
  const d = sha256(head);
  const inner = await gcm(kcore, f.lease_id.subarray(0, 12), d, bk);
  const pub = await subtle.importKey('spki', installSpki, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const z = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256));
  const kek = await hkdf(f.lease_id, z, cat(u8('quranlab-lease-kek 1\n'), f.install_hash, eph.raw));
  const outer = await gcm(kek, new Uint8Array(12), d, inner);
  const body = cat(head, Uint8Array.of(1), u16(eph.raw.length), eph.raw, u16(outer.length), outer, sha256(signerPub(seed)).subarray(0, 8));
  return cat(body, edSignBytes(cat(u8('quranlab-lease 1\n'), body), seed));
}

export async function newEph() {
  const k = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { privateKey: k.privateKey, raw: new Uint8Array(await subtle.exportKey('raw', k.publicKey)) };
}
export async function ephFromPkcs8(der) {
  const privateKey = await subtle.importKey('pkcs8', der, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const jwk = await subtle.exportKey('jwk', privateKey);
  const raw = cat(Uint8Array.of(4), unb64u(jwk.x), unb64u(jwk.y));
  return { privateKey, raw };
}

export const CERT_FIELDS = ['app', 'platform', 'key', 'install', 'sign', 'att', 'hw', 'iat', 'exp', 'recheck', 'batch', 'digest'];
export function signCert(c, seed = SIGNER_SEED) {
  const t = u8('quranlab-install-cert 1\n' + CERT_FIELDS.map((k) => `${k} ${c[k]}\n`).join(''));
  return b64u(t) + '.' + b64u(edSignBytes(t, seed));
}
/** A certificate's fields ({ app, platform, key, install, ... }), signature not checked (the fake's own), or null. */
export function parseCert(c) {
  try {
    const text = Buffer.from(String(c).split('.')[0], 'base64url').toString('utf8');
    const lines = text.split('\n');
    if (lines[0] !== 'quranlab-install-cert 1') return null;
    return Object.fromEntries(lines.slice(1).filter(Boolean).map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]));
  } catch (_) { return null; }
}
export function signRefusal(key, reason, installHex, challenge, t, seed = SIGNER_SEED) {
  const text = u8(`quranlab-refusal 1\n${key}\n${reason}\n${installHex}\n${challenge}\n${t}\n`);
  return b64u(text) + '.' + b64u(edSignBytes(text, seed));
}

async function ecdsaOk(spkiB64, sigB64, text) {
  try {
    const k = await subtle.importKey('spki', unb64u(spkiB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, unb64u(sigB64), u8(text));
  } catch (_) { return false; }
}

const json = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * The fake API and CDN as a fetch function. `cdnDir`: the test build's sdk/v4.0 folder (CDN form). Options:
 * site (the allowed origin), keyId (the API key id), turnstile ('required' | 'off' | 'outage'), stop (a reason: the
 * lease route answers a signed stop), apiKey. Turnstile as qlab-api c261dc2 answers: no token
 * or the token `ts:lease:doubt` (a doubt), and every lease while 'outage', give the 24-hour lease with no page session
 * certificate and `turnstile: unverified`, `turnstile_why`; a token for another cdata is 403 turnstile_failed (forgery).
 */
export async function fakeServer({ cdnDir, site = 'https://app.example', apiKey = 'qlk_v1_apps-one_aaaaaaaaaaaaaaaaaaaaaa', keyId = 'apps-one',
  turnstile = 'required', now = () => Math.floor(Date.now() / 1000), cdnBase = 'https://cdn.test/models', allowed = null, engineId = '20261114.000000000000', contributions = false, configPatch = null, leaseVersion = 2, dates = true, leaseDays = null } = {}) {
  // st.pieces: the pieces served in lease answers, one per answer in order (base64url), and the piece ids whose
  // proofs this server refuses (no digest for this target), as qlab-api's piece rules
  const manifestBytes = new Uint8Array(readFileSync(join(cdnDir, 'manifest.json')));
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  const build = hex(sha256(manifestBytes)).slice(0, 40);
  const st = { engineId: null, leaseVersion: null, leaseSite: null, requests: [], pieces: [], refuseProofUnder: new Set(), servingPieces: false, askedPieces: [], issues: [], corruptLease: false, calls: [], leases: 0, stop: null, tokens: new Set(), challenges: new Set(), passed: new Set(), sawSite: new Set(), downloads: 0, bytes: 0, events: [],
    leaseCerts: [], offline: false, status5xx: 0, stopAll: null, plan: [] };
  const kcore = await kCore();
  const bk = await buildKey(new Uint8Array(Buffer.from(manifest.encryption.key_id, 'hex')), manifest.model_id, manifest.version);
  const pub = signerPub();
  const config = () => {
    const cfgObj = ({ v: 1, expires_at: now() + 86400, flags: { analytics: true, issues: true, contributions },
      // the 4.0 config (decided 11-14): the build and its key id, no base URL; the model and its folder as production
      // names them (the lease answer's base below is made from them, as qlab-api makes it)
      recommended: { model: 'Quran-Lab/v4-test', folder: `sdk/${manifest.model_id}`, revision: build, version: manifest.version, model_id: manifest.model_id,
        key_id: manifest.encryption.key_id },
      web: { api: 4, engine: { current: st.engineId || engineId } } });
    const body = u8(JSON.stringify(configPatch ? configPatch(cfgObj) : cfgObj));
    // the server's time in Date, as every HTTP answer carries it (the SDK judges expires_at by it when the device
    // clock is off; a browser reads it only when the API exposes it, docs/server-for-web-4.md 3); dates: false leaves it out
    return new Response(body, { status: 200, headers: { 'x-qlab-signature': 'ed25519=' + b64u(edSignBytes(body)), 'x-qlab-key-id': hex(sha256(pub).subarray(0, 8)),
      ...(dates ? { date: new Date(now() * 1000).toUTCString() } : {}) } });
  };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(init.body) : null;
    st.calls.push(`${init.method || 'GET'} ${u.pathname}`);
    st.requests.push({ path: `${init.method || 'GET'} ${u.pathname}`, search: u.search, host: u.host, headers: h, body });
    if (h['x-qlab-site']) st.sawSite.add(h['x-qlab-site']);
    if (h['x-qlab-site'] && h['x-qlab-site'] !== site) return json(401, { error: 'invalid_key', reason: 'origin_not_allowed' });
    const tokenOk = () => st.tokens.has(String(h.authorization || '').replace(/^Bearer /, ''));
    // st.offline: no answer at all (a TypeError, as fetch gives); st.status5xx: every API and CDN route answers it
    if (st.offline) throw new TypeError('fetch failed');
    if (st.status5xx) return json(st.status5xx, { error: 'unavailable' });
    // st.stopAll: the key is revoked, and the API says so on every route of the key (15.3: a stop on any route)
    if (st.stopAll && u.pathname.startsWith('/v1/') && !['/v1/origin-check', '/v1/events', '/v1/issues', '/v1/model-key'].includes(u.pathname)) {
      return json(401, { error: 'invalid_key', reason: st.stopAll });
    }
    if (String(url).startsWith(cdnBase + '/')) {
      if (!tokenOk() || h['x-qlab-key'] !== apiKey) return json(401, { error: 'invalid_token' });
      const rel = decodeURIComponent(u.pathname.split(`/${build}/sdk/${manifest.model_id}/`)[1] || '');
      const p = join(cdnDir, rel);
      if (!rel || !existsSync(p)) return json(404, { error: 'not_found' });
      const b = readFileSync(p);
      st.downloads++; st.bytes += b.length;
      if (!st.ranges && !st.cut) return new Response(b, { status: 200 });
      // 4.0.2 (SPEC 16.7): st.ranges, the CDN as it answers: an ETag and Accept-Ranges, and an open-ended Range answered
      // 206 from that byte when its If-Range, if sent, is the file's ETag (else the whole file, 200). st.cut ({ file, at
      // }): that file's answer cut once, the connection ending after byte `at` of the file
      const etag = `"${hex(sha256(b)).slice(0, 32)}"`;
      const m = st.ranges ? /^bytes=(\d+)-$/.exec(String(h.range || '')) : null;
      const from = m && (h['if-range'] === undefined || h['if-range'] === etag) && Number(m[1]) < b.length ? Number(m[1]) : 0;
      const part = b.subarray(from);
      const headers = { etag, 'accept-ranges': 'bytes', 'content-length': String(part.length), ...(from ? { 'content-range': `bytes ${from}-${b.length - 1}/${b.length}` } : {}) };
      const cut = st.cut && !st.cut.done && rel.endsWith(st.cut.file) ? st.cut : null;
      if (!cut) return new Response(part, { status: from ? 206 : 200, headers });
      cut.done = true;
      const stop = Math.max(0, cut.at - from);
      let i = 0;
      const body = new ReadableStream({
        pull(ctl) {
          if (i >= stop) { ctl.error(new TypeError('terminated')); return; }
          const n = Math.min(stop, i + (1 << 20));
          ctl.enqueue(new Uint8Array(part.subarray(i, n)));
          i = n;
        },
      }, { highWaterMark: 0 });
      return new Response(body, { status: from ? 206 : 200, headers });
    }
    switch (`${init.method || 'GET'} ${u.pathname}`) {
      case 'GET /v1/origin-check': {
        const o = h.origin || null;
        const ok = (allowed || [site]).includes(o);
        return json(200, { origin: o, allowed: ok, why: ok ? 'listed' : 'not_listed' });
      }
      case 'POST /v1/register': return json(200, {});
      case 'POST /v1/events': st.events.push(body); return json(202, {});
      case 'POST /v1/issues': st.issues.push(body); return json(202, {});
      case 'GET /v1/config': return tokenOk() ? config() : json(401, { error: 'invalid_token' });
      case 'POST /v1/attest': {
        if (h['x-qlab-key'] !== apiKey) return json(401, { error: 'invalid_key' });
        if (!body.install_key) { // a 3.x attest (the page's sharing link): an unattested app token, no certificate
          const token = 'tok_page_' + st.tokens.size;
          st.tokens.add(token);
          st.pageAttests = (st.pageAttests || 0) + 1;
          return json(200, { token, expires_in: 86400, attested: false });
        }
        const ih = hex(sha256(unb64u(body.install_key)));
        if (!(await ecdsaOk(body.install_sign_key, body.install_sig, `quranlab-attest 1\n-\n${ih}\n`))) return json(401, { error: 'install_sig_invalid' });
        const token = 'tok_' + b64u(stream('t' + st.tokens.size + ih, 12));
        st.tokens.add(token);
        const t = now();
        // a desktop app (the Node path): its app id and platform, as qlab-api writes them
        const desktop = body.platform && body.platform !== 'web';
        const cert = signCert({ app: desktop ? body.bundle_id : site, platform: desktop ? body.platform : 'web', key: keyId, install: ih, sign: hex(sha256(unb64u(body.install_sign_key))), att: 'none', hw: body.install_hw,
          iat: t, exp: t + 30 * 86400, recheck: 0, batch: '-', digest: '-' });
        return json(200, { token, expires_in: 86400, install_cert: cert });
      }
      case 'GET /v1/attest/challenge': {
        if (!tokenOk()) return json(401, { error: 'invalid_token' });
        const c = `c1.${String(now()).padStart(10, '0')}.${b64u(stream('c' + st.challenges.size, 16))}.${b64u(stream('d' + st.challenges.size, 16))}`;
        st.challenges.add(c);
        return json(200, { challenge: c });
      }
      case 'POST /v1/model-key': {
        if (!tokenOk()) return json(401, { error: 'invalid_token' });
        // st.hold: a promise the lease route waits on before it answers (an answer that comes late)
        if (st.hold) await st.hold;
        // a dependency of the lease route down and no fallback (qlab-api, stream 1 of 11-18): 503 lease_unavailable
        // with Retry-After: 30, so many times
        if (st.leaseUnavailable > 0) { st.leaseUnavailable--; st.unavailableAnswers = (st.unavailableAnswers || 0) + 1; return json(503, { error: 'lease_unavailable' }, { 'retry-after': '30' }); }
        const ih = hex(sha256(unb64u(body.install_key)));
        if (!st.challenges.has(body.challenge)) return json(401, { error: 'challenge_invalid' });
        if (!(await ecdsaOk(body.install_sign_key, body.install_sig, `quranlab-lease-ask 1\n${body.challenge}\n${body.build}\n`))) return json(401, { error: 'install_cert_invalid', why: 'install_sig' });
        if (st.stop) return json(403, { error: 'invalid_key', reason: st.stop, signed: signRefusal(keyId, st.stop, ih, body.challenge, now()) });
        // R9: core.piece is required while a piece is served; a proof under a piece without this target's digest is refused
        if (st.servingPieces && !Number.isInteger(body.core && body.core.piece)) return json(400, { error: 'invalid_body' });
        st.askedPieces.push(body.core ? body.core.piece : undefined);
        // st.plan: the answers to the next lease requests, in order ('accept', or 'refuse_core': 403 lease_integrity_failed
        // why core, the frame asks once more under the piece the Core falls back to; 'refuse': 403
        // lease_attestation_required, not asked again; 'busy': 503 lease_unavailable, no Core call)
        const planned = st.plan.length ? st.plan.shift() : 'accept';
        if (planned === 'refuse_core') return json(403, { error: 'lease_integrity_failed', why: 'core' });
        if (planned === 'refuse') return json(403, { error: 'lease_attestation_required' });
        if (planned === 'busy') return json(503, { error: 'lease_unavailable' }, { 'retry-after': '30' });
        if (st.refuseProofUnder.has(body.core && body.core.piece)) return json(403, { error: 'lease_integrity_failed', why: 'core' });
        if (body.build !== build || body.key_id !== manifest.encryption.key_id) return json(404, { error: 'build_unknown' });
        // the certificate (18.4.3): this install's, not expired; a Turnstile pass makes it `att turnstile` for 24 hours at
        // most, never past the certificate it came from, and later leases ride on it with no token (18.4.9)
        const cert = parseCert(body.install_cert);
        if (!cert || cert.install !== ih) return json(401, { error: 'install_cert_invalid', why: 'key' });
        if (Number(cert.exp) <= now()) return json(401, { error: 'install_cert_invalid', why: 'expired' });
        let answerCert = body.install_cert;
        // (Turnstile gates web leases only, as qlab-api: a desktop app has no page to run it in)
        let unverified = null;
        const gated = cert.att !== 'turnstile' && (!body.platform || body.platform === 'web');
        if ((turnstile === 'required' || turnstile === 'outage') && gated) {
          const want = b64u(sha256(u8(`${ih}\n${body.challenge}`)));
          st.tsTokens = [...(st.tsTokens || []), body.turnstile ?? null];
          if (turnstile === 'outage') unverified = 'outage';
          else if (!body.turnstile) unverified = 'no_token';
          else if (body.turnstile === 'ts:lease:doubt') unverified = 'token_doubt';
          else if (body.turnstile !== `ts:lease:${want}`) return json(403, { error: 'turnstile_failed', why: 'cdata' });
        }
        if (unverified) st.unverified = [...(st.unverified || []), unverified];
        else if (turnstile === 'required' && gated) {
          st.passed.add(ih);
          st.turnstilePasses = (st.turnstilePasses || 0) + 1;
          const t0 = now();
          answerCert = signCert({ ...cert, att: 'turnstile', iat: t0, exp: Math.min(t0 + 86400, Number(cert.exp)) });
        }
        st.leaseCerts.push(cert.att);
        const t = now(), ihb = new Uint8Array(Buffer.from(ih, 'hex'));
        // a web lease: 24 hours, never past the certificate (cap_to_cert, 18.4.7, until 11-19). With leaseDays (qlab-api
        // lease_days, 11-19): that many days, and only refresh_after held to the certificate
        const certExp = Number(parseCert(answerCert).exp);
        const leaseExp = leaseDays ? t + leaseDays * 86400 - 1 : Math.min(t + 86400 - 1, certExp);
        // a web lease (flags bit 1, the site), or a desktop one: no web flag and no site (18.4.6)
        const webLease = !body.platform || body.platform === 'web';
        const f = { flags: webLease ? 2 : 0, lease_id: stream('lease' + st.leases, 16), iat: t - 1, exp: leaseExp, refresh_after: Math.min(t + 43200, certExp), key_id: Buffer.from(manifest.encryption.key_id, 'hex'),
          build, install_hash: ihb, mark: await mark(await kMark(), keyId, ihb), model: manifest.model_id, version: manifest.version, release: body.core.release,
          // a web lease names the site the request named in x-qlab-site (qlab-api web-lease-v2); st.leaseSite overrides it
          ...((st.leaseVersion || leaseVersion) === 2 ? { site: !webLease ? '' : st.leaseSite !== null ? st.leaseSite : (h['x-qlab-site'] || '') } : {}) };
        let lease = await makeLease(f, { bk, kcore, installSpki: unb64u(body.install_key), eph: await newEph() });
        if (st.corruptLease) { st.corruptLease = false; lease = lease.slice(); lease[lease.length - 1] ^= 1; }
        st.leases++;
        const piece = st.pieces.length ? st.pieces.shift() : null;
        return json(200, { v: 1, lease: b64u(lease), iat: f.iat, exp: f.exp, refresh_after: f.refresh_after,
          // st.leaseBase: a lease answer that names another model folder than the config's (a server that moved it)
          base: st.leaseBase || `${cdnBase}/Quran-Lab/v4-test/${build}/sdk/${manifest.model_id}/`, install_cert: answerCert, ...(piece ? { piece } : {}),
          ...(unverified ? { turnstile: 'unverified', turnstile_why: unverified } : {}) }, { 'cache-control': 'no-store' });
      }
      default: return json(404, { error: 'not_found' });
    }
  };
  return { fetch, state: st, build, manifest, trustedKey: hex(pub), apiKey, keyId, site,
    /** a Turnstile stand-in: the token names the action and the cdata it was made for */
    turnstile: async ({ action, cdata }) => `ts:${action}:${cdata}` };
}
