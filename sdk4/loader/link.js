// The loader's side of the frame: the hidden iframe on Quran Lab's origin, the handshake's answer, and the port the
// engine Worker serves. The loader never reads the frame and the frame never reads the page.
import { API, HELLO, ACK, caller } from '../shared/protocol.js';
import { TajweedError } from '../../web/api/errors.js';

const HIDDEN = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;z-index:-1';

/** No hello from the first host this long: the frame of the fallback host is opened beside it (the first hello wins).
 * 4 s, so the fallback has taken over within 5 s of the start (Stage B, 11-18: at 5 s it took 5.1 s). */
export const SWITCH_MS = 4_000;
/** No hello from any host this long: the origin check says why. */
export const TIMEOUT_MS = 20_000;

/**
 * Open the frame for `key` and wait for its hello. The frame is Quran Lab's on its first host (web.quranlab.ai); when
 * no hello has come after `switchMs` (4 s), the same frame on the fallback host (web2.quranlab.ai, a separate route
 * of its own) is opened beside it, and the first frame to say hello is the page's: the other is removed. Both hosts
 * serve the same files under the same rules (frame-ancestors per key, the handshake, the site in x-qlab-site and in
 * the lease); each frame's storage is its own origin's. Resolves { rpc, iframe, base, fallback, close() }. Rejects
 * with a TajweedError when no frame answers within `timeoutMs` (20 s): the origin check tells whether the page's
 * origin is not on the key.
 * @param {object} o  { key, frameBases (["https://web.quranlab.ai", "https://web2.quranlab.ai"]) or frameBase, apiUrl,
 *   storage, opts, switchMs, timeoutMs, win, doc, fetch }
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
    let timer = null, switcher = null, settled = false;
    const stop = () => { settled = true; clearTimeout(timer); clearTimeout(switcher); win.removeEventListener('message', onMessage); };
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
    if (bases.length > 1) switcher = setTimeout(() => { if (!settled) open(bases[1]); }, Number.isFinite(o.switchMs) ? o.switchMs : SWITCH_MS);
    timer = setTimeout(async () => {
      stop();
      for (const x of frames) x.iframe.remove();
      reject(await refusalOf(o, site));
    }, o.timeoutMs || TIMEOUT_MS);
    open(bases[0]);
  });
}

// No hello: the browser refused the frame (frame-ancestors), or the network did. The origin check (a simple GET the
// API answers for every origin, 3.x NAMING section 7) tells which.
async function refusalOf(o, site) {
  try {
    const r = await (o.fetch || globalThis.fetch)(`${o.apiUrl}/v1/origin-check?key=${encodeURIComponent(o.key)}`, { redirect: 'error', credentials: 'omit' });
    if (r.status === 200) {
      const a = await r.json();
      if (a && a.allowed === false) {
        return new TajweedError('invalid_key', { detail: `the page's origin ${site} is not allowed for this key (${a.why || 'not listed'}); add it in the portal` });
      }
    }
  } catch (_) { /* not reached either */ }
  return new TajweedError('needs_connection', { detail: 'the Quran Lab frame did not answer on either of its hosts (offline, or blocked by the page\'s Content-Security-Policy: see the README)' });
}
