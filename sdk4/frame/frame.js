// The frame: a page on Quran Lab's origin that a site embeds through the loader. Its URL names the developer key
// (the server answers it with Content-Security-Policy frame-ancestors listing exactly that key's origins, so the
// browser refuses to show it in any other page):
//
//   https://web.quranlab.ai/4/frame/<key>#s=<storage name>
//
// frame-ancestors says nothing about a window opened with window.open, so before anything else the frame refuses to
// run unless it is a frame: top-level (window.top is itself, or no parent) and opened by window.open (an opener and no
// parent) start nothing. Then it learns the site from what the BROWSER says, never from what the host page claims
// (docs/server-for-web-4.md, "Allowed origins, three ways"):
//   1. the hello goes to window.parent; the parent's ack is accepted only from window.parent itself with the hello's
//      nonce, and the site is that message's event.origin, which the browser stamps;
//   2. location.ancestorOrigins, where the browser has it, must name the same origin as the parent;
//   3. the site goes into every API request (x-qlab-site); the server checks it against the key again and signs it
//      into the certificate the lease rides on.
// Nothing in the URL, the referrer or any message body is taken as the site (an `o` in the URL of an older loader, or
// a `site` in the ack, is ignored). It never reads the host page and the host page cannot read it.
import { API, HELLO, ACK } from '../shared/protocol.js';

const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/;

