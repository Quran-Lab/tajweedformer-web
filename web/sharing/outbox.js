// The shared sessions on their way to R2 (the Swift SDK's ContributionOutbox and ShareFiles, with
// PLATFORM_CLIENT.md sections 8 to 10). Each session is a folder of files in a storage:
//   session.json   the start's body          capture.json  { preSkip, bitrates: { n: bit/s } } (set as segments open)
//   seg-NNNNN.opus  a segment's Ogg pages     seg-NNNNN.json { n, bytes, sha256, granule, bitrate }: closed
//   end.json       { durationMs, completed }  item.json     the outbox's record (only the outbox writes it)
//   takes.json     { takes: [{ start_ms, gap_ms }] }: a recording of 2 or more takes (2.0.3), the take list call's body
// The upload starts once the first segment is closed; every closed segment is PUT straight to its
// presigned URL, at most 2 at a time; the next batch of URLs is asked for when 5 unused remain, fresh
// ones on a 403. A session the page was closed in is recovered on the next load: the open segment is
// cut back to its last whole page and the session ends as not completed (its stream has no end page).
//
// The take list (2.0.3, takes.js): a recording that takes in a row shared has its take boundaries in takes.json.
// The session JSON goes up with the first segment, before later takes exist, so the list goes in its own call
// once the recording has closed and every segment is uploaded: POST /v1/uploads/{id}/takes. The item is
// `uploaded` when its segments are, whatever becomes of the list; the list (item.json `takeList: 'pending'` and
// takes.json) waits across page loads until it is sent or dropped. 2xx: sent. 404 (a server without the route,
// or an upload it does not know) and 410 (the upload was deleted): dropped. 400: dropped, with an issue. 401:
// the token renewed, sent again. Anything else (429, 5xx, no connection): again later, with the outbox's
// backoff. Sharing turned off drops it: no request is started after a withdrawal.

import { segmentName, wholePages } from './oggopus.js';
import { freshUrl, parseUrls, SharingError } from './uploader.js';
import { isNetworkFailure } from './bitrate.js';
import { takeList, takesBody } from './takes.js';
import { node, isNode } from '../platform/node-hook.js';

export const FILES = Object.freeze({ session: 'session.json', capture: 'capture.json', end: 'end.json', item: 'item.json', takes: 'takes.json' });
const DAY_MS = 86400000;
/** Unsent sessions older than this are deleted (PLATFORM_CLIENT 10.4). */
export const MAX_AGE_MS = 7 * DAY_MS;
/** How long stop() waits for an upload pass to leave the session it is in before it deletes the queue (ms). */
export const STOP_WAIT_MS = 3000;
// what a wait of a pass resolves with when sharing went off meanwhile
const OFF = Symbol('sharing went off');
// One segment PUT at a time, in segment order, as the Android, Apple and C SDKs do. Two in parallel (2.0.1 before
// this fix) let the second segment start first whenever its bytes were read from storage first, so after an outage
// or a relaunch a session could arrive as seg-00002, seg-00001, ... (the server accepts any order, but Quran Lab wants
// segments in order). Tried and rejected: reading every segment of a group before starting its PUTs (the requests
// still race on the wire).
const PARALLEL = 1;

const enc = new TextEncoder(), dec = new TextDecoder();
const isId = (s) => /^[0-9a-f]{32}$/.test(s);

export async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------------------------------------
// Storages: the same async interface over IndexedDB (browsers), a directory (Node) and memory (tests)

/** In memory (tests; `snapshot()` copies it, as a disk at the moment an app is killed). */
export class MemoryStorage {
  constructor(state) { this.files = new Map(state ? state.files : []); this.global = new Map(state ? state.global : []); }
  snapshot() { return new MemoryStorage({ files: [...this.files].map(([k, v]) => [k, v.slice()]), global: [...this.global] }); }
  async sessions() { return [...new Set([...this.files.keys()].map((k) => k.split('/')[0]))].filter(isId); }
  async list(id) { return [...this.files.keys()].filter((k) => k.startsWith(id + '/')).map((k) => k.slice(id.length + 1)); }
  async read(id, name) { const v = this.files.get(`${id}/${name}`); return v ? v.slice() : null; }
  async write(id, name, bytes) { this.files.set(`${id}/${name}`, Uint8Array.from(bytes)); }
  async append(id, name, bytes) {
    const k = `${id}/${name}`, old = this.files.get(k);
    const n = new Uint8Array((old ? old.length : 0) + bytes.length);
    if (old) n.set(old);
    n.set(bytes, old ? old.length : 0);
    this.files.set(k, n);
  }
  async truncate(id, name, len) { const v = this.files.get(`${id}/${name}`); if (v) this.files.set(`${id}/${name}`, v.slice(0, len)); }
  async remove(id, name) { this.files.delete(`${id}/${name}`); }
  async removeSession(id) { for (const k of [...this.files.keys()]) if (k.startsWith(id + '/')) this.files.delete(k); }
  async getGlobal(k) { return this.global.has(k) ? this.global.get(k) : null; }
  async setGlobal(k, v) { if (v === null) this.global.delete(k); else this.global.set(k, v); }
}

