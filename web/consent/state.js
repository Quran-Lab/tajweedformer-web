// The sharing state machine: when to ask,
// how often to re-ask, settings, the thank-you. Plain JS, no DOM. Every app has the same sheet and the same rules
// (ONE_SHEET_40 26.1): there is no other variant of the ask.
//
// Asking, in SDK 4.0: the first ask is the full sheet, not within 24 hours of the install, not before the
// 3rd completed session, and only at the end of a good session; after "Not now" a re-ask is a small card, when both
// 14 days and 7 completed sessions have passed since the last ask (then 30 days and 10 sessions). An ask counts
// once it is on screen (`shown`), three at most, ever (the sheet and two cards); the count carries over from 3.x and
// 2.0.0. Quran Lab's signed config (`share_ask`) can only make asking rarer.
// - a yes ends asking for good: the grant keeps the consent version (and, for an app's own wording, the text hash)
//   recorded when the learner agreed, across copy decks, wordings and SDK upgrades. There is no version re-ask
//   and nothing pauses sharing when the wording in force changes;
// - turning sharing off ends asking for good; only the settings switch (setSharing) turns it on or off then.
//
// Stored under SHARING_STATE_KEY, the same object 2.0.0 stored: { v: 1, consent: 'unknown' | 'granted' |
// 'declined' | 'final', asks, lastAskSession, sessions, thanked, decidedAt, consentVersion } plus consentTextSha256
// (2.0.1) and, from 4.0, installedAt, lastAskAt, lastAskDay (20.4). 2.0.0's `versionAsked` and the `guardian` that SDKs
// before 4.0 stored with a grant are left as they are, never read and written back unchanged (26.1.4): a yes given on
// a 3.x guardian sheet is a yes like any other and is never asked about again. This app session's part (takes,
// recited_ms, the ask in hand) is in memory only.

import { decide, freshApp, HARD_MAX_ASKS } from './ask40.js';

export const SHARING_STATE_KEY = 'sharing.v1';
// the count of a stored answer (see `changes`)
const countOf = (s) => (s && Number.isInteger(s.changes) ? s.changes : (s && s.consent === 'final' ? 1 : 0));
const FRESH = { v: 1, consent: 'unknown', asks: 0, lastAskSession: 0, sessions: 0, thanked: false, decidedAt: null,
  consentVersion: null, consentTextSha256: null, installedAt: null, lastAskAt: null, lastAskDay: null };
/** Asks shown in all, ever: the sheet and at most two cards after "Not now". */
export const MAX_ASKS = HARD_MAX_ASKS;
// the stored names of 20.4 against the reference's
const NAMES = [['consent', 'consent'], ['asks', 'asks'], ['sessions', 'sessions'], ['lastAskSession', 'last_ask_session'],
  ['installedAt', 'installed_at'], ['lastAskAt', 'last_ask_at'], ['lastAskDay', 'last_ask_day']];
const toRef = (s) => { const r = {}; for (const [a, b] of NAMES) if (s[a] !== undefined) r[b] = s[a]; return r; };
/** The consent version of the copy deck the web SDK 2.0.0 bundled: a 2.0.0 grant stored without a version was
 * given to it. */
export const LEGACY_CONSENT_VERSION = 'share-2026-11-07';

export class SharingState {
  /**
   * @param {{ get(k): any, set(k, v): void }} state  persistence (per origin in browsers)
   * @param {{ enabled: () => boolean, consentVersion?: string, consentTextSha256?: string|null,
   *           clock?: () => number, tzMin?: (ms: number) => number, shareAsk?: () => object|null }} o
   *           consentVersion: the version a new grant records (the deck's, or custom-... for an app's own wording,
   *           with its text hash); tzMin: the device's offset from UTC in minutes east at a time; shareAsk: the
   *           signed config's `share_ask` as it came (null when absent)
   */
  constructor(state, o = {}) {
    this.state = state;
    this.enabledFn = o.enabled || (() => false);
    this.consentVersion = o.consentVersion || null;
    this.consentTextSha256 = o.consentTextSha256 || null;
    this.clock = o.clock || Date.now;
    this.tzMin = o.tzMin || ((ms) => -new Date(ms).getTimezoneOffset());
    this.shareAsk = o.shareAsk || (() => null);
    this.listeners = new Set();
    /** This app session's part (20.4): never stored. */
    this.app = freshApp();
  }
  get s() {
    // (while "delete what I shared" asks the server: what this page has seen, not the stored off form)
    const s = { ...FRESH, ...((this._held ? this._held.seen : this._raw()) || {}) };
    if (!Number.isFinite(s.asks) || s.asks < 0) s.asks = 0;
    // a 2.0.0 grant without a version was given to the deck 2.0.0 bundled
    if (s.consent === 'granted' && !s.consentVersion) { s.consentVersion = LEGACY_CONSENT_VERSION; s.consentTextSha256 = null; }
    return s;
  }
  _put(s) {
    if (this._held) { this._held.seen = s; this._storeOff(); } else this._store(s);
    for (const f of this.listeners) f(s);
  }

