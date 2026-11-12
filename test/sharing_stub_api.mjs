// A stub qlab-api for the sharing wiring tests (not a test file itself): token, register, a signed config with
// the given flags, /v1/uploads with URLs that the same stub takes as R2 PUTs (it keeps the bodies), events
// (kept, answered by `state.events`), issues, the contribution routes for a deletion.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuranLab, keyId, memoryState } from '../web/platform/index.js';

const enc = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString('base64url');
export const KEY = 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa';
const root = fileURLToPath(new URL('..', import.meta.url));

export async function stubApi(flags) {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const kid = await keyId(pub);
  const state = { flags, starts: [], puts: new Map(), takes: [], configVersion: 1, registers: [], events: [], eventReply: () => ({ status: 202, body: { ok: true, points: 1 } }), deletes: 0 };
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const urls = (id, from) => ({ id, urls: Array.from({ length: 20 }, (_, i) => ({ n: from + i, url: `https://r2.test/v1/${id}/seg-${String(from + i).padStart(5, '0')}.opus`, expires_at: Math.floor(Date.now() / 1000) + 604800 })) });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (u.host === 'r2.test') {
      assert.equal(init.method, 'PUT');
      assert.equal(h['content-type'], 'audio/ogg');
      const b = init.body instanceof Uint8Array ? init.body : new Uint8Array(await new Response(init.body).arrayBuffer());
      state.puts.set(u.pathname, b);
      return new Response('', { status: 200 });
    }
    if (u.pathname === '/v1/attest') return json(200, { token: 'qlt_v1.test.sig', expires_in: 86400, attested: false });
    if (u.pathname === '/v1/contributions/challenge') return json(200, { nonce: 'd1.1790000000.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB', expires_in: 300 });
    // state.deleteStatus: the server does not take the delete (an error status)
    if (u.pathname === '/v1/contributions/delete') { if (state.deleteStatus) return json(state.deleteStatus, { error: 'unavailable' }); state.deletes++; return json(202, { ok: true }); }
    if (h.authorization !== 'Bearer qlt_v1.test.sig') return json(401, { error: 'invalid_token' });
    if (u.pathname === '/v1/register') { state.registers.push(JSON.parse(init.body)); return json(200, { ok: true }); }
    if (u.pathname === '/v1/config') {
      const now = Math.floor(Date.now() / 1000);
      const cfg = { v: 1, app: 'linux:org.example.recfix', channel: 'stable', issued_at: now, expires_at: now + 86400, models: {}, recommended: null, denylist: [], flags: state.flags };
      const bytes = enc.encode(JSON.stringify(cfg));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, bytes));
      return new Response(bytes, { status: 200, headers: { 'x-qlab-signature': `ed25519=${b64u(sig)}`, 'x-qlab-key-id': kid, etag: `"v${state.configVersion++}"` } });
    }
    if (u.pathname === '/v1/uploads' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      state.starts.push(body);
      return json(201, urls(h['x-qlab-id'], 1));
    }
    const more = /^\/v1\/uploads\/([0-9a-f]{32})\/urls$/.exec(u.pathname);
    if (more) return json(200, urls(more[1], Number(u.searchParams.get('from'))));
    // 2.0.3: the take list of a recording that takes in a row shared (kept as sent)
    const list = /^\/v1\/uploads\/([0-9a-f]{32})\/takes$/.exec(u.pathname);
    if (list && init.method === 'POST') { state.takes.push({ id: list[1], body: init.body, contributor: h['x-qlab-contributor'] }); return new Response(null, { status: 204 }); }
    if (u.pathname === '/v1/events') {
      const body = JSON.parse(init.body);
      state.events.push({ body, raw: init.body, keepalive: !!init.keepalive });
      const r = state.eventReply(body);
      return json(r.status, r.body);
    }
    if (u.pathname === '/v1/issues') return json(202, { ok: true });
    if (u.pathname === '/v1/contributions/summary') return json(200, { you: { sessions: 1, minutes: 3 }, app: null, all: { contributors: 1, minutes: 3 } });
    return json(404, { error: 'not_found' });
  };
  return { fetch, pub, state };
}

export const client = async (api, extra = {}) => QuranLab.configure({ key: KEY, platform: 'linux', bundleId: 'org.example.recfix', apiUrl: 'https://api.test',
  fetch: api.fetch, trustedKeys: [api.pub], state: memoryState(), appVersion: '1', ...extra });

/** The model self-test clip (16 kHz) repeated to `seconds`. */
export function clip16k(seconds) {
  const clip = new Float32Array(readFileSync(path.join(root, 'test', 'sharing', 'selftest_16k.f32')).buffer.slice(0));
  const pcm = new Float32Array(Math.round(16000 * seconds));
  for (let i = 0; i < pcm.length; i += clip.length) pcm.set(clip.subarray(0, Math.min(clip.length, pcm.length - i)), i);
  return pcm;
}

/** One listened session through the controller's wiring (a stub stream), then the session-completed hook. */
export async function listen(ctl, pcm, { complete = true } = {}) {
  const s = { pushAudio: () => 0, finish: () => 0, free: () => 0 };
  ctl.streamStarted({ sampleRate: 16000 }, s);
  for (let i = 0; i < pcm.length; i += 640) s.pushAudio(pcm.subarray(i, i + 640));
  s.finish();
  await new Promise((r) => setTimeout(r, 300));
  return complete ? ctl.sessionCompleted({ feedback: true }) : null;
}
