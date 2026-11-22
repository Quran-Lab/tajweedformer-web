// Quran Lab's hosts and failover. One module for every
// part of the web SDK that talks to Quran Lab: the npm wrapper (the loader's hosts), the hosted loader (the frame's
// hosts, the origin check), the frame's Worker and the Node path (the API, the model files, the engine files).
//
//   28.1  ROLES and the allow-list (hostAllowed)
//   28.2  roleList: a signed config's `endpoints` reorders, disables and adds hosts of the allow-list (at most 8 per
//         role), only while that config is in force; web_frame is never taken from a config
//   28.3  Role: the sticky host P, the order (P first, the probe back to the first host after 30 minutes), and
//         Endpoints.request: one request across the hosts, each answer read as taken, refused, slow_down (a 429: no
//         other host is asked) or unreachable (the next host at once); a host has 10 s without a byte before the status
//   28.4  baseOf: a lease's base on any allowed host; its path is fetched through the models order
//   28.7  diagnose(): the host each role asks first, and the last request whose first host was unreachable
//   share/adopt: on the web one page has more than one endpoint set (the frame's Worker, the host page's sharing
//         link); they keep one sticky host per role for the page by telling each other P (28.3: P is kept for the page
//         load), so a host one part of the page found unreachable is not waited for again by another part
//
// A test build may replace a role's hosts (the SDK's test seams): `hosts` names them and `origins` says where each
// is served (http://127.0.0.1:<port> for a local stand-in). A released build uses the built-in lists, over https.

// 28.1: the first hosts, then the backup hosts, in this order; a later name never moves an earlier one
export const ROLES = Object.freeze({
  api: Object.freeze(['api.quranlab.ai', 'api-b.tajweedformer.com', 'api-g.tajweedformer.com', 'api-a.tajweedformer.com']),
  models: Object.freeze(['cdn.quranlab.ai', 'cdn-b.tajweedformer.com', 'cdn-g.tajweedformer.com', 'cdn-a.tajweedformer.com']),
  web_frame: Object.freeze(['web.quranlab.ai', 'web2.quranlab.ai', 'web-b.tajweedformer.com', 'web-g.tajweedformer.com', 'web-a.tajweedformer.com']),
});
/** The roles a signed config may change (28.2). */
export const CONFIG_ROLES = Object.freeze(['api', 'models']);
/** The roles whose P the parts of one page share (Endpoints.share): the frame is the page's own (28.6). */
export const SHARED_ROLES = CONFIG_ROLES;
export const SUFFIXES = Object.freeze(['quranlab.ai', 'tajweedformer.com', 'quran-lab.com']);
/** Entries per role in a config's endpoints; a longer list is refused whole (28.2). */
export const MAX_CONFIG_HOSTS = 8;
/** A host's time without a byte before the answer's status, where the platform cannot bound the connect alone (28.3). */
export const HEAD_MS = 10_000;
/** After P became preferred, one request asks the first host first again (28.3 item 1). */
export const PROBE_MS = 1_800_000;
/** The npm wrapper: the next loader host when one has not loaded (28.6). */
export const LOADER_SWITCH_MS = 4_000;
/** The loader: the next frame host after each 4 s without a hello (web at 0, web2 at 4 s, ... the fifth at 16 s); no
 * hello at 24 s, 8 s after the last host started: the origin check says why (28.6). */
export const FRAME_SWITCH_MS = 4_000;
export const FRAME_TIMEOUT_MS = 24_000;
/** The API requests' own bound once the answer began (30 s, as before 4.0.1 and as the C SDK). */
export const API_BODY_MS = 30_000;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** ASCII lowercase only (a non-ASCII letter stays as it is, and the label rule then refuses it). */
export const asciiLower = (s) => String(s).replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** 28.1: a host is Quran Lab's: ASCII labels of a-z 0-9 -, at most 253 characters, one of SUFFIXES or under one. */
export function hostAllowed(host) {
  if (typeof host !== 'string' || host.length < 1 || host.length > 253) return false;
  const h = asciiLower(host);
  if (!h.split('.').every((x) => LABEL.test(x))) return false;
  return SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}