  // One write of the stored answer. It never throws. False when the device did not take it: the store threw
  // (a full disk, a folder that refuses), or it reads back something else (the browser store keeps a write
  // that localStorage refused in memory only, and goes on reading the old value).
  _write(v) {
    try { this.state.set(SHARING_STATE_KEY, v); } catch (_) { return false; }
    try { return JSON.stringify(this.state.get(SHARING_STATE_KEY) ?? null) === JSON.stringify(v ?? null); } catch (_) { return false; }
  }

  // The answer is `v` from now on. When the device does not take the write, `v` is kept in memory: it is what
  // this page reads, and every later write of the answer (and flush()) stores it.
  _store(v) {
    if (this._write(v)) { this._unsaved = null; return true; }
    let over = null;
    try { over = JSON.stringify(this.state.get(SHARING_STATE_KEY) ?? null); } catch (_) { over = null; }
    this._unsaved = { v, over };
    return false;
  }

  // The answer as this page has it: the stored one, or the one the device has not taken yet. When another
  // page has written the stored answer since, the learner's no is never lost: an off held here stays in force
  // (the next write stores it); an on held here gives way to what is stored.
  _raw() {
    const u = this._unsaved;
    if (u) {
      let now = u.over;
      try { now = JSON.stringify(this.state.get(SHARING_STATE_KEY) ?? null); } catch (_) { now = u.over; }
      if (now === u.over) return u.v;
      if (u.v && u.v.consent !== 'granted') { u.over = now; return u.v; }
      this._unsaved = null;
    }
    try { return this.state.get(SHARING_STATE_KEY) || null; } catch (_) { return null; }
  }

  /** Stores an answer the device did not take earlier, if there is one (after the queue was deleted: the write
   * may succeed now that the queue's data is gone). */
  flush() {
    if (!this._unsaved) return;
    this._raw(); // (another page may have written since: then the stored answer is in force)
    if (this._unsaved) this._store(this._unsaved.v);
  }

  // The stored form while the server is asked to delete: what this page sees, as consent off with the count one
  // higher. A page or process that starts now, or after this one died here, finds sharing off.
  _storeOff() {
    // (a write the device refuses is not an error: the server is asked all the same, and the next write of the
    // answer tries again)
    const h = this._held;
    h.stored = this._write({ ...FRESH, ...(h.seen || {}), consent: 'final', changes: Math.max(h.count, countOf(h.seen) + 1) });
  }
  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  _today() { return new Date(this.clock()).toISOString().slice(0, 10); }

  /** Uploads may run: enabled by the app and the signed config, and the learner said yes (to whichever
   * version: a grant is never paused by a newer deck or wording). */
  get sharing() {
    return this.enabledFn() && this.s.consent === 'granted';
  }

  /** Asking has not ended: no yes, not turned off, and fewer than MAX_ASKS asks shown (the sheet and the cards). */
  get asking() {
    const s = this.s;
    return (s.consent === 'unknown' || s.consent === 'declined') && s.asks < MAX_ASKS;
  }

  /** The version a NEW grant records (an app changed its wording, or a new deck). A learner who already agreed
   * keeps the version recorded then, keeps sharing and is not asked again. */
  setConsent(version, textSha256 = null) {
    this.consentVersion = version || null;
    this.consentTextSha256 = textSha256 || null;
    for (const f of this.listeners) f(this.s);
  }

  /** The consent version the current grant was given to (null when not granted): what each session of this
   * grant sends as consent_version. */
  get grantVersion() { const s = this.s; return s.consent === 'granted' ? s.consentVersion : null; }

  /** The hash of the custom wording the current grant was given to (null for a deck's own wording, or when
   * not sharing): what each session of this grant sends as consent_text_sha256. */
  get grantTextSha256() {
    if (!this.sharing) return null;
    const s = this.s;
    return s.consentVersion && s.consentVersion.startsWith('custom-') ? s.consentTextSha256 || null : null;
  }

