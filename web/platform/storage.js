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
