// Tajweed settings: calibration.json defaults < the portal's remote `tajweed` block < app code.
//
// The same rules as every SDK 2.0.0 wrapper (calibration.json and the portal's block, and
// TAJWEED_SETTINGS.md): parseRemote never throws (an invalid field is dropped, never the config),
// app options throw TajweedSettingsError on any invalid value (a programming error is never silently
// dropped), and resolveSettings gives the effective settings, each with where it came from. The test
// vectors (test/tajweed/config_vectors.json) are reproduced exactly by test/tajweed_settings.test.mjs.
//
// Plain JavaScript with no dependencies: it runs in browsers and Node without the WebAssembly build.

/** The four presets, strictest first. */
export const PRESETS = Object.freeze(['strict', 'balanced', 'sensitive', 'very_sensitive']);

/** The eight site classes of calibration.json, in its order (the engine's ZfTajweedClass). */
export const CLASSES = Object.freeze(['vowel_sub', 'vowel_del', 'vowel_ins', 'short_to_long', 'long_to_short',
  'cons_sub', 'cons_del', 'insertion']);

/** Features that take a per-feature preset override (never a threshold): madd picks its preset_cuts,
 * qalqalah and gemination their preset_tau. */
export const FEATURES = Object.freeze(['madd', 'qalqalah', 'gemination']);

/** Threshold sets of calibration.json: int8 = the exact engine (the default), fp32 = heads from
 * CoreML, an NPU or a server. */
export const BACKENDS = Object.freeze(['int8', 'fp32']);

/** The checks an app or the portal switches on and off (the engine's ZfTajweedCheck). */
export const CHECKS = Object.freeze(['letters', 'vowels', 'length', 'madd', 'gemination', 'qalqalah', 'lazim']);

/** The check that switches each verdict item. ghunna and tafkheem have none: never reported in 2.0.0. */
export const ITEM_CHECK = Object.freeze({
  vowel_sub: 'vowels', vowel_del: 'vowels', vowel_ins: 'vowels',
  short_to_long: 'length', long_to_short: 'length',
  cons_sub: 'letters', cons_del: 'letters', insertion: 'letters',
  madd: 'madd', lazim: 'lazim', gemination: 'gemination', qalqalah: 'qalqalah', word: 'word',
});

/** The word level's check (engine API 3, ZF_TJ_CHECK_WORD): outside CHECKS, whose order is the engine's
 * ZfTajweedEffective arrays. */
export const WORD_CHECK = 'word';
/** Word presets (calibration.json contexts[ctx].word.presets; the engine's ZfTajweedWordPreset). */
export const WORD_PRESETS = Object.freeze(['strict', 'general', 'beginner']);
const isCheck = (c) => CHECKS.includes(c) || c === WORD_CHECK;
const isFiniteNum = (x) => typeof x === 'number' && Number.isFinite(x);
/** A word option ({ preset } or { threshold }), as the engine's remote parser takes it; null if invalid. */
function parseWord(w) {
  if (!isObject(w) || hasOwn(w, 'preset') === hasOwn(w, 'threshold')) return null;
  if (hasOwn(w, 'preset')) return WORD_PRESETS.includes(w.preset) ? { preset: w.preset } : null;
  return isFiniteNum(w.threshold) ? { threshold: w.threshold } : null;
}

/** The calibration.json format this SDK reads. */
export const CALIBRATION_FORMAT = 'quranlab.tajweed-calibration/1';

/** The remote block's version this SDK reads; any other version makes it ignore the whole block. */
export const REMOTE_VERSION = 1;

const APP_KEYS = ['preset', 'overrides', 'checks', 'context', 'word'];
const STATUSES = ['off', 'experimental', 'validated'];

/** An invalid app option (code: 'invalid_app_option') or an unusable calibration.json
 * (code: 'invalid_calibration'). `field` names what was wrong. */
