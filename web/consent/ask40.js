// When SDK 4.0 asks a learner to share: a direct port of the
// reference tools/share_ask.py (resolveConfig 20.3, localDay and normalize 20.4, decide 20.5), pure and
// synchronous, in the reference's own names (snake_case), so that vectors/share_ask.json replays through it as it
// is. web/consent/state.js maps the stored names (installedAt, lastAskAt, lastAskDay, lastAskSession) to these.
//
// The rule in plain words (20.1): the first ask is the full sheet, never in the first 24 hours after the install,
// never before the 3rd completed session, and only at the end of a good session (60 s recited in this app
// session). After "Not now" the next ask is a small card, when both 14 days and 7 completed sessions have passed
// since the last ask; the one after that needs 30 days and 10 sessions. Three asks at most, ever; a yes, or sharing
// turned off, ends asking for good. Quran Lab's signed config (`share_ask`) can only make it rarer.

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Quran Lab's permanent rule: three asks per install, ever. No config raises it. */
export const HARD_MAX_ASKS = 3;
const CONSENTS = ['unknown', 'granted', 'declined', 'final'];

/** 20.3: the defaults, and the bounds every SDK applies whatever the config says. */
export const SHARE_ASK_DEFAULTS = Object.freeze({ first_min_sessions: 3, first_min_hours: 24, reask_days: Object.freeze([14, 30]),
  reask_sessions: Object.freeze([7, 10]), good_session_min_s: 60, max_asks: 3 });
const BOUNDS = { first_min_sessions: [3, 30], first_min_hours: [24, 720], reask_days: [[14, 180], [30, 365]],
  reask_sessions: [[7, 100], [10, 100]], good_session_min_s: [60, 600], max_asks: [1, HARD_MAX_ASKS] };
const SCALARS = ['first_min_sessions', 'first_min_hours', 'good_session_min_s', 'max_asks'];
const PAIRS = ['reask_days', 'reask_sessions'];

/** A JSON number with an integral value (21 and 21.0), else null (a boolean, a string, 14.5, null, a list). */
const int = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v ? v : null);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 20.3: the config's `share_ask` as the SDK applies it, field by field (anything that is not an integral number is
 * the default; a pair must be a list of exactly two). Not an object (or absent): every default. */
export function resolveConfig(raw) {
  const out = { ...SHARE_ASK_DEFAULTS, reask_days: [...SHARE_ASK_DEFAULTS.reask_days], reask_sessions: [...SHARE_ASK_DEFAULTS.reask_sessions] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of SCALARS) { const n = int(raw[k]); if (n !== null) out[k] = clamp(n, ...BOUNDS[k]); }
  for (const k of PAIRS) {
    const v = raw[k];
    if (Array.isArray(v) && v.length === 2) for (let i = 0; i < 2; i++) { const n = int(v[i]); if (n !== null) out[k][i] = clamp(n, ...BOUNDS[k][i]); }
  }
  return out;
}

/** 20.2: the device's calendar day at `now` ({ms, tz_min}: minutes east of UTC). */
export const localDay = (now) => Math.floor((now.ms + (now.tz_min || 0) * MINUTE_MS) / DAY_MS);

/** 20.4: this app session's part (never stored). */
export const freshApp = () => ({ takes: 0, recited_ms: 0, asked: false, take_open: false, ask: null });

/** 20.4: the stored state as decide reads it (a 3.x state read for the first time, the clock rule). Any other key
 * passes through untouched. */
export function normalize(state, now) {
  const s = { ...state };
  if (!CONSENTS.includes(s.consent)) s.consent = 'unknown';
  for (const k of ['asks', 'sessions', 'last_ask_session']) { const n = int(s[k]); s[k] = n !== null && n > 0 ? n : 0; }
  if (s.consent === 'declined' && s.asks < 1) s.asks = 1;
  if (s.last_ask_session > s.sessions) s.last_ask_session = s.sessions;
  const t = now.ms;
  const ia = int(s.installed_at);
  s.installed_at = ia === null || ia > t ? t : ia;
  let la = int(s.last_ask_at), ld = int(s.last_ask_day);
  if (s.asks === 0) { la = null; ld = null; } else if (la === null || la > t) { la = t; ld = localDay(now); } else if (ld === null) ld = localDay({ ms: la, tz_min: now.tz_min || 0 });
  s.last_ask_at = la; s.last_ask_day = ld;
  const a = freshApp();
  if (s.app && typeof s.app === 'object' && !Array.isArray(s.app)) for (const k of Object.keys(a)) if (k in s.app) a[k] = clone(s.app[k]);
  s.app = a;
  return s;
}
const clone = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

