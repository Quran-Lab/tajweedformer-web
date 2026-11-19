// The machine key of the Node path. The same reading of the machine id as the 3.x Node SDK
// (web/tajweed/install.js, SPEC 15.2 as of contract 1.14.0):
//
//   K = SHA-256("quranlab-node-keys 1\n" + machine id + "\n" + user id)
//
//   machine id   /etc/machine-id or /var/lib/dbus/machine-id; on Windows the registry's MachineGuid (`reg`), on a Mac
//                the platform UUID (`ioreg`). The host name is never read (a container's is new at every start).
//   user id      the process's uid, else the user name.
//   A machine id a command reads (Windows, a Mac) can fail or time out (5 s): a read that works is kept in the folder
//   (`machine.json`, vouched for by an HMAC under the folder's own random key file `device.key`), and the kept answer
//   is used only when a later read fails. With no machine id at all (a container without /etc/machine-id), K is the
//   folder's `device.key` (32 random bytes, mode 0600): a copied folder then carries it, the one stated limit.
import { webcrypto, createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/** { id, byCommand } or { id: null, commandFailed }. `read` (tests): a function standing in for the system. */
export function readMachineId(platform = process.platform) {
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return { id: t, byCommand: false }; } catch (_) { /* not this system */ }
  }
  if (platform !== 'win32' && platform !== 'darwin') return { id: null, commandFailed: false };
  try {
    if (platform === 'win32') {
      const out = String(execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
      const m = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out);
      if (m) return { id: m[1], byCommand: true };
    } else {
      const out = String(execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      if (m) return { id: m[1], byCommand: true };
    }
  } catch (_) { /* the command failed or did not answer in time */ }
  return { id: null, commandFailed: true };
}

function userId() {
  try { const u = os.userInfo(); return typeof u.uid === 'number' && u.uid >= 0 ? String(u.uid) : String(u.username); } catch (_) {
    return typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  }
}

/** Write a file whole: a temporary file, then a rename (a kill leaves the old file or the new one). */
export function writeAtomic(file, bytes, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, bytes, { mode });
  try { fs.chmodSync(tmp, mode); } catch (_) { /* a system without modes */ }
  fs.renameSync(tmp, file);
}

// the folder's own random key: read, or made by an exclusive create (another process may make it at the same time)
function deviceKey(dir) {
  const f = path.join(dir, 'device.key');
  try { const b = fs.readFileSync(f); if (b.length === 32) return b; } catch (_) { /* none yet */ }
  try { fs.writeFileSync(f, randomBytes(32), { mode: 0o600, flag: 'wx' }); } catch (_) { /* made by another process */ }
  const b = fs.readFileSync(f);
  if (b.length !== 32) throw new Error('the folder\'s key file is damaged');
  return b;
}

const vouch = (secret, id) => createHmac('sha256', secret).update(`quranlab-node-machine 1\n${id}\n`).digest('hex');

/**
 * The machine key of a storage folder: an AES-GCM CryptoKey (not extractable) for sealing the install keys and the
 * lease, and `source` ('machine', 'kept' or 'folder'). `o.read` and `o.user` stand in for the system in tests.
 */
export async function machineKey(dir, { read = readMachineId, user = userId } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const r = read();
  let id = r.id, source = 'machine';
  const keptFile = path.join(dir, 'machine.json');
  if (id && r.byCommand) {
    try {
      const secret = deviceKey(dir);
      let kept = null;
      try { kept = JSON.parse(fs.readFileSync(keptFile, 'utf8')); } catch (_) { kept = null; }
      if (!kept || kept.id !== id || kept.mac !== vouch(secret, id)) writeAtomic(keptFile, JSON.stringify({ v: 1, id, mac: vouch(secret, id) }));
    } catch (_) { /* an unwritable folder does not change this start's key */ }
  }
  if (!id && r.commandFailed) {
    try {
      const kept = JSON.parse(fs.readFileSync(keptFile, 'utf8'));
      if (kept && typeof kept.id === 'string' && kept.mac === vouch(deviceKey(dir), kept.id)) { id = kept.id; source = 'kept'; }
    } catch (_) { id = null; }
  }
  const raw = id ? createHash('sha256').update(`quranlab-node-keys 1\n${id}\n${user()}\n`).digest() : deviceKey(dir);
  if (!id) source = 'folder';
  const key = await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  raw.fill(0);
  return { key, source };
}

/** AES-256-GCM of `plain` under the machine key: 12-byte nonce, then the ciphertext. */
export async function seal(key, plain, aad) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0); out.set(ct, 12);
  return out;
}

/** The plaintext of `seal`, or null when it does not open (another machine or user, another folder, damaged). */
export async function open(key, sealed, aad) {
  if (!sealed || sealed.length < 28) return null;
  try { return new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12), additionalData: aad }, key, sealed.subarray(12))); } catch (_) { return null; }
}
