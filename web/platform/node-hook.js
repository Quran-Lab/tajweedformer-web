// What Node gives the SDK, reached through a hook so that nothing a browser bundler follows from the browser
// entry (web/index.js) imports a `node:` module. web/index.node.js, the package's entry under the "node"
// condition, fills it; this file imports nothing.
let given = null;

/** Called once by web/index.node.js: { fs, fsp, path, os, dirStore, execFileSync, wasm(name) }. */
export function setNode(parts) { given = parts; }

/** True when this is Node (not a page, not a Worker of a page). */
export const isNode = () => typeof globalThis.document === 'undefined' && !!(globalThis.process && globalThis.process.versions && globalThis.process.versions.node);

/** Node's parts. In Node without them the package was imported by a file path instead of its name. */
export function node() {
  if (!given) throw new Error('the Node parts of @quran-lab/tajweedformer are not loaded: import the package by its name, or web/index.node.js, not web/index.js');
  return given;
}

/**
 * The argument for an Emscripten module factory. The glue is built for web and worker, where it fetches its
 * wasm file itself; in Node the SDK reads the file and instantiates it through the glue's instantiateWasm hook.
 * Elsewhere nothing.
 */
export async function wasmArgs(name) {
  if (!isNode()) return {};
  const bytes = await node().wasm(name);
  return {
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(bytes, imports).then((r) => done(r.instance, r.module));
      return {};
    },
  };
}