/** Parse the frame's URL: { key, storage } or null. Exported for the tests. Never a site. */
export function parseFrameUrl(loc) {
  const m = /\/4\/frame\/(qlk_v1_[A-Za-z0-9_-]+)$/.exec(loc.pathname);
  if (!m) return null;
  const storage = new URLSearchParams(String(loc.hash || '').replace(/^#/, '')).get('s');
  return { key: m[1], storage: storage && /^[A-Za-z0-9._-]{1,40}$/.test(storage) ? storage : null };
}

/** Why this window must not run the frame, or null: 'top_level' (no parent, or the top itself), 'opened' (window.open). */
export function notFramed(win) {
  if (win.opener && (!win.parent || win.parent === win)) return 'opened';
  if (!win.parent || win.parent === win || win.top === win) return 'top_level';
  return null;
}

/**
 * The handshake. `win` is the frame's window. Resolves { port, key, site, storage, opts } with the loader's port and
 * the site the browser named, or rejects with the step that failed: 'top_level', 'opened', 'url', 'ancestor', 'timeout'.
 */
export function handshake(win, { timeoutMs = 10_000, random = () => crypto.getRandomValues(new Uint8Array(16)) } = {}) {
  return new Promise((resolve, reject) => {
    const why = notFramed(win);
    if (why) { reject(new Error(why)); return; }
    const u = parseFrameUrl(win.location);
    if (!u) { reject(new Error('url')); return; }
    const nonce = [...random()].map((x) => x.toString(16).padStart(2, '0')).join('');
    let timer = null;
    const onMessage = (e) => {
      const d = e.data;
      if (e.source !== win.parent || !d || d.ql !== ACK || d.api !== API || d.nonce !== nonce || !e.ports || e.ports.length !== 1) return;
      win.removeEventListener('message', onMessage);
      clearTimeout(timer);
      const site = e.origin; // stamped by the browser: the parent's real origin
      const anc = win.location.ancestorOrigins;
      if (typeof site !== 'string' || !ORIGIN_RE.test(site)) { reject(new Error('url')); return; }
      if (anc && anc.length && anc[0] !== site) { reject(new Error('ancestor')); return; }
      resolve({ port: e.ports[0], key: u.key, site, storage: u.storage, opts: d.opts || {} });
    };
    win.addEventListener('message', onMessage);
    timer = setTimeout(() => { win.removeEventListener('message', onMessage); reject(new Error('timeout')); }, timeoutMs);
    // a nonce only, to the parent window (whatever its origin: the site is read from its answer, never assumed)
    win.parent.postMessage({ ql: HELLO, api: API, nonce }, '*');
  });
}

// ---- Turnstile, on this frame's hostname (one widget for every key: 18.4.9 as the frame makes possible) ----
let tsReady = null;
function turnstileScript(doc) {
  if (tsReady) return tsReady;
  tsReady = new Promise((resolve, reject) => {
    const s = doc.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve(globalThis.turnstile);
    s.onerror = () => { tsReady = null; reject(new Error('turnstile_unavailable')); };
    doc.head.appendChild(s);
  });
  return tsReady;
}

// The widget is invisible (owner, 11-18: a learner never sees a check or a box, on any browser; contract 18.4.9): it is
// rendered in the frame's hidden box, the frame is never shown for it, and nothing stays after it ends. Turnstile retries
// by itself; on an error the frame resets it, until TS_WITHIN_MS have passed. A widget that would need the learner
// (a managed widget asking for interaction) is given up at once, never shown.
export const TS_WITHIN_MS = 18_000;
const TS_RESETS = 4;
async function turnstileToken(doc, { sitekey, action, cdata }, show) {
  if (!sitekey) return null;
  // a widget that gives no token (its script blocked, it failed, it timed out, it wanted the learner): false; the lease
  // is then asked without a token, and the server gives the unattested class (18.4.9); no site key: null, no gate
  const ts = await turnstileScript(doc).catch(() => null);
  if (!ts) return false;
  const box = doc.getElementById('ts');
  return new Promise((resolve) => {
    let id = null, over = false, resets = 0;
    const done = (t) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      show(false);
      try { if (id !== null) ts.remove(id); } catch (_) { /* gone */ }
      resolve(t);
    };
    const timer = setTimeout(() => done(false), TS_WITHIN_MS);
    try {
      id = ts.render(box, {
        sitekey, action, cData: cdata, appearance: 'interaction-only', execution: 'render', retry: 'auto', 'retry-interval': 2000, 'refresh-expired': 'never',
        callback: (t) => done(t),
        'error-callback': () => {
          if (!over && resets < TS_RESETS) { resets++; try { ts.reset(id); return true; } catch (_) { /* fall through */ } }
          done(false);
          return true;
        },
        'expired-callback': () => done(false), 'timeout-callback': () => done(false),
        // an interactive check is never shown: given up at once
        'before-interactive-callback': () => done(false),
      });
    } catch (_) { done(false); }
  });
}

/** The frame's start (frame.html loads this module). */
export async function startFrame(win = globalThis.window) {
  let hs;
  try { hs = await handshake(win); } catch (e) {
    // nothing is started; the loader sees no hello and reports the origin check's answer
    if (win.document && win.document.body) win.document.body.dataset.refused = e.message;
    return null;
  }
  const worker = new win.Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'quranlab-engine' });
  const ch = new win.MessageChannel();
  // the loader's port now belongs to the Worker: show and hide go through it
  const show = (on) => ch.port1.postMessage({ show: !!on });
  ch.port1.onmessage = async (m) => {
    const d = m.data || {};
    // 4.0.1: the Worker will ask for a token soon (no kept lease): the script loads now, nothing is rendered yet
    if (d.prepare) { turnstileScript(win.document).catch(() => {}); return; }
    if (d.turnstile) ch.port1.postMessage({ id: d.id, token: await turnstileToken(win.document, d.turnstile, show).catch(() => false) });
  };
  const o = hs.opts;
  worker.postMessage({ ql: 'start', port: hs.port, frame: ch.port2, key: hs.key, site: hs.site, storage: hs.storage,
    // (no analytics or audience option in 4.0: an `analytics` or `audience` the page puts in its opts is not passed on)
    appVersion: typeof o.appVersion === 'string' ? o.appVersion : undefined,
    appBuild: typeof o.appBuild === 'string' ? o.appBuild : undefined,
    threads: o.threads === 'auto' ? 'auto' : 'off' }, [hs.port, ch.port2]);
  return { worker, site: hs.site };
}
