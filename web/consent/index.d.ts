// Types for @quran-lab/tajweedformer/consent: the recitation sharing experience (SHARING_EXPERIENCE.md).
import type { QuranLab, StateStore } from '../platform/index.js';

/** 'first', or 'reask' after "Not now". 'version' is deprecated and never produced since 2.0.1: a grant is kept
 * across decks and wordings and is never asked about again. */
export type AskVariant = 'first' | 'reask' | 'version';
export interface Ask { variant: AskVariant; guardian: boolean }
export interface Answer { yes: boolean; guardianConfirmed?: boolean }

/** sheets shown in all per install, ever (the first ask and at most two re-asks after "Not now") */
export declare const MAX_ASKS: 3;
/** sessions between asks */
export declare const REASK_GAP: 7;
/** the consent version a 2.0.0 grant stored without a version was given to (the deck 2.0.0 bundled) */
export declare const LEGACY_CONSENT_VERSION: 'share-2026-11-07';
/** the StateStore key of the sharing state (the same since 2.0.0) */
export declare const SHARING_STATE_KEY: 'sharing.v1';

export declare class SharingState {
  constructor(state: StateStore, o?: { enabled?: () => boolean; consentVersion?: string; consentTextSha256?: string | null; audience?: string; clock?: () => number });
  /** uploads may run: allowed by the signed config, and the learner said yes (to whichever version) */
  readonly sharing: boolean;
  readonly guardianVariant: boolean;
  /** asking has not ended: no yes, not turned off, fewer than MAX_ASKS sheets shown */
  readonly asking: boolean;
  /** the version a new grant records */
  readonly consentVersion: string | null;
  readonly consentTextSha256: string | null;
  /** the version the current grant was given to, as recorded then (null when not granted) */
  readonly grantVersion: string | null;
  /** the hash of the own wording the current grant was given to (null for a deck's wording or when not sharing) */
  readonly grantTextSha256: string | null;
  /** the version a new grant records; an existing grant keeps its own and is not asked again */
  setConsent(version: string, textSha256?: string | null): void;
  /** a session ended; the ask due now (counted as shown), or null */
  sessionCompleted(o?: { feedback?: boolean }): Ask | null;
  /** the app's own timing: an ask counted as shown, or null once asking has ended */
  askNow(): Ask | null;
  answer(yes: boolean, o?: { guardianConfirmed?: boolean }): 'granted' | 'declined' | 'final';
  setSharing(on: boolean, o?: { guardianConfirmed?: boolean }): void;
  takeThanks(): boolean;
  onChange(f: (s: object) => void): () => void;
}

/** A copy deck (quranlab.sharing-copy/1) for one language, with any own wording applied. */
export interface Deck {
  lang: string; dir: 'ltr' | 'rtl'; version: string; consentVersion: string; deleteDays: number;
  /** 'immediate' since deck 2026-11-09.1 */
  deleteTiming: string;
  /** the keys the app's own wording replaces */
  overridden: string[];
  hadithSource: { collection: string; number: number; url: string; translation_source: string | null; translated: boolean } | null;
  /** a string by key: the app's own wording, else this deck's, else English */
  t(key: string): string;
  /** the plural impact line for real shared minutes */
  minutes(n: number): string;
}
export declare const EN: Readonly<{ format: string; version: string; lang: string; dir: string; consent_version: string; strings: Record<string, unknown> }>;
export declare function copyFor(lang?: string, overrides?: Record<string, string> | null): Deck;

/** An app's own wording ({deck key: text}); plural lines as `impact.minutes.<category>`. */
export type Wording = Record<string, string>;
/** The consent a grant is to: the deck's version, or custom-<24 hex> with the text's SHA-256 and canonical text. */
export interface Consent { version: string; textSha256: string | null; canonicalText: string | null }
export declare const CONSENT_TEXT_FORMAT: 'quranlab.consent-text/1';
export declare const PLURAL_CATEGORIES: readonly string[];
/** checks overrides; throws a TypeError for an unknown key or an empty or blank text */
export declare function validateWording(overrides: Wording | null | undefined): Readonly<Wording>;
export declare function canonicalConsentText(base: string, overrides: Wording | null): string | null;
export declare function deriveConsent(base: string, overrides: Wording | null): Consent;
export declare function wordingKeys(): Set<string>;
export declare function sha256HexSync(bytes: Uint8Array): string;