/**
 * 28.2: a role's hosts. While the config is in force, its list for the role: allowed hosts only, in ASCII lowercase,
 * repeats dropped (it may reorder, disable and add hosts of the allow-list); else, and for more than 8 entries or
 * nothing left, the built-in list. web_frame is never taken from a config.
 */
export function roleList(role, endpoints, inForce = true, builtIn = ROLES[role]) {
  const built = [...builtIn];
  const list = endpoints && typeof endpoints === 'object' && !Array.isArray(endpoints) ? endpoints[role] : undefined;
  if (!inForce || !CONFIG_ROLES.includes(role) || !Array.isArray(list) || list.length > MAX_CONFIG_HOSTS) return built;
  const out = [];
  for (const h of list) {
    if (typeof h !== 'string' || !hostAllowed(h)) continue;
    const l = asciiLower(h);
    if (!out.includes(l)) out.push(l);
  }
  return out.length ? out : built;
}

/**
 * 28.4: { host, path } of a lease answer's base, or null when it is no base: https, an allowed host with no port or
 * user information, a path that starts and ends with "/", printable ASCII, at most 511 characters, no query,
 * fragment, backslash, space or "..".
 */
export function baseParts(base) {
  if (typeof base !== 'string' || base.length < 9 || base.length > 511 || !base.startsWith('https://') || !base.endsWith('/')) return null;
  for (let i = 0; i < base.length; i++) { const c = base.charCodeAt(i); if (c < 0x21 || c > 0x7e) return null; }
  if (/[?#@\\]/.test(base) || base.includes('..')) return null;
  const rest = base.slice(8);
  const i = rest.indexOf('/');
  const host = rest.slice(0, i), path = rest.slice(i);
  if (host.includes(':') || !hostAllowed(host)) return null;
  return { host: asciiLower(host), path };
}

/**
 * 28.3: one role's hosts in force and its sticky host P, on a clock of milliseconds. `p` is the host the next request
 * asks first; `since` the time it became preferred (null while it is the first host).
 */
export class Role {
  constructor(name, hosts) {
    this.name = name;
    this.hosts = [...hosts];
    this.p = this.hosts[0];
    this.since = null;
    /** (role) => void: P moved by an answer (settle); not by a list change or by adopt */
    this.onChange = null;
  }

  /** A list that changes (28.2) starts again at its first host. */
  setHosts(hosts) {
    if (hosts.length === this.hosts.length && hosts.every((h, i) => h === this.hosts[i])) return false;
    this.hosts = [...hosts];
    this.p = this.hosts[0];
    this.since = null;
    return true;
  }

  /** { order, probe }: the hosts a request at `now` asks, in order, and whether it is the probe back. */
  order(now) {
    if (this.p !== this.hosts[0] && now - this.since >= PROBE_MS) return { order: [...this.hosts], probe: true };
    return { order: [this.p, ...this.hosts.filter((h) => h !== this.p)], probe: false };
  }

  /** The host whose answer was taken, refused or a slow down becomes P; its time is now when it was not P or the
   * request was the probe. A host that is not one of the role's (a base's own host) never becomes P. */
  settle(h, now, probe) {
    if (this.hosts.includes(h) && (h !== this.p || probe)) {
      const moved = h !== this.p;
      this.p = h;
      this.since = h === this.hosts[0] ? null : now;
      if (moved && typeof this.onChange === 'function') { try { this.onChange(this.name); } catch (_) { /* never in the way */ } }
    }
  }

  /** { hosts, p, age }: this role's P and how long it has been P (ms; null for the first host), for another part of
   * the page (a clock of another realm may differ, so an age, never a time). */
  share(now) {
    return { hosts: [...this.hosts], p: this.p, age: this.since === null ? null : Math.max(0, now - this.since) };
  }

  /** Another part of the page's P for the same list in force: taken as this role's (its probe time kept). A state for
   * another list (a config of its own in force there) or a host not in the list changes nothing. */
  adopt(st, now) {
    if (!st || typeof st !== 'object' || !Array.isArray(st.hosts) || typeof st.p !== 'string') return false;
    if (st.hosts.length !== this.hosts.length || !st.hosts.every((h, i) => h === this.hosts[i]) || !this.hosts.includes(st.p)) return false;
    if (st.p === this.hosts[0]) { this.p = st.p; this.since = null; return true; }
    const age = Number.isFinite(st.age) && st.age >= 0 ? st.age : 0;
    this.p = st.p;
    this.since = now - age;
    return true;
  }
}

/** The stage of an API path in the error reports (ERRORS_40.md 24.3), or null for a route without a stage of 28.7
 * (the issues route, the origin check, sdk/latest). */
export function stageOfPath(path) {
  const p = String(path);
  if (p.startsWith('/v1/config')) return 'config';
  if (p.startsWith('/v1/register')) return 'register';
  if (p.startsWith('/v1/model-key')) return 'lease';
  if (p.startsWith('/v1/attest')) return 'attest';
  if (p.startsWith('/v1/events')) return 'events';
  if (p.startsWith('/v1/issues') || p.startsWith('/v1/origin-check') || p.startsWith('/v1/sdk/')) return null;
  return 'sharing';
}

/** The JSON `error` string of a 4xx body, or null (a proxy's page, an empty body, an error that is not a string). */
async function apiError(res) {
  try {
    const j = JSON.parse(await res.text());
    return j && typeof j === 'object' && typeof j.error === 'string' && j.error !== '' ? j.error : null;
  } catch (_) { return null; }
}

/** 28.11 item 4 (SDK 4.0.2): after a 429 on optional traffic, the wait when the answer gives no Retry-After, and the
 * most the doubling reaches (seconds). */
export const STEP_BACK_S = 300;
export const STEP_BACK_MAX_S = 3600;
/** 28.11 item 3 (SDK 4.0.2): a kept time more than this far ahead of the clock at start (a clock that moved back) is
 * read as ending now; also the most a Retry-After is read as (seconds). */
export const HOLD_MAX_S = 21600;

/** A kept time (ms) read back at start: null when gone, the clock's now when more than HOLD_MAX_S ahead. */
const keptUntil = (until, now) => (!Number.isFinite(until) || until <= now ? null : until - now > HOLD_MAX_S * 1000 ? now : until);

/**
 * 28.11 item 4 (SDK 4.0.2): one optional route's step back after 429s (telemetry, error reports, shared-recording
 * uploads). Its next attempt waits the larger of the answer's Retry-After (300 s when it has none) and its own next send
 * point, and the wait doubles at each 429 in a row, up to 3600 s (never below a Retry-After); an accepted answer ends
 * the row. Nothing is dropped for it: the route's queue keeps its own limits. `keep` ({ get(), set(v) }, the SDK's
 * state): the row and its time are kept there and read back at the next start (28.11 item 3); none: this process only.
 */
export class StepBack {
  constructor(clock = () => Date.now(), keep = null) {
    this.clock = clock; this.keep = keep; this.row = 0; this.until = 0;
    let v = null;
    try { v = keep ? keep.get() : null; } catch (_) { v = null; }
    if (v && Number.isInteger(v.row) && v.row > 0) {
      this.row = Math.min(v.row, 32);
      this.until = keptUntil(v.until, this.clock()) || 0;
    }
  }
  _save() {
    if (!this.keep) return;
    try { this.keep.set(this.row ? { row: this.row, until: this.until } : null); } catch (_) { /* this process only */ }
  }
  /** A 429 (`retryAfter` in seconds, or null): the wait it starts, in seconds. */
  slowDown(retryAfter = null) {
    this.row += 1;
    const ra = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, HOLD_MAX_S) : null;
    const wait = Math.max(ra || 0, Math.min(STEP_BACK_MAX_S, (ra || STEP_BACK_S) * 2 ** (this.row - 1)));
    this.until = Math.max(this.until, this.clock() + wait * 1000);
    this._save();
    return wait;
  }
  /** An accepted answer: the row ends. */
  ok() { if (this.row) { this.row = 0; this._save(); } }
  /** Milliseconds before the route may be asked again (0: now). */
  left() { return Math.max(0, this.until - this.clock()); }
}

/** A Retry-After header in seconds (a number of seconds, or an HTTP date), or null. */
export function retryAfterOf(res, nowMs = Date.now()) {
  let h = null;
  try { h = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null; } catch (_) { h = null; }
  if (typeof h !== 'string' || !h.trim()) return null;
  const t = h.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const d = Date.parse(t);
  return Number.isFinite(d) ? Math.max(0, Math.ceil((d - nowMs) / 1000)) : null;
}

const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };
// the answer a held route stands on (28.11 item 2): the status and error token of the answer that held it, and the time left
const heldAnswer = (h) => new Response(JSON.stringify({ error: h.error || (h.status === 429 ? 'rate_limited' : 'unavailable') }),
  { status: h.status, headers: { 'content-type': 'application/json', 'retry-after': String(Math.max(1, h.left)) } });
