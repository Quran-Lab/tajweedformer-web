// Recitation sharing for the web product: the SDK's own consent sheet and settings (web components),
// the state machine (when to ask, re-ask limits, guardian variant), and the wiring that shares the
// WHOLE session while the SDK listens once the learner said yes (the 2.0.0 design; the upload itself is
// web/sharing/, loaded lazily so it costs nothing until sharing is on).
//
// SDK internals since 3.0.0: TajweedClient makes the controller (enableSharing) and puts client.sharing in
// front of it; the settings element takes the Client.
//
// Since 2.0.1 the sheets take a theme (`theme`, or CSS custom properties), an app can show its own UI
// (`ask: fn`, then the learner's answer through the return value or `sharing.answer(yes)`), and an app can
// replace strings with its own wording (`wording`, `sharing.setWording`): a learner who agrees then agrees to that
// text, under the version `custom-<24 hex>` derived from it, and each session sends its hash.
//
// The sheet is shown at most three times per install; a yes is kept, with the version the learner agreed to, across
// copy decks, wordings and SDK upgrades (also from 2.0.0), and is never asked about again.
//
// Since 2.0.3 takes in a row share one recording (web/sharing/takes.js): each take the SDK listens to still starts
// and ends a shared session here, and the sharing pipeline joins it to the recording the previous take left open.
// The ask after a finished take does not close that recording.

import { SharingState } from './state.js';
import { copyFor, registerDeck, languages, EN } from './copy.js';
import { validateWording, deriveConsent } from './wording.js';
import { themeProperties } from './theme.js';
import { contributorKey, forgetContributorKey, deletionMessage, b64url, newRecoveryCode, recoveryHash } from '../platform/contributor-key.js';
import { SDK_VERSION } from '../platform/client.js';

export { SharingState, MAX_ASKS, REASK_GAP, LEGACY_CONSENT_VERSION, SHARING_STATE_KEY } from './state.js';
export { copyFor, registerDeck, languages, EN } from './copy.js';
export { validateWording, deriveConsent, canonicalConsentText, wordingKeys, sha256HexSync, CONSENT_TEXT_FORMAT, PLURAL_CATEGORIES } from './wording.js';
export { THEME_PROPERTIES, themeProperties, applyTheme } from './theme.js';

/** A take's audio that may wait for the sharing session to start (ms); past it the take is not shared. */
export const START_WAIT_MS = 30000;
/** The longest buffer the feed takes, and the most fed audio on its way to the pipeline (seconds). */
export const FEED_MAX_S = 10;
export const FEED_WAIT_S = 2;

/**
 * Turn on the sharing experience for a configured platform client.
 * @param {import('../platform/client.js').QuranLab} ql  a configured client (the signed config decides whether sharing is offered)
 * @param {object} [o]
 * @param {string} [o.lang]  the deck's language (default: the browser's)
 * @param {'auto'|((ask: object) => Promise<{yes: boolean, guardianConfirmed?: boolean}|null|undefined>)} [o.ask='auto']
 *        auto: the SDK shows <quranlab-consent> when the app is idle after a session with feedback; a
 *        function: the app shows its own UI with the SDK's strings (`ask.copy`, the copy with any own wording)
 *        and resolves with the learner's answer, or resolves with nothing and calls `sharing.answer(yes)` from
 *        the learner's tap later. Counted and re-asked exactly like the SDK's own sheet (three asks at most).
 * @param {(() => boolean)} [o.idle]  whether the app is idle now (default: always)
 * @param {Record<string, string>|null} [o.wording]  the app's own wording, {deck key: text} (see setWording)
 * @param {object|null} [o.theme]  colours, corner radius and fonts of the SDK's sheets (THEME_PROPERTIES)
 */