/** A directory (Node): <root>/outbox/<id>/<file>, <root>/sharing.json for the contributor id. */
export async function dirStorage(root) {
  const { fsp: fs, path } = node();
  const box = path.join(root, 'outbox');
  await fs.mkdir(box, { recursive: true });
  const f = (id, name) => path.join(box, id, name);
  const globalFile = path.join(root, 'sharing.json');
  let tmpSeq = 0;
  // Windows refuses a rename over a file another handle has open (a concurrent read, an antivirus scan)
  // with EPERM/EACCES/EBUSY for a moment: retry briefly, as graceful-fs does
  const rename = async (a, b) => {
    for (let i = 0; ; i++) {
      try { return await fs.rename(a, b); } catch (e) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || i >= 20) throw e;
        await new Promise((r) => setTimeout(r, 5 * (i + 1)));
      }
    }
  };
  const readGlobal = async () => { try { return JSON.parse(await fs.readFile(globalFile, 'utf8')); } catch (_) { return {}; } };
  return {
    root,
    async sessions() { return (await fs.readdir(box).catch(() => [])).filter(isId); },
    async list(id) { return fs.readdir(path.join(box, id)).catch(() => []); },
    async read(id, name) { try { return new Uint8Array(await fs.readFile(f(id, name))); } catch (_) { return null; } },
    async write(id, name, bytes) {
      await fs.mkdir(path.join(box, id), { recursive: true });
      // a unique temp name per write: two writes of the same file never share one (they raced before)
      const tmp = `${f(id, name)}.${process.pid}.${++tmpSeq}.tmp`;
      await fs.writeFile(tmp, bytes);
      try { await rename(tmp, f(id, name)); } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        if (e.code !== 'ENOENT') throw e; // the session was removed meanwhile (sharing off, uploaded): nothing to keep
      }
    },
    async append(id, name, bytes) { await fs.mkdir(path.join(box, id), { recursive: true }); await fs.appendFile(f(id, name), bytes); },
    async truncate(id, name, len) { await fs.truncate(f(id, name), len).catch(() => {}); },
    async remove(id, name) { await fs.rm(f(id, name), { force: true }); },
    async removeSession(id) { await fs.rm(path.join(box, id), { recursive: true, force: true }); },
    async getGlobal(k) { const g = await readGlobal(); return k in g ? g[k] : null; },
    async setGlobal(k, v) {
      const g = await readGlobal();
      if (v === null) delete g[k]; else g[k] = v;
      const tmp = `${globalFile}.${process.pid}.${++tmpSeq}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(g));
      await rename(tmp, globalFile);
    },
  };
}

/**
 * IndexedDB (browsers), per origin: database `quranlab-sharing`, store `files` keyed [id, name, part]
 * (an append is one new record, so a page is never torn), store `global`.
 */
export async function indexedDbStorage(dbName = 'quranlab-sharing', idb = globalThis.indexedDB) {
  if (!idb) throw new Error('IndexedDB is not available');
  const db = await new Promise((resolve, reject) => {
    const r = idb.open(dbName, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('files'); r.result.createObjectStore('global'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const tx = (stores, mode, fn) => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const range = (id, name) => (name === undefined
    ? IDBKeyRange.bound([id], [id, []]) : IDBKeyRange.bound([id, name, 0], [id, name, Infinity]));
  const keys = (id, name) => tx(['files'], 'readonly', (t) => req(t.objectStore('files').getAllKeys(range(id, name))));
  return {
    async sessions() {
      const all = await tx(['files'], 'readonly', (t) => req(t.objectStore('files').getAllKeys()));
      return [...new Set(all.map((k) => k[0]))].filter(isId);
    },
    async list(id) { return [...new Set((await keys(id)).map((k) => k[1]))]; },
    async read(id, name) {
      const parts = await tx(['files'], 'readonly', (t) => req(t.objectStore('files').getAll(range(id, name))));
      if (!parts.length) return null;
      const n = parts.reduce((k, p) => k + p.byteLength, 0);
      const out = new Uint8Array(n);
      let at = 0;
      for (const p of parts) { out.set(new Uint8Array(p), at); at += p.byteLength; }
      return out;
    },
    async write(id, name, bytes) {
      await tx(['files'], 'readwrite', (t) => {
        const s = t.objectStore('files');
        s.delete(range(id, name));
        s.put(Uint8Array.from(bytes).buffer, [id, name, 0]);
      });
    },
    async append(id, name, bytes) {
      await tx(['files'], 'readwrite', async (t) => {
        const s = t.objectStore('files');
        const ks = await req(s.getAllKeys(range(id, name)));
        const part = ks.length ? ks[ks.length - 1][2] + 1 : 0;
        s.put(Uint8Array.from(bytes).buffer, [id, name, part]);
      });
    },
    async truncate(id, name, len) { const b = await this.read(id, name); if (b) await this.write(id, name, b.slice(0, len)); },
    async remove(id, name) { await tx(['files'], 'readwrite', (t) => { t.objectStore('files').delete(range(id, name)); }); },
    async removeSession(id) { await tx(['files'], 'readwrite', (t) => { t.objectStore('files').delete(range(id)); }); },
    async getGlobal(k) { const v = await tx(['global'], 'readonly', (t) => req(t.objectStore('global').get(k))); return v === undefined ? null : v; },
    async setGlobal(k, v) { await tx(['global'], 'readwrite', (t) => { if (v === null) t.objectStore('global').delete(k); else t.objectStore('global').put(v, k); }); },
  };
}

/** The default storage: IndexedDB in a browser, `<cwd>/.quranlab` in Node, else memory. */
export async function defaultStorage() {
  if (globalThis.indexedDB) return indexedDbStorage();
  if (isNode()) return dirStorage(node().path.join(globalThis.process.cwd(), '.quranlab'));
  return new MemoryStorage();
}

export const readJson = async (s, id, name) => { const b = await s.read(id, name); if (!b) return null; try { return JSON.parse(dec.decode(b)); } catch (_) { return null; } };
export const writeJson = (s, id, name, v) => s.write(id, name, enc.encode(JSON.stringify(v)));

/** The closed segments' markers, in order. */
export async function markers(s, id) {
  const names = (await s.list(id)).filter((n) => /^seg-\d{5,}\.json$/.test(n));
  const out = [];
  for (const n of names) { const m = await readJson(s, id, n); if (m) out.push(m); }
  return out.sort((a, b) => a.n - b.n);
}

/** Closes segment n: its marker, from the bytes as they are stored, with the bit rate it was coded at. */
export async function mark(s, id, n, granule, bitrate = null) {
  const b = await s.read(id, segmentName(n) + '.opus');
  if (!b) throw new Error(`no ${segmentName(n)}.opus`);
  const m = { n, bytes: b.length, sha256: await sha256Hex(b), granule };
  if (Number.isInteger(bitrate)) m.bitrate = bitrate;
  await writeJson(s, id, segmentName(n) + '.json', m);
}

/** Seconds of audio per closed segment, from the markers' granule positions (segment 1 from 0). */
export function markerSeconds(ms) {
  let prev = 0;
  return ms.map((m) => { const sec = Math.max(0, m.granule - prev) / 48000; prev = m.granule; return sec; });
}

/** The take list a session's takes.json holds, or null (one take, or a file that is not a valid list). */
export async function storedTakes(s, id) {
  const j = await readJson(s, id, FILES.takes);
  return j ? takeList(j.takes) : null;
}

/** A session the page was closed in: open segments cut back to their whole pages and closed, the
 * session ended as not completed. Its take list keeps the takes that start before the recovered end (none of a
 * later take's audio was kept); fewer than 2 left: no list. False when there is nothing to share (it is then
 * removed). */
export async function recover(s, id) {
  const cap = await readJson(s, id, FILES.capture);
  if (!cap) { await s.removeSession(id); return false; }
  const have = new Set((await markers(s, id)).map((m) => m.n));
  const open = (await s.list(id)).filter((n) => /^seg-\d{5,}\.opus$/.test(n)).map((n) => Number(n.slice(4, -5)))
    .filter((n) => !have.has(n)).sort((a, b) => a - b);
  for (const n of open) {
    const name = segmentName(n) + '.opus';
    const d = (await s.read(id, name)) || new Uint8Array(0);
    const { keep, granule } = wholePages(d);
    if (keep === 0) { await s.remove(id, name); continue; }
    if (keep < d.length) await s.truncate(id, name, keep);
    // the bit rate the capture recorded when the segment opened
    const bitrate = cap.bitrates && Number.isInteger(cap.bitrates[n]) ? cap.bitrates[n] : null;
    await mark(s, id, n, granule, bitrate);
  }
  const ms = await markers(s, id);
  if (!ms.length) { await s.removeSession(id); return false; }
  const last = ms[ms.length - 1];
  const end = { durationMs: Math.trunc(Math.max(0, last.granule - cap.preSkip) / 48), completed: false };
  const j = await readJson(s, id, FILES.takes);
  const takes = j ? takeList(j.takes, end.durationMs) : null;
  if (takes) {
    await s.write(id, FILES.takes, enc.encode(takesBody(takes)));
    end.takes = takes.length;
  } else await s.remove(id, FILES.takes);
  await writeJson(s, id, FILES.end, end);
  return true;
}

/** Session ids being captured in this page or process (never taken for crashed). */
export const activeCaptures = new Set();

/**
 * The outbox.
 * @param {object} o
 * @param {object} o.storage
 * @param {import('./uploader.js').ContributionClient} o.client
 * @param {() => Promise<{token: string, attested?: boolean}>} o.tokenProvider
 * @param {() => object|null} [o.flags]  the signed config's flags (contributions, upload_trust, capped_limits)
 * @param {() => boolean} [o.enabled]  sharing is on (the app's option and the learner's consent)
 * @param {() => Promise<string|null>} [o.turnstile]  web, capped tier with Turnstile on: a fresh token
 * @param {string} [o.platform]  'web' (upload_trust key)
 * @param {() => Promise<string>} o.contributor
 * @param {() => number} [o.clock]  ms
 * @param {(item: object) => void} [o.onChange]
 * @param {import('./bitrate.js').BitrateLadder} [o.ladder]  told about network failures, successful PUTs and the backlog
 * @param {(kind: string, code: string) => void} [o.onIssue]  a take list refused as a bad request ('other', 'takes:<code>')
 * @param {() => Promise<void>|void} [o.onStop]  sharing went off: the recorder ends the recording being captured
 * @param {(message: string) => void} [o.log]  one line for the developer (a server without the take list route)
 */
export class Outbox {
  constructor({ storage, client, tokenProvider, flags = () => null, enabled = () => true, turnstile = null, platform = 'web',
    contributor, clock = () => Date.now(), onChange = null, onError = null, random = Math.random, ladder = null,
    onIssue = null, onStop = null, log = null, epoch = null }) {
    Object.assign(this, { storage, client, tokenProvider, flags, enabled, turnstile, platform, contributor, clock, onChange, onError, random, ladder,
      onIssue, onStop, log, epoch });
    this._epochSeen = null; // the count of consent changes at the last scan
    this._undeletable = new Set(); // recordings whose delete failed (logged once each)
    this.takesLogged = false; // the dropped take list line, once per pipeline
    // closed segments not yet uploaded, per session: id -> Map(n -> seconds of audio); kept in memory so a
    // capture can read the backlog at the moment it closes a segment (the markers are written after)
    this.waiting = new Map();
    this.records = new Map();
    this.inFlight = new Map(); // "<id>/<file>" -> AbortController
    this.running = null;
    this.again = false;
    this.stopped = false;
    this.stopping = null; // the stop in progress (a promise): no pass starts and resume() waits while it is at work
    this._givenUp = null; // a pass the off call waited its whole bound for
    this.removed = new Set(); // sessions deleted with the queue (their ids are never used again)
    this._offWaiters = new Set(); // waits of a pass that end when sharing goes off (the app's token and Turnstile callbacks)
    this.wakeTimer = null;
    this.seqTop = 0;
  }

  // ---- public ----

  /** Every session, oldest first: { id, segments, bytes, durationMs, segmentBitrates, day, completed, status, failCode, attempts, lastError,
   * takes (how many takes share the recording), takeList (null, 'pending', 'sent' or 'dropped') }. */
  async items() {
    await this._scan();
    const out = [];
    for (const r of [...this.records.values()].sort((a, b) => a.seq - b.seq)) out.push(await this._snapshot(r));
    return out;
  }

  async item(id) { await this._scan(); const r = this.records.get(id); return r ? this._snapshot(r) : null; }

  /** Sessions not yet fully uploaded. */
  async pending() { return (await this.items()).filter((x) => x.status === 'queued'); }

  /** Seconds of audio in closed segments not yet uploaded, every session. */
  backlogSeconds() {
    let t = 0;
    for (const w of this.waiting.values()) for (const sec of w.values()) t += sec;
    return t;
  }

  /** A capture closed segment n of session id (seconds of audio): counted in the backlog at once, and the
   * bitrate ladder told (a long backlog lowers the next segment's bitrate). */
  segmentClosed(id, n, seconds) {
    if (!this.waiting.has(id)) this.waiting.set(id, new Map());
    this.waiting.get(id).set(n, seconds);
    if (this.ladder) this.ladder.segmentClosed(this.backlogSeconds());
  }

  _networkResult(status) { if (this.ladder && isNetworkFailure(status)) this.ladder.uploadFailed(); }

  // the backlog of a session first seen in storage (a page closed earlier, or a session found by a scan)
  async _countWaiting(rec) {
    if (rec.state !== 'active') { this.waiting.delete(rec.id); return; }
    const ms = await markers(this.storage, rec.id);
    const secs = markerSeconds(ms);
    const w = this.waiting.get(rec.id) || new Map();
    ms.forEach((m, i) => {
      if ((rec.uploaded || []).includes(segmentName(m.n) + '.opus')) w.delete(m.n);
      else if (!w.has(m.n)) w.set(m.n, secs[i]);
    });
    this.waiting.set(rec.id, w);
  }

  /** Starts an upload pass (also at load, when a segment closes and when a retry is due). */
  async resume() {
    // a stop still at work deletes the queue first: what was recorded before the learner turned sharing off is
    // never sent because they turned it on again
    while (this.stopping) await this.stopping.catch(() => {});
    this.stopped = false;
    this.paused = false;
    return this.drain();
  }

  /** Sharing was turned off: every request in flight aborted, every session not fully uploaded deleted at
   * once, the recording being captured with them (`onStop`: also between takes, where no push would notice),
   * and take lists still waiting dropped (no request is started after a withdrawal; what the browser or the
   * system had already buffered of the segment in flight may still go out). Resolves when the queue is gone:
   * within STOP_WAIT_MS and a few file removals, whatever was in flight. */
  stop() { return this._off(true); }

  /**
   * The queue stops and keeps everything: the requests in flight are aborted, the pass leaves, nothing is deleted.
   * resume() goes on with the recording that was in flight. For "delete what I shared": the queue stands still
   * while the server is asked.
   */
  pause() { return this._off(false); }

  /** The part of pause() that needs no wait: from this line no pass sends or writes, and the queue keeps
   * everything. pause() (the passes leave) or stop() follows; resume() ends it. */
  hold() {
    this.stopped = true;
    // a paused queue keeps everything: while the server is asked the count of consent changes is ahead of the
    // stamps (the off is written first), and no scan deletes a recording as outdated; the count at the pause
    // is the one a scan goes by until resume() or stop()
    if (!this.paused) this._pausedEpoch = this._epoch();
    this.paused = true;
  }

  _off(remove) {
    // from this line on no request is started and no pass writes: every request and every write of a pass asks
    // _live()
    if (remove) { this.stopped = true; this.paused = false; } else this.hold();
    const before = this.stopping;
    // deletes that fail are tried again for half of the off call's bound at most (the other half is the
    // margin for the passes to leave and for one try per recording): what is left then is never uploaded and
    // is deleted at the next pass or start (_scan)
    const until = Date.now() + STOP_WAIT_MS / 2;
    const p = (async () => {
      if (before) await before.catch(() => {});
      await this._halt();
      if (remove) await this._deleteQueue(until);
    })().finally(() => { if (this.stopping === p) this.stopping = null; });
    this.stopping = p;
    return p;
  }

  // the pass leaves the session it is in
  async _halt() {
    for (const c of this.inFlight.values()) c.abort();
    this.inFlight.clear();
    for (const w of [...this._offWaiters]) w();
    if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = null; }
    // its requests were aborted above and its waits ended. At most STOP_WAIT_MS for anything else (a storage call
    // that does not come back); a pass that leaves later finds its session gone and writes nothing.
    // A pass that was already waited for its whole bound is not waited for again (a delete pauses, asks the
    // server, then stops: one bound in all).
    if (!this.running || this.running === this._givenUp) return;
    let timer = null;
    const pass = this.running;
    const left = (async () => { while (this.running) await this.running.catch(() => {}); return true; })();
    const gone = await Promise.race([left, new Promise((r) => { timer = setTimeout(() => r(false), STOP_WAIT_MS); })]);
    clearTimeout(timer);
    if (!gone) this._givenUp = pass;
  }

  async _deleteQueue(until = 0) {
    if (this.onStop) { try { await this.onStop(); } catch (_) { /* the capture's own end */ } }
    await this._scan(until);
    for (const r of [...this.records.values()]) {
      if (r.state === 'active' && !activeCaptures.has(r.id)) await this._remove(r.id, until);
      else if (r.takeList === 'pending') await this._takesDone(r, 'dropped', 'sharing_off');
    }
    // a second look at the disk itself: nothing unsent may be left, whatever the records say
    for (const id of await this.storage.sessions()) {
      if (activeCaptures.has(id)) continue;
      if (this._undeletable.has(id)) continue; // tried above, and at every pass from now on
      const item = await readJson(this.storage, id, FILES.item);
      if (!item || item.state === 'active') await this._remove(id, until);
    }
    this.waiting.clear();
  }

  // one session out of the queue, on disk and in memory. A delete that fails is tried again (a file of the
  // folder can be open for a moment on Windows) while `until` allows, at most ten times; it never keeps the
  // other sessions from being deleted. A session that could not be deleted stays in `removed`: it is never
  // read into the queue again, and _scan tries its delete at every pass. True when it is gone.
  async _remove(id, until = 0) {
    this.removed.add(id);
    this.records.delete(id);
    this.waiting.delete(id);
    for (let i = 0; ; i++) {
      try { await this.storage.removeSession(id); this._undeletable.delete(id); return true; } catch (e) {
        const wait = 20 * (i + 1);
        if (i >= 10 || Date.now() + wait > until) {
          if (this.log && !this._undeletable.has(id)) this.log(`TajweedFormer sharing: a queued recording could not be deleted (${(e && e.code) || e}); it is not uploaded, and it is deleted at the next pass or start`);
          this._undeletable.add(id);
          return false;
        }
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  /** The count of the learner's consent changes now (the controller's; 0 for a pipeline without one). */
  _epoch() { const n = this.epoch ? this.epoch() : 0; return Number.isInteger(n) ? n : 0; }

  // a recording made before the learner's last "off": its audio is deleted; one that was uploaded while
  // sharing was on keeps its item, and a take list of it that still waits is dropped
  async _outdated(rec, until = 0) {
    if (rec.state === 'active') { await this._remove(rec.id, until); return; }
    if (rec.takeList === 'pending') { this.records.set(rec.id, rec); await this._takesDone(rec, 'dropped', 'sharing_off'); }
  }

  /** Deletes what a stop left on the device (the page died before the queue was deleted; a delete failed), with
   * sharing on or off. Resolves with how many such recordings are still there. */
  async sweep() {
    await this._scan();
    let left = 0;
    for (const id of await this.storage.sessions()) if (this.removed.has(id)) left++;
    return left;
  }

  /** Whether a pass may send or write now: sharing is on, and no stop was asked for. */
  _live() { return !this.stopped && this.enabled(); }

  // One request of a pass. Not made when sharing is off; abortable by stop(); null when it was aborted or
  // sharing went off while it was in flight, so its answer is neither written nor acted on.
  async _request(key, send) {
    if (!this._live()) return null;
    const ctrl = new AbortController();
    this.inFlight.set(key, ctrl);
    try {
      const r = await send(ctrl.signal);
      return this._live() ? r : null;
    } catch (e) {
      if ((e && e.name === 'AbortError') || !this._live()) return null;
      throw e;
    } finally { if (this.inFlight.get(key) === ctrl) this.inFlight.delete(key); }
  }

  // A wait of a pass for something of the app's (its token, its Turnstile widget): ends with OFF when sharing
  // goes off, so a callback that never answers does not keep a pass inside a session.
  _untilOff(promise) {
    if (!this._live()) return Promise.resolve(OFF);
    let done;
    const off = new Promise((r) => { done = () => r(OFF); });
    this._offWaiters.add(done);
    return Promise.race([Promise.resolve(promise), off]).finally(() => this._offWaiters.delete(done));
  }

  /** Takes a session out before the server has it. */
  async cancel(id) {
    await this._scan();
    const r = this.records.get(id);
    if (!r) throw new Error(`no outbox item ${id}`);
    if (r.state !== 'active' || r.started || activeCaptures.has(id)) throw new Error(`item ${id} is already uploading`);
    await this.storage.removeSession(id);
    this.records.delete(id);
    this.waiting.delete(id);
  }

  /** One upload pass, after any pass already running. */
  async drain({ ignoringBackoff = false } = {}) {
    while (this.stopping) await this.stopping.catch(() => {});
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      while (this.running) await this.running.catch(() => {});
      if (!this.again || this.stopped) return;
    }
    this.again = false;
    this.running = (async () => {
      try { await this._pass(ignoringBackoff); } finally { this._scheduleWake(); }
    })();
    try { await this.running; } finally { this.running = null; }
    if (this.again && !this.stopped) await this.drain({ ignoringBackoff });
  }

  /** Whether this install may upload now: the app/learner switch, the config's contributions flag and
   * this platform's upload trust (web: `capped` only; PLATFORM_CLIENT 9). */
  uploadAllowed() {
    if (this.stopped || !this.enabled()) return { ok: false, why: 'sharing is off' };
    const f = this.flags() || {};
    if (f.contributions === false) return { ok: false, why: 'sharing is turned off for this app' };
    const trust = f.upload_trust && f.upload_trust[this.platform];
    // owner decision (11-07): web and desktop upload at the lower trust tier (`capped`: per-key and
    // per-contributor caps, sessions marked attested=false); an absent entry means that tier for them
    const tier = trust || (['ios', 'macos', 'android'].includes(this.platform) ? 'attested' : 'capped');
    if (tier === 'off') return { ok: false, why: `uploads are off for ${this.platform} (upload_trust)` };
    if (tier === 'attested' && !['ios', 'macos', 'android'].includes(this.platform)) {
      return { ok: false, why: `${this.platform} has no attestation and the config asks for it (upload_trust attested)` };
    }
    return { ok: true, tier };
  }

  // ---- the pass ----

  async _pass(ignoringBackoff) {
    if (this.stopped) return;
    await this._scan();
    await this._expire();
    if (this.stopped) return;
    const allowed = this.uploadAllowed();
    const now = this.clock();
    const due = [...this.records.values()].filter((r) => r.state === 'active' && (ignoringBackoff || !r.nextAttempt || r.nextAttempt <= now))
      .sort((a, b) => a.seq - b.seq).map((r) => r.id);
    // take lists of recordings already uploaded: a retry, or one a closed page left
    const lists = () => [...this.records.values()].filter((r) => r.takeList === 'pending' && (ignoringBackoff || !r.takeListNext || r.takeListNext <= this.clock()))
      .sort((a, b) => a.seq - b.seq).map((r) => r.id);
    if (!due.length && !lists().length) return;
    if (!allowed.ok) { for (const id of due) await this._note(id, `${allowed.why}; waiting`); return; }
    for (const id of due) {
      if (this.stopped) return;
      let token;
      try { token = await this._untilOff(this.tokenProvider()); } catch (e) {
        await this._retry(id, `token: ${e && e.message || e}`);
        return;
      }
      if (token === OFF || !this._live()) return;
      if (!token || !token.token) { await this._retry(id, 'no token'); return; }
      if (allowed.tier === 'attested' && !token.attested) {
        await this._retry(id, 'attestation_required: this install has no attested token; sharing paused', { long: true });
        continue;
      }
      if (!(await this._step(id, token.token))) return;
    }
    for (const id of lists()) {
      if (this.stopped) return;
      let token = null;
      try { token = await this._untilOff(this.tokenProvider()); } catch (_) { token = null; }
      if (token === OFF || !this._live()) return;
      if (!token || !token.token) { await this._takesRetry(this.records.get(id), 'no token'); return; }
      if (!(await this._sendTakes(id, token.token))) return;
    }
  }

  // Moves one session on as far as it goes now. False when the pass should stop (offline).
  async _step(id, token) {
    const s = this.storage;
    const ms = await markers(s, id);
    const end = await readJson(s, id, FILES.end);
    let rec = this.records.get(id);
    if (!rec) return true;
    if (!rec.started) {
      if (!ms.length) return true;
      const session = await s.read(id, FILES.session);
      if (!session) return true;
      if (!this._live()) return false;
      rec.attempts++;
      await this._save(rec);
      const turnstile = this.turnstile && (this.flags() || {}).capped_limits?.turnstile_web ? await this._untilOff(this.turnstile()) : null;
      if (turnstile === OFF) return false;
      const r = await this._request(`${id}/start`, (signal) => this.client.start({ id, session: dec.decode(session), token, turnstile, signal }));
      if (!r) return false; // sharing went off: nothing of the answer is kept
      const urls = await this._answer(id, r);
      if (!urls) return r.status !== 0;
      rec = this.records.get(id);
      rec.started = true;
      rec.urls = merge(rec.urls, urls);
      await this._save(rec);
    }
    // every closed segment, in order, one PUT at a time (PARALLEL)
    const todo = ms.filter((m) => !rec.uploaded.includes(segmentName(m.n) + '.opus'));
    for (let i = 0; i < todo.length; i += PARALLEL) {
      const group = [];
      for (const m of todo.slice(i, i + PARALLEL)) {
        rec = this.records.get(id);
        if (!rec || rec.state !== 'active') return true;
        if (!this._live()) return false;
        if (!(rec.urls || []).some((u) => u.n === m.n && freshUrl(u, this.clock()))) {
          const ok = await this._fetchUrls(id, m.n, token);
          if (!ok.ok) return !ok.offline;
          rec = this.records.get(id);
          if (!rec || rec.state !== 'active') return true;
        }
        const u = (rec.urls || []).find((x) => x.n === m.n);
        if (!u) return true;
        group.push(this._put(id, m, u));
      }
      const results = await Promise.all(group);
      if (results.includes('offline')) return false;
      // refused (a retry is scheduled, at once for a 403): this pass stops here for the session
      if (results.includes('stop') || results.includes('retry')) return true;
    }
    rec = this.records.get(id);
    if (!rec || rec.state !== 'active') return true;
    if (!this._live()) return false;
    // while the session runs: the next batch once 5 unused URLs remain
    const lastUrl = Math.max(0, ...(rec.urls || []).map((u) => u.n));
    if (!end && lastUrl > 0 && lastUrl - (ms.length ? ms[ms.length - 1].n : 0) <= 5) {
      const ok = await this._fetchUrls(id, lastUrl + 1, token);
      if (!ok.ok) return !ok.offline;
      rec = this.records.get(id);
    }
    if (!end || !rec.started || !ms.length || !ms.every((m) => rec.uploaded.includes(segmentName(m.n) + '.opus'))) return true;
    rec.state = 'uploaded';
    this.waiting.delete(id);
    rec.lastError = null;
    rec.nextAttempt = null;
    rec.urls = null;
    // a recording of 2 or more takes: its take list follows its last segment; the item is uploaded either way
    const list = await storedTakes(s, id);
    if (list) rec.takeList = 'pending';
    await this._save(rec);
    for (const name of await s.list(id)) {
      if (name !== FILES.item && name !== FILES.end && name !== FILES.session && !(list && name === FILES.takes)
        && !/^seg-\d{5,}\.json$/.test(name)) await s.remove(id, name);
    }
    return list ? this._sendTakes(id, token) : true;
  }

  // ---- the take list (2.0.3) ----

  // POST /v1/uploads/{id}/takes for an uploaded recording whose list waits. False when the pass should stop
  // (offline); the item stays uploaded whatever the answer.
  async _sendTakes(id, token) {
    const s = this.storage;
    let rec = this.records.get(id);
    if (!rec || rec.takeList !== 'pending') return true;
    const list = await storedTakes(s, id);
    if (!list) { await this._takesDone(rec, 'dropped', 'no_list'); return true; }
    const body = takesBody(list);
    // under the contributor the recording was made by (its session JSON), as the server checks
    const ses = await readJson(s, id, FILES.session);
    const contributor = ses && typeof ses.contributor === 'string' ? ses.contributor : await this.contributor();
    if (!this._live()) return false;
    rec.takeListAttempts = (rec.takeListAttempts || 0) + 1;
    let r = await this._request(`${id}/takes`, (signal) => this.client.takes({ id, body, contributor, token, signal }));
    if (!r) return false; // sharing went off: stop() drops the list
    if (r.status === 401) {
      // the token renewed, the same body once more
      if (this.tokenProvider.invalidate) await this.tokenProvider.invalidate();
      let fresh = null;
      try { fresh = await this._untilOff(this.tokenProvider()); } catch (_) { fresh = null; }
      if (fresh === OFF) return false;
      if (fresh && fresh.token) {
        r = await this._request(`${id}/takes`, (signal) => this.client.takes({ id, body, contributor, token: fresh.token, signal }));
        if (!r) return false;
      }
    }
    rec = this.records.get(id);
    if (!rec || rec.takeList !== 'pending' || this.stopped) return true; // sharing went off meanwhile
    if (r.status >= 200 && r.status < 300) { await this._takesDone(rec, 'sent'); return true; }
    const code = (r.body && r.body.error) || `http_${r.status}`;
    if (r.status === 404 || r.status === 410) {
      if (r.status === 404 && !this.takesLogged) {
        this.takesLogged = true;
        if (this.log) {
          try { this.log('Quran Lab sharing: the server took the recording but not its take list (HTTP 404: no such route or upload); the list is dropped, the recording stays uploaded'); } catch (_) { /* the app's logger */ }
        }
      }
      await this._takesDone(rec, 'dropped', code);
      return true;
    }
    if (r.status === 400) {
      // SDK 3.0.0: a list the server refuses as a bad request is NOT dropped (the server could refuse a correct
      // list while its own view of the recording was stale). It stays pending and is retried on the backoff
      // until it is accepted, sharing goes off, or the recording passes the seven-day limit; the issue is
      // reported once for this list.
      if (!rec.takeListReported) {
        rec.takeListReported = true;
        if (this.onIssue) { try { this.onIssue('other', 'bad_request:takes'); } catch (_) { /* never in the way */ } }
      }
      await this._takesRetry(rec, `HTTP 400 ${code}`);
      return true;
    }
    await this._takesRetry(rec, r.status === 0 ? (r.error || 'offline') : `HTTP ${r.status} ${code}`);
    return r.status !== 0;
  }

  // the list is sent or dropped: takes.json goes, the record says which
  async _takesDone(rec, state, why = null) {
    rec.takeList = state;
    rec.takeListNext = null;
    rec.takeListError = state === 'sent' ? null : why;
    await this.storage.remove(rec.id, FILES.takes);
    await this._save(rec, { byStop: why === 'sharing_off' });
  }

  // again later, with the outbox's backoff (30 s doubling to 6 h, jittered)
  async _takesRetry(rec, why) {
    if (!rec) return;
    const n = Math.max(1, rec.takeListAttempts || 1);
    const base = Math.min(30 * 2 ** Math.min(n - 1, 16), 6 * 3600);
    rec.takeListError = why;
    rec.takeListNext = this.clock() + base * (0.8 + 0.4 * this.random()) * 1000;
    await this._save(rec);
  }

  // one PUT: 'ok', 'retry' (refused; retry scheduled), 'offline', 'stop'
  async _put(id, m, u) {
    const name = segmentName(m.n) + '.opus';
    const key = `${id}/${name}`;
    const bytes = await this.storage.read(id, name);
    if (!bytes) return 'stop';
    const r = await this._request(key, (signal) => this.client.put({ url: u.url, bytes, signal }));
    if (!r) return 'stop'; // not sent, aborted, or sharing went off while it was in flight
    const rec = this.records.get(id);
    if (!rec || rec.state !== 'active') return 'stop';
    this._networkResult(r.status);
    if (r.status === 0) { await this._retry(id, `PUT ${name}: ${r.error}`); return 'offline'; }
    if (r.status >= 200 && r.status < 300) {
      if (!rec.uploaded.includes(name)) rec.uploaded.push(name);
      const w = this.waiting.get(id);
      if (w) w.delete(m.n);
      if (this.ladder) this.ladder.uploadOk(this.backlogSeconds());
      rec.urls = (rec.urls || []).filter((x) => x.n !== m.n);
      rec.lastError = null;
      await this._save(rec);
      await this.storage.remove(id, name);
      return 'ok';
    }
    rec.attempts++;
    if (r.status === 403) rec.urls = (rec.urls || []).filter((x) => x.n !== m.n);
    await this._save(rec);
    await this._retry(id, `PUT ${name}: HTTP ${r.status}`, { immediately: r.status === 403 && rec.attempts < 5 });
    return 'retry';
  }

  // URLs for segments from..from+19, merged into the item
  async _fetchUrls(id, from, token) {
    const contributor = await this.contributor();
    const r = await this._request(`${id}/urls`, (signal) => this.client.urls({ id, from, contributor, token, signal }));
    if (!r) return { ok: false, offline: true }; // sharing went off: the pass ends here
    const urls = await this._answer(id, r);
    const rec = this.records.get(id);
    if (!urls) {
      if (rec && rec.state === 'active') { rec.attempts++; await this._save(rec); }
      return { ok: false, offline: r.status === 0 };
    }
    if (!rec) return { ok: false, offline: false };
    rec.urls = merge(rec.urls, urls);
    await this._save(rec);
    return { ok: true };
  }

  // A Worker answer: the URLs on 2xx; otherwise the item is retried, paused, capped or failed
  // (PLATFORM_CLIENT 8) and null comes back.
  async _answer(id, r) {
    this._networkResult(r.status);
    if (r.status === 0) { await this._retry(id, r.error || 'offline'); return null; }
    if (r.status >= 200 && r.status < 300) {
      const u = parseUrls(r.body, id);
      if (u) return u;
      await this._retry(id, 'no upload URLs in the answer');
      return null;
    }
    const code = (r.body && r.body.error) || `http_${r.status}`;
    const message = (r.body && r.body.message) || '';
    if (code === 'contributor_revoked' || code === 'contributor_key_mismatch') {
      // the contributor id this session was recorded under can never upload again: the app's
      // controller makes a new contributor, key and recovery code (SharingError.code)
      await this._fail(id, code, message);
      if (this.onError) this.onError(new SharingError(code, r.status, message));
      return null;
    }
    if (code === 'volume_limit' || code === 'capped_limit') {
      // retry after the next UTC midnight
      const rec = this.records.get(id);
      if (rec) {
        const now = this.clock();
        rec.lastError = `HTTP ${r.status} ${code}: retry tomorrow`;
        rec.nextAttempt = (Math.floor(now / DAY_MS) + 1) * DAY_MS + Math.floor(this.random() * 3600000);
        await this._save(rec);
      }
      if (this.onError) this.onError(new SharingError(code, r.status, message));
      return null;
    }
    if (r.status === 401) await this._retry(id, `HTTP 401 ${code}`, { immediately: (this.records.get(id)?.attempts || 0) < 3, invalidate: true });
    else if (r.status >= 500 || [408, 425, 429].includes(r.status)) await this._retry(id, `HTTP ${r.status} ${code}`);
    else if (code === 'contributions_disabled' || code === 'attestation_required') await this._retry(id, `HTTP ${r.status} ${code}: paused`, { long: true });
    else if (code === 'turnstile_required' || code === 'turnstile_failed') await this._retry(id, `HTTP ${r.status} ${code}`, { immediately: (this.records.get(id)?.attempts || 0) < 2 });
    else if (code === 'segment_cap') await this._capped(id);
    else if (r.status === 404 || r.status === 410) await this._drop(id, code);
    else await this._fail(id, code, message);
    if (r.status === 401 && this.tokenProvider.invalidate) await this.tokenProvider.invalidate();
    return null;
  }

  // ---- states ----

  async _retry(id, why, { immediately = false, long = false } = {}) {
    const rec = this.records.get(id);
    if (!rec || this.stopped) return;
    rec.lastError = why;
    const n = Math.max(1, rec.attempts);
    const base = long ? 6 * 3600 : Math.min(30 * 2 ** Math.min(n - 1, 16), 6 * 3600);
    const delay = immediately ? 0 : base * (0.8 + 0.4 * this.random());
    rec.nextAttempt = this.clock() + delay * 1000;
    await this._save(rec);
  }

  async _fail(id, code, message) {
    const rec = this.records.get(id);
    if (!rec) return;
    Object.assign(rec, { state: 'failed', failCode: code, failMessage: message, nextAttempt: null, urls: null });
    this.waiting.delete(id);
    await this._save(rec);
    for (const name of await this.storage.list(id)) if (name !== FILES.item) await this.storage.remove(id, name);
  }

  // the capped tier's per-session limit was reached: what went up stays valid; nothing more is sent
  async _capped(id) {
    const rec = this.records.get(id);
    if (!rec) return;
    Object.assign(rec, { state: 'uploaded', capped: true, nextAttempt: null, urls: null, lastError: 'segment_cap' });
    this.waiting.delete(id);
    await this._save(rec);
    // no take list for a recording the cap cut short: its later takes never went up
    for (const name of await this.storage.list(id)) if (/\.opus$/.test(name) || name === FILES.takes) await this.storage.remove(id, name);
  }

  // the server does not know it (404) or deleted it (410): drop it locally
  async _drop(id, code) {
    await this.storage.removeSession(id);
    this.records.delete(id);
    this.waiting.delete(id);
    if (this.onChange) this.onChange({ id, status: 'dropped', failCode: code });
  }

  async _note(id, why) {
    const rec = this.records.get(id);
    if (!rec || rec.lastError === why || this.stopped) return;
    rec.lastError = why;
    await this._save(rec);
  }

  async _expire() {
    const now = this.clock();
    for (const r of [...this.records.values()]) {
      if (r.state === 'active' && !activeCaptures.has(r.id) && now - (r.createdAt || now) > MAX_AGE_MS) await this._drop(r.id, 'expired');
      else if (r.takeList === 'pending' && now - (r.createdAt || now) > MAX_AGE_MS) await this._takesDone(r, 'dropped', 'expired');
    }
  }

  _scheduleWake() {
    if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = null; }
    if (this.stopped) return;
    const next = Math.min(...[...this.records.values()].filter((r) => r.state === 'active' && r.nextAttempt).map((r) => r.nextAttempt),
      ...[...this.records.values()].filter((r) => r.takeList === 'pending' && r.takeListNext).map((r) => r.takeListNext));
    if (!Number.isFinite(next)) return;
    const delay = Math.min(Math.max(1000, next - this.clock()), 2 ** 31 - 1);
    this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.drain().catch(() => {}); }, delay);
    if (this.wakeTimer.unref) this.wakeTimer.unref();
  }

  // ---- storage ----

  // Picks up sessions the captures made and recovers the ones a closed page left.
  async _scan(until = 0) {
    const s = this.storage;
    // A recording is stamped at its creation with the count of the learner's consent changes. One whose stamp is
    // not the current count was made before the learner's last "off" (the stop did not get to it: the page
    // died, or its delete failed): it is never read into the queue, and it is deleted here, at every pass and
    // start, with sharing on or off. The same for one this pipeline's stop could not delete (`removed`).
    const epoch = this.paused ? this._pausedEpoch : this._epoch();
    if (this._epochSeen !== epoch) {
      this._epochSeen = epoch;
      for (const r of [...this.records.values()]) if (!activeCaptures.has(r.id) && (r.epoch || 0) !== epoch) await this._outdated(r, until);
    }
    for (const id of await s.sessions()) {
      // (the stop's own scan: one it has just tried till its deadline is not tried again in the same call)
      if (this.removed.has(id)) { if (!until || !this._undeletable.has(id)) await this._remove(id, until); continue; }
      if (this.records.has(id)) continue;
      const capturing = activeCaptures.has(id);
      const rec = await readJson(s, id, FILES.item);
      if (rec && rec.id === id) {
        if (!capturing && (rec.epoch || 0) !== epoch && (rec.state === 'active' || rec.takeList === 'pending')) {
          await this._outdated(rec, until);
          if (rec.state === 'active') continue;
        }
        this.records.set(id, rec); this.seqTop = Math.max(this.seqTop, rec.seq); await this._countWaiting(rec); continue;
      }
      if (capturing && !(await markers(s, id)).length) continue;
      const cap = await readJson(s, id, FILES.capture);
      const stamp = cap && Number.isInteger(cap.epoch) ? cap.epoch : 0;
      if (!capturing && stamp !== epoch) { await this._remove(id, until); continue; }
      if (!capturing && !(await readJson(s, id, FILES.end)) && !(await recover(s, id))) continue;
      const fresh = { id, seq: ++this.seqTop, state: 'active', started: false, urls: null, uploaded: [], failCode: null,
        failMessage: null, attempts: 0, lastError: null, nextAttempt: null, createdAt: this.clock(), epoch: stamp };
      await this._save(fresh);
      await this._countWaiting(fresh);
    }
    for (const r of [...this.records.values()]) {
      if (r.state !== 'active' || activeCaptures.has(r.id)) continue;
      if (!(await readJson(s, r.id, FILES.end)) && !(await recover(s, r.id))) { this.records.delete(r.id); this.waiting.delete(r.id); }
    }
  }

  async _save(rec, { byStop = false } = {}) {
    if (this.removed.has(rec.id)) return; // deleted with the queue: a pass that comes back late never brings it back
    this.records.set(rec.id, rec);
    if (this.stopped && !byStop) return; // sharing is off: a pass writes nothing more (stop() itself may)
    await writeJson(this.storage, rec.id, FILES.item, rec);
    // the write came back after the recording was deleted with the queue (a storage call that took longer than
    // the off call waits): it has made the folder anew, so the recording is deleted again
    if (this.removed.has(rec.id)) { await this._remove(rec.id, Date.now() + 1000); return; }
    if (this.onChange) this.onChange(await this._snapshot(rec));
  }

  async _snapshot(r) {
    const ms = await markers(this.storage, r.id);
    const end = await readJson(this.storage, r.id, FILES.end);
    const ses = await readJson(this.storage, r.id, FILES.session);
    // how many takes share the recording: end.json once it closed, takes.json while it runs
    let takes = 1;
    if (end) takes = Number.isInteger(end.takes) && end.takes > 1 ? end.takes : 1;
    else { const list = await storedTakes(this.storage, r.id); if (list) takes = list.length; }
    return {
      id: r.id, segments: ms.length, bytes: ms.reduce((k, m) => k + m.bytes, 0), durationMs: end ? end.durationMs : 0,
      // the bit rate each segment was coded at, in segment order (null for a segment recorded before 2.0.1)
      segmentBitrates: ms.map((m) => (Number.isInteger(m.bitrate) ? m.bitrate : null)),
      day: ses ? ses.day : '', completed: end ? end.completed : null,
      status: r.state === 'active' ? 'queued' : r.state, capped: !!r.capped, failCode: r.failCode || null,
      failMessage: r.failMessage || null, attempts: r.attempts, lastError: r.lastError,
      takes, takeList: r.takeList || null,
    };
  }
}

function merge(old, add) {
  const by = new Map((old || []).map((u) => [u.n, u]));
  for (const u of add) by.set(u.n, u);
  return [...by.values()].sort((a, b) => a.n - b.n);
}
