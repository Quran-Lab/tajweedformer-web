// The contract's vectors (sdk_4.0.0/vectors, commit 7ee6ff4) against this SDK's pieces: the fake server's lease
// and refusal makers byte for byte, and the real Core through this SDK's binding (core.js, keys.js): the vector
// leases accepted or refused, the texts the binding prepares for the key store equal to the texts the Core signs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { vector, makeLease, ephFromPkcs8, unb64u, b64u, signRefusal, buildKey, kCore, sha256 } from './helpers/fake-api.mjs';
import { loadEngine } from './helpers/env.mjs';
import { createCore, CoreError, QLC } from '../../sdk4/frame/core.js';
import { InstallKeys } from '../../sdk4/frame/keys.js';
import { MemoryFiles } from '../../sdk4/frame/stores.js';
import { hex } from '../../sdk4/shared/bytes.js';

const subtle = webcrypto.subtle;
const L = vector('lease.json');
const fromHex = (h) => new Uint8Array(Buffer.from(h, 'hex'));

async function vectorKeys(pkcs8B64, spkiB64) {
  const der = unb64u(pkcs8B64);
  const ecdh = await subtle.importKey('pkcs8', der, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const ecdsa = await subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const spki = unb64u(spkiB64);
  return new InstallKeys(subtle, { privateKey: ecdh }, { privateKey: ecdsa }, spki, spki, hex(sha256(spki)));
}

test('lease.json: the fake server makes every ECDH lease byte for byte', async () => {
  const bk = await buildKey(fromHex(L.key_id_hex), L.model, L.version);
  assert.equal(hex(bk), L.build_key_hex);
  const kcore = await kCore(L.release);
  assert.equal(hex(kcore), L.k_core_hex);
  let n = 0;
  for (const c of L.accept.filter((x) => x.wrap === 1)) {
    const f = c.fields;
    const lease = await makeLease({ flags: f.flags, lease_id: fromHex(f.lease_id_hex), iat: f.iat, exp: f.exp, refresh_after: f.refresh_after,
      key_id: fromHex(L.key_id_hex), build: L.build, install_hash: fromHex(f.install_hash_hex), mark: fromHex(f.mark_hex), model: L.model,
      version: L.version, release: L.release }, { bk, kcore, installSpki: unb64u(L.install_ecdh.spki_b64u), eph: await ephFromPkcs8(unb64u(c.eph_pkcs8_b64u)) });
    assert.equal(hex(lease), c.lease_hex, c.name);
    n++;
  }
  assert.ok(n >= 1);
});

test('refusal_signed.json: the fake server signs the stops of the vectors byte for byte', () => {
  const R = vector('refusal_signed.json');
  for (const c of R.cases.filter((x) => x.stop)) {
    const [, key, reason, install, challenge, t] = c.text.split('\n');
    assert.equal(signRefusal(key, reason, install, challenge, Number(t)), c.body.signed, c.name);
  }
});

const engine = await loadEngine();
const skip = engine ? false : 'no packaged engine (python scripts/build_web4.py engine)';

test('the real Core accepts and refuses the vector leases through this binding', { skip }, async () => {
  const M = vector('manifest_40.json');
  const manifest = new TextEncoder().encode(JSON.stringify(M.manifest));
  const keys = await vectorKeys(L.install_ecdh.pkcs8_b64u, L.install_ecdh.spki_b64u);
  assert.equal(keys.installHex, L.install_ecdh.install_hash_hex);
  const at = (now) => ({ wall: () => now * 1000, boot: () => 0 });
  const accepted = [];
  for (const c of L.accept.filter((x) => x.wrap === 1)) {
    const core = await createCore({ factory: engine.factory, wasm: engine.wasm, files: new MemoryFiles(), keys, clock: at(L.now) });
    const r = await core.leaseAccept(fromHex(c.lease_hex), manifest, L.core_context.build);
    assert.equal(r.exp, c.fields.exp, c.name);
    accepted.push(c.name);
    core.destroy();
  }
  assert.ok(accepted.length >= 1);
  for (const c of L.refuse) {
    if (Object.keys(c.context || {}).some((k) => k !== 'now')) continue; // a case for another install key or release: the Core's own runner covers it
    // the Core's clock anchored first by a good lease (a first lease is judged at its own iat, 18.4.7)
    const now = (c.context && c.context.now) || L.now;
    const first = L.accept.find((x) => x.wrap === 1);
    let t = first.fields.iat; // the wall clock and the boot clock move together on one boot
    const core = await createCore({ factory: engine.factory, wasm: engine.wasm, files: new MemoryFiles(), keys,
      clock: { wall: () => t * 1000, boot: () => (t - first.fields.iat) * 1000 } });
    await core.leaseAccept(fromHex(first.lease_hex), manifest, L.core_context.build);
    t = now;
    await assert.rejects(core.leaseAccept(fromHex(c.lease_hex), manifest, L.core_context.build), (e) => e instanceof CoreError && e.status < 0, c.name);
    core.destroy();
  }
});

test('the texts the binding prepares are the texts the Core signs (attest and lease ask), and they verify', { skip }, async () => {
  const keys = await InstallKeys.create();
  const core = await createCore({ factory: engine.factory, wasm: engine.wasm, files: new MemoryFiles(), keys });
  const challenge = 'c1.1790000300.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB';
  const pub = await subtle.importKey('spki', keys.signSpki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = (sig, text) => subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(sig), new TextEncoder().encode(text));
  // the Core signs only what was prepared: a call that returns proves the Core's text is the binding's
  const fromCore = await core.attestSig(challenge);
  assert.ok(await ok(fromCore, `quranlab-attest 1\n${challenge}\n${keys.installHex}\n`));
  assert.ok(await ok(await keys.attestSig(null), `quranlab-attest 1\n-\n${keys.installHex}\n`));
  const build = 'aa'.repeat(20);
  const ask = await core.leaseAsk(challenge, build);
  assert.ok(await ok(ask.installSig, `quranlab-lease-ask 1\n${challenge}\n${build}\n`));
  assert.equal(ask.core.release, '4.0.0-c1');
  assert.match(ask.core.target, /^wasm32-simd/);
  assert.equal(unb64u(ask.core.proof).length, 16);
  // a text the binding did not prepare is refused by the key store, never signed
  keys._sig = null;
  assert.throws(() => core._check(-10, 'x'), (e) => e.status === QLC.E_KEYSTORE);
  core.destroy();
});

test('install_cert.json attest_proof: the rule this SDK signs by', async () => {
  const C = vector('install_cert.json');
  const good = C.attest_proof.cases[0];
  const ih = hex(sha256(unb64u(good.install_key_b64u)));
  const pub = await subtle.importKey('spki', unb64u(good.install_sign_key_b64u), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  let sig = unb64u(good.install_sig_b64u);
  if (sig.length !== 64) { // DER to r || s
    const r = sig.subarray(4, 4 + sig[3]), s = sig.subarray(6 + sig[3]);
    const fix = (x) => (x.length > 32 ? x.subarray(x.length - 32) : Uint8Array.from([...new Array(32 - x.length).fill(0), ...x]));
    sig = new Uint8Array([...fix(r), ...fix(s)]);
  }
  assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, new TextEncoder().encode(`quranlab-attest 1\n${good.challenge}\n${ih}\n`)));
  assert.equal(b64u(sha256(new Uint8Array(0))).length, 43);
});
