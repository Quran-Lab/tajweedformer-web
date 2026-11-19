// The signed engine index (docs/server-for-web-4.md, "Engine files"): one small text that names an engine build
// and every file of it by SHA-256 and size, signed with Quran Lab's Ed25519 key. The frame reads it, checks the
// signature with a pinned key, then fetches each file and runs nothing whose bytes do not hash to the signed value.
//
//   quranlab-web-engine 1
//   engine <engine build id>
//   api 4
//   core <Core release> <Core commit>
//   file <sha256 hex> <size> <name>
//   ...
//
// Served as index.json: {"text": "<the text above>", "kid": "<16 hex>", "sig": "<base64url Ed25519 signature of the
// text's UTF-8 bytes>"}. The first line keeps it apart from every other text the same key signs (the config body
// starts with "{", a lease with "quranlab-lease 1", a certificate with "quranlab-install-cert 1").
import { utf8, unb64u, unhex, sha256Hex } from './bytes.js';
import { verify, keyIdOf } from './ed25519.js';

export const ENGINE_FIRST_LINE = 'quranlab-web-engine 1';
export const ENGINE_ID_RE = /^[0-9]{8}\.[0-9a-f]{12}$/; // <yyyymmdd>.<first 12 hex of the index's own files hash>
const NAME_RE = /^qlcore(-mt)?\.(mjs|wasm)$/;

export class EngineIndexError extends Error {
  constructor(code, message) { super(message || code); this.name = 'EngineIndexError'; this.code = code; }
}

/** The text of an index: { engine, api, core: { release, commit }, files: [{ name, sha256, size }] }. */
export function engineIndexText({ engine, api = 4, core, files }) {
  const lines = [ENGINE_FIRST_LINE, `engine ${engine}`, `api ${api}`, `core ${core.release} ${core.commit}`];
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) lines.push(`file ${f.sha256} ${f.size} ${f.name}`);
  return lines.join('\n') + '\n';
}

/** Parse an index text; throws EngineIndexError('format') on anything but the exact form. */
export function parseEngineIndex(text) {
  if (typeof text !== 'string' || !text.endsWith('\n')) throw new EngineIndexError('format');
  const lines = text.slice(0, -1).split('\n');
  if (lines[0] !== ENGINE_FIRST_LINE) throw new EngineIndexError('format');
  const m1 = /^engine (\S+)$/.exec(lines[1] || '');
  const m2 = /^api ([1-9][0-9]{0,2})$/.exec(lines[2] || '');
  const m3 = /^core (\S+) ([0-9a-f]{7,40})$/.exec(lines[3] || '');
  if (!m1 || !ENGINE_ID_RE.test(m1[1]) || !m2 || !m3) throw new EngineIndexError('format');
  const files = [];
  for (const l of lines.slice(4)) {
    const m = /^file ([0-9a-f]{64}) ([0-9]{1,10}) (\S+)$/.exec(l);
    if (!m || !NAME_RE.test(m[3]) || files.some((f) => f.name === m[3])) throw new EngineIndexError('format');
    files.push({ sha256: m[1], size: Number(m[2]), name: m[3] });
  }
  if (!files.length) throw new EngineIndexError('format');
  return { engine: m1[1], api: Number(m2[1]), core: { release: m3[1], commit: m3[2] }, files };
}

/**
 * Verify an index.json answer against the pinned public keys (32-byte Ed25519, as hex or bytes). Returns the parsed
 * index. Refusals: 'format' (not the shape), 'key' (a key id no pinned key has), 'signature', 'api' (another API
 * number than this loader's).
 */
export async function verifyEngineIndex(json, pinned, { api = 4 } = {}) {
  if (!json || typeof json.text !== 'string' || typeof json.sig !== 'string' || typeof json.kid !== 'string') throw new EngineIndexError('format');
  let sig;
  try { sig = unb64u(json.sig); } catch (_) { throw new EngineIndexError('format'); }
  let key = null;
  for (const p of pinned) {
    const pub = typeof p === 'string' ? unhex(p) : p;
    if ((await keyIdOf(pub)) === json.kid) { key = pub; break; }
  }
  if (!key) throw new EngineIndexError('key');
  if (!(await verify(key, utf8(json.text), sig))) throw new EngineIndexError('signature');
  const idx = parseEngineIndex(json.text);
  if (idx.api !== api) throw new EngineIndexError('api', `engine ${idx.engine} is for API ${idx.api}, this loader is API ${api}`);
  return idx;
}

/** The files of a variant: 'st' (one thread) or 'mt' (threads). Null when the index has no such variant. */
export function variantFiles(idx, variant) {
  const suf = variant === 'mt' ? '-mt' : '';
  const js = idx.files.find((f) => f.name === `qlcore${suf}.mjs`);
  const wasm = idx.files.find((f) => f.name === `qlcore${suf}.wasm`);
  return js && wasm ? { js, wasm } : null;
}

/** Bytes fetched for an index entry: refused unless their size and SHA-256 are the signed ones. */
export async function checkEngineFile(entry, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== entry.size) throw new EngineIndexError('size', `${entry.name}: ${bytes ? bytes.length : 0} bytes, signed ${entry.size}`);
  if ((await sha256Hex(bytes)) !== entry.sha256) throw new EngineIndexError('sha256', `${entry.name}: not the signed bytes`);
  return bytes;
}

/**
 * Which engine build and variant this site runs (the config's `web` object, verified with the rest of the signed
 * config; docs/server-for-web-4.md "Pin and rollout"):
 *   web.engine: { current: <id>, pinned?: <id>, pinned_until?: <unix s>, previous?: <id> }
 * A pin in force wins until its end; else `current` (the server already applied the site's rollout stage).
 * `threads`: 'auto' (threads when the frame is cross-origin isolated and has 4 or more cores) or 'off'.
 */
export function chooseEngine(web, { now = Date.now() / 1000, isolated = false, cores = 1, threads = 'auto', fallback = null } = {}) {
  const e = web && typeof web === 'object' && web.engine && typeof web.engine === 'object' ? web.engine : null;
  let id = null, why = 'default';
  if (e && typeof e.pinned === 'string' && ENGINE_ID_RE.test(e.pinned) && Number.isFinite(e.pinned_until) && now < e.pinned_until) { id = e.pinned; why = 'pinned'; }
  else if (e && typeof e.current === 'string' && ENGINE_ID_RE.test(e.current)) { id = e.current; why = 'auto'; }
  else if (fallback && ENGINE_ID_RE.test(fallback)) { id = fallback; why = 'built-in'; }
  const previous = e && typeof e.previous === 'string' && ENGINE_ID_RE.test(e.previous) && e.previous !== id ? e.previous : null;
  const variant = threads !== 'off' && isolated && cores >= 4 ? 'mt' : 'st';
  return { id, why, previous, variant };
}