const drop = (res) => { try { if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {}); } catch (_) { /* gone */ } };
const mark = (o, props) => { try { for (const [k, v] of Object.entries(props)) Object.defineProperty(o, k, { value: v, configurable: true }); } catch (_) { /* frozen */ } return o; };
/** A request that ended on a redirect: fetch with redirect 'error' says so only in its message (Node: "unexpected
 * redirect"); a browser's TypeError does not tell it from no answer, and it is read as network there. */
const redirected = (e) => /redirect/i.test(String((e && e.cause && e.cause.message) || '') + String((e && e.message) || ''));

/** Each role's hosts, its sticky host, the last failover; one per process (a page, a frame's Worker, a Node worker). */
export class Endpoints {
  /**
   * @param {object} [o]
   * @param {{api?: string[], models?: string[], web_frame?: string[]}} [o.hosts]  test builds: a role's hosts replaced
   * @param {Object<string,string>} [o.origins]  test builds: where a host is served (default https://<host>)
   * @param {() => number} [o.clock]  ms
   * @param {number} [o.headMs]  a host's time without a byte before the status (10 s)
   */
  constructor({ hosts = {}, origins = {}, clock = () => Date.now(), headMs = HEAD_MS } = {}) {
    this.builtIn = {};
    this.roles = {};
    for (const r of Object.keys(ROLES)) {
      this.builtIn[r] = Object.freeze([...(Array.isArray(hosts[r]) && hosts[r].length ? hosts[r] : ROLES[r])]);
      this.roles[r] = new Role(r, this.builtIn[r]);
    }
    this.origins = { ...origins };
    this.clock = clock;
    this.headMs = headMs;
    this.lastFailover = null;
    // 28.11 item 2 (4.0.2): "<role> <route> <host>" -> { until (ms), status, error }: a 429, or a 503 with a Retry-After,
    // holds that route on that host until then; no request of the route goes to the host before it
    this.holds = new Map();
    /** (holds) => void: a hold was set (28.11 item 3: Quran Lab keeps holdsState() in the SDK's state) */
    this.onHolds = null;
    /** ({ role, stage, reason, status }) => void: a request of a stage answered on another host (28.7, silent report) */
    this.onFailover = null;
    /** () => void: the api or models P moved by an answer (the other parts of the page are told, share) */
    this.onChange = null;
    for (const r of SHARED_ROLES) this.roles[r].onChange = () => { if (typeof this.onChange === 'function') { try { this.onChange(); } catch (_) { /* never in the way */ } } };
  }

