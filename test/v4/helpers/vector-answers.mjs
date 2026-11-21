// The answers of contract sdk_4.0.0 vectors/endpoints_40.json (`answers_are`) as fetch gives them, so the failover
// code (sdk4/shared/endpoints.js) and the routes' own checks read them as real answers: { answer: none } is a fetch that
// fails with no status, { answer: stalled } one whose status never comes (it ends when the request is aborted), else a
// Response of the status with the body the vector names. `json` is the route's own answer (for a 2xx) or the API's
// error body (a 4xx or 5xx); `bytes` a model file's bytes; `invalid` an answer that fails the route's check.
import { edSignBytes, signerPub, sha256 } from './fake-api.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const enc = new TextEncoder();
/** The key the stand-in signs configs with (the contract's test key), as a QuranLab's trustedKeys. */
export const TRUSTED = [hex(signerPub())];

/** A signed config (PLATFORM_CLIENT 3) valid for a day at `nowS`, or (bad) one whose signature is not over its bytes. */
export function signedConfig(nowS = Math.floor(Date.now() / 1000), { bad = false, extra = {} } = {}) {
  const body = enc.encode(JSON.stringify({ v: 1, issued_at: nowS, expires_at: nowS + 86400, flags: { analytics: true, issues: true }, ...extra }));
  const sig = edSignBytes(bad ? enc.encode('another body') : body);
  return { body, headers: { 'x-qlab-signature': 'ed25519=' + Buffer.from(sig).toString('base64url'), 'x-qlab-key-id': hex(sha256(signerPub()).subarray(0, 8)), etag: '"e1"' } };
}

/** The route's own 2xx answer (body and headers), or its `invalid` form. */
function routeAnswer(route, a, invalid) {
  if (route === 'config') { const c = signedConfig(undefined, { bad: invalid }); return { body: c.body, headers: c.headers }; }
  if (route === 'file' || route === 'engine') {
    // 1000 bytes; a 206 names bytes 0- of them, its `invalid` form another total
    const total = invalid ? 999 : 1000;
    return { body: new Uint8Array(1000), headers: a.status === 206 ? { 'content-range': `bytes 0-999/${total}` } : {} };
  }
  if (invalid) return { body: '{"not":"the answer"}', headers: {} };
  if (route === 'token' || route === 'attest') return { body: JSON.stringify({ token: 'tok', expires_in: 86400 }), headers: {} };
  if (route === 'challenge') return { body: JSON.stringify({ challenge: 'c1.0.a.b' }), headers: {} };
  // the lease route: what the Core says of it rides along for the stand-in Core (core: accepted | refused)
  if (route === 'model-key') return { body: JSON.stringify({ v: 1, lease: 'AA', base: 'https://cdn.quranlab.ai/models/x/', core: a.core || null }), headers: {} };
  return { body: '{}', headers: {} };
}

/** One host's answer `a` to a request of `route`, as fetch gives it. */
export function respond(a, route, { signal = null } = {}) {
  if (!a) return Promise.reject(new Error('a host was asked that the case gives no answer'));
  if (a.answer === 'none') return Promise.reject(new TypeError('fetch failed'));
  if (a.answer === 'stalled') {
    return new Promise((_, reject) => {
      if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
  }
  const headers = {};
  if (a.retry_after !== undefined && a.retry_after !== null) headers['retry-after'] = String(a.retry_after);
  let body = null;
  if (a.status === 304 || a.body === 'empty') body = a.status === 304 ? null : '';
  else if (a.body === 'html') body = '<!doctype html><title>a page</title>';
  else if (a.status >= 300 && a.body === 'json') body = JSON.stringify({ error: a.error, ...(a.reason ? { reason: a.reason } : {}) });
  else if (a.body === 'json' || a.body === 'bytes' || a.body === 'invalid') {
    const r = routeAnswer(route, a, a.body === 'invalid');
    body = r.body;
    Object.assign(headers, r.headers);
  }
  return Promise.resolve(new Response(body, { status: a.status, headers }));
}

/** A fetch over hosts: answers[host] answers a request to https://<host>/...; `asked` lists the hosts in order. */
export function hostsFetch(answers, route) {
  const asked = [];
  const fetch = (url, init = {}) => {
    const host = new URL(url).host;
    asked.push(host);
    return respond(answers[host], route, { signal: init.signal });
  };
  return { fetch, asked };
}
