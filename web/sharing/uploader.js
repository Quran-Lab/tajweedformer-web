// qlab-api's shared-session routes and the PUTs to R2 (PLATFORM_CLIENT.md section 10; the Swift
// SDK's ContributionClient). POST /v1/uploads (the session JSON, x-qlab-id) answers presigned PUT
// URLs for segments 1 to 20, each for its own key v1/{id}/seg-NNNNN.opus (content-type audio/ogg
// signed, valid 7 days); POST /v1/uploads/{id}/urls?from=n answers the next batch, or fresh URLs for
// the same numbers. Segments go straight to R2 as plain PUTs. Nothing is sent at the end.

export const SDK_VERSION = '3.1.1';
export const INPUT_ROUTES = Object.freeze(['built_in', 'wired', 'usb', 'bluetooth', 'car', 'continuity', 'other', 'unknown']);
const CONSENT_RE = /^[A-Za-z0-9._-]{1,32}$/;
const DEVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** "2026-11-07": the UTC day. */
export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

/** The session JSON sent at the start: exactly the fields of qlab-api's closed schema. consentTextSha256: the
 * hash of an app's own wording the learner agreed to (2.0.1), sent next to consent_version only then. */
export function sessionJson({ modelRevision = null, backend = 'exact', weightsSha256 = null, sdkVersion = SDK_VERSION,
  consentVersion = null, consentTextSha256 = null, contributor, day, deviceClass, osMajor, inputSampleRate, inputRoute = 'unknown',
  contributorKey = null, recoveryHash = null, takeSeq = null, gapMsPrev = null, modelBuild = null }) {
  if (contributorKey !== null && !/^[A-Za-z0-9_-]{87}$/.test(contributorKey)) throw new TypeError('contributor_key: base64url of the 65-byte point');
  if (recoveryHash !== null && !HEX64.test(recoveryHash)) throw new TypeError('recovery_hash: 64 lowercase hex');
  if (!HEX32.test(contributor)) throw new TypeError('contributor: 32 lowercase hex');
  if (!DEVICE_RE.test(deviceClass)) throw new TypeError(`device_class ${deviceClass}`);
  if (!(Number.isInteger(osMajor) && osMajor >= 1 && osMajor <= 99)) throw new TypeError(`os_major ${osMajor}`);
  if (consentVersion !== null && !CONSENT_RE.test(consentVersion)) throw new TypeError('consent version: 1 to 32 of A-Z a-z 0-9 . _ -');
  if (consentTextSha256 !== null && !(HEX64.test(consentTextSha256) && consentVersion === `custom-${consentTextSha256.slice(0, 24)}`)) {
    throw new TypeError('consent_text_sha256: 64 lowercase hex, with the custom-<24 hex> consent version it derives');
  }
  if (!INPUT_ROUTES.includes(inputRoute)) throw new TypeError(`input_route ${inputRoute}`);
  if (!['neuralEngine', 'exact', 'mock'].includes(backend)) throw new TypeError(`backend ${backend}`);
  if (takeSeq !== null && !(Number.isInteger(takeSeq) && takeSeq >= 1)) throw new TypeError(`take_seq ${takeSeq}`);
  if (gapMsPrev !== null && !(Number.isInteger(gapMsPrev) && gapMsPrev >= 0 && gapMsPrev <= 3600000 && gapMsPrev % 100 === 0)) throw new TypeError(`gap_ms_prev ${gapMsPrev}`);
  const audio = { codec: 'opus', container: 'ogg', sample_rate: 48000, channels: 1, input_route: inputRoute };
  if (inputSampleRate >= 8000 && inputSampleRate <= 192000) audio.input_sample_rate = Math.round(inputSampleRate);
  const o = {
    audio,
    consent_text_sha256: consentTextSha256,
    consent_version: consentVersion,
    contributor,
    contributor_key: contributorKey,
    day,
    decode: { backend, model_revision: modelRevision ? String(modelRevision).slice(0, 64) : null,
      sdk_version: sdkVersion, weights_sha256: weightsSha256 && HEX64.test(weightsSha256) ? weightsSha256 : null },
    device_class: deviceClass,
    format: 1,
    os_major: osMajor,
    recovery_hash: recoveryHash,
  };
  if (consentVersion === null) delete o.consent_version;
  // absent for the deck's own wording: a 2.0.0 server's closed schema refuses fields it does not know
  if (consentTextSha256 === null) delete o.consent_text_sha256;
  if (contributorKey === null) delete o.contributor_key;
  if (recoveryHash === null) delete o.recovery_hash;
  // SDK 3.0.0: the model's build next to its version; this install's count of shared recordings; the wall gap
  // since the previous one (absent for the first, or after more than an hour)
  if (typeof modelBuild === 'string' && /^[0-9a-f]{40}$/.test(modelBuild)) o.decode.model_build = modelBuild;
  if (takeSeq !== null) o.take_seq = takeSeq;
  if (gapMsPrev !== null) o.gap_ms_prev = gapMsPrev;
  // sorted keys, as the Swift SDK writes it
  const sort = (x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
  return JSON.stringify(sort(o));
}

/** base64url without padding. */
export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The exact bytes a deletion signs (PLATFORM_CLIENT 9.1 step 2). */
export function deletionMessage({ app, contributor, nonce, timestamp }) {
  return new TextEncoder().encode(`quranlab-contribution-delete 1
app ${app}
contributor ${contributor}
nonce ${nonce}
` +
    `timestamp ${timestamp}
action delete-all
`);
}

/** Errors the SDK must act on: `code` contributor_revoked or contributor_key_mismatch (make a new
 * contributor, key and recovery code), volume_limit, segment_cap, ... */
export class SharingError extends Error {
  constructor(code, status, message) {
    super(`${code}${message ? `: ${message}` : ''}`);
    this.name = 'SharingError';
    this.code = code;
    this.status = status;
  }
}

/** The URLs in an answer of either route ([{n, url, expiresAt (ms)}]), or null. */
export function parseUrls(body, id) {
  if (!body || body.id !== id || !Array.isArray(body.urls)) return null;
  const out = [];
  for (const u of body.urls) {
    if (Number.isInteger(u.n) && u.n > 0 && typeof u.url === 'string' && typeof u.expires_at === 'number') {
      out.push({ n: u.n, url: u.url, expiresAt: u.expires_at * 1000 });
    }
  }
  return out.length ? out : null;
}

/** Usable for a PUT that starts now (five minutes of margin). */
export const freshUrl = (u, now) => u.expiresAt - now > 300000;

/** The Worker calls and the PUT. `fetch` is injectable; responses come back as { status, body (parsed
 * JSON or null), text }, and a network failure as { status: 0, error }. */
export class ContributionClient {
  constructor({ api, fetch: f = globalThis.fetch?.bind(globalThis), headers = {} }) {
    this.api = String(api).replace(/\/+$/, '');
    this.fetch = f;
    // extra headers for the Worker calls (never for the PUTs to R2)
    this.headers = headers;
  }

  async _send(url, init) {
    let r;
    try { r = await this.fetch(url, init); } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      return { status: 0, error: String(e && e.message || e), body: null, text: '' };
    }
    const text = await r.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
    return { status: r.status, body, text };
  }

  start({ id, session, token, turnstile = null, signal }) {
    const headers = { ...this.headers, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-qlab-id': id };
    if (turnstile) headers['x-qlab-turnstile'] = turnstile;
    return this._send(`${this.api}/v1/uploads`, { method: 'POST', headers, body: session, signal });
  }

  urls({ id, from, contributor, token, signal }) {
    return this._send(`${this.api}/v1/uploads/${id}/urls?from=${from}`, {
      method: 'POST', headers: { ...this.headers, authorization: `Bearer ${token}`, 'x-qlab-contributor': contributor }, signal,
    });
  }

  /** The take list of an uploaded recording that takes in a row shared (2.0.3): POST /v1/uploads/{id}/takes with
   * the exact body {"takes":[{"start_ms","gap_ms"}, ...]} (2 to 256 entries). Idempotent: the server replaces
   * the list. */
  takes({ id, body, contributor, token, signal }) {
    return this._send(`${this.api}/v1/uploads/${id}/takes`, {
      method: 'POST', headers: { ...this.headers, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-qlab-contributor': contributor },
      body, signal,
    });
  }

  /** A plain PUT of one segment to its presigned URL: content-type audio/ogg (signed into the URL)
   * and nothing else. */
  put({ url, bytes, signal }) {
    return this._send(url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: bytes, signal });
  }

  /**
   * "Delete what I shared" with the device key (PLATFORM_CLIENT 9.1): a challenge, the signed
   * message, the delete. No app credential is sent (the server refuses one). `sign(bytes)` returns
   * the ECDSA P-256 SHA-256 signature (r||s, 64 bytes, or DER). Resolves to the 202 body.
   */
  async deleteShared({ app, contributor, sign, now = () => Date.now() }) {
    const json = { ...this.headers, 'content-type': 'application/json' };
    delete json.authorization;
    delete json['x-qlab-key'];
    const c = await this._send(`${this.api}/v1/contributions/challenge`, { method: 'POST', headers: json, body: JSON.stringify({ app, contributor }) });
    if (c.status !== 200 || !c.body || typeof c.body.nonce !== 'string') throw new SharingError((c.body && c.body.error) || `http_${c.status}`, c.status, c.error);
    const timestamp = Math.floor(now() / 1000);
    const signature = b64url(new Uint8Array(await sign(deletionMessage({ app, contributor, nonce: c.body.nonce, timestamp }))));
    const r = await this._send(`${this.api}/v1/contributions/delete`, { method: 'POST', headers: json,
      body: JSON.stringify({ app, contributor, nonce: c.body.nonce, timestamp, action: 'delete-all', signature }) });
    if (r.status !== 202 && r.status !== 200) throw new SharingError((r.body && r.body.error) || `http_${r.status}`, r.status, r.error);
    return r.body;
  }

  /** GET /v1/contributions/summary: real aggregate numbers for the gratitude line. */
  summary({ contributor, token }) {
    return this._send(`${this.api}/v1/contributions/summary`, {
      method: 'GET', headers: { ...this.headers, authorization: `Bearer ${token}`, 'x-qlab-contributor': contributor },
    });
  }
}

/** Worker calls and R2 PUTs for a session of a given length, from the segment plan (Swift
 * testRequestCountsBySessionLength). */
export function requestCounts(seconds, plan = [10, 20, 40, 60]) {
  let n = 0, t = 0;
  while (t < seconds) { n++; t += plan[Math.min(n, plan.length) - 1]; }
  return { segments: n, workerCalls: 1 + Math.trunc(Math.max(0, n - 15 + 19) / 20) };
}