  /**
   * One event of 20.5 through the decision: launch, take_start, take_end {end, speech_ms, offered},
   * ask_now {offered}, shown, answer {answer: yes | not_now | open}, withdrawn, setting {on}. Stores what changed
   * (the fields of 20.4, and with a consent that changed what 3.x stored with it: the version and text hash a
   * grant records, the day, the count of changes of mind); keeps this app session's part. Every other stored field
   * (a 3.x `guardian`, 2.0.0's `versionAsked`) is written back as it was.
   * Returns { action: 'none' | 'sheet' | 'card', why, ask } (ask: the ask in hand after the event, or null).
   */
  decide(event) {
    const ms = this.clock();
    const s = this.s;
    const r = decide({ ...toRef(s), app: this.app }, event, this.shareAsk(), { ms, tz_min: this.tzMin(ms) });
    const n = r.new_state;
    this.app = n.app;
    const next = { ...s };
    for (const [a, b] of NAMES) next[a] = n[b];
    if (n.consent !== s.consent || (event && event.type === 'setting')) {
      if (n.consent === 'granted' && s.consent !== 'granted') {
        Object.assign(next, { decidedAt: this._today(), consentVersion: this.consentVersion, consentTextSha256: this.consentTextSha256,
          changes: this.changes + 1 }); // sharing comes on: a change of mind, in the same write
      } else if (event && event.type === 'setting' && n.consent === 'final') {
        next.changes = this.changes + 1; // turned off: a change of mind, in the write that saves the switch (R5)
      } else if (n.consent !== s.consent) next.decidedAt = this._today();
    }
    const raw = this._raw();
    if (!raw || NAMES.some(([a]) => JSON.stringify(raw[a] ?? null) !== JSON.stringify(next[a] ?? null)) || next.changes !== s.changes
      || next.decidedAt !== s.decidedAt) this._put(next);
    return { action: r.action, why: r.why, ask: this.app.ask ? { ...this.app.ask } : null };
  }

  /**
   * The learner's answer to the ask in hand: 'yes' (the sheet only: share, recording the version in force now),
   * 'not_now' (or dismissed; final after the third ask), 'open' (a card opened into the full sheet). true and false
   * are 'yes' and 'not_now'. After a yes or a switch turned off this changes nothing (the recorded grant stays as it
   * is): use setSharing.
   */
  answer(answer) {
    const ans = answer === true ? 'yes' : answer === false ? 'not_now' : answer;
    return this.decide({ type: 'answer', answer: ans });
  }

  /**
   * "Delete what I shared" is about to ask the server (R5). From this call, with no wait before it, the STORED
   * answer says off with the count one higher: a page or process that starts while the server is asked, or
   * after this one died there, finds sharing off and deletes the queue. What THIS page sees does not change
   * while the server is asked: `s`, `sharing` and `changes` stay what they were and no listener is called.
   * Every other write of the answer meanwhile is stored in the off form too, so nothing puts "on" back on the
   * device. Returns { accepted(), refused() }: accepted turns sharing off for this page too (one change);
   * refused stores what this page has seen all along, and nothing was ever visible. When the device cannot store
   * the off, the server is asked all the same: nothing is thrown and no mark is left behind (after a refusal
   * the next write stores the page's own answer; after an acceptance the page's answer is off whether or not
   * it could be stored, and every later write stores it).
   */
  offUntilAnswered() {
    if (this._held) return this._held.done; // a second delete while one asks: the same answer serves both
    const held = { seen: this._raw(), count: this.changes + 1, done: null, stored: false };
    held.done = {
      accepted: () => {
        if (this._held !== held) { if (this.s.consent === 'granted') this.setSharing(false); return; }
        const s = this.s;
        const count = Math.max(held.count, this.changes + 1);
        this._held = null;
        Object.assign(s, { consent: 'final', changes: count });
        this._put(s);
      },
      refused: () => {
        if (this._held !== held) return;
        this._held = null;
        // (when the device refuses this write, a new page would read the off form until the next write of the
        // answer here stores it; this page reads its own answer all along)
        this._store(held.seen);
      },
    };
    this._held = held;
    this._storeOff();
    return held.done;
  }

  /** The count of the learner's changes of mind (sharing turned off, an accepted delete, sharing coming on).
   * A state stored by an SDK without the count reads 1 when sharing was turned off there, else 0: the queue of
   * such an SDK has no stamps (0), so it uploads as before while sharing stayed on and is deleted when it did not. */
  get changes() { return countOf(this.s); }

  /** The settings switch. On records the version in force now (an existing grant keeps its own). Off is final
   * until the learner turns it on again here, and is never asked about again. */
  setSharing(on) {
    if (on && this.s.consent === 'granted') { this.app.ask = null; return; }
    // 20.5 `setting`: any ask in hand goes; the count of the learner's changes of mind is in the write that saves
    // the switch (R5): a recording begun under an earlier count is never uploaded
    this.decide({ type: 'setting', on: !!on });
  }

  /** The thank-you is due (first shared session uploaded): returns true once. */
  takeThanks() {
    const s = this.s;
    if (s.consent !== 'granted' || s.thanked) return false;
    s.thanked = true;
    this._put(s);
    return true;
  }
}
