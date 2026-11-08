// Recitation sharing for the web product: the SDK's own consent sheet and settings (web components),
// the state machine (when to ask, re-ask limits, guardian variant), and the wiring that shares the
// WHOLE session while the SDK listens once the learner said yes (the 2.0.0 design; the upload itself is
// web/sharing/, loaded lazily so it costs nothing until sharing is on).
//
//   import { QuranLab } from '@quran-lab/tajweedformer/platform';
//   import { enableSharing } from '@quran-lab/tajweedformer/consent';
//   const ql = await QuranLab.configure({ key, contributions: true });
//   const sharing = enableSharing(ql, { lang: 'ar' });     // asks by itself after a session with feedback
//   document.querySelector('quranlab-sharing-settings').controller = sharing;

import { SharingState } from './state.js';
import { copyFor, registerDeck, languages, EN } from './copy.js';
import { contributorKey, forgetContributorKey, deletionMessage, b64url, newRecoveryCode, recoveryHash } from '../platform/contributor-key.js';

export { SharingState, MAX_ASKS, REASK_GAP } from './state.js';
export { copyFor, registerDeck, languages, EN } from './copy.js';

/**
 * Turn on the sharing experience for a configured platform client.
 * @param {import('../platform/client.js').QuranLab} ql  configured with contributions: true
 * @param {object} [o]
 * @param {string} [o.lang]  the deck's language (default: the browser's)
 * @param {'auto'|((ask: object) => Promise<{yes: boolean, guardianConfirmed?: boolean}>)} [o.ask='auto']
 *        auto: the SDK shows <quranlab-consent> when the app is idle after a session with feedback; a
 *        function: the app shows it itself (timing only; the lines are copyFor(lang))
 * @param {(() => boolean)} [o.idle]  whether the app is idle now (default: always)
 */
export function enableSharing(ql, o = {}) {
  const lang = o.lang || (globalThis.navigator && navigator.language) || 'en';
  const deck = copyFor(lang);
  const state = new SharingState(ql.state, { enabled: () => ql.sharingAllowed(), consentVersion: deck.consentVersion, audience: ql.audience });
  const ctl = {
    lang, state, deck,
    /** The ask to show after a session (null when none is due); auto mode shows it. */
    async sessionCompleted({ feedback = true } = {}) {
      const ask = state.sessionCompleted({ feedback });
      if (!ask) return null;
      const show = typeof o.ask === 'function' ? o.ask : async (a) => {
        const { QuranLabConsent } = await import('./element.js');
        return QuranLabConsent.ask({ lang, variant: a.variant, guardian: a.guardian });
      };
      const wait = () => new Promise((r) => { const tick = () => (!o.idle || o.idle() ? r() : setTimeout(tick, 1000)); tick(); });
      await wait();
      const a = await show(ask);
      state.answer(!!a.yes, { guardianConfirmed: !!a.guardianConfirmed });
      return a;
    },
    /** The settings switch: off stops uploads at once and deletes the unsent queue. */
    setSharing(on, opts) {
      state.setSharing(on, opts);
      if (!on && ctl.outbox) ctl.outbox.stop();
    },
    /** "Delete what I shared": challenge-response signed with this install's contributor key (P2.11). */
    async deleteShared() {
      const contributor = ql.contributor();
      const key = await contributorKey(contributor, { create: false });
      if (!key) { ql.resetContributor(); return { deleted: 0, objects: 0 }; } // never shared from here
      const r = await deleteWithKey(ql, key);
      await forgetContributorKey(contributor);
      ql.resetContributor();
      ql.state.set('sharing.recovery', null);
      if (ctl.outbox) ctl.outbox.stop();
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
      return deck.minutes(Math.floor(s.you.minutes));
    },
  };
  ql.sharing = ctl;
  // every session the SDK listens to, shared in full while consent is on (P2.9)
  ctl.streamStarted = (tf, s) => {
    if (!state.sharing) return;
    let session = null, starting = null;
    const begin = () => starting || (starting = import('../sharing/index.js').then(async (mod) => {
      const key = await contributorKey(ql.contributor());
      let code = ql.state.get('sharing.recovery');
      if (!code) { code = newRecoveryCode(); ql.state.set('sharing.recovery', code); }
      session = await mod.createSharingSession({
        api: ql.apiUrl, fetch: ql.fetch, tokenProvider: () => ql.token(), headers: ql.origin ? { origin: ql.origin } : {},
        contributor: ql.contributor(), contributorKeyRaw: key.publicKeyRaw, recoveryHash: await recoveryHash(code), inputSampleRate: tf.sampleRate, inputRoute: 'unknown',
        decodeInfo: { model_revision: ql.modelRevision || null, backend: 'exact', weights_sha256: null, sdk_version: '2.0.0' },
        consentVersion: deck.consentVersion, device: ql.telemetry.device, flags: ql.flags,
        ...(ql.sharingBitrate ? { bitrate: ql.sharingBitrate } : {}),
      });
      ctl.outbox = mod.outbox || ctl.outbox;
      return session;
    }).catch((e) => { ql.reportIssue('other', 'sharing_start:' + (e.code || 'error')); return null; }));
    const push = s.pushAudio, finish = s.finish, free = s.free;
    s.pushAudio = (pcm) => {
      const k = push(pcm);
      if (state.sharing) { const copy = pcm.slice(); begin().then((x) => x && x.push(copy)); }
      return k;
    };
    s.finish = () => {
      const k = finish();
      if (starting) begin().then((x) => x && x.finish()).then(() => { if (state.takeThanks() && typeof o.ask !== 'function') import('./element.js').then((m) => m.QuranLabConsent.thank({ lang })); });
      starting = null;
      return k;
    };
    s.free = () => { if (starting) begin().then((x) => x && x.finish()); starting = null; return free(); };
  };
  // the moment to ask: after a scored session (the learner saw feedback)
  const scored = ql.scored.bind(ql);
  ql.scored = (tf, r) => { scored(tf, r); ctl.sessionCompleted({ feedback: true }).catch(() => {}); };
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