export class TajweedSettingsError extends Error {
  constructor(code, field, message) {
    super(message || `${code}: ${field}`);
    this.name = 'TajweedSettingsError';
    this.code = code;
    this.field = field;
  }
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isNum = (x) => typeof x === 'number';
const okThreshold = (t) => isNum(t) && Number.isFinite(t) && t >= -20 && t <= 20;
const isPreset = (p) => typeof p === 'string' && PRESETS.includes(p);
// Python's sorted() on ASCII keys; compare by code point so non-ASCII keys sort as there too
const byCodePoint = (a, b) => {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
};
const sortedUnique = (xs) => [...new Set(xs)].sort(byCodePoint);

/**
 * Parse the portal's `tajweed` block. Never throws.
 * @param {unknown} raw  the block as JSON-parsed (null or undefined: no block)
 * @returns {{ block: object|null, dropped: string[] }}  the valid fields, and the names of what was
 *          dropped ("remote", "remote.v", "remote.preset", "remote.overrides.cons_sub", ...), sorted
 */
export function parseRemote(raw) {
  if (raw === null || raw === undefined) return { block: null, dropped: [] };
  if (!isObject(raw)) return { block: null, dropped: ['remote'] };
  if (!(isNum(raw.v) && raw.v === REMOTE_VERSION)) return { block: null, dropped: ['remote.v'] };
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'v') continue;
    if (k === 'preset') {
      if (isPreset(v)) out.preset = v; else dropped.push('remote.preset');
    } else if (k === 'context') {
      if (typeof v === 'string' && v) out.context = v; else dropped.push('remote.context');
    } else if (k === 'overrides') {
      if (!isObject(v)) { dropped.push('remote.overrides'); continue; }
      const ov = {};
      for (const [c, o] of Object.entries(v)) {
        if (!(CLASSES.includes(c) || FEATURES.includes(c)) || !isObject(o)) { dropped.push(`remote.overrides.${c}`); continue; }
        const hasP = hasOwn(o, 'preset'), hasT = hasOwn(o, 'threshold');
        if (FEATURES.includes(c) && hasT) { dropped.push(`remote.overrides.${c}`); continue; }
        if (hasP === hasT) { dropped.push(`remote.overrides.${c}`); continue; }
        if (hasP) {
          if (isPreset(o.preset)) ov[c] = { preset: o.preset }; else dropped.push(`remote.overrides.${c}`);
        } else if (okThreshold(o.threshold)) {
          ov[c] = { threshold: o.threshold };
        } else {
          dropped.push(`remote.overrides.${c}`);
        }
      }
      out.overrides = ov;
    } else if (k === 'checks') {
      if (!isObject(v)) { dropped.push('remote.checks'); continue; }
      const ch = {};
      for (const [c, b] of Object.entries(v)) {
        if (isCheck(c) && typeof b === 'boolean') ch[c] = b; else dropped.push(`remote.checks.${c}`);
      }
      out.checks = ch;
    } else if (k === 'word') {
      // engine API 3: exactly one of a word preset or a finite threshold (clamped when resolved)
      const w = parseWord(v);
      if (w) out.word = w; else dropped.push('remote.word');
    } else {
      dropped.push(`remote.${k}`);
    }
  }
  return { block: out, dropped: dropped.sort(byCodePoint) };
}

/**
 * Pull the `tajweed` block out of a whole /v1/config document, or pass a block through. Never throws.
 * @param {unknown} doc  a parsed /v1/config document, a bare tajweed block, or null
 */
export function remoteBlockOf(doc) {
  // a whole /v1/config document (it has its own "v": 1) holds the block under "tajweed"; a block never does
  if (isObject(doc) && hasOwn(doc, 'tajweed')) return doc.tajweed;
  return doc === undefined ? null : doc;
}

/**
 * Check app options. Throws TajweedSettingsError (code 'invalid_app_option') on any invalid value:
 * an unknown option, preset, class or check, an override with both or neither of preset and
 * threshold, a threshold that is not a finite number in -20..20 (or any threshold for madd, qalqalah
 * or gemination, which take a preset only), a context calibration.json lacks.
 * @param {object|null|undefined} app
 * @param {object} calibration  a parsed calibration.json
 * @returns {object} the same options
 */