  /** The api and models roles' state for the other endpoint sets of this page (adopt). */
  share() {
    const now = this.clock();
    const out = {};
    for (const r of SHARED_ROLES) out[r] = this.roles[r].share(now);
    return out;
  }

  /** Another endpoint set of this page told its state (share): its P taken where the lists in force are the same. */
  adopt(state) {
    if (!state || typeof state !== 'object') return false;
    const now = this.clock();
    let any = false;
    for (const r of SHARED_ROLES) if (this.roles[r].adopt(state[r], now)) any = true;
    return any;
  }

  /** The test seams of the SDK (a local stand-in's URL per role) as hosts and origins; production URLs change nothing. */
  static fromSeams({ apiUrl = null, modelsUrl = null, frameBases = null, clock, headMs } = {}) {
    const hosts = {}, origins = {};
    const one = (role, url) => {
      if (typeof url !== 'string' || !url) return;
      const u = new URL(url);
      if (u.protocol === 'https:' && u.host === ROLES[role][0]) return; // the built-in list
      (hosts[role] || (hosts[role] = [])).push(u.host);
      origins[u.host] = u.origin;
    };
    one('api', apiUrl);
    one('models', modelsUrl);
    for (const b of Array.isArray(frameBases) ? frameBases : []) one('web_frame', b);
    return new Endpoints({ hosts, origins, clock, headMs });
  }

