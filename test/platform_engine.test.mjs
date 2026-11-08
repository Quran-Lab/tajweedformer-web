// The platform client with the real engine: a mock API (signed config recommending a model, a tajweed
// block) and a mock CDN (the staged V4 files, signed with a test key), then TajweedFormer.load({ platform })
// streams a conformance clip and scores it: the portal's settings are in force, telemetry records the
// session (chunks, latency, margins, coverage), and the sharing state asks after the scored session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { bindTajweed, signedText, memoryStore } from '../web/tajweed/index.js';
import { QuranLab, keyId, memoryState } from '../web/platform/index.js';
import { enableSharing } from '../web/consent/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const ENGINE = process.env.TAJWEED_V4_ENGINE || '';
const CAL = process.env.TAJWEED_V4_CALIBRATION || '';
const TOKENS = process.env.TAJWEED_V4_TOKENS || '';
const AUDIO = process.env.TAJWEED_V4_AUDIO || '';
const have = existsSync(path.join(ENGINE, 'c16_l64', 'layers.zfw')) && existsSync(path.join(root, 'dist', 'tajweedformer.mjs')) && existsSync(AUDIO);

test('platform + engine: recommended model from the CDN, portal settings, telemetry, the sharing ask', {
  skip: have ? false : 'needs the staged V4 files, dist/tajweedformer.mjs and the audio', timeout: 600000,
}, async (t) => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const kid = await keyId(pub);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const folder = new Map([['calibration.json', readFileSync(CAL)], ['tokens.txt', readFileSync(TOKENS)], ['expected_tj3.zfx', readFileSync(path.join(ENGINE, 'expected_tj3.zfx'))]]);
  for (const f of readdirSync(path.join(ENGINE, 'c16_l64'))) folder.set(`c16_l64/${f}`, readFileSync(path.join(ENGINE, 'c16_l64', f)));
  const m = { format: 2, model_id: 'v4.0', family: 'tajweedformer', revision: 'abc123', min_sdk_version: '2.0.0', engine_format: 2, coreml_format: 9,
    tokens_sha256: sha(folder.get('tokens.txt')), coreml: '-', sidecar: 'c16_l64/layers.zfw', keeps: '-', tokens: 'tokens.txt',
    files: [...folder].map(([p, b]) => ({ path: p, size: b.length, sha256: sha(b) })) };
  m.signature = Buffer.from(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(signedText(m)))).toString('base64');
  folder.set('manifest.json', Buffer.from(JSON.stringify(m)));

  const log = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    log.push(`${init.method || 'GET'} ${u.host}${u.pathname}`);
    const json = (s, o, hh = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...hh } });
    if (u.host === 'cdn.test') {
      assert.equal(h['x-qlab-key'], 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa');
      const p = decodeURIComponent(u.pathname.replace('/hf/Quran-Lab/tajweedformer-v4/abc123/sdk/v4.0/', ''));
      const b = folder.get(p);
      if (!b) return new Response(null, { status: 404 });
      const r = /^bytes=(\d+)-(\d+)$/.exec(h.range || '');
      if (r) { const lo = +r[1], hi = Math.min(+r[2], b.length - 1); return new Response(b.subarray(lo, hi + 1), { status: 206, headers: { 'content-range': `bytes ${lo}-${hi}/${b.length}` } }); }
      return new Response(b, { status: 200 });
    }
    if (u.pathname === '/v1/attest') return json(200, { token: 'qlt_v1.t.s', expires_in: 86400, attested: false });
    if (u.pathname === '/v1/register') return json(200, { ok: true, app_id: 'web:https://app.example', store_status: 'pending' });
    if (u.pathname === '/v1/config') {
      const now = Math.floor(Date.now() / 1000);
      const cfg = { v: 1, app: 'web:https://app.example', channel: 'stable', issued_at: now, expires_at: now + 86400, models: {},
        recommended: { model: 'Quran-Lab/tajweedformer-v4', model_id: 'v4.0', folder: 'sdk/v4.0', revision: 'abc123', source: 'stable' },
        denylist: [], flags: { analytics: true, issues: true, contributions: true, upload_trust: { web: 'capped' } },
        tajweed: { v: 1, preset: 'sensitive', overrides: { cons_sub: { preset: 'strict' } } } };
      const body = new TextEncoder().encode(JSON.stringify(cfg));
      const sig = Buffer.from(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, body)).toString('base64url');
      return new Response(body, { status: 200, headers: { 'x-qlab-signature': `ed25519=${sig}`, 'x-qlab-key-id': kid, etag: '"1"' } });
    }
    return json(404, { error: 'not_found' });
  };
  const ql = await QuranLab.configure({ key: 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa', bundleId: 'https://app.example', origin: 'https://app.example',
    fetch, trustedKeys: [pub], state: memoryState(), apiUrl: 'https://api.test', cdnUrl: 'https://cdn.test', contributions: true });
  assert.equal(ql.lastError, undefined, String(ql.lastError));
  assert.equal(ql.sharingAllowed(), true);
  const asks = [];
  const sharing = enableSharing(ql, { ask: async (a) => { asks.push(a); return { yes: false }; } });

  const { default: f } = await import(pathToFileURL(path.join(root, 'dist', 'tajweedformer.mjs')).href);
  const TF = bindTajweed(f);
  const tf = await TF.load({ platform: ql, cache: memoryStore(), trustedKeys: [pub] });
  assert.equal(tf.info.revision, 'abc123');
  const eff = tf.effectiveSettings();
  assert.equal(eff.preset, 'sensitive');
  assert.equal(eff.sites.cons_sub.preset, 'strict');
  assert.equal(eff.sites.cons_sub.source, 'remote');

  const exp = JSON.parse(readFileSync(path.join(root, 'test/tajweed/conformance/v4_c16_l64_audio_expected.jsonl'), 'utf8').split('\n')[0]);
  const pcmBuf = readFileSync(path.join(AUDIO, `${exp.clip}.pcm`));
  const pcm = new Float32Array(pcmBuf.buffer.slice(pcmBuf.byteOffset, pcmBuf.byteOffset + pcmBuf.byteLength));
  const s = tf.createStream();
  for (let at = 0; at < pcm.length; at += 320) s.pushAudio(pcm.subarray(at, at + 320));
  s.finish();
  assert.deepEqual(s.greedy(), exp.tokens, 'the hooks change no bits');
  const r = await tf.score(s.heads(), 1, 1);
  s.free();
  assert.equal(r.settings.preset, 'sensitive');
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(asks, [{ variant: 'first', guardian: false }], 'asked once, after the scored session');
  assert.equal(sharing.state.s.consent, 'declined');

  // telemetry: one session with this clip's chunks, latency histogram, margins, coverage of surah 1
  const days = ql.state.get('telemetry.days');
  const d = Object.values(days)[0];
  const c = d.cohorts[0];
  t.diagnostic(`telemetry cohort: ${JSON.stringify({ preset: c.preset, sessions: c.sessions, minutes: c.minutes, chunks: c.chunks, latency_ms: c.latency_ms, rtf: c.rtf })}`);
  assert.equal(c.preset, 'sensitive');
  assert.equal(c.sessions, 1);
  assert.equal(c.chunks, exp.chunks);
  assert.equal(Object.values(c.latency_ms).reduce((a, b) => a + b, 0), exp.chunks);
  assert.ok(Object.values(c.margin).reduce((a, b) => a + b, 0) >= exp.tokens.length);
  assert.deepEqual(d.coverage, { 1: 1 });
  assert.equal(Object.values(c.model_load_ms).reduce((a, b) => a + b, 0), 1);
  assert.equal(d.downloads[0].profile, 'web-cpu');
  assert.ok(log.filter((x) => x.startsWith('GET cdn.test')).length > 0);
  tf.free();
});