export function validateAppOptions(app, calibration) {
  const bad = (field, why) => { throw new TajweedSettingsError('invalid_app_option', field, `invalid app option ${field}: ${why}`); };
  if (app === null || app === undefined) return {};
  if (!isObject(app)) bad('options', 'not an object');
  for (const k of Object.keys(app)) if (!APP_KEYS.includes(k)) bad(k, 'unknown option');
  if (hasOwn(app, 'preset') && !isPreset(app.preset)) bad('preset', `not one of ${PRESETS.join(', ')}`);
  if (hasOwn(app, 'context') && !(typeof app.context === 'string' && isObject(calibration.contexts) &&
      hasOwn(calibration.contexts, app.context))) bad('context', 'not a context calibration.json ships');
  if (hasOwn(app, 'overrides')) {
    if (!isObject(app.overrides)) bad('overrides', 'not an object');
    for (const [c, o] of Object.entries(app.overrides)) {
      const f = `overrides.${c}`;
      if (!CLASSES.includes(c) && !FEATURES.includes(c)) bad(f, 'unknown class or feature');
      if (!isObject(o) || hasOwn(o, 'preset') === hasOwn(o, 'threshold')) bad(f, 'needs exactly one of preset or threshold');
      if (FEATURES.includes(c) && hasOwn(o, 'threshold')) bad(f, `${c} takes a preset only`);
      if (hasOwn(o, 'preset') && !isPreset(o.preset)) bad(f, 'unknown preset');
      if (hasOwn(o, 'threshold') && !okThreshold(o.threshold)) bad(f, 'threshold must be a finite number in -20..20');
    }
  }
  if (hasOwn(app, 'word') && !parseWord(app.word)) bad('word', `needs exactly one of preset (${WORD_PRESETS.join(', ')}) or a finite threshold`);
  if (hasOwn(app, 'checks')) {
    if (!isObject(app.checks)) bad('checks', 'not an object');
    for (const [c, b] of Object.entries(app.checks)) {
      if (!isCheck(c) || typeof b !== 'boolean') bad(`checks.${c}`, 'unknown check or not a boolean');
    }
  }
  return app;
}

/**
 * Check a parsed calibration.json well enough to resolve settings from it. Throws
 * TajweedSettingsError (code 'invalid_calibration').
 * @param {unknown} cal
 * @returns {object} the same calibration
 */
export function validateCalibration(cal) {
  const bad = (field, why) => { throw new TajweedSettingsError('invalid_calibration', field, `calibration.json ${field}: ${why}`); };
  if (!isObject(cal)) bad('(root)', 'not an object');
  if (cal.format !== CALIBRATION_FORMAT) bad('format', `${JSON.stringify(cal.format)} is not ${CALIBRATION_FORMAT}`);
  if (typeof cal.model_id !== 'string' || !cal.model_id) bad('model_id', 'missing');
  if (!isObject(cal.contexts) || !Object.keys(cal.contexts).length) bad('contexts', 'missing or empty');
  if (!hasOwn(cal.contexts, cal.default_context)) bad('default_context', 'not one of contexts');
  if (!isPreset(cal.default_preset)) bad('default_preset', 'not a preset');
  if (!Array.isArray(cal.classes)) bad('classes', 'missing');
  for (const c of cal.classes) if (!CLASSES.includes(c)) bad('classes', `unknown class ${c}`);
  for (const [name, cc] of Object.entries(cal.contexts)) {
    const at = `contexts.${name}`;
    if (!isObject(cc) || !isObject(cc.sites)) bad(at, 'no sites');
    // a class or feature absent is "off"; a missing preset threshold disables that class at resolve time
    for (const c of cal.classes) {
      const s = cc.sites[c];
      if (s === undefined || s === null) continue;
      if (!isObject(s) || (s.status !== undefined && !STATUSES.includes(s.status))) bad(`${at}.sites.${c}`, 'bad status');
      if (s.thresholds !== undefined && s.thresholds !== null) {
        if (!isObject(s.thresholds)) bad(`${at}.sites.${c}.thresholds`, 'not an object');
        for (const [p, t] of Object.entries(s.thresholds)) {
          if (t !== null && !(isNum(t) && Number.isFinite(t))) bad(`${at}.sites.${c}.thresholds.${p}`, 'not a finite number');
        }
      }
    }
    for (const f of FEATURES) {
      const x = cc[f];
      if (x === undefined || x === null) continue;
      if (!isObject(x) || (x.status !== undefined && !STATUSES.includes(x.status))) bad(`${at}.${f}`, 'bad status');
    }
  }
  return cal;
}

