// "A newer SDK is available", for the developer only. The signed /v1/config may carry `sdk_latest: {version,
// severity, url}` for the app's platform. When this SDK is older, one console.warn per page load or process, and
// only outside production:
//   Quran Lab SDK <version> is available (<severity>), you have <this version>: <url>
// Production (and anything that cannot tell) stays silent. A missing or malformed field is ignored, never thrown.
// Tried and rejected: warning per configured client (two clients or two configs in one launch would repeat it);
// semver pre-release ordering (a pre-release or junk version simply counts as not newer).

const NUMERIC = /^\d+(\.\d+)*$/;
let warned = false;

/** -1, 0 or 1 for two dotted numeric versions; null when either is not one (a pre-release, junk). */
export function compareVersions(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !NUMERIC.test(a) || !NUMERIC.test(b)) return null;
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The field when it is well formed ({version: dotted numbers, severity: a string, url: https}), else null. */
export function sdkLatestOf(cfg) {
  const s = cfg && typeof cfg === 'object' ? cfg.sdk_latest : null;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  if (typeof s.version !== 'string' || !NUMERIC.test(s.version)) return null;
  if (typeof s.severity !== 'string' || !s.severity.length) return null;
  if (typeof s.url !== 'string') return null;
  try { if (new URL(s.url).protocol !== 'https:') return null; } catch (_) { return null; }
  return { version: s.version, severity: s.severity, url: s.url };
}

/** Outside production: an explicit debug flag wins; else NODE_ENV where it resolves (Node, or a bundler that
 * substitutes process.env.NODE_ENV); else (a plain browser page) production. */
export function isDevelopment(debug) {
  if (debug === true || debug === false) return debug;
  try {
    // eslint-disable-next-line no-undef
    const env = process.env.NODE_ENV;
    if (typeof env === 'string') return env !== 'production';
    return typeof process !== 'undefined' && !!process.versions && !!process.versions.node;
  } catch (_) { return false; }
}

/** Warns once per launch when cfg's sdk_latest is newer than `current`; returns whether it warned now. */
export function noticeSdkLatest(cfg, current, { debug, warn = (m) => console.warn(m) } = {}) {
  try {
    if (warned) return false;
    const l = sdkLatestOf(cfg);
    if (!l || compareVersions(current, l.version) !== -1) return false;
    if (!isDevelopment(debug)) return false;
    warned = true;
    warn(`Quran Lab SDK ${l.version} is available (${l.severity}), you have ${current}: ${l.url}`);
    return true;
  } catch (_) { return false; }
}

/** A new launch (tests). */
export function resetSdkLatestNoticeForTests() { warned = false; }
