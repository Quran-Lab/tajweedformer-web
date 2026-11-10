// The sharing state machine: when to ask,
// how often to re-ask, the guardian variant, settings, the thank-you. Plain JS, no DOM.
//
// Asking, since 2.0.1:
// - the sheet is shown at most MAX_ASKS times per install, ever (the first ask and, after "Not now", re-asks
//   REASK_GAP sessions apart); the count is of asks handed out (the SDK's sheet or an app's own UI), stored, and
//   carried over from 2.0.0's `asks`;
// - a yes ends asking for good: the grant keeps the consent version (and, for an app's own wording, the text hash)
//   recorded when the learner agreed, across copy decks, wordings and SDK upgrades. There is no version re-ask
//   and nothing pauses sharing when the wording in force changes;
// - turning sharing off ends asking for good; only the settings switch (setSharing) turns it on or off then.
//
// Stored under SHARING_STATE_KEY, the same object 2.0.0 stored: { v: 1, consent: 'unknown' | 'granted' |
// 'declined' | 'final', asks, lastAskSession, sessions, thanked, decidedAt, consentVersion, guardian } plus
// consentTextSha256 (2.0.1). 2.0.0's `versionAsked` is left as it is and no longer read.

export const SHARING_STATE_KEY = 'sharing.v1';
const FRESH = { v: 1, consent: 'unknown', asks: 0, lastAskSession: 0, sessions: 0, thanked: false, decidedAt: null,
  consentVersion: null, consentTextSha256: null, guardian: false };
/** Sheets shown in all, ever: the first ask and at most two re-asks after "Not now". */
export const MAX_ASKS = 3;
/** Sessions between asks. */
export const REASK_GAP = 7;
/** The consent version of the copy deck the web SDK 2.0.0 bundled: a 2.0.0 grant stored without a version was
 * given to it. */
export const LEGACY_CONSENT_VERSION = 'share-2026-11-07';

export class SharingState {
  /**
   * @param {{ get(k): any, set(k, v): void }} state  persistence (per origin in browsers)
   * @param {{ enabled: () => boolean, consentVersion?: string, consentTextSha256?: string|null, audience?: string,
   *           clock?: () => number }} o  consentVersion: the version a new grant records (the deck's, or custom-...
   *           for an app's own wording, with its text hash)
   */
  constructor(state, o = {}) {
    this.state = state;
    this.enabledFn = o.enabled || (() => false);
    this.consentVersion = o.consentVersion || null;
    this.consentTextSha256 = o.consentTextSha256 || null;
    this.audience = o.audience || 'general';
    this.clock = o.clock || Date.now;
    this.listeners = new Set();
  }
  get s() {
    const s = { ...FRESH, ...(this.state.get(SHARING_STATE_KEY) || {}) };
    if (!Number.isFinite(s.asks) || s.asks < 0) s.asks = 0;
    // a 2.0.0 grant without a version was given to the deck 2.0.0 bundled
    if (s.consent === 'granted' && !s.consentVersion) { s.consentVersion = LEGACY_CONSENT_VERSION; s.consentTextSha256 = null; }
    return s;
  }
  _put(s) { this.state.set(SHARING_STATE_KEY, s); for (const f of this.listeners) f(s); }
  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  _today() { return new Date(this.clock()).toISOString().slice(0, 10); }

  /** Uploads may run: enabled by the app and the signed config, and the learner said yes (to whichever
   * version: a grant is never paused by a newer deck or wording). */
  get sharing() {
    return this.enabledFn() && this.s.consent === 'granted';
  }
  get guardianVariant() { return this.audience === 'children'; }

  /** Asking has not ended: no yes, not turned off, and fewer than MAX_ASKS sheets shown. */
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

  _ask(s) {
    if (!(s.consent === 'unknown' || s.consent === 'declined') || s.asks >= MAX_ASKS) return null;
    if (s.asks > 0 && s.sessions - s.lastAskSession < REASK_GAP) return null;
    return s.consent === 'declined' ? 'reask' : 'first';
  }

  /**
   * A session ended. Returns null, or the ask to show: { variant: 'first' | 'reask', guardian: boolean }
   * (counted as shown). The caller shows the sheet and calls answer().
   * @param {{ feedback: boolean }} o  feedback: the learner was shown the model's verdicts
   */
  sessionCompleted({ feedback = false } = {}) {
    const s = this.s;
    s.sessions += 1;
    const ask = this.enabledFn() && feedback ? this._ask(s) : null;
    if (ask) { s.asks += 1; s.lastAskSession = s.sessions; }
    this._put(s);
    return ask ? { variant: ask, guardian: this.guardianVariant } : null;
  }

  /** The app asks now (its own timing; the disclosure lines stay the SDK's). Counted as shown; null once asking
   * has ended (a yes, sharing turned off, or MAX_ASKS sheets shown). The REASK_GAP spacing is the app's to keep. */
  askNow() {
    const s = this.s;
    if (!(s.consent === 'unknown' || s.consent === 'declined') || s.asks >= MAX_ASKS) return null;
    const variant = s.consent === 'declined' ? 'reask' : 'first';
    s.asks += 1; s.lastAskSession = s.sessions;
    this._put(s);
    return { variant, guardian: this.guardianVariant };
  }

  /**
   * The learner answered the sheet. yes: share, recording the version in force now; no (or dismissed): not now
   * (final after the last ask). guardianConfirmed must be true for a yes in the guardian variant. After a yes or
   * a switch turned off this changes nothing (the recorded grant stays as it is): use setSharing.
   */
  answer(yes, { guardianConfirmed = false } = {}) {
    const s = this.s;
    if (s.consent === 'granted' || s.consent === 'final') return s.consent;
    if (yes) {
      if (this.guardianVariant && !guardianConfirmed) throw new Error('the guardian variant needs the parent or guardian confirmation');
      Object.assign(s, { consent: 'granted', decidedAt: this._today(), consentVersion: this.consentVersion,
        consentTextSha256: this.consentTextSha256, guardian: !!guardianConfirmed });
    } else {
      s.consent = s.asks >= MAX_ASKS ? 'final' : 'declined';
      s.decidedAt = this._today();
    }
    this._put(s);
    return s.consent;
  }

  /** The settings switch. On records the version in force now (an existing grant keeps its own). Off is final
   * until the learner turns it on again here, and is never asked about again. */
  setSharing(on, { guardianConfirmed = false } = {}) {
    const s = this.s;
    if (on) {
      if (s.consent === 'granted') return;
      if (this.guardianVariant && !guardianConfirmed) throw new Error('the guardian variant needs the parent or guardian confirmation');
      Object.assign(s, { consent: 'granted', consentVersion: this.consentVersion, consentTextSha256: this.consentTextSha256,
        guardian: !!guardianConfirmed, decidedAt: this._today() });
    } else {
      s.consent = 'final';
    }
    this._put(s);
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