/**
 * The effective settings: app code > remote (portal) > calibration.json (TAJWEED_SETTINGS.md rev 2).
 * @param {object} calibration  parsed calibration.json
 * @param {unknown} remoteRaw   the portal's tajweed block as parsed JSON (or null); never throws on it
 * @param {object} [app]        app options { preset, overrides, checks, context }; throws on invalid ones
 * @param {boolean|{debug?: boolean}} [debug=false]  the app is a debug build: only then can app code
 *        (never the portal) turn on a check whose calibration status is "off"
 * @param {'int8'|'fp32'} [backend='int8']  whose thresholds: int8 = the exact engine, fp32 = heads from
 *        CoreML, an NPU or a server (calibration's contexts[ctx].backend_overrides[backend] when present)
 * @returns {object} { context, backend, preset, sites, madd, lazim, gemination, qalqalah, dropped, refused }
 */
export function resolveSettings(calibration, remoteRaw, app, debug = false, backend = 'int8') {
  const dbg = isObject(debug) ? !!debug.debug : !!debug;
  if (!BACKENDS.includes(backend)) {
    throw new TajweedSettingsError('invalid_app_option', 'backend', `backend must be one of ${BACKENDS.join(', ')}`);
  }
  app = validateAppOptions(app, calibration);
  const parsed = parseRemote(remoteRaw);
  let remote = parsed.block || {};
  let dropped = parsed.dropped;
  if (hasOwn(remote, 'context') && !hasOwn(calibration.contexts, remote.context)) {
    dropped = dropped.concat(['remote.context']);
    remote = Object.fromEntries(Object.entries(remote).filter(([k]) => k !== 'context'));
  }
  const ctx = app.context || remote.context || calibration.default_context;
  const cc = calibration.contexts[ctx];
  const preset = app.preset || remote.preset || calibration.default_preset;
  const layers = [['app', app], ['remote', remote]];
  const block = (b) => (isObject(b) ? b : { status: 'off' });
  const statusOf = (b) => (b.status === undefined ? 'off' : b.status);

  const flag = (check) => {
    for (const [name, layer] of layers) {
      if (isObject(layer.checks) && hasOwn(layer.checks, check)) return [layer.checks[check], name];
    }
    return [null, null];
  };
  const refused = [];
  const enabled = (item, status) => {
    const [f, src] = flag(ITEM_CHECK[item]);
    if (f === null) return status === 'validated';
    if (!f) return false;
    if (status !== 'off') return true;
    if (src === 'app' && dbg) return true;
    refused.push(`${src}:${item}`);
    return false;
  };
  // per class or feature: an override (app, then remote) beats a global preset (app, then remote),
  // then calibration's default preset
  const pick = (key) => {
    for (const [name, layer] of layers) {
      if (isObject(layer.overrides) && hasOwn(layer.overrides, key)) return [layer.overrides[key], name];
    }
    for (const [name, layer] of layers) if (hasOwn(layer, 'preset')) return [{ preset: layer.preset }, name];
    return [{ preset: calibration.default_preset }, 'calibration'];
  };
  const nonEmpty = (o) => (isObject(o) && Object.keys(o).length ? o : null);
  const bo = (isObject(cc.backend_overrides) && isObject(cc.backend_overrides[backend]) &&
    isObject(cc.backend_overrides[backend].sites)) ? cc.backend_overrides[backend].sites : {};

  const sites = {};
  for (const c of calibration.classes) {
    const s = block(cc.sites[c]);
    const [o, src] = pick(c);
    // the backend's threshold set replaces the class's whole set when it has one (as tajweed_ref.py)
    const th = nonEmpty(isObject(bo[c]) ? bo[c].thresholds : null) || nonEmpty(s.thresholds) || {};
    let threshold;
    if (hasOwn(o, 'threshold')) threshold = Number(o.threshold);
    else threshold = th[o.preset] === undefined || th[o.preset] === null ? null : Number(th[o.preset]);
    const st = statusOf(s);
    const on = enabled(c, st);
    sites[c] = { status: st, enabled: on && threshold !== null, threshold, preset: hasOwn(o, 'preset') ? o.preset : null, source: src };
  }
  const madd = block(cc.madd);
  const lz = (isObject(madd.cuts) && isObject(madd.cuts.lazim) && madd.cuts.lazim.status) || 'off';
  const maddOn = enabled('madd', statusOf(madd));
  const lazimOn = enabled('lazim', lz);
  const [mo, msrc] = pick('madd');
  const feats = {};
  for (const key of ['qalqalah', 'gemination']) {
    const b = block(cc[key]);
    const [fo, fsrc] = pick(key);
    const pt = isObject(b.preset_tau) ? b.preset_tau : {};
    const tau = hasOwn(pt, fo.preset) ? pt[fo.preset] : b.tau;
    feats[key] = { status: statusOf(b), enabled: enabled(key, statusOf(b)), preset: fo.preset, source: fsrc,
      tau: tau === undefined || tau === null ? null : Number(tau) };
  }
  const out = {
    context: ctx,
    backend,
    preset,
    sites,
    madd: { status: statusOf(madd), enabled: maddOn, preset: mo.preset, source: msrc },
    lazim: { status: lz, enabled: lazimOn && maddOn },
    gemination: feats.gemination,
    qalqalah: feats.qalqalah,
  };
  // the word level (engine API 3, tajweed_ref.resolve), only when the context's calibration has a word block
  const wc = wordCalibration(calibration, ctx);
  if (wc) {
    const layer = app.word ? ['app', app.word] : remote.word ? ['remote', remote.word] : null;
    let tau = null, wpreset;
    if (layer && hasOwn(layer[1], 'threshold')) {
      tau = Math.min(Math.max(layer[1].threshold, wc.customLo), wc.customHi);
      wpreset = 'custom';
    } else {
      wpreset = layer ? layer[1].preset : wc.defaultPreset;
      tau = hasOwn(wc.tau, wpreset) ? wc.tau[wpreset] : null;
    }
    if (tau !== null && tau < wc.floor) tau = wc.floor;
    const on = enabled('word', wc.status);
    out.word = { status: wc.status, enabled: on && tau !== null, preset: wpreset, source: layer ? layer[0] : 'calibration', tau };
  }
  out.dropped = sortedUnique(dropped);
  out.refused = sortedUnique(refused);
  return out;
}

