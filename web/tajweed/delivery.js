// Model delivery for browsers and Node (the web download profile): only the files the
// chosen context needs, fetched in resumable HTTP ranges, checked against the signed manifest's size
// and SHA-256, and kept in a content-addressed cache (keyed by SHA-256, so a file shared by contexts
// or revisions, such as one shared weight file, is downloaded and stored once).
//
//   const reader = cachedReader({ baseUrl: 'https://cdn.quranlab.ai/models/Quran-Lab/tajweedformer-v4/<rev>/sdk/v4.0/',
//                                 headers: () => ql.modelHeaders(), onProgress });
//   const { folder } = await openTajweedFolder(reader);
//
// Stores: the Cache API in browsers (default), IndexedDB where there is no Cache API, a directory in
// Node (nodeStore in ./node.js), or memoryStore. Every store holds whole verified files under
// "sha256/<hex>" and in-progress ranges under "part/<hex>/<range index>"; a download interrupted
// (tab closed, network gone) continues from the ranges already stored.

import { logicalPath, gunzip } from './manifest.js';

/** Where the cache lives in a browser: the Cache API name and the IndexedDB name. */
export const CACHE_NAME = 'quranlab-tajweedformer-v1';
/** Range size of a download (4 MiB): the unit of resumption. */
export const DEFAULT_RANGE_SIZE = 4 * 1024 * 1024;

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
async function sha256(bytes) { return hex(await globalThis.crypto.subtle.digest('SHA-256', bytes)); }

/** A delivery failure: code 'http' (status in .status), 'checksum_mismatch', 'aborted', 'offline'. */
export class DeliveryError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'DeliveryError'; this.code = code; Object.assign(this, extra); }
}

// ---- stores: { get(key) -> Uint8Array|null, put(key, bytes), delete(key), keys(prefix) } ----

/** In memory (tests, or no persistence wanted). */
export function memoryStore() {
  const m = new Map();
  return {
    kind: 'memory',
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v, o = {}) { if (o.exclusive && m.has(k)) return false; m.set(k, v); return true; },
    async delete(k) { m.delete(k); },
    async keys(prefix = '') { return [...m.keys()].filter((k) => k.startsWith(prefix)); },
  };
}

/** The Cache API (browsers, service workers). Keys become same-origin-free synthetic URLs. */
export function cacheApiStore(name = CACHE_NAME) {
  const base = 'https://cache.quranlab.invalid/';
  const open = () => globalThis.caches.open(name);
  return {
    kind: 'cache-api',
    async get(k) { const r = await (await open()).match(base + k); return r ? new Uint8Array(await r.arrayBuffer()) : null; },
    async put(k, v) { await (await open()).put(base + k, new Response(v, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(v.length) } })); },
    async delete(k) { await (await open()).delete(base + k); },
    async keys(prefix = '') {
      const ks = await (await open()).keys();
      return ks.map((r) => r.url.slice(base.length)).filter((k) => k.startsWith(prefix));
    },
  };
}

/** IndexedDB (browsers without the Cache API, e.g. some private modes). */
export function indexedDbStore(name = CACHE_NAME) {
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const q = globalThis.indexedDB.open(name, 1);
    q.onupgradeneeded = () => q.result.createObjectStore('files');
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('files', mode);
      const r = fn(t.objectStore('files'));
      t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    kind: 'indexeddb',
    async get(k) { const v = await tx('readonly', (s) => s.get(k)); return v ? new Uint8Array(v) : null; },
    async put(k, v) { await tx('readwrite', (s) => s.put(v, k)); },
    async delete(k) { await tx('readwrite', (s) => s.delete(k)); },
    async keys(prefix = '') { const ks = await tx('readonly', (s) => s.getAllKeys()); return ks.filter((k) => String(k).startsWith(prefix)); },
  };
}

/** The best store this runtime has: the Cache API, else IndexedDB, else memory. */
export function defaultStore() {
  if (globalThis.caches && typeof globalThis.caches.open === 'function') return cacheApiStore();
  if (globalThis.indexedDB) return indexedDbStore();
  return memoryStore();
}