  /** Where `host` is asked: https on 443, or a test build's stand-in. */
  origin(host) { return this.origins[host] || `https://${host}`; }

  /** 28.2: the config in force sets the api and models lists (a list that changes starts again at its first host). */
  useConfig(endpoints, inForce) {
    for (const r of CONFIG_ROLES) this.roles[r].setHosts(roleList(r, endpoints, inForce, this.builtIn[r]));
  }

  /** The path and query of a URL on one of the api hosts (built in, or the config's), else null. */
  apiRoute(url) {
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    for (const h of new Set([...this.builtIn.api, ...this.roles.api.hosts])) if (this.origin(h) === u.origin) return u.pathname + u.search;
    return null;
  }

  /** 28.4: { host, path } of a lease's base (any allowed host; a test build's own model hosts too), or null. */
  baseOf(base) {
    const p = baseParts(base);
    if (p) return p;
    if (typeof base !== 'string') return null;
    for (const h of Object.keys(this.origins)) {
      const o = this.origins[h];
      if (!base.startsWith(o + '/')) continue;
      const path = base.slice(o.length);
      if (baseParts(`https://cdn.quranlab.ai${path}`)) return { host: h, path };
    }
    return null;
  }

  /** 28.4: a model request's URL as { first, path }: its host when that is not one of the models role's (asked before
   * the order), and its path and query; null for a host that is not Quran Lab's. */
  modelTarget(url) {
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    const path = u.pathname + u.search, ro = this.roles.models;
    for (const h of new Set([...ro.hosts, ...this.builtIn.models, ...Object.keys(this.origins)])) {
      if (this.origin(h) === u.origin) return { first: ro.hosts.includes(h) ? null : h, path };
    }
    if (u.protocol === 'https:' && !u.port && !u.username && hostAllowed(u.hostname)) {
      const h = asciiLower(u.hostname);
      return { first: ro.hosts.includes(h) ? null : h, path };
    }
    return null;
  }

  /**
   * 28.11 item 2 (SDK 4.0.2): an answer of `host` for `route` (a path without its query; on the models role each file's
   * path, contract e330c08)
   * that was a 429, or a 503 with a Retry-After: no request of that route goes to that host before the Retry-After
   * (read as 1 to 21600 s; a 429 without one holds nothing here: its route's own rules wait). `error`: the answer's own
   * error token, answered again while the hold lasts.
   */
  hold(role, route, host, retryAfter, status, error = null) {
    if (!(status === 429 || status === 503) || !Number.isFinite(retryAfter)) return;
    const s = Math.min(Math.max(Math.ceil(retryAfter), 1), HOLD_MAX_S);
    const key = `${role} ${route} ${host}`, until = this.clock() + s * 1000;
    const had = this.holds.get(key);
    if (had && had.until >= until) return;
    this.holds.set(key, { until, status, error });
    if (typeof this.onHolds === 'function') { try { this.onHolds(this.holdsState()); } catch (_) { /* this process only */ } }
  }

  /** 28.11 item 3 (SDK 4.0.2): the holds in force, as the SDK's state keeps them ([{ k, until, status, error }]). */
  holdsState() {
    const now = this.clock();
    return [...this.holds].filter(([, h]) => h.until > now).map(([k, h]) => ({ k, until: h.until, status: h.status, error: h.error || null }));
  }

  /** 28.11 item 3 (SDK 4.0.2): the holds an earlier page load or process kept (holdsState), each still in force taken
   * again; one ending more than 6 h ahead of the clock (a clock that moved back) is read as ending now. */
  restoreHolds(list) {
    if (!Array.isArray(list)) return;
    const now = this.clock();
    for (const h of list) {
      if (!h || typeof h.k !== 'string' || !(h.status === 429 || h.status === 503)) continue;
      const until = keptUntil(h.until, now);
      if (!until || until === now) continue;
      const had = this.holds.get(h.k);
      if (!had || had.until < until) this.holds.set(h.k, { until, status: h.status, error: typeof h.error === 'string' ? h.error : null });
    }
  }