// the first rule (in this order) that keeps an ask from being due now, or null; `moment`: the end of a take (the
// 60 s rule applies), false for the app's ask()
function blocked(s, cfg, now, moment) {
  const app = s.app;
  if (s.consent === 'granted') return 'granted';
  if (s.consent === 'final') return 'final';
  if (s.asks >= cfg.max_asks) return 'cap';
  if (app.ask !== null) return 'ask_open';
  if (app.asked) return 'app_session';
  if (s.last_ask_day !== null && localDay(now) <= s.last_ask_day) return 'same_day';
  if (moment && app.recited_ms < cfg.good_session_min_s * 1000) return 'short';
  const t = now.ms;
  if (s.asks === 0) {
    if (t - s.installed_at < cfg.first_min_hours * HOUR_MS) return 'first_hours';
    if (s.sessions < cfg.first_min_sessions) return 'first_sessions';
  } else {
    const k = s.asks - 1;
    if (t - s.last_ask_at < cfg.reask_days[k] * DAY_MS) return 'reask_days';
    if (s.sessions - s.last_ask_session < cfg.reask_sessions[k]) return 'reask_sessions';
  }
  return null;
}
function pend(s) {
  const kind = s.asks === 0 ? 'sheet' : 'card';
  s.app.ask = { kind, number: s.asks + 1, shown: false };
  return kind;
}
// the ask in hand goes on screen now: counted (one of the three) unless it is stale
function show(s, cfg, now) {
  const a = s.app.ask;
  if (!(s.consent === 'unknown' || s.consent === 'declined') || s.asks + 1 !== a.number || s.asks >= cfg.max_asks) { s.app.ask = null; return 'stale'; }
  s.asks += 1; s.last_ask_at = now.ms; s.last_ask_day = localDay(now); s.last_ask_session = s.sessions;
  s.app.asked = true; a.shown = true;
  return null;
}
// "Not now" on the sheet or the card, the sheet closed without an answer, a card dismissed or gone
function notNow(s) {
  if (s.consent === 'unknown' || s.consent === 'declined') s.consent = s.asks >= HARD_MAX_ASKS ? 'final' : 'declined';
  s.app.ask = null;
}

/**
 * 20.5: decide(state, event, config, now) -> { action: 'none' | 'sheet' | 'card', why, new_state }. `state`: the
 * stored state (reference names) with this app session's part under `app`; `event`: launch, take_start,
 * take_end {end, speech_ms, offered}, ask_now {offered}, shown, answer {answer: yes | not_now | open}, withdrawn,
 * setting {on}; `config`: the signed config's `share_ask` as it came (null when absent); `now`: {ms, tz_min}.
 */
export function decide(state, event, config, now) {
  const cfg = resolveConfig(config);
  const s = normalize(state, now);
  const app = s.app;
  const typ = event && event.type;
  let action = 'none', why = null;
  if (typ === 'launch') {
    s.app = freshApp();
  } else if (typ === 'take_start') {
    app.take_open = true;
    const a = app.ask;
    if (a !== null && !a.shown) app.ask = null; // withdrawn before it was on screen: nothing is counted
    else if (a !== null && a.kind === 'card') notNow(s); // a card on screen goes when a take starts: Not now
  } else if (typ === 'take_end') {
    app.take_open = false;
    const speech = int(event.speech_ms) || 0;
    const completed = event.end === 'normal' && speech > 0;
    if (completed) { s.sessions += 1; app.takes += 1; app.recited_ms += speech; }
    if (!completed) why = 'not_completed';
    else if (event.offered !== true) why = 'not_offered';
    else { why = blocked(s, cfg, now, true); if (why === null) action = pend(s); }
  } else if (typ === 'ask_now') {
    if (event.offered !== true) why = 'not_offered';
    else if (app.take_open) why = 'take_open';
    else if (app.takes === 0) why = 'no_take';
    else { why = blocked(s, cfg, now, false); if (why === null) action = pend(s); }
  } else if (typ === 'shown') {
    const a = app.ask;
    if (a === null) why = 'no_ask';
    else if (a.shown) why = 'already_shown';
    else { why = show(s, cfg, now); if (why === null) action = a.kind; }
  } else if (typ === 'answer') {
    const a = app.ask;
    const ans = event.answer;
    if (a === null) why = 'no_ask';
    else if (!(s.consent === 'unknown' || s.consent === 'declined')) { app.ask = null; why = 'answered'; }
    else if (ans === 'yes' && a.kind !== 'sheet') why = 'card_has_no_yes';
    else if (ans === 'open' && a.kind !== 'card') why = 'not_a_card';
    else if (!['yes', 'not_now', 'open'].includes(ans)) why = 'unknown_answer';
    else {
      if (!a.shown) why = show(s, cfg, now); // an answer means the ask was on screen
      if (why === null) {
        if (ans === 'yes') { s.consent = 'granted'; app.ask = null; } else if (ans === 'not_now') notNow(s);
        else { app.ask = { kind: 'sheet', number: a.number, shown: true }; action = 'sheet'; }
      }
    }
  } else if (typ === 'withdrawn') {
    const a = app.ask;
    if (a === null) why = 'no_ask';
    else if (!a.shown) app.ask = null;
    else if (a.kind === 'card') notNow(s);
    else app.ask = null; // a sheet taken back after it was shown: the ask is used, no answer is recorded
  } else if (typ === 'setting') {
    s.consent = event.on === true ? 'granted' : 'final';
    app.ask = null;
  } else {
    why = 'unknown_event';
  }
  return { action, why, new_state: s };
}
