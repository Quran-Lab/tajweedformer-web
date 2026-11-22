// A host page for the loader in Node, with no browser: `window`, `document` and the frame's iframe. The iframe is the
// test's own frame: when the loader appends it, it says hello as frame.js does, and on the loader's ack it serves a
// Controller the test makes on the port the ack carries, as worker.js does. So the loader's own code (client.js,
// link.js, model.js, errors.js) and the frame's (serve.js, controller.js) run unchanged, over a real MessageChannel.
//
//   const page = installPage({ controller: async () => new Controller({ ... }) });
//   const client = await TajweedClient.create({ key });   // the loader's, from sdk4/loader/client.js
//   ...
//   await client.close(); page.close();
import { serve } from '../../../sdk4/frame/serve.js';
import { HELLO, API } from '../../../sdk4/shared/protocol.js';

/**
 * Puts a page on globalThis (window, document; navigator is Node's own). `controller()` makes the frame's Controller
 * at the ack (once per frame the loader opens). `site`: the page's origin. Returns { controllers, frames, close() }.
 */
export function installPage({ controller, site = 'https://app.example' } = {}) {
  const listeners = new Map();
  const on = (type, f) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(f); };
  const off = (type, f) => { const s = listeners.get(type); if (s) s.delete(f); };
  const fire = (type, ev) => { for (const f of [...(listeners.get(type) || [])]) f(ev); };
  const controllers = [], frames = [], ports = [];
  const win = { location: { origin: site }, MessageChannel, addEventListener: on, removeEventListener: off };
  const element = (tag) => {
    const el = { tag, style: {}, attributes: {}, removed: false, setAttribute(k, v) { el.attributes[k] = v; }, remove() { el.removed = true; } };
    if (tag === 'iframe') {
      el.contentWindow = {
        // the loader's ack: { ql: 'ack', api, nonce, opts } addressed to the frame's origin, with the port to serve on
        postMessage(msg, origin, transfer = []) {
          if (!msg || msg.ql !== 'ack' || origin !== new URL(el.src).origin || !transfer[0]) return;
          const port = transfer[0];
          ports.push(port);
          Promise.resolve(controller({ frame: el, opts: msg.opts || {} })).then((ctl) => { controllers.push(ctl); serve(port, ctl); });
        },
      };
    }
    return el;
  };
  const doc = {
    visibilityState: 'visible',
    createElement: element,
    addEventListener: on,
    removeEventListener: off,
    body: {
      appendChild(el) {
        frames.push(el);
        // the frame's hello, as frame.js sends it to window.parent, stamped with the frame's own origin
        if (el.tag === 'iframe') setTimeout(() => fire('message', { source: el.contentWindow, origin: new URL(el.src).origin, data: { ql: HELLO, api: API, nonce: `n${frames.length}` } }), 0);
        return el;
      },
    },
  };
  doc.documentElement = doc.body;
  win.document = doc;
  const before = { window: globalThis.window, document: globalThis.document };
  globalThis.window = win;
  globalThis.document = doc;
  return {
    window: win, document: doc, controllers, frames,
    /** The page is gone: its ports closed (so Node can exit), the globals put back. */
    close() {
      for (const p of ports) { try { p.close(); } catch (_) { /* closed */ } }
      globalThis.window = before.window;
      globalThis.document = before.document;
    },
  };
}

/**
 * navigator.connection as a browser with the Network Information API reports it (`value`; null: a browser without the
 * API, such as Safari and Firefox), and navigator.onLine. Every read of navigator.connection is counted (`reads`).
 * Returns { reads, set(value, online), restore() }.
 */
export function connectionStandIn(value = null, online = true) {
  const nav = globalThis.navigator;
  const had = Object.getOwnPropertyDescriptor(nav, 'connection');
  const hadOnline = Object.getOwnPropertyDescriptor(nav, 'onLine');
  const s = { reads: 0, value, online };
  Object.defineProperty(nav, 'connection', { configurable: true, get() { s.reads++; return s.value === null ? undefined : s.value; } });
  Object.defineProperty(nav, 'onLine', { configurable: true, get() { return s.online; } });
  return Object.assign(s, {
    set(v, o = true) { s.value = v; s.online = o; },
    restore() {
      if (had) Object.defineProperty(nav, 'connection', had); else delete nav.connection;
      if (hadOnline) Object.defineProperty(nav, 'onLine', hadOnline); else delete nav.onLine;
    },
  });
}

/** The connections of no_wait_40.json as a browser's navigator.connection reports them. */
export const CONNECTIONS = Object.freeze({
  // Chrome on Android on mobile data
  metered: (saver) => ({ type: 'cellular', effectiveType: '4g', saveData: !!saver }),
  unmetered: (saver) => ({ type: 'wifi', effectiveType: '4g', saveData: !!saver }),
  // no network at all
  none: () => ({ type: 'none', saveData: false }),
  // a browser without the Network Information API (Safari, Firefox)
  unknown: () => null,
});
