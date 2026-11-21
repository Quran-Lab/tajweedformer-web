// The loader's side of the frame: the hidden iframe on Quran Lab's origin, the handshake's answer, and the port the
// engine Worker serves. The loader never reads the frame and the frame never reads the page.
import { API, HELLO, ACK, caller } from '../shared/protocol.js';
import { TajweedError } from '../../web/api/errors.js';
import { Endpoints, FRAME_SWITCH_MS, FRAME_TIMEOUT_MS } from '../shared/endpoints.js';

const HIDDEN = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;z-index:-1';

/** No hello for this long after a host's frame was opened: the next host's frame is opened beside it (the first hello
 * wins). 4 s, so the second host has taken over within 5 s of the start (Stage B, 11-18), the third at 8 s (28.6). */
export const SWITCH_MS = FRAME_SWITCH_MS;
/** No hello from any host this long: the origin check says why. 24 s with five hosts: 8 s after the last one (28.6). */
export const TIMEOUT_MS = FRAME_TIMEOUT_MS;

/**
 * Open the frame for `key` and wait for its hello (ENDPOINTS_40.md 28.6). The frame is Quran Lab's, on the web_frame
 * hosts in order: the first at once, the next after each `switchMs` (4 s) without a hello (web at 0, web2 at 4 s, then
 * the backup hosts at 8, 12 and 16 s), each beside the ones before; the first frame to say hello is the page's and
 * the others are removed. Every host serves the same files under the same rules (frame-ancestors per key, the
 * handshake, the site in x-qlab-site and in the lease); each frame's storage is its own origin's. Resolves
 * { rpc, iframe, base, fallback, close() }. Rejects with a TajweedError when no frame answers within `timeoutMs`
 * (24 s): the origin check, through the api order, tells whether the page's origin is not on the key.
 * @param {object} o  { key, frameBases (the hosts' https origins, in order) or frameBase, apiUrl, endpoints, storage,
 *   opts, switchMs, timeoutMs, win, doc, fetch }
 */
export function openFrame(o) {
  const win = o.win || globalThis.window, doc = o.doc || win.document;
  const bases = (Array.isArray(o.frameBases) && o.frameBases.length ? o.frameBases : [o.frameBase]).filter((b, i, a) => typeof b === 'string' && a.indexOf(b) === i);
  const site = win.location.origin;
  // no origin in the URL: the frame reads the site from the browser (event.origin, ancestorOrigins), never from a claim
  const hash = o.storage ? `s=${encodeURIComponent(o.storage)}` : '';
  // threads: only when the site asks for them AND its page is cross-origin isolated; the frame is then asked for with
  // ?coi=1 (the server adds Cross-Origin-Embedder-Policy to it) and allowed isolation by the iframe's permission
  const coi = o.threads === 'auto' && globalThis.crossOriginIsolated === true;
  const frames = [];
  const open = (base) => {
    const iframe = doc.createElement('iframe');
    iframe.src = `${base.replace(/\/$/, '')}/4/frame/${encodeURIComponent(o.key)}${coi ? '?coi=1' : ''}${hash ? `#${hash}` : ''}`;
    iframe.title = 'Quran Lab engine';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.referrerPolicy = 'origin';
    if (coi) iframe.allow = 'cross-origin-isolated';
    iframe.style.cssText = HIDDEN;
    frames.push({ base, origin: new URL(base).origin, iframe });
    (doc.body || doc.documentElement).appendChild(iframe);
  };
  return new Promise((resolve, reject) => {
    let timer = null, settled = false;
    const switchers = [];
    const stop = () => { settled = true; clearTimeout(timer); for (const t of switchers) clearTimeout(t); win.removeEventListener('message', onMessage); };
    const onMessage = (e) => {
      const d = e.data;
      // from one of the frames this loader opened, stamped with that frame's own origin
      const f = frames.find((x) => e.source === x.iframe.contentWindow && e.origin === x.origin);
      if (!f || !d || d.ql !== HELLO || d.api !== API || typeof d.nonce !== 'string') return;
      stop();
      for (const x of frames) if (x !== f) x.iframe.remove();
      const ch = new win.MessageChannel();
      // addressed to that frame's origin only
      f.iframe.contentWindow.postMessage({ ql: ACK, api: API, nonce: d.nonce, opts: o.opts || {} }, f.origin, [ch.port2]);
      const rpc = caller(ch.port1);
      // the frame stays hidden whatever it asks: the Turnstile check is invisible (18.4.9; owner, 11-18)
      rpc.onEvent((x) => { if (x.ev === 'frame') f.iframe.style.cssText = HIDDEN; });
      resolve({ rpc, iframe: f.iframe, base: f.base, fallback: f.base !== bases[0],
        close() { rpc.fail(new TajweedError('invalid_argument', { detail: 'this client is closed' })); f.iframe.remove(); } });
    };
    win.addEventListener('message', onMessage);
    // each next host after switchMs more without a hello: the i-th at i times switchMs (28.6)
    const every = Number.isFinite(o.switchMs) ? o.switchMs : SWITCH_MS;
    for (let i = 1; i < bases.length; i++) switchers.push(setTimeout(() => { if (!settled) open(bases[i]); }, i * every));
    timer = setTimeout(async () => {
      stop();
      for (const x of frames) x.iframe.remove();
      reject(await refusalOf(o, site));
    }, o.timeoutMs || TIMEOUT_MS);
    open(bases[0]);
  });
}

// No hello: the browser refused the frame (frame-ancestors), or the network did. The origin check (a simple GET the
// API answers for every origin, 3.x NAMING section 7), asked through the api order (28.3, 28.6), tells which.
async function refusalOf(o, site) {
  try {
    const ep = o.endpoints instanceof Endpoints ? o.endpoints : Endpoints.fromSeams({ apiUrl: o.apiUrl || null });
    // the origin check's answer is JSON with `allowed`: anything else (a captive portal's page) is no answer here
    const accept = async (res) => { try { const a = await res.json(); return a && typeof a === 'object' && typeof a.allowed === 'boolean' ? a : null; } catch (_) { return null; } };
    const got = await ep.request('api', `/v1/origin-check?key=${encodeURIComponent(o.key)}`, { redirect: 'error', credentials: 'omit' },
      { fetch: o.fetch || globalThis.fetch.bind(globalThis), accept });
    const a = got.cls === 'taken' ? got.value : null;
    if (a && a.allowed === false) {
      return new TajweedError('invalid_key', { detail: `the page's origin ${site} is not allowed for this key (${a.why || 'not listed'}); add it in the portal` });
    }
  } catch (_) { /* not reached either */ }
  return new TajweedError('needs_connection', { detail: 'the Quran Lab frame did not answer on any of its hosts (offline, or blocked by the page\'s Content-Security-Policy: see the README)' });
}