/**
 * A mutable holder of the three layers, the shape an app works with: calibration fixed at load, the
 * remote block replaced whenever the portal's config arrives, app settings changed by code. Every
 * setter validates and throws on invalid app values; setRemote never throws.
 */
export class TajweedSettings {
  /**
   * @param {object} calibration  parsed calibration.json (checked with validateCalibration)
   * @param {{ debug?: boolean, backend?: 'int8'|'fp32', app?: object, remote?: unknown }} [opts]
   */
  constructor(calibration, opts = {}) {
    this.calibration = validateCalibration(calibration);
    this.debug = !!opts.debug;
    /** whose thresholds: 'int8' (the exact engine, default) or 'fp32' (CoreML, NPU, server heads) */
    this.backend = opts.backend || 'int8';
    if (!BACKENDS.includes(this.backend)) throw new TajweedSettingsError('invalid_app_option', 'backend', `backend must be one of ${BACKENDS.join(', ')}`);
    this._app = {};
    this._remote = null;
    if (opts.app) this.setApp(opts.app);
    if (opts.remote !== undefined) this.setRemote(opts.remote);
  }

  /** The portal's block, or a whole /v1/config document holding one, as parsed JSON or as text.
   * Replaces the previous remote layer; null clears it. Never throws: text that is not JSON clears
   * the layer. Returns what was dropped. */
  setRemote(raw) {
    let v = raw;
    if (typeof raw === 'string') {
      try { v = JSON.parse(raw); } catch (_) { this._remote = null; return ['remote']; }
    }
    this._remote = remoteBlockOf(v);
    return parseRemote(this._remote).dropped;
  }

  /** Replace every app setting at once ({ preset, overrides, checks, context }); throws on invalid. */
  setApp(app) {
    const copy = JSON.parse(JSON.stringify(app || {}));
    validateAppOptions(copy, this.calibration);
    this._app = copy;
    return this;
  }

  _edit(fn) {
    const next = JSON.parse(JSON.stringify(this._app));
    fn(next);
    validateAppOptions(next, this.calibration);
    this._app = next;
    return this;
  }

