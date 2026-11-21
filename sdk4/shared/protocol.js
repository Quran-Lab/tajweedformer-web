// The messages between the host page (the loader) and Quran Lab's frame and engine Worker. API number 4.
//
// 1. Handshake, frame <-> parent window (window.postMessage, never a wildcard target):
//      frame  -> parent  { ql: 'hello', api: 4, nonce }                    to window.parent (a nonce only)
//      parent -> frame   { ql: 'ack', api: 4, nonce } + MessagePort        addressed to the frame's origin only
//    The frame accepts the ack only from window.parent with the nonce, and the site is the ack's event.origin, which
//    the browser stamps (checked against location.ancestorOrigins where the browser has it). No message field, URL
//    part or referrer is ever the site (frame.js). The frame refuses to run top-level or in a window.open window.
// 2. Calls, loader <-> engine Worker, over the transferred MessagePort (the frame relays nothing):
//      { id, op, args }  ->  { id, ok: true, value } | { id, ok: false, error: { code, message, reason } }
//      events            ->  { ev: 'progress' | 'frame', ... }
// Nothing that crosses carries a model byte, a key, the lease or the install certificate.
export const API = 4;
export const HELLO = 'hello';
export const ACK = 'ack';
export const OPS = Object.freeze(['init', 'model', 'prefetch', 'storage', 'removeModels', 'diagnose', 'warm', 'start', 'push', 'finish',
  'cancel', 'reportRecited', 'reportChecks', 'telemetryCount', 'takeReport', 'clip', 'reference', 'background', 'foreground', 'closeModel', 'close', 'endpoints']);

/** The ArrayBuffers of a value, for postMessage's transfer list. */
export function transferables(x, out = []) {
  if (!x || typeof x !== 'object') return out;
  if (ArrayBuffer.isView(x)) {
    const shared = typeof SharedArrayBuffer !== 'undefined' && x.buffer instanceof SharedArrayBuffer;
    if (!shared && !out.includes(x.buffer)) out.push(x.buffer);
    return out;
  }
  if (Array.isArray(x)) { for (const v of x) transferables(v, out); return out; }
  for (const v of Object.values(x)) transferables(v, out);
  return out;
}

/** The calling side over a MessagePort: call(op, args) -> Promise; onEvent(fn). */
export function caller(port) {
  let seq = 0;
  const waiting = new Map();
  const listeners = new Set();
  let dead = null;
  port.onmessage = (e) => {
    const d = e.data || {};
    if (d.ev) { for (const f of listeners) { try { f(d); } catch (_) { /* the listener's problem */ } } return; }
    const w = waiting.get(d.id);
    if (!w) return;
    waiting.delete(d.id);
    if (d.ok) w.resolve(d.value); else w.reject(Object.assign(new Error(d.error && d.error.message || 'failed'), { code: d.error && d.error.code, reason: d.error && d.error.reason }));
  };
  if (typeof port.start === 'function') port.start();
  return {
    call(op, args = {}, transfer = null) {
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        port.postMessage({ id, op, args }, transfer || []);
      });
    },
    onEvent(f) { listeners.add(f); return () => listeners.delete(f); },
    fail(e) { dead = e; for (const w of waiting.values()) w.reject(e); waiting.clear(); },
  };
}