/** A storage API's answer that means "this browser refuses storage here", not "it failed". */
export const isSecurityError = (e) => !!e && e.name === 'SecurityError';

/**
 * What Cache Storage answers in this context, asked once and without making a cache: 'works', 'blocked', 'none'
 * (there is no Cache Storage) or 'failed' (any other failure).
 * 'blocked' is a SecurityError and nothing else, thrown by the `caches` getter or given by `caches.has`. Seen
 * 2026-11-13: Chrome 157 and Edge 157 with the site's cookies and site data blocked, and Firefox 150 with
 * cookies blocked, reject every call of CacheStorage with SecurityError; in a frame without an origin the getter
 * throws it. A failure of a store that works (a full disk, an internal error) has another name.
 */
export async function cacheStorageState(get = () => globalThis.caches) {
  let c;
  try { c = get(); } catch (e) { return isSecurityError(e) ? 'blocked' : 'failed'; }
  if (!c || typeof c.open !== 'function') return 'none';
  try { await c.has(CACHE_NAME); return 'works'; } catch (e) { return isSecurityError(e) ? 'blocked' : 'failed'; }
}

/**
 * The Client's store in a browser (SPEC 15.2 as of contract 1.14.0): the Cache API, else IndexedDB, else memory, as
 * defaultStore(); and where the browser BLOCKS storage, memory for this page load, marked `blocked: true`: the
 * model is downloaded, verified and run from memory, and downloaded again at the next visit. A browser that
 * keeps nothing has nothing to protect; before 3.1.2 it could not run the model at all.
 * A Cache Storage that fails in another way is still the store: its calls fail as storage errors, and a cached
 * model is never set aside for a failure that may pass.
 * @param {{ cacheStorage?: () => any, indexedDB?: () => any }} [o]  how the two are read (tests)
 */
export async function openDefaultStore(o = {}) {
  const state = await cacheStorageState(o.cacheStorage || (() => globalThis.caches));
  if (state === 'blocked') return Object.assign(memoryStore(), { blocked: true });
  if (state !== 'none') return cacheApiStore();
  let idb = null;
  try { idb = (o.indexedDB || (() => globalThis.indexedDB))(); } catch (_) { idb = null; }
  return idb ? indexedDbStore() : memoryStore();
}

// ---- the download profile ----

const CONTEXT_RE = /^c\d+_l\d+$/;

/**
 * The files a profile needs, from a format 2 manifest. Web and Node (the exact CPU engine): the root
 * files (tokens, calibration, expected table, a shared weight file when the manifest has one) and the
 * chosen context's folder; never CoreML, NPU blobs or the other contexts. A manifest whose files carry
 * delivery tags ({platform, context, role}; the delivery format) is filtered by them instead.
 * @param {object} manifest  parsed manifest.json
 * @param {{ context: string, platform?: string }} profile  platform: 'web' (default) or 'cpu'
 * @returns {string[]} paths, manifest.json not included
 */
export function profilePaths(manifest, { context, platform = 'web', optional = false } = {}) {
  if (!context) throw new TypeError('profilePaths: a context is needed');
  const out = [];
  if (manifest.format === 3) {
    // LAYOUT.md v2: need required (or optional when asked), platforms * or this one, context * or this one;
    // the logical (decoded) path, which is what the engine opens
    for (const f of manifest.files || []) {
      const platOk = f.platforms === '*' || [].concat(f.platforms).includes(platform);
      const ctxOk = f.context === '*' || f.context === context;
      if (platOk && ctxOk && (f.need === 'required' || optional) && f.soc === '*') out.push(logicalPath(f));
    }
    return out;
  }
  for (const f of manifest.files || []) {
    const p = f.path;
    if (p === 'manifest.json') continue;
    const tags = f.tags || (f.platform || f.context || f.role ? { platform: f.platform, context: f.context, role: f.role } : null);
    if (tags) {
      const plats = [].concat(tags.platform || []);
      const ctxs = [].concat(tags.context || []);
      const platOk = !plats.length || plats.some((x) => ['all', 'cpu', 'engine', platform].includes(x));
      const ctxOk = !ctxs.length || ctxs.includes('*') || ctxs.includes(context);
      if (platOk && ctxOk) out.push(p);
      continue;
    }
    const top = p.split('/')[0];
    if (!p.includes('/')) { out.push(p); continue; }
    if (top === context) { out.push(p); continue; }
    // other contexts, coreml/, npu/ and anything else nested are not part of the web profile
    if (CONTEXT_RE.test(top) || top === 'coreml' || top === 'npu') continue;
  }
  return out;
}

