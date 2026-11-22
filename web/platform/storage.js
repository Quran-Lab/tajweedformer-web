// Small persistent state for the platform client (tokens, the signed config, telemetry days, the
// sharing state, the bucket, the first-launch flag): JSON values by key.
//   browsers: localStorage (per origin), wrapped in try/catch (private modes can throw)
//   Node:     a JSON file per key in a directory (nodeStateStore in ../tajweed/node.js style, here)
//   tests:    memoryState()

import { node } from './node-hook.js';

/** In memory. */
export function memoryState() {
  const m = new Map();
  return {
    kind: 'memory',
    get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    set(k, v) { if (v === null || v === undefined) m.delete(k); else m.set(k, JSON.stringify(v)); },
  };
}

/** localStorage, prefixed "quranlab.". Falls back to memory when storage throws. */
export function localState(prefix = 'quranlab.') {
  const mem = memoryState();
  const ls = (() => { try { return globalThis.localStorage || null; } catch (_) { return null; } })();
  return {
    kind: ls ? 'localStorage' : 'memory',
    get(k) {
      try { const v = ls ? ls.getItem(prefix + k) : null; return v === null ? mem.get(k) : JSON.parse(v); } catch (_) { return mem.get(k); }
    },
    set(k, v) {
      mem.set(k, v);
      try { if (ls) { if (v === null || v === undefined) ls.removeItem(prefix + k); else ls.setItem(prefix + k, JSON.stringify(v)); } } catch (_) { /* kept in memory */ }
    },
  };
}

/** 4.0.2: the IndexedDB database of the default `storage` name's shared recordings (the one of every name up to 4.0.1). */
export const SHARING_DB = 'quranlab-sharing';
/** 4.0.2: one sharing database per `storage` name: `quranlab-sharing` for the default name (none given), and
 * `quranlab-sharing.<name>` for any other, so one name's answer and passes never touch another name's recordings. */
export const sharingDbName = (storage) => (typeof storage === 'string' && storage ? `${SHARING_DB}.${storage}` : SHARING_DB);

/**
 * 4.0.2: the contributor ids the other `storage` names of this origin keep (localState's `quranlab.<name>.contributor`):
 * the default name's sharing queue leaves alone a recording made under one of them, which that name takes into its own
 * database (outbox.js, adoptRecordings). An empty set where localStorage cannot be read.
 */
export function namedContributors() {
  const out = new Set();
  try {
    const ls = globalThis.localStorage;
    if (!ls) return out;
    for (let i = 0; i < ls.length; i++) {
      const m = /^quranlab\.([A-Za-z0-9._-]{1,40})\.contributor$/.exec(ls.key(i) || '');
      if (!m) continue;
      let v = null;
      try { v = JSON.parse(ls.getItem(ls.key(i))); } catch (_) { v = null; }
      if (typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)) out.add(v);
    }
  } catch (_) { /* nothing known */ }
  return out;
}

/** A directory of JSON files (Node). Synchronous on purpose: tiny files, called rarely. */
export async function dirState(dir) {
  const { fs, path } = node();
  fs.mkdirSync(dir, { recursive: true });
  const file = (k) => path.join(dir, encodeURIComponent(k) + '.json');
  return {
    kind: 'directory',
    get(k) { try { return JSON.parse(fs.readFileSync(file(k), 'utf8')); } catch (_) { return null; } },
    set(k, v) {
      const f = file(k);
      if (v === null || v === undefined) { fs.rmSync(f, { force: true }); return; }
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
      fs.renameSync(tmp, f);
    },
  };
}