  /** The hold of `route` on `host` now ({ until, status, error, left (s) }), or null. */
  held(role, route, host) {
    const key = `${role} ${route} ${host}`, h = this.holds.get(key);
    if (!h) return null;
    const left = Math.ceil((h.until - this.clock()) / 1000);
    if (left <= 0) { this.holds.delete(key); return null; }
    return { ...h, left };
  }

  /** 28.7: diagnose()'s endpoints. `webFrame`: the frame's host on the web, the engine's P in Node. */
  diagnose(webFrame) {
    return { api: this.roles.api.p, models: this.roles.models.p, ...(webFrame ? { webFrame } : {}), lastFailover: this.lastFailover ? { ...this.lastFailover } : null };
  }

  /** A request whose first host was unreachable: diagnose's lastFailover; and when another host answered, the silent
   * report of its stage (28.7). */
  noteFailover(role, first, to, stage, toAsked = true) {
    this.lastFailover = { role, from: first.host, to: to || null, reason: first.reason || 'network', status: Number.isInteger(first.status) ? first.status : null,
      at: Math.floor(this.clock() / 1000) };
    // 4.0.2: the silent report only when the first host was asked and was unreachable, and the host the request ended on
    // was asked and answered (28.7, "answered on another of Quran Lab's hosts"); a host passed or ended on for a
    // Retry-After hold (28.11 item 2, kept from an earlier answer or page load) was not asked, and reports nothing
    if (to && stage && first.asked !== false && toAsked !== false && typeof this.onFailover === 'function') {
      try { this.onFailover({ role, stage, reason: this.lastFailover.reason, status: this.lastFailover.status }); } catch (_) { /* never in the way */ }
    }
  }

  /**
   * One request to one host with 28.3's bound: no status within headMs is no answer (the request is aborted); after the
   * status, `bodyMs` more for the rest (0: none). Resolves { res } or { error, reason } (network, redirect); a
   * request the caller itself aborted (its own signal) rejects as it was.
   */
  async ask(fetch, url, init = {}, bodyMs = 0) {
    const outer = init.signal || null;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    if (outer && ac) { if (outer.aborted) ac.abort(); else outer.addEventListener('abort', () => ac.abort(), { once: true }); }
    let timer = null, headOut = false;
    const head = new Promise((_, reject) => {
      timer = setTimeout(() => {
        headOut = true;
        if (ac) ac.abort();
        reject(Object.assign(new Error(`no answer within ${this.headMs} ms`), { name: 'TimeoutError' }));
      }, this.headMs);
    });
    try {
      const res = await Promise.race([Promise.resolve().then(() => fetch(url, ac ? { ...init, signal: ac.signal } : init)), head]);
      clearTimeout(timer);
      if (ac && bodyMs > 0) unref(setTimeout(() => ac.abort(), bodyMs));
      return { res };
    } catch (e) {
      clearTimeout(timer);
      if (outer && outer.aborted && !headOut) throw e;
      return { error: e, reason: !headOut && redirected(e) ? 'redirect' : 'network' };
    }
  }

  /**
   * 28.3: how one host answered: { cls: taken | refused | slow_down | unreachable, reason, status, value }. `accept`
   * (a 2xx's own check, given a copy of the answer): a value is taken, false or null is a 2xx that is not what was
   * asked (unreachable, invalid_answer); a throw ends the request with it. `notModified`: a 304 is taken (a config
   * request with If-None-Match).
   */
  async classify(one, { accept = null, notModified = false } = {}) {
    if (one.error) return { cls: 'unreachable', reason: one.reason || 'network', status: null };
    const r = one.res, s = r.status;
    if (s === 429) return { cls: 'slow_down', status: s };
    if (s === 304) return notModified ? { cls: 'taken', status: s } : { cls: 'unreachable', reason: 'http', status: s };
    if (s >= 200 && s < 300) {
      if (!accept) return { cls: 'taken', status: s };
      const value = await accept(r.clone(), s);
      return value ? { cls: 'taken', status: s, value } : { cls: 'unreachable', reason: 'invalid_answer', status: s };
    }
    if (s >= 300 && s < 400) return { cls: 'unreachable', reason: 'redirect', status: s };
    if (s >= 400 && s < 500 && (await apiError(r.clone()))) return { cls: 'refused', status: s };
    return { cls: 'unreachable', reason: 'http', status: s };
  }

