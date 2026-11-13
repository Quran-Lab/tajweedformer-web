// Node only: the delivery cache of the Client in a directory.
import { readFile, writeFile, mkdir, rename, rm, readdir, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// in a temp file's name, so that two puts of one entry in this process never share a temp file
let puts = 0;

/** A delivery cache in a directory (Node): the same keys as the browser stores ("sha256/<hex>",
 * "part/<hex>/<i>", "manifest/<url>"), one file each, written atomically (temp file, rename).
 * Default directory: $XDG_CACHE_HOME or ~/.cache, then quranlab/tajweedformer. */
export function dirStore(dir) {
  const root = path.resolve(dir || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'quranlab', 'tajweedformer'));
  const file = (k) => path.join(root, ...k.split('/').map((x) => encodeURIComponent(x)));
  return {
    kind: 'directory',
    root,
    async get(k) { try { return new Uint8Array(await readFile(file(k))); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    // o.mode: the file's mode where the system has modes. o.exclusive: the entry is made only when there is none
    // (two processes that start at once on one folder: the first one's bytes stay); resolves false when there
    // was one. The whole file appears at once in both cases (a temp file, then a hard link or a rename).
    async put(k, v, o = {}) {
      const f = file(k);
      await mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.${++puts}.tmp`;
      await writeFile(tmp, v, o.mode ? { mode: o.mode } : undefined);
      if (!o.exclusive) { await rename(tmp, f); return true; }
      try {
        await link(tmp, f);
        return true;
      } catch (e) {
        if (e.code === 'EEXIST') return false;
        // a file system without hard links: a rename (the last writer's bytes stay; the caller reads back what is there)
        await rename(tmp, f);
        return true;
      } finally { await rm(tmp, { force: true }); }
    },
    async delete(k) { await rm(file(k), { force: true }); },
    async keys(prefix = '') {
      const out = [];
      const walk = async (d, rel) => {
        let es;
        try { es = await readdir(d, { withFileTypes: true }); } catch (_) { return; }
        for (const e of es) {
          const k = rel ? `${rel}/${decodeURIComponent(e.name)}` : decodeURIComponent(e.name);
          if (e.isDirectory()) await walk(path.join(d, e.name), k); else if (!e.name.endsWith('.tmp')) out.push(k);
        }
      };
      await walk(root, '');
      return out.filter((k) => k.startsWith(prefix));
    },
  };
}