// ---- the reader ----

/**
 * A model-folder reader over HTTP that caches by SHA-256 and resumes by range.
 * @param {object} o
 * @param {string} o.baseUrl  the folder's URL, ending in "/" (sdk/v4.0/)
 * @param {Record<string,string>|(() => Promise<Record<string,string>>)} [o.headers]  the headers of every request, or
 *   what makes them (asked before each request: the Client's one header provider, SPEC 15.4)
 * @param {() => Promise<unknown>} [o.renew]  a 401 `invalid_token`: called once, then that request is repeated once
 *   (never when the answer's `reason` is one that `o.stops` names: the key is refused, not the token)
 * @param {(reason: string|null) => boolean} [o.stops]  whether an answer's `reason` refuses the key or the app
 * @param {(e: DeliveryError) => void} [o.onRefusal]  a 401 or 403 answer, with its `error` and `reason`
 * @param {() => void} [o.onServed]  the CDN served a request (a 2xx answer)
 * @param {() => boolean} [o.stopped]  true: the server has refused this app; no stored manifest is used
 * @param {typeof fetch} [o.fetch]
 * @param {object} [o.store]  a store (default: defaultStore()); false: no cache
 * @param {number} [o.rangeSize]  bytes per range request (default 4 MiB)
 * @param {number} [o.parallel]  ranges in flight (default 4)
 * @param {(p: {path: string, loaded: number, total: number, cached: boolean}) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {{ read(path: string): Promise<Uint8Array|null>, prefetch(paths: string[]): Promise<void>, stats: object, store: object|null }}
 */