export function enableSharing(ql, o = {}) {
  const lang = o.lang || (globalThis.navigator && navigator.language) || 'en';
  let wording = validateWording(o.wording);
  let theme = o.theme || null;
  themeProperties(theme); // refuses a bad theme now, not when a sheet opens
  let deck = copyFor(lang, wording);
  let consent = deriveConsent(deck.consentVersion, wording);
  const state = new SharingState(ql.state, { enabled: () => ql.sharingAllowed(), consentVersion: consent.version,
    consentTextSha256: consent.textSha256, audience: ql.audience });
  const count = (field) => { try { if (ql.telemetry && typeof ql.telemetry.count === 'function') ql.telemetry.count(field); } catch (_) { /* never in the way */ } };
  let pending = null; // the ask an app's own UI has not answered yet
  const ctl = {
    lang, state,
    /** The copy the sheets show and an app's own UI should show: the deck with the app's own wording applied. */
    get deck() { return deck; },
    get copy() { return deck; },
    /** The consent a new grant records: { version, textSha256, canonicalText } (the last two null for the deck's own
     * wording). Send textSha256 or canonicalText to Quran Lab for a review of your wording. */
    get consent() { return consent; },
    get wording() { return wording; },
    get theme() { return theme; },
    /**
     * Replace deck strings with the app's own wording ({key: text}; plural lines as `impact.minutes.one`, ...;
     * null or {} goes back to the deck). An unknown key or an empty or blank text throws a TypeError and nothing
     * changes. A learner who agrees from now on agrees to this wording (its custom version); a learner who already
     * agreed keeps the version recorded then, keeps sharing and is not asked again.
     */
    setWording(next) {
      const w = validateWording(next);
      wording = w;
      deck = copyFor(lang, wording);
      consent = deriveConsent(deck.consentVersion, wording);
      state.setConsent(consent.version, consent.textSha256);
      return consent;
    },
    /** The look of the SDK's sheets: { accent, accentText, background, text, secondaryText, cornerRadius, titleFont,
     * bodyFont } (CSS values; null for the default). The words and the consent version do not change. */
    setTheme(next) { themeProperties(next); theme = next || null; },
    /** The ask an app's own UI is showing and has not answered (null when none). */
    get pendingAsk() { return pending; },
    /**
     * The learner's answer to a consent ask, from the learner's own tap (the SDK's sheet calls it, and so does an
     * app's own UI). yes: share under the wording shown; no: not now. Counted as share_yes or share_no. After a yes
     * or the switch turned off it changes nothing (and counts nothing): the settings switch decides then.
     */
    answer(yes, { guardianConfirmed = false } = {}) {
      const was = state.s.consent;
      const r = state.answer(!!yes, { guardianConfirmed: !!guardianConfirmed });
      pending = null;
      if (was !== 'granted' && was !== 'final') count(yes ? 'share_yes' : 'share_no');
      return r;
    },
    /** The ask to show after a session (null when none is due); auto mode shows it. */
    async sessionCompleted({ feedback = true, now = false } = {}) {
      const ask = now ? state.askNow() : state.sessionCompleted({ feedback });
      if (!ask) return null;
      const own = typeof o.ask === 'function';
      const show = own ? o.ask : async (a) => {
        const { QuranLabConsent } = await import('./element.js');
        return QuranLabConsent.ask({ lang, variant: a.variant, guardian: a.guardian, wording, theme });
      };
      const wait = () => new Promise((r) => { const tick = () => (!o.idle || o.idle() ? r() : setTimeout(tick, 1000)); tick(); });
      await wait();
      const full = { ...ask, lang, copy: deck, consentVersion: consent.version };
      pending = full;
      count('share_asked');
      const a = await show(full);
      if (!a || typeof a.yes !== 'boolean') return null; // the app's own UI answers later with ctl.answer()
      if (pending === full) ctl.answer(a.yes, { guardianConfirmed: !!a.guardianConfirmed });
      return a;
    },
    /** Ask now, at the app's own moment, if an ask is still allowed (three at most; never after a yes). Resolves
     * with the learner's answer, or null when no ask is allowed or an app's own UI answers later. */
    askNow() { return ctl.sessionCompleted({ now: true }); },
    /** The settings switch: off stops uploads at once and deletes the unsent queue (the open recording with it).
     * Returns a promise: resolved when that is done (off), or at once (on). */
    setSharing(on, opts) {
      state.setSharing(on, opts);
      // off: a promise that resolves when the uploads in flight are aborted and the unsent queue is gone
      if (!on) return ctl.outbox ? Promise.resolve(ctl.outbox.stop()).catch(() => {}) : Promise.resolve();
      // on again in the same page: the pipeline that off stopped takes sessions again (before 2.0.3 it stayed
      // stopped until the next page load, so nothing was shared after off and on)
      if (ctl.outbox) Promise.resolve(ctl.outbox.resume()).catch(() => {});
      return Promise.resolve();
    },
    /** The app went to the background (2.0.3): the shared recording that takes in a row keep open closes now.
     * The platform client calls it when the page is hidden; call it yourself where the app knows better. */
    async background() { if (ctl.outbox && ctl.outbox.background) await ctl.outbox.background(); },
    /** The app is in the foreground again. */
    async foreground() { if (ctl.outbox && ctl.outbox.foreground) await ctl.outbox.foreground(); },
    /** No take follows (the learner left the recitation screen): the open recording closes now instead of at
     * the end of its join window. */
    async closeRecording() { if (ctl.outbox && ctl.outbox.closeRecording) await ctl.outbox.closeRecording(); },
    /** "Delete what I shared": challenge-response signed with this install's contributor key (P2.11). */
    async deleteShared() {
      const contributor = ql.contributor();
      const key = await contributorKey(contributor, { create: false });
      if (!key) { ql.resetContributor(); return { deleted: 0, objects: 0 }; } // never shared from here
      // the queue stands still before the server is asked (uploads in flight are aborted, nothing is deleted
      // yet), so nothing arrives there after the delete
      if (ctl.outbox && ctl.outbox.pause) await ctl.outbox.pause();
      let r;
      try { r = await deleteWithKey(ql, key); } catch (e) {
        // the server did not take it: nothing changes. Sharing is as it was, nothing on the device was deleted,
        // the queue goes on with the recording that was in flight
        if (ctl.outbox && state.sharing) Promise.resolve(ctl.outbox.resume()).catch(() => {});
        throw e;
      }
      // accepted (3.0.1): sharing is off. The learner turns it on again with the switch and is never asked
      // again; the next shared recording has a new contributor. The unsent queue goes with it.
      state.setSharing(false);
      if (ctl.outbox) await Promise.resolve(ctl.outbox.stop()).catch(() => {});
      await forgetContributorKey(contributor);
      ql.resetContributor();
      ql.state.set('sharing.recovery', null);
      // the count of shared recordings starts again with the new contributor
      ql.state.set('sharing.install', null);
      if (ctl.outbox && ctl.outbox.forgetInstall) ctl.outbox.forgetInstall().catch(() => {});
      return r;
    },
    /** "Show my recovery code": for the learner's eyes only (call it from a confirm step in your UI). */
    recoveryCode() { return ql.state.get('sharing.recovery'); },
    /** A rejected contributor (403 contributor_revoked, 409 contributor_key_mismatch): new id, key, code. */
    async rotateContributor() {
      await forgetContributorKey(ql.contributor());
      ql.resetContributor();
      ql.state.set('sharing.recovery', null);
    },
    /** A quiet impact line from the backend's real numbers, or null. */
    async impactLine() {
      const s = await ql.contributionSummary();
      if (!s || !s.you || !s.you.minutes) return null;
      return ctl.copy.minutes(Math.floor(s.you.minutes));
    },
  };
  ql.sharing = ctl;
  // every session the SDK listens to, shared in full while consent is on (P2.9)
  // what the sharing pipeline of this page needs (made once, updated at every take)
  const pipelineOptions = async () => {
    const tokenProvider = async () => {
      const token = await ql.token();
      return { token, attested: !!(ql._token && ql._token.attested) };
    };
    tokenProvider.invalidate = async () => { ql._token = null; ql.state.set('token', null); };
    return { api: ql.apiUrl, fetch: ql.fetch, tokenProvider, headers: ql.origin ? { origin: ql.origin } : {},
      flags: () => ql.flags, enabled: () => state.sharing, onIssue: (kind, code) => ql.reportIssue(kind, code),
      install: { get: async () => ql.state.get('sharing.install'), set: (v) => ql.state.set('sharing.install', v.seq || v.prevEnd !== null ? v : null) },
      ...(ql.sharingStorage ? { storage: ql.sharingStorage } : {}), ...(ql.sharingSeams || {}) };
  };
  let takes = 0; // takes running now (a buffer fed while a take runs is dropped)
  let feedWaiting = 0; // fed samples on their way to the pipeline
  /** Fed samples that have not reached the pipeline yet (at most FEED_WAIT_S of audio). */
  ctl.feedWaiting = () => feedWaiting;
  /**
   * (3.0.0) Audio the app already captures outside takes (SPEC 11.2). Without a yes, or with sharing off or not
   * offered, it is dropped at once and nothing of it is kept. The recognizer never sees it.
   */
  ctl.feed = (samples, sampleRate) => {
    if (!(samples instanceof Float32Array) || !(sampleRate >= 8000 && sampleRate <= 192000)) throw new TypeError('feed takes a Float32Array and its sample rate');
    if (!state.sharing) { if (ctl.outbox && ctl.outbox.feed) ctl.outbox.feed(new Float32Array(0), sampleRate).catch(() => {}); return; }
    if (takes > 0 || !samples.length) return;
    // the feed is live audio: a buffer over FEED_MAX_S is not, and at most FEED_WAIT_S of audio is on its way
    // to the pipeline at a time; what comes on top of that is dropped
    if (samples.length > FEED_MAX_S * sampleRate || (feedWaiting > 0 && feedWaiting + samples.length > FEED_WAIT_S * sampleRate)) return;
    const copy = samples.slice(), at = ql.clock();
    feedWaiting += copy.length;
    import('../sharing/index.js').then(async (mod) => {
      const pipe = await mod.outbox.configure(await pipelineOptions());
      ctl.outbox = mod.outbox;
      if (state.sharing) pipe.feed(copy, sampleRate, at);
    }).catch(() => {}).then(() => { feedWaiting -= copy.length; });
  };
  ctl.streamStarted = (tf, s) => {
    if (!state.sharing) return;
    let session = null, starting = null;
    const startedAt = ql.clock();
    let counted = false;
    // audio that waits for the sharing session to start (its key, its storage, the encoder): at most
    // START_WAIT_MS of it; a take that outruns a start this slow is not shared (never in part)
    let waiting = 0, gaveUp = false;
    const begin = () => starting || (starting = import('../sharing/index.js').then(async (mod) => {
      const key = await contributorKey(ql.contributor());
      let code = ql.state.get('sharing.recovery');
      if (!code) { code = newRecoveryCode(); ql.state.set('sharing.recovery', code); }
      // 2.0.0 passed ql.token() (a string; the outbox wants {token, attested}, so every pass stopped at
      // "no token"), the telemetry device ({class, os_major}; the session JSON wants {deviceClass,
      // osMajor}, so every start threw "os_major undefined" and was reported as sharing_start:error),
      // snake_case decode fields (dropped), a flags snapshot and no consent check in the outbox
      const tokenProvider = async () => {
        const token = await ql.token();
        return { token, attested: !!(ql._token && ql._token.attested) };
      };
      tokenProvider.invalidate = async () => { ql._token = null; ql.state.set('token', null); };
      const dev = ql.telemetry.device || {};
      session = await mod.createSharingSession({
        api: ql.apiUrl, fetch: ql.fetch, tokenProvider, headers: ql.origin ? { origin: ql.origin } : {},
        contributor: ql.contributor(), contributorKeyRaw: key.publicKeyRaw, recoveryHash: await recoveryHash(code), inputSampleRate: tf.sampleRate, inputRoute: 'unknown',
        decodeInfo: { modelRevision: ql.modelRevision || null, modelBuild: ql.modelBuild || null, backend: 'exact', weightsSha256: null, sdkVersion: SDK_VERSION },
        startedAt,
        // the version the learner agreed to, as recorded then (not the deck or wording in force now) and, for an
        // app's own wording, the hash of that text
        consentVersion: state.grantVersion, consentTextSha256: state.grantTextSha256,
        device: { deviceClass: dev.class || 'browser', osMajor: dev.os_major || 1 },
        // read at every pass: the signed config in force now, and the learner's answer now (a withdrawal
        // or a config that turned sharing off stops the next PUT, not only the next session)
        flags: () => ql.flags, enabled: () => state.sharing,
        // a take list the server refused as a bad request goes to the issue reports
        onIssue: (kind, code) => ql.reportIssue(kind, code),
        ...(ql.sharingBitrate ? { bitrate: ql.sharingBitrate } : {}),
        // where the outbox keeps its files when the Client was given a storage folder (Node), and the Client's
        // test seams (a libopus module, a clock, timers, the page's life)
        ...(ql.sharingStorage ? { storage: ql.sharingStorage } : {}),
        ...(ql.sharingSeams || {}),
      });
      ctl.outbox = mod.outbox || ctl.outbox;
      return session;
    }).catch((e) => { ql.reportIssue('other', 'sharing_start:' + (e.code || 'error')); return null; }));
    const push = s.pushAudio, finish = s.finish, free = s.free;
    s.pushAudio = (pcm) => {
      const k = push(pcm);
      if (!counted) { counted = true; takes++; }
      if (state.sharing && !gaveUp) {
        if (!session) {
          waiting += pcm.length;
          if (waiting > (START_WAIT_MS / 1000) * tf.sampleRate) { gaveUp = true; begin(); return k; }
        }
        const copy = pcm.slice();
        begin().then((x) => x && !gaveUp && x.push(copy));
      }
      return k;
    };
    s.finish = () => {
      const k = finish();
      if (counted) { counted = false; takes--; }
      const endedAt = ql.clock();
      if (starting) begin().then((x) => x && x.finish({ endedAt })).then(() => { if (state.takeThanks() && typeof o.ask !== 'function') import('./element.js').then((m) => m.QuranLabConsent.thank({ lang, wording, theme })); });
      starting = null;
      return k;
    };
    s.free = () => {
      if (counted) { counted = false; takes--; }
      const endedAt = ql.clock();
      if (starting) begin().then((x) => x && x.finish({ endedAt }));
      starting = null;
      return free();
    };
  };
  // the moment to ask: after a finished take in which the model heard speech (the platform client's
  // takeFinished calls ctl.sessionCompleted), or when the app calls sharing.ask()
  return ctl;
}

