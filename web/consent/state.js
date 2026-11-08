// The sharing state machine: when to ask,
// how often to re-ask, the guardian variant, settings, the thank-you. Plain JS, no DOM.

export const SHARING_STATE_KEY = 'sharing.v1';
const FRESH = { v: 1, consent: 'unknown', asks: 0, lastAskSession: 0, sessions: 0, thanked: false, decidedAt: null,
  consentVersion: null, guardian: false };
/** Asks in all: the first and at most two re-asks. */
export const MAX_ASKS = 3;
/** Sessions between asks. */
export const REASK_GAP = 7;

export class SharingState {
  /**
   * @param {{ get(k): any, set(k, v): void }} state  persistence (per origin in browsers)
   * @param {{ enabled: () => boolean, consentVersion?: string, audience?: string, clock?: () => number }} o
   */
  constructor(state, o = {}) {
    this.state = state;
    this.enabledFn = o.enabled || (() => false);
    this.consentVersion = o.consentVersion || null;
    this.audience = o.audience || 'general';
    this.clock = o.clock || Date.now;
    this.listeners = new Set();
  }
  get s() { return { ...FRESH, ...(this.state.get(SHARING_STATE_KEY) || {}) }; }
  _put(s) { this.state.set(SHARING_STATE_KEY, s); for (const f of this.listeners) f(s); }
  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }

  /** Uploads may run: enabled by the app and the signed config, and the learner said yes (for the
   * current consent version). */
  get sharing() {
    const s = this.s;
    return this.enabledFn() && s.consent === 'granted';
  }
  get guardianVariant() { return this.audience === 'children'; }

  /**
   * A session ended. Returns null, or the ask to show: { variant: 'first' | 'reask' | 'version',
   * guardian: boolean }. The caller shows the sheet and calls answer().
   * @param {{ feedback: boolean }} o  feedback: the learner was shown the model's verdicts
   */
  sessionCompleted({ feedback = false } = {}) {
    const s = this.s;
    s.sessions += 1;
    let ask = null;
    if (this.enabledFn() && feedback) {
      if (s.consent === 'unknown') ask = 'first';
      else if (s.consent === 'declined' && s.asks < MAX_ASKS && s.sessions - s.lastAskSession >= REASK_GAP) ask = 'reask';
      else if (s.consent === 'granted' && this.consentVersion && s.consentVersion && s.consentVersion !== this.consentVersion && !s.versionAsked) {
        ask = 'version'; s.versionAsked = this.consentVersion;
      }
    }
    if (ask) { s.asks += ask === 'version' ? 0 : 1; s.lastAskSession = s.sessions; }
    this._put(s);
    return ask ? { variant: ask, guardian: this.guardianVariant } : null;
  }

  /** The app asks now (its own timing); the disclosure lines stay the SDK's. */
  askNow() { return { variant: this.s.consent === 'unknown' ? 'first' : 'reask', guardian: this.guardianVariant }; }

  /**
   * The learner answered the sheet. yes: share; no (or dismissed): not now (final after the last ask).
   * guardianConfirmed must be true for a yes in the guardian variant.
   */
  answer(yes, { guardianConfirmed = false } = {}) {
    const s = this.s;
    if (yes) {
      if (this.guardianVariant && !guardianConfirmed) throw new Error('the guardian variant needs the parent or guardian confirmation');
      Object.assign(s, { consent: 'granted', decidedAt: new Date(this.clock()).toISOString().slice(0, 10), consentVersion: this.consentVersion,
        guardian: !!guardianConfirmed });
    } else {
      s.consent = s.asks >= MAX_ASKS ? 'final' : 'declined';
      s.decidedAt = new Date(this.clock()).toISOString().slice(0, 10);
    }
    this._put(s);
    return s.consent;
  }

  /** The settings switch. Off is final until the learner turns it on again here. */
  setSharing(on, { guardianConfirmed = false } = {}) {
    const s = this.s;
    if (on) {
      if (this.guardianVariant && !guardianConfirmed) throw new Error('the guardian variant needs the parent or guardian confirmation');
      Object.assign(s, { consent: 'granted', consentVersion: this.consentVersion, guardian: !!guardianConfirmed,
        decidedAt: new Date(this.clock()).toISOString().slice(0, 10) });
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
