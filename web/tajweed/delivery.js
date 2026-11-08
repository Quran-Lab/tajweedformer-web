// Model delivery for browsers and Node (the web download profile): only the files the
// chosen context needs, fetched in resumable HTTP ranges, checked against the signed manifest's size
// and SHA-256, and kept in a content-addressed cache (keyed by SHA-256, so a file shared by contexts
// or revisions, such as one shared weight file, is downloaded and stored once).
//
//   const reader = cachedReader({ baseUrl: 'https://cdn.quranlab.ai/hf/Quran-Lab/tajweedformer-v4/<rev>/sdk/v4.0/',
//                                 headers: { 'x-qlab-key': key }, onProgress });
//   const tf = await TajweedFormer.load({ reader, context: 'c16_l64' });
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
    async put(k, v) { m.set(k, v); },
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
 * @param {Record<string,string>} [o.headers]  e.g. { 'x-qlab-key': key } for the Quran Lab CDN
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

  const req = async (path, range) => {
    const headers = { ...(o.headers || {}) };
    if (range) headers.range = `bytes=${range[0]}-${range[1]}`;
    let r;
    stats.requests++;
    try { r = await f(base + path.split('/').map(encodeURIComponent).join('/'), { headers, signal: o.signal, cache: 'no-store' }); } catch (e) {
      if (o.signal && o.signal.aborted) throw new DeliveryError('aborted', 'download aborted');
      throw new DeliveryError('offline', `${path}: ${e.message || e}`);
    }
    return r;
  };

  async function fetchWhole(path) {
    const r = await req(path, null);
    if (r.status === 404) return null;
    if (!r.ok) throw new DeliveryError('http', `${path}: HTTP ${r.status}`, { status: r.status });
    const b = new Uint8Array(await r.arrayBuffer());
    stats.bytesDownloaded += b.length;
    return b;
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
    let next = 0, whole = null;
    const worker = async () => {
      while (whole === null) {
        let i = next++;
        while (i < n && parts[i]) i = next++;
        if (i >= n) return;
        const lo = i * rangeSize, hi = Math.min(size, lo + rangeSize) - 1;
        const r = await req(path, n === 1 && size === 0 ? null : [lo, hi]);
        if (r.status === 200) { // the server ignored Range: the whole file
          const b = new Uint8Array(await r.arrayBuffer());
          stats.bytesDownloaded += b.length;
          whole = b;
          return;
        }
        if (r.status !== 206) throw new DeliveryError('http', `${path}: HTTP ${r.status}`, { status: r.status });
        const cr = r.headers.get('content-range');
        if (cr && !cr.startsWith(`bytes ${lo}-${hi}/`)) throw new DeliveryError('checksum_mismatch', `${path}: wrong range ${cr}`);
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length !== hi - lo + 1) throw new DeliveryError('offline', `${path}: short range`);
        stats.bytesDownloaded += b.length;
        parts[i] = b;
        loaded += b.length;
        if (store) await store.put(`part/${sum}/${i}`, b);
        o.onProgress?.({ path: label, loaded, total: size, cached: false });
      }
    };
    if (size === 0) whole = new Uint8Array(0);
    else await Promise.all(Array.from({ length: Math.min(parallel, n) }, worker));
    let bytes = whole;
    if (!bytes) {
      bytes = new Uint8Array(size);
      let at = 0;
      for (const p of parts) { bytes.set(p, at); at += p.length; }
    }
    if (bytes.length !== size || (await sha256(bytes)) !== sum) {
      if (store) for (let i = 0; i < n; i++) await store.delete(`part/${sum}/${i}`);
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
    async read(path) {
      if (path === 'manifest.json') {
        // always fresh when online (it is small and signed); the last good copy when offline
        let b = null;
        try { b = await fetchWhole('manifest.json'); } catch (e) {
          if (!(e instanceof DeliveryError) || e.code !== 'offline' || !store) throw e;
          b = await store.get(`manifest/${base}`);
          if (!b) throw e;
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
