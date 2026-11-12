// Readers of a model folder for the tests, the conformance tools and the local proof. Since SDK 3.1.0 the
// package has no reader an app can use: a model comes from Quran Lab's server through the Client. These live
// with the tests, not in web/, and are not part of what npm ships.
//
//   import { openModel } from '../../web/api/model.js';        (the SDK's internal entry)
//   const model = await openModel({ reader: dirReader('models/sdk/v4.0'), folder: { trustedKeys: [KEY] } });
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isSafePath } from '../../web/tajweed/manifest.js';

const asBytes = (d) => (d instanceof Uint8Array ? d : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));

/** A folder held in memory: { 'manifest.json': bytes, 'c16_l64/layers.zfw': bytes, ... }. */
export function memoryReader(files) {
  const map = new Map(Object.entries(files || {}));
  return { async read(p) { const d = map.get(p); return d === undefined ? null : asBytes(d); } };
}

/** Reads `<dir>/<path>`; a missing file is null. Paths are the manifest's ("/"-separated, relative);
 * anything that would leave `dir` (through "..", an absolute path or a link) is refused. */
export function dirReader(dir) {
  const root = path.resolve(dir);
  let realRoot = null;
  return {
    async read(p) {
      if (!isSafePath(p)) return null;
      const full = path.join(root, ...p.split('/'));
      let real;
      try { real = await realpath(full); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      realRoot = realRoot || await realpath(root);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
      try { return new Uint8Array(await readFile(real)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
  };
}
