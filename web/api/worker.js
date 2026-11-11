// The engine's Worker (browsers): the WebAssembly module and the engine host live here, off the page's main
// thread. The page talks to it through workerHost() in engine-host.js: { id, method, args } in,
// { id, result } or { id, error } out, typed arrays transferred both ways.
import createTajweedFormer from '../../dist/tajweedformer.mjs';
import { EngineHost, transferables } from './engine-host.js';

const host = new EngineHost(createTajweedFormer);
let queue = Promise.resolve();

self.onmessage = (ev) => {
  const { id, method, args } = ev.data || {};
  queue = queue.then(async () => {
    try {
      if (typeof host[method] !== 'function' || method.startsWith('_')) throw new Error(`unknown call ${method}`);
      const result = await host[method](...(args || []));
      self.postMessage({ id, result }, transferables(result));
    } catch (e) {
      self.postMessage({ id, error: { message: String((e && e.message) || e) } });
    }
  });
};