/**
 * "Delete what I shared" (PLATFORM_CLIENT.md section 9.1): a challenge for this app and contributor, the
 * exact message signed with the device key (ECDSA P-256, SHA-256, r||s), then the deletion request. No
 * app key or token is sent to these routes (the server refuses them). 202 is the answer whatever the
 * signature (no enumeration); the summary then confirms. Returns { accepted, sessionsLeft }.
 */
export async function deleteWithKey(ql, key) {
  const app = `${ql.platform}:${ql.bundleId}`;
  const contributor = key.contributor;
  const post = async (path, body) => {
    const h = { 'content-type': 'application/json', ...(ql.origin ? { origin: ql.origin } : {}) };
    const r = await ql.fetch(ql.apiUrl + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
    let j = {};
    try { j = await r.json(); } catch (_) { /* none */ }
    if (r.status >= 400) { const e = new Error(`${r.status} ${j.error || ''}`); e.status = r.status; e.code = j.error; throw e; }
    return j;
  };
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { nonce } = await post('/v1/contributions/challenge', { app, contributor });
    const timestamp = Math.floor(ql.clock() / 1000);
    const sig = await key.sign(deletionMessage({ app, contributor, nonce, timestamp }));
    try {
      await post('/v1/contributions/delete', { app, contributor, nonce, timestamp, action: 'delete-all', signature: b64url(sig) });
      const s = await ql.contributionSummary();
      return { accepted: true, sessionsLeft: s && s.you ? s.you.sessions : null };
    } catch (e) {
      lastErr = e;
      if (!(e.code === 'nonce_invalid' || e.code === 'timestamp_invalid')) throw e;
    }
  }
  throw lastErr;
}

export { QuranLabConsent, QuranLabSharingSettings } from './element.js';