export function cachedReader(o) {
  const base = o.baseUrl.endsWith('/') ? o.baseUrl : o.baseUrl + '/';
  const f = o.fetch || globalThis.fetch.bind(globalThis);
  const store = o.store === false ? null : (o.store || defaultStore());
  const rangeSize = o.rangeSize || DEFAULT_RANGE_SIZE;
  const parallel = Math.max(1, o.parallel || 4);
  const stats = { requests: 0, bytesDownloaded: 0, filesFromCache: 0, filesDownloaded: 0, rangesResumed: 0 };
  let listing = null; // path -> { size, sha256 } from the manifest, once read
  const pending = new Map();
  const held = new Map(); // prefetched bytes, handed over once (no second read from the store)

  const answers = new WeakMap(); // an error answer's { error, reason }, read once
  const req = async (path, range, repeated = false) => {
    let headers;
    try { headers = typeof o.headers === 'function' ? { ...(await o.headers()) } : { ...(o.headers || {}) }; } catch (e) {
      // no header can be made (no token: the server did not answer, or it refused): nothing is sent. `auth`
      // is the server's answer, raised where no stored copy can stand in.
      const err = new DeliveryError('offline', `${path}: ${(e && e.message) || e}`);
      if (e && e.name === 'PlatformError') err.auth = e;
      throw err;
    }
    if (range) headers.range = `bytes=${range[0]}-${range[1]}`;
    let r;
    stats.requests++;
    // a model request never leaves the CDN: a redirect is an error, not followed
    try { r = await f(base + path.split('/').map(encodeURIComponent).join('/'), { headers, signal: o.signal, cache: 'no-store', redirect: 'error' }); } catch (e) {
      if (o.signal && o.signal.aborted) throw new DeliveryError('aborted', 'download aborted');
      throw new DeliveryError('offline', `${path}: ${e.message || e}`);
    }
    if (r.status >= 200 && r.status < 300 && typeof o.onServed === 'function') { try { o.onServed(); } catch (_) { /* the Client's own problem */ } }
    if (r.status === 401 || r.status === 403 || r.status === 429) {
      let body = null;
      try { body = await r.clone().json(); } catch (_) { body = null; }
      const error = body && typeof body.error === 'string' ? body.error : null;
      const reason = body && typeof body.reason === 'string' ? body.reason : null;
      const refused = typeof o.stops === 'function' && o.stops(reason);
      // the token ran out or does not verify: a new one, once, and this request once more
      if (r.status === 401 && error === 'invalid_token' && !refused && typeof o.renew === 'function' && !repeated) {
        let renewed = true;
        try { await o.renew(); } catch (_) { renewed = false; }
        if (renewed) return req(path, range, true);
      }
      answers.set(r, { error, reason });
    }
    return r;
  };
  // an error answer as a DeliveryError that carries the answer's code; a refusal is told to the Client
  const httpError = (path, r) => {
    const a = answers.get(r) || { error: null, reason: null };
    const e = new DeliveryError('http', `${path}: HTTP ${r.status}${a.error ? ' ' + a.error : ''}`, { status: r.status, error: a.error, reason: a.reason });
    if ((r.status === 401 || r.status === 403) && typeof o.onRefusal === 'function') { try { o.onRefusal(e); } catch (_) { /* the Client's own problem */ } }
    return e;
  };

  async function fetchWhole(path) {
    const r = await req(path, null);
    if (r.status === 404) return null;
    if (!r.ok) throw httpError(path, r);
    const b = new Uint8Array(await r.arrayBuffer());
    stats.bytesDownloaded += b.length;
    return b;
  }

  // An answer that is not what was asked for: a failed attempt (a failed download for the app), never the file.
  const wrongAnswer = (path, r, why) => new DeliveryError('http', `${path}: HTTP ${r.status}, ${why}`, { status: r.status, error: null, reason: null });
  // The body of an answer, which must have exactly `want` bytes: it is read with that cap, so a body that runs
  // past it is cut off (and the rest let go), and one that ends before it fails as a connection that dropped.
  async function bodyOf(path, r, want) {
    const stream = r.body && typeof r.body.getReader === 'function' ? r.body.getReader() : null;
    if (!stream) {
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length > want) throw wrongAnswer(path, r, `a body of ${b.length} bytes where ${want} were asked for`);
      if (b.length < want) throw new DeliveryError('offline', `${path}: the body ended after ${b.length} of ${want} bytes`);
      return b;
    }
    const out = new Uint8Array(want);
    let at = 0;
    for (;;) {
      const { done, value } = await stream.read();
      if (done) break;
      if (at + value.length > want) {
        await stream.cancel().catch(() => {});
        throw wrongAnswer(path, r, `a body longer than the ${want} bytes that were asked for`);
      }
      out.set(value, at);
      at += value.length;
    }
    if (at < want) throw new DeliveryError('offline', `${path}: the body ended after ${at} of ${want} bytes`);
    return out;
  }

  async function fetchListed(path, size, sum, { keep = true, label = path } = {}) {
    const key = `sha256/${sum}`;
    if (store && keep) {
      const have = await store.get(key);
      if (have && have.length === size) { stats.filesFromCache++; o.onProgress?.({ path, loaded: size, total: size, cached: true }); return have; }
    }
    const n = Math.max(1, Math.ceil(size / rangeSize));
    const parts = new Array(n);
    let loaded = 0;
    if (store) {
      for (let i = 0; i < n; i++) {
        const p = await store.get(`part/${sum}/${i}`);
        const want = Math.min(size, (i + 1) * rangeSize) - i * rangeSize;
        if (p && p.length === want) { parts[i] = p; loaded += p.length; stats.rangesResumed++; }
      }
    }
    o.onProgress?.({ path: label, loaded, total: size, cached: false });
    let next = 0, whole = null, failed = null;
    // one failure stops every worker at its next range, and the read fails only when all of them have stopped:
    // nothing is requested or stored after the read has failed, so what is kept for the resume is settled
    const worker = async () => {
      while (whole === null && !failed) {
        let i = next++;
        while (i < n && parts[i]) i = next++;
        if (i >= n) return;
        const lo = i * rangeSize, hi = Math.min(size, lo + rangeSize) - 1;
        const r = await req(path, n === 1 && size === 0 ? null : [lo, hi]);
        if (r.status === 200) {
          // the server ignored Range: the whole file, and only at the manifest's size. A Content-Length that says
          // otherwise is refused before the body is read (with a content coding the length given is the coded
          // one and says nothing); the body is read with the size as its cap
          const length = r.headers.get('content-length');
          const coding = r.headers.get('content-encoding');
          if (length !== null && (!coding || coding === 'identity') && Number(length) !== size) {
            if (r.body && typeof r.body.cancel === 'function') await r.body.cancel().catch(() => {});
            throw wrongAnswer(path, r, `${length} bytes where the manifest says ${size}`);
          }
          const b = await bodyOf(path, r, size);
          stats.bytesDownloaded += b.length;
          whole = b;
          return;
        }
        // any other answer, a 2xx among them (204, 205, ...), is not the range
        if (r.status !== 206) throw httpError(path, r);
        // the range that was asked for, of the file the manifest lists: start, end and total. A page reads this
        // header only when the host names it in access-control-expose-headers (Quran Lab's CDN does); where it
        // cannot be read, the exact length of the range and the file's SHA-256 decide
        const cr = r.headers.get('content-range');
        if (cr !== null && cr.trim() !== `bytes ${lo}-${hi}/${size}`) throw wrongAnswer(path, r, `the range ${JSON.stringify(cr)} where bytes ${lo}-${hi}/${size} was asked for`);
        const b = await bodyOf(path, r, hi - lo + 1);
        stats.bytesDownloaded += b.length;
        parts[i] = b;
        loaded += b.length;
        if (store) await store.put(`part/${sum}/${i}`, b);
        o.onProgress?.({ path: label, loaded, total: size, cached: false });
      }
    };
    if (size === 0) whole = new Uint8Array(0);
    else {
      await Promise.all(Array.from({ length: Math.min(parallel, n) }, () => worker().catch((e) => { failed = failed || e; })));
      if (failed) throw failed;
    }
    let bytes = whole;
    const assembled = !bytes;
    if (assembled) {
      bytes = new Uint8Array(size);
      let at = 0;
      for (const p of parts) { bytes.set(p, at); at += p.length; }
    }
    if (bytes.length !== size || (await sha256(bytes)) !== sum) {
      // A failed attempt never deletes the ranges already stored. They are deleted in this one case: every range
      // is there and the file assembled from them fails its size or its SHA-256, so the ranges themselves are
      // the fault and the next read must start clean (it could never recover otherwise). A whole body (a 200)
      // that is not the file says nothing about the stored ranges: they stay.
      if (store && assembled) for (let i = 0; i < n; i++) await store.delete(`part/${sum}/${i}`);
      throw new DeliveryError('checksum_mismatch', `${path} does not match its size and SHA-256 in the manifest`, { path });
    }
    stats.filesDownloaded++;
    if (store) {
      if (keep) await store.put(key, bytes);
      for (let i = 0; i < n; i++) await store.delete(`part/${sum}/${i}`);
    }
    return bytes;
  }

  // a gzip transport file: the decoded file from the cache, else the stored bytes (resumable ranges,
  // checked), inflated, checked against the decoded size and SHA-256, and kept decoded
  async function fetchDecoded(path, e) {
    if (store) {
      const have = await store.get(`sha256/${e.sha256}`);
      if (have && have.length === e.size) { stats.filesFromCache++; o.onProgress?.({ path, loaded: e.size, total: e.size, cached: true }); return have; }
    }
    const gz = await fetchListed(e.stored.path, e.stored.size, e.stored.sha256, { keep: false, label: path });
    const bytes = await gunzip(gz);
    if (bytes.length !== e.size || (await sha256(bytes)) !== e.sha256) {
      throw new DeliveryError('checksum_mismatch', `${path} (inflated from ${e.stored.path}) does not match its decoded size and SHA-256`, { path });
    }
    stats.bytesInflated = (stats.bytesInflated || 0) + bytes.length;
    if (store) await store.put(`sha256/${e.sha256}`, bytes);
    return bytes;
  }

  const reader = {
    store,
    stats,
    /** Every read hands over bytes nobody else holds (so they may be transferred to a Worker). */
    fresh: true,
    /** Whether a listed file is in the cache whole (no network). False before the manifest was read. */
    async cached(path) {
      const e = listing && listing.get(path);
      if (!e || !store) return false;
      if (typeof store.has === 'function') return store.has(`sha256/${e.sha256}`);
      return (await store.keys(`sha256/${e.sha256}`)).length > 0;
    },
    async read(path) {
      if (path === 'manifest.json') {
        // always fresh when online (it is small and signed). With no fresh one (no network, no token, an error
        // answer of the CDN) the last good copy, so a model a real download left keeps running; never when
        // the server's answer stops the model on this device
        let b = null;
        try { b = await fetchWhole('manifest.json'); } catch (e) {
          if (!(e instanceof DeliveryError) || e.code === 'aborted' || e.code === 'checksum_mismatch') throw e;
          const have = store && !(typeof o.stopped === 'function' && o.stopped()) ? await store.get(`manifest/${base}`) : null;
          if (!have) {
            if (e.auth) throw e.auth;
            if (e.code === 'offline') e.nothingCached = true;
            throw e;
          }
          b = have;
        }
        if (b && store) await store.put(`manifest/${base}`, b);
        try {
          const m = JSON.parse(new TextDecoder().decode(b));
          listing = new Map((m.files || []).map((x) => [logicalPath(x), x.encoding === 'gzip' && x.decoded
            ? { size: x.decoded.size, sha256: String(x.decoded.sha256).toLowerCase(), stored: { path: x.path, size: x.size, sha256: String(x.sha256).toLowerCase() } }
            : { size: x.size, sha256: String(x.sha256).toLowerCase(), stored: null }]));
        } catch (_) { listing = null; }
        return b;
      }
      if (held.has(path)) { const b = held.get(path); held.delete(path); return b; }
      const e = listing && listing.get(path);
      if (!e) return fetchWhole(path); // unlisted: ModelFolder refuses it anyway
      if (!pending.has(path)) pending.set(path, (e.stored ? fetchDecoded(path, e) : fetchListed(path, e.size, e.sha256)).finally(() => pending.delete(path)));
      return pending.get(path);
    },
    /** Download (or find in the cache) the given listed paths, in parallel. */
    async prefetch(paths) { await Promise.all(paths.map(async (p) => { const b = await reader.read(p); if (b) held.set(p, b); })); },
  };
  return reader;
}

/**
 * Remove cached files that no manifest in `keep` lists (old revisions). Returns bytes freed when the
 * store can tell. Leaves in-progress ranges of listed files.
 */
export async function pruneCache(store, keepManifests) {
  const keep = new Set();
  for (const m of keepManifests) for (const f of m.files || []) keep.add(String(f.sha256).toLowerCase());
  let removed = 0;
  for (const k of await store.keys('sha256/')) {
    if (!keep.has(k.slice(7))) { await store.delete(k); removed++; }
  }
  for (const k of await store.keys('part/')) {
    if (!keep.has(k.split('/')[1])) { await store.delete(k); removed++; }
  }
  return removed;
}