/** The look of the SDK's sheets (consent, guardian, thanks, settings): CSS values; a number cornerRadius is px. */
export interface SharingTheme {
  accent?: string; accentText?: string; background?: string; text?: string; secondaryText?: string;
  cornerRadius?: string | number; titleFont?: string; bodyFont?: string;
}
export declare const THEME_PROPERTIES: Readonly<Record<keyof SharingTheme, string>>;
export declare function themeProperties(theme: SharingTheme | null | undefined): Record<string, string>;
export declare function applyTheme<E extends { style: CSSStyleDeclaration }>(el: E, theme: SharingTheme | null | undefined): E;

/** What an app's own UI receives: show its own sheet with `copy`, then answer from the learner's tap. */
export interface OwnAsk extends Ask { lang: string; copy: Deck; consentVersion: string }
export declare function registerDeck(lang: string, deck: { format: 'quranlab.sharing-copy/1'; [k: string]: unknown }): void;
export declare function languages(): string[];

export interface SharingController {
  lang: string;
  state: SharingState;
  /** the copy with the app's own wording applied (the same as copy) */
  readonly deck: Deck;
  readonly copy: Deck;
  /** the consent a new grant records; send textSha256 or canonicalText to Quran Lab for a review of your wording */
  readonly consent: Consent;
  readonly wording: Readonly<Wording>;
  readonly theme: SharingTheme | null;
  /** replace deck strings (null or {} restores the deck); a TypeError for a bad key or text, nothing changes then */
  setWording(wording: Wording | null): Consent;
  setTheme(theme: SharingTheme | null): void;
  /** the ask an app's own UI has not answered yet */
  readonly pendingAsk: OwnAsk | null;
  /** the learner's answer, from their own tap (default sheet and own UI); after a yes or a switch turned off it changes nothing */
  answer(yes: boolean, o?: { guardianConfirmed?: boolean }): 'granted' | 'declined' | 'final';
  sessionCompleted(o?: { feedback?: boolean }): Promise<Answer | null>;
  setSharing(on: boolean, o?: { guardianConfirmed?: boolean }): void;
  /** 2.0.3: the app went to the background: the shared recording that takes in a row keep open closes now (the
   * platform client calls it when the page is hidden) */
  background(): Promise<void>;
  /** 2.0.3: the app is in the foreground again */
  foreground(): Promise<void>;
  /** 2.0.3: no take follows: the open recording closes now instead of at the end of its join window */
  closeRecording(): Promise<void>;
  /** "Delete what I shared": signed with this install's device key (no app credential can delete) */
  deleteShared(): Promise<{ accepted: boolean; sessionsLeft: number | null }>;
  /** "Show my recovery code": for the learner only */
  recoveryCode(): string | null;
  rotateContributor(): Promise<void>;
  impactLine(): Promise<string | null>;
}

/** Wire the sharing experience for a configured client (the SDK also does it when a model attaches in a page). */
export declare function enableSharing(ql: QuranLab, o?: { lang?: string; ask?: 'auto' | ((a: OwnAsk) => Promise<Answer | null | void>); idle?: () => boolean;
  wording?: Wording | null; theme?: SharingTheme | null }): SharingController;
export declare function deleteWithKey(ql: QuranLab, key: import('../platform/index.js').ContributorKey): Promise<{ accepted: boolean; sessionsLeft: number | null }>;

/** The web components (import '@quran-lab/tajweedformer/consent/element' or let enableSharing load them). */
export declare class QuranLabConsent extends HTMLElement {
  static ask(o?: { lang?: string; variant?: AskVariant; guardian?: boolean; parent?: Element; wording?: Wording | null; theme?: SharingTheme | null }): Promise<{ yes: boolean; guardianConfirmed: boolean }>;
  static thank(o?: { lang?: string; parent?: Element; ms?: number; wording?: Wording | null; theme?: SharingTheme | null }): HTMLElement;
  show(o?: { lang?: string; variant?: AskVariant; guardian?: boolean; wording?: Wording | null; theme?: SharingTheme | null }): Promise<{ yes: boolean; guardianConfirmed: boolean }>;
}
export declare class QuranLabSharingSettings extends HTMLElement {
  controller: SharingController;
}
