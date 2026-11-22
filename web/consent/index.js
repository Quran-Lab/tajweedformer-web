// Recitation sharing for the web product: the SDK's own consent sheet and settings (web components),
// the state machine (when to ask, re-ask limits), and the wiring that shares the
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
// copy decks, wordings and SDK upgrades (also from 2.0.0, and a yes given on a 3.x guardian sheet), and is never asked
// about again. Every app shows the same sheet (ONE_SHEET_40 26.1): there is no variant for an app to select.
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
import { SHARING_DB, namedContributors } from '../platform/storage.js';

export { SharingState, MAX_ASKS, LEGACY_CONSENT_VERSION, SHARING_STATE_KEY } from './state.js';
export { decide as decideShareAsk, resolveConfig as resolveShareAsk, SHARE_ASK_DEFAULTS } from './ask40.js';

/** 20.6: an ask is presented once the moment has settled: this long with no new take (and the app idle). */
export const SHARE_ASK_SETTLE_MS = 3000;
/** 20.2: a page shown again after at least this long hidden starts a new app session. */
export const APP_SESSION_GAP_MS = 30 * 60_000;
/** The deck keys of the re-ask card (20.7). A deck without them shows the re-ask sheet in the card's place. */
export const CARD_KEYS = Object.freeze(['card.line', 'card.open', 'card.not_now']);
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
 * @param {import('../platform/client.js').QuranLab} ql  a configured client (its signed config carries Quran Lab's global
 *   incident switch over sharing; every learner is asked otherwise, and the choice is the learner's)
 * @param {object} [o]
 * @param {string} [o.lang]  the deck's language (default: the browser's)
 * @param {'auto'|((ask: object) => Promise<{yes: boolean}|null|undefined>)} [o.ask='auto']
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
  // the decision of 20.5 (web/consent/ask40.js) on the signed config's share_ask and the device's clock
  const state = new SharingState(ql.state, { enabled: () => ql.sharingAllowed(), consentVersion: consent.version,
    consentTextSha256: consent.textSha256, clock: () => ql.clock(),
    shareAsk: () => (ql.config && ql.config.share_ask) || null });
  const count = (field) => { try { if (ql.telemetry && typeof ql.telemetry.count === 'function') ql.telemetry.count(field); } catch (_) { /* never in the way */ } };
  const timers = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
  const offered = () => { try { return !!ql.sharingAllowed(); } catch (_) { return false; } };
  let pending = null; // the ask an app's own UI has not answered yet
  let ui = null; // what the SDK has on screen for the ask in hand: { kind, close() }
  let gen = 0; // a settling ask is presented only while no take started or ended, and nothing withdrew it, since
  let hiddenAt = null; // when the page was hidden (a new app session after APP_SESSION_GAP_MS)
  const card = () => { const a = state.app.ask; return !!(a && a.shown && a.kind === 'card'); };
  // the learner's answer through the decision, counted as share_yes or share_no when the decision took it
  const finish = (yes) => {
    const r = state.answer(yes ? 'yes' : 'not_now');
    if (r.why === null) count(yes ? 'share_yes' : 'share_no');
    return yes && r.why === null;
  };
  // the SDK's full sheet for the ask in hand (the first ask, a card opened, the fallback): its answer, or null when
  // it was taken back before the learner answered
  const sheet = async (variant) => {
    const { QuranLabConsent } = await import('./element.js');
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const mine = { kind: 'sheet', close: () => { if (ac) ac.abort(); } };
    ui = mine;
    const a = await QuranLabConsent.ask({ lang, variant, wording, theme, signal: ac ? ac.signal : undefined });
    if (ui === mine) ui = null;
    if (!a || a.withdrawn) return null;
    finish(a.yes);
    return { yes: !!a.yes };
  };
  // 20.6: the ask in hand goes on screen. `shown` first: an ask another page asked or answered meanwhile is stale
  // and nothing appears. Resolves with the learner's answer ({ yes }) or null.
  const present = async (kind) => {
    const d = state.decide({ type: 'shown' });
    if (d.action !== kind) return null;
    count('share_asked');
    if (typeof o.ask === 'function') return presentOwn(kind);
    if (kind === 'sheet') return sheet('first');
    // a deck without the card's strings (before 2026-11-15.1): the re-ask sheet in the card's place, the same ask
    if (!CARD_KEYS.every((k) => deck.has(k))) {
      if (state.decide({ type: 'answer', answer: 'open' }).action !== 'sheet') return null;
      return sheet('reask');
    }
    const { QuranLabConsent } = await import('./element.js');
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const mine = { kind: 'card', close: () => { if (ac) ac.abort(); } };
    ui = mine;
    const r = await QuranLabConsent.card({ lang, wording, theme, signal: ac ? ac.signal : undefined });
    if (ui === mine) ui = null;
    if (r === 'open') {
      // the full sheet at once, without the reask line (the card has just said it); the same ask, not counted again
      if (state.decide({ type: 'answer', answer: 'open' }).action !== 'sheet') return null;
      return sheet('first');
    }
    if (r === 'not_now') { finish(false); return { yes: false }; }
    return null; // taken back: the event that took it (a take, the page hidden) decided and counted it
  };
  // an app's own screen (SPEC 3.0 section 14): it is handed the ask with its kind and, for a card, the card's lines
  // and open(); a yes on a card that was not opened is not a yes, and the SDK shows its own full sheet instead. It
  // is handed nothing about a guardian, and its answer is read for `yes` alone (26.1.3)
  const presentOwn = async (kind) => {
    let opened = kind === 'sheet';
    const full = {
      kind, variant: kind === 'sheet' ? 'first' : 'reask', lang, copy: deck, consentVersion: consent.version,
      ...(kind === 'card' ? { card: { line: deck.t('card.line'), open: deck.t('card.open'), notNow: deck.t('card.not_now') } } : {}),
      /** "See how it helps": the card becomes the full sheet (the app shows the full lines, then takes one answer). */
      open: () => {
        if (!opened && state.decide({ type: 'answer', answer: 'open' }).action === 'sheet') opened = true;
        return opened;
      },
    };
    pending = full;
    const a = await o.ask(full);
    if (!a || typeof a.yes !== 'boolean') return null; // the app's own UI answers later with ctl.answer()
    if (pending !== full) return null;
    pending = null;
    if (a.yes && !opened) {
      if (state.decide({ type: 'answer', answer: 'open' }).action !== 'sheet') return null;
      return sheet('first');
    }
    finish(a.yes);
    return { yes: a.yes };
  };
  // 20.6 the moment: SHARE_ASK_SETTLE_MS with no new take, and the app idle where it says so
  const settle = (kind) => {
    const my = ++gen;
    return new Promise((resolve) => {
      const tick = () => {
        const a = state.app.ask;
        if (my !== gen || !a || a.shown) { resolve(null); return; }
        if (o.idle && !o.idle()) { timers.setTimeout(tick, 1000); return; }
        present(kind).then(resolve, () => resolve(null));
      };
      timers.setTimeout(tick, SHARE_ASK_SETTLE_MS);
    });
  };
  // the ask in hand goes back: a card on screen is "Not now" (share_no), a sheet on screen is used with no answer,
  // one not yet on screen counts nothing
  const withdraw = () => {
    gen++;
    if (!state.app.ask) return;
    const wasCard = card();
    state.decide({ type: 'withdrawn' });
    if (wasCard) count('share_no');
    pending = null;
    if (ui) ui.close();
  };
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
    answer(yes) {
      const a = state.app.ask;
      pending = null;
      // a yes on a card that was not opened is not a yes: the SDK's own full sheet for the same ask (20.6)
      if (yes && a && a.kind === 'card') {
        if (state.decide({ type: 'answer', answer: 'open' }).action === 'sheet') sheet('first').catch(() => {});
        return state.s.consent;
      }
      finish(!!yes);
      return state.s.consent;
    },
    /** A new app session (20.2): the page started, or was shown again after APP_SESSION_GAP_MS hidden. */
    launch() { gen++; state.decide({ type: 'launch' }); },
    /** A take starts (20.5 take_start): an ask waiting for its moment is dropped, a card on screen goes ("Not now"),
     * a sheet on screen stays. */
    takeStarted() {
      gen++;
      const wasCard = card();
      state.decide({ type: 'take_start' });
      if (wasCard && !state.app.ask) { count('share_no'); if (ui && ui.kind === 'card') ui.close(); }
    },
    /** A take ended ({ end: normal | interrupted | error | cancelled, speechMs }): a completed session counts, and
     * at a good moment an ask due is presented once the moment settles. Resolves with the answer or null. */
    takeEnded({ end = 'normal', speechMs = 0 } = {}) {
      const d = state.decide({ type: 'take_end', end, speech_ms: Math.max(0, Math.round(speechMs) || 0), offered: offered() });
      return d.action === 'none' ? Promise.resolve(null) : settle(d.action);
    },
    /** The app's own moment (sharing.ask()): an ask only when one is due by the same rules (without the 60 s), never
     * before a completed take of this app session nor during a take. Resolves with the learner's answer, or null
     * when no ask is due (nothing is shown) or an app's own UI answers later. */
    async askNow() {
      const d = state.decide({ type: 'ask_now', offered: offered() });
      if (d.action === 'none') return null;
      gen++;
      return present(d.action);
    },
    /** The ask the SDK has in hand (null when none): { kind: 'sheet' | 'card', number, shown }. */
    get askInHand() { return state.app.ask ? { ...state.app.ask } : null; },
    /** The settings switch: off starts no upload request from the call on, aborts the one in flight and deletes
     * the unsent queue (the open recording with it).
     * Returns a promise: resolved when that is done (off), or at once (on). */
    setSharing(on) {
      state.setSharing(on);
      // 20.5 setting: any ask in hand goes
      gen++; pending = null;
      if (ui) ui.close();
      // off: a promise that resolves when the uploads in flight are aborted and the unsent queue is gone. In a
      // page that has not loaded the sharing module yet, the queue an earlier page left is deleted by the sweep
      // (the answer is written once more when the queue is gone, in case the device did not take it before)
      if (!on) return (ctl.outbox ? Promise.resolve(ctl.outbox.stop()).catch(() => {}) : Promise.resolve()).then(() => sweep()).catch(() => {}).then(() => state.flush());
      // on again in the same page: the pipeline that off stopped takes sessions again (before 2.0.3 it stayed
      // stopped until the next page load, so nothing was shared after off and on)
      if (ctl.outbox) Promise.resolve(ctl.outbox.resume()).catch(() => {});
      return Promise.resolve();
    },
    /** The app went to the background (2.0.3): the shared recording that takes in a row keep open closes now.
     * The platform client calls it when the page is hidden; call it yourself where the app knows better. */
    async background() {
      // the app leaving the foreground takes back the ask in hand (20.6)
      if (hiddenAt === null) hiddenAt = ql.clock();
      withdraw();
      if (ctl.outbox && ctl.outbox.background) await ctl.outbox.background();
    },
    /** The app is in the foreground again: after APP_SESSION_GAP_MS or more hidden, a new app session (20.2). */
    async foreground() {
      if (hiddenAt !== null && ql.clock() - hiddenAt >= APP_SESSION_GAP_MS) ctl.launch();
      hiddenAt = null;
      if (ctl.outbox && ctl.outbox.foreground) await ctl.outbox.foreground();
    },
    /** No take follows (the learner left the recitation screen): the open recording closes now instead of at
     * the end of its join window. */
    async closeRecording() { if (ctl.outbox && ctl.outbox.closeRecording) await ctl.outbox.closeRecording(); },
    /** "Delete what I shared": challenge-response signed with this install's contributor key (P2.11). */
    async deleteShared() {
      // R5: before anything else, and with no wait in between, the queue stands still (no pass sends or writes
      // from this line; it keeps everything) and the off is on the device. A process that ends while the server
      // is asked finds sharing off at its next launch, and the queue is deleted there. What this page sees
      // (isOn, the listeners) does not change while the server is asked: only the stored answer says off.
      if (ctl.outbox && ctl.outbox.hold) ctl.outbox.hold();
      const answer = state.offUntilAnswered();
      // nothing changes: the stored answer is again what this page saw all along, nothing on the device was
      // deleted, the queue goes on with the recording that was in flight
      const asBefore = () => { answer.refused(); if (ctl.outbox && state.sharing) Promise.resolve(ctl.outbox.resume()).catch(() => {}); };
      const contributor = ql.contributor();
      let key;
      try { key = await contributorKey(contributor, { create: false }); } catch (e) { asBefore(); throw e; }
      if (!key) { asBefore(); ql.resetContributor(); return { deleted: 0, objects: 0 }; } // never shared from here
      // uploads in flight are aborted and the pass leaves (nothing is deleted yet), so nothing arrives at the
      // server after the delete
      if (ctl.outbox && ctl.outbox.pause) await ctl.outbox.pause();
      let r;
      try { r = await deleteWithKey(ql, key); } catch (e) {
        // the server did not take it
        asBefore();
        throw e;
      }
      // accepted (3.0.1): sharing is off. The learner turns it on again with the switch and is never asked
      // again; the next shared recording has a new contributor. The unsent queue goes with it. (The stored off
      // was written before the server was asked; this page sees it now, as one change.)
      answer.accepted();
      if (ctl.outbox) await Promise.resolve(ctl.outbox.stop()).catch(() => {});
      await sweep().catch(() => {});
      // the off is written once more now that the queue is deleted: a device that could not store it before
      // (a full quota) may be able to
      state.flush();
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
  // 4.0.2: the queue of this Client's `storage` name (ql.sharingDb, from the Client's `storage` option): one database
  // per name (`where`: the test seam's storage, where there is one). The default name's queue, the one every name
  // shared up to 4.0.1, leaves alone the recordings made under another name's contributor id
  const dbName = () => ql.sharingDb || SHARING_DB;
  const where = () => (ql.sharingStorage ? { storage: ql.sharingStorage } : { dbName: dbName() });
  const others = () => (!ql.sharingStorage && dbName() === SHARING_DB ? namedContributors() : null);
  // what the sharing pipeline of this page needs (made once, updated at every take)
  const pipelineOptions = async () => {
    const tokenProvider = async () => {
      const token = await ql.token();
      return { token, attested: !!(ql._token && ql._token.attested) };
    };
    tokenProvider.invalidate = async () => { ql._token = null; ql.state.set('token', null); };
    return { api: ql.apiUrl, fetch: ql.fetch, tokenProvider, headers: ql.origin ? { origin: ql.origin } : {},
      flags: () => ql.flags, enabled: () => state.sharing, epoch: () => state.changes, onIssue: (kind, code) => ql.reportIssue(kind, code),
      install: { get: async () => ql.state.get('sharing.install'), set: (v) => ql.state.set('sharing.install', v.seq || v.prevEnd !== null ? v : null) },
      ...where(), others, ...(ql.sharingSeams || {}) };
  };
  // 4.0.2: a storage name other than the default takes its own recordings out of the one database 4.0.0 and 4.0.1 kept
  // for every name of the site (adoptRecordings), at every page start, before its queue is looked at. Only when that
  // database is there and this name has ever shared (it has a contributor id); nothing is made where there is none
  const adopt = async () => {
    if (ql.sharingStorage || !ql.sharingDb || ql.sharingDb === SHARING_DB) return;
    const own = ql.state.get('contributor');
    if (typeof own !== 'string') return;
    const mod = await import('../sharing/index.js');
    const legacy = await mod.indexedDbStorage(SHARING_DB, undefined, { existing: true }).catch(() => null);
    if (legacy) await mod.adoptRecordings(legacy, await mod.defaultStorage(dbName()), own, { locks: mod.captureLocks() });
  };
  ctl.adopt = adopt;
  const adopts = !ql.sharingStorage && dbName() !== SHARING_DB && typeof ql.state.get('contributor') === 'string';
  // What a stop left on the device (the page died after the "off" was saved and before the queue was deleted;
  // a delete failed): deleted at the start and after every "off". The sharing module is loaded for it only
  // when the consent's count of changes is ahead of the count the queue was last known clean at.
  const sweep = async () => {
    const at = state.changes;
    if (at === (ql.state.get('sharing.swept') || 0)) return;
    const mod = await import('../sharing/index.js');
    const pipe = await mod.outbox.configure(await pipelineOptions());
    ctl.outbox = mod.outbox;
    if ((await pipe.outbox.sweep()) === 0 && state.changes === at) ql.state.set('sharing.swept', at);
  };
  ctl.sweep = sweep;
  // 4.0.1: recordings an earlier page could not send because their requests got no answer at all (offline, or a
  // CORS refusal: a bucket rule held every web upload that way for four days in November 2026) wait in the outbox on
  // a backoff that reaches 6 hours. At the page's start, with sharing on, they are tried once at once (the outbox's
  // first pass, Outbox._loadRetry), then the backoff goes on. A refusal or any other answer keeps its backoff, and
  // nothing is loaded or asked when the queue holds none. Consent, deletion and limits are the outbox's, as always.
  const retryAtLoad = async () => {
    if (!state.sharing) return;
    const mod = await import('../sharing/index.js');
    // the queue's records are read first: a page with none to try makes no pipeline at its start
    const storage = ql.sharingStorage || await mod.defaultStorage(dbName());
    if (!(await mod.networkFailedIn(storage)).length || !state.sharing) return;
    const pipe = await mod.outbox.configure(await pipelineOptions());
    ctl.outbox = mod.outbox;
    await pipe.outbox.drain();
  };
  ctl.retryAtLoad = retryAtLoad;
  ctl.loadRetried = (adopts ? Promise.resolve().then(adopt).catch(() => {}) : Promise.resolve()).then(sweep).catch(() => {}).then(retryAtLoad).catch(() => {});
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
    ctl.takeStarted();
    // the count first, the consent second: a stop between the two is either seen below or leaves this take's
    // recording with an old stamp, which is never uploaded
    const begun = state.changes;
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
        flags: () => ql.flags, enabled: () => state.sharing, epoch: () => state.changes, stamp: begun,
        // a take list the server refused as a bad request goes to the issue reports
        onIssue: (kind, code) => ql.reportIssue(kind, code),
        ...(ql.sharingBitrate ? { bitrate: ql.sharingBitrate } : {}),
        // where the outbox keeps its files (4.0.2: the database of this Client's storage name; a storage folder in
        // Node), and the Client's test seams (a libopus module, a clock, timers, the page's life)
        ...where(), others,
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
  // the moment to ask (SDK 4.0, contract section 20): at the end of a good session (the platform client's
  // takeFinished calls ctl.takeEnded for every take), or when the app calls sharing.ask(); a new app session now
  ctl.launch();
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
    const r = await ql.fetch(ql.apiUrl + path, { method: 'POST', headers: h, body: JSON.stringify(body), redirect: 'error' });
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
