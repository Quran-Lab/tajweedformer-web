// Node only: the delivery cache of the Client in a directory.
import { readFile, writeFile, mkdir, rename, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
    async put(k, v) {
      const f = file(k);
      await mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      await writeFile(tmp, v);
      await rename(tmp, f);
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