  /**
   * One request on a role (28.3): P first, then the others in list order (or the probe back), each asked at once
   * after an unreachable one; ends at the first answer taken, refused or a slow down, whose host becomes P. When every
   * host was unreachable it is the FIRST host's answer (a response, or its failure thrown). `first`: a host that is
   * not one of the role's, asked before the order (a lease base's own host, 28.4).
   * Resolves { res, host, cls, fallback, probe, value, status }; a thrown failure carries qlHostRole, qlFallback and qlProbe.
   */
  async request(role, path, init = {}, { fetch, accept = null, notModified = false, first = null, stage = null, bodyMs = 0 } = {}) {
    const ro = this.roles[role];
    const now = this.clock();
    let { order, probe } = ro.order(now);
    if (first && !ro.hosts.includes(first)) order = [first, ...order];
    const tried = [];
    // 4.0.2 (ERRORS_40 24.3, ENDPOINTS_40 28.7): `fallback` is true only when more than one host was asked; a host
    // passed for its Retry-After hold was not (diagnose's lastFailover still names it, as before)
    const askedMore = () => tried.filter((t) => t.asked).length > 1;
    let head = null, retryAfter = null;
    const route = String(path).split('?')[0];
    for (const host of order) {
      // 28.11 item 2: a route that host holds (a 429 or a 503 with Retry-After) is not asked of it before its time: its
      // answer stands for it (a 429 ends the request there, 28.3; a 503 goes on to the next host)
      const h = this.held(role, route, host);
      const one = h ? { res: mark(heldAnswer(h), { qlHeld: true }) } : await this.ask(fetch, this.origin(host) + path, init, bodyMs);
      if (!h && one.res && (one.res.status === 429 || one.res.status === 503)) {
        this.hold(role, route, host, retryAfterOf(one.res, this.clock()), one.res.status, await apiError(one.res.clone()));
      }
      const c = await this.classify(one, { accept, notModified });
      tried.push({ host, reason: c.reason, status: c.status, asked: !h });
      // 28.5: an attempt unreachable on every host waits the largest Retry-After any host gave
      const ra = one.res ? retryAfterOf(one.res, this.clock()) : null;
      if (ra !== null && (c.cls === 'unreachable' || c.cls === 'slow_down')) retryAfter = c.cls === 'slow_down' ? ra : Math.max(retryAfter || 0, ra);
      if (c.cls !== 'unreachable') {
        ro.settle(host, now, probe);
        if (tried.length > 1) { drop(head && head.res); this.noteFailover(role, tried[0], host, stage, !h); }
        return { res: one.res, host, cls: c.cls, fallback: askedMore(), probe, value: c.value, status: c.status, retryAfter: c.cls === 'slow_down' ? ra : null };
      }
      if (!head) head = one; else drop(one.res);
    }
    const fallback = askedMore();
    this.noteFailover(role, tried[0], null, stage);
    if (head.res) return { res: head.res, host: order[0], cls: 'unreachable', fallback, probe, value: undefined, status: head.res.status, retryAfter };
    throw mark(head.error, { qlHostRole: role, qlFallback: fallback, qlProbe: probe });
  }

  /**
   * A fetch that sends every request to an api host through the api order (28.3) and anything else as it is. Its
   * answer carries qlFallback, qlHost and qlValue; init.qlAccept and init.qlStage are its own (the route's 2xx check,
   * the stage of the failover report), never sent.
   */
  wrap(fetch, { bodyMs = API_BODY_MS } = {}) {
    return async (url, init = {}) => {
      const { qlAccept = null, qlStage, ...rest } = init || {};
      const path = this.apiRoute(url);
      if (path === null) return fetch(url, rest);
      const h = rest.headers || {};
      const notModified = Object.keys(h).some((k) => k.toLowerCase() === 'if-none-match');
      const got = await this.request('api', path, rest, { fetch, accept: qlAccept, notModified, stage: qlStage !== undefined ? qlStage : stageOfPath(path), bodyMs });
      return mark(got.res, { qlFallback: got.fallback, qlHost: got.host, qlValue: got.value, qlHostRole: 'api', qlRetryAfter: got.retryAfter });
    };
  }
}