  /** The global preset; null removes the app's choice. */
  setPreset(preset) {
    return this._edit((a) => { if (preset === null) delete a.preset; else a.preset = preset; });
  }

  /** One class's (or madd's, qalqalah's, gemination's) preset; null removes the app's override. */
  setClassPreset(cls, preset) {
    return this._edit((a) => {
      a.overrides = a.overrides || {};
      if (preset === null) delete a.overrides[cls]; else a.overrides[cls] = { preset };
    });
  }

  /** One class's fused-LLR threshold, -20..20. */
  setClassThreshold(cls, threshold) {
    return this._edit((a) => { a.overrides = a.overrides || {}; a.overrides[cls] = { threshold }; });
  }

  /** Remove the app's override of a class. */
  clearClass(cls) {
    if (!CLASSES.includes(cls) && !FEATURES.includes(cls)) throw new TajweedSettingsError('invalid_app_option', `overrides.${cls}`, `unknown class ${cls}`);
    return this.setClassPreset(cls, null);
  }

  /** Turn a check on or off; null removes the app's switch. */
  setCheck(check, on) {
    return this._edit((a) => {
      a.checks = a.checks || {};
      if (on === null) delete a.checks[check]; else a.checks[check] = on;
    });
  }

  /** The context ("c16_l64", "c24_l72"); null removes the app's choice. */
  setContext(context) {
    return this._edit((a) => { if (context === null) delete a.context; else a.context = context; });
  }

  /** Forget every app setting. */
  clearApp() { this._app = {}; return this; }

  /** The app layer as it stands (a copy). */
  get app() { return JSON.parse(JSON.stringify(this._app)); }

  /** The remote block as last given (unparsed), or null. */
  get remote() { return this._remote; }

  /** The effective settings (resolveSettings). */
  effective() { return resolveSettings(this.calibration, this._remote, this._app, this.debug, this.backend); }
  /** The app's word level: { preset } (a name from calibration's word block) or { threshold }; null
   * removes the app's choice. Throws on an invalid value. */
  setWord(word) {
    return this._edit((a) => { if (word === null) delete a.word; else a.word = word; });
  }
  /** The word level in force: effective().word with the calibration's presets and range, or null when
   * the context's calibration has no word block. */
  wordLevel() {
    const e = this.effective();
    const wc = wordCalibration(this.calibration, e.context);
    return e.word && wc ? { ...e.word, threshold: e.word.tau, presets: { ...wc.tau }, floor: wc.floor, min: wc.customLo, max: wc.customHi } : null;
  }
}

// ---------------------------------------------------------------------------------------------------
// The word level (the 2.0.0 design; engine API 3): calibration.json contexts[ctx].word holds the
// presets' tau (strict, general, beginner), the floor and the custom range; the word score itself is the
// engine's (zf_tajweed_result_words: every single edit inside the word, clipped fused LLR, flagged at or
// above tau). Resolution as the engine's: app > remote ("word") > default_preset; a custom threshold is
// clamped to custom_range, never below the floor; the check "word" switches it as any other check.

/** The context's word block normalised: { status, tau: {preset: tau}, defaultPreset, floor, customLo,
 * customHi }, or null when calibration has none. */
export function wordCalibration(calibration, context) {
  const cc = isObject(calibration.contexts) ? calibration.contexts[context] : null;
  const w = isObject(cc) && isObject(cc.word) ? cc.word : null;
  if (!w) return null;
  const tau = {};
  for (const p of WORD_PRESETS) {
    const v = isObject(w.presets) ? w.presets[p] : undefined;
    const t = isObject(v) ? v.tau : v;
    if (isFiniteNum(t)) tau[p] = t;
  }
  const floor = isFiniteNum(w.floor) ? w.floor : 2.0;
  const range = Array.isArray(w.custom_range) ? w.custom_range : [floor, 30];
  for (const p of Object.keys(tau)) if (tau[p] < floor) tau[p] = floor;
  return { status: STATUSES.includes(w.status) ? w.status : 'off', tau,
    defaultPreset: WORD_PRESETS.includes(w.default_preset) ? w.default_preset : 'general', floor,
    customLo: isFiniteNum(range[0]) ? range[0] : floor, customHi: isFiniteNum(range[1]) ? range[1] : 30 };
}
