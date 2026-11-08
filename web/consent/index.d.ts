// Types for @quran-lab/tajweedformer/consent: the recitation sharing experience (SHARING_EXPERIENCE.md).
import type { QuranLab, StateStore } from '../platform/index.js';

export type AskVariant = 'first' | 'reask' | 'version';
export interface Ask { variant: AskVariant; guardian: boolean }
export interface Answer { yes: boolean; guardianConfirmed?: boolean }

export declare const MAX_ASKS: 3;
export declare const REASK_GAP: 7;

export declare class SharingState {
  constructor(state: StateStore, o?: { enabled?: () => boolean; consentVersion?: string; audience?: string; clock?: () => number });
  /** uploads may run: allowed by the app and the signed config, and the learner said yes */
  readonly sharing: boolean;
  readonly guardianVariant: boolean;
  /** a session ended; the ask due now, or null */
  sessionCompleted(o?: { feedback?: boolean }): Ask | null;
  askNow(): Ask;
  answer(yes: boolean, o?: { guardianConfirmed?: boolean }): 'granted' | 'declined' | 'final';
  setSharing(on: boolean, o?: { guardianConfirmed?: boolean }): void;
  takeThanks(): boolean;
  onChange(f: (s: object) => void): () => void;
}

/** A copy deck (quranlab.sharing-copy/1) for one language. */
export interface Deck {
  lang: string; dir: 'ltr' | 'rtl'; version: string; consentVersion: string; deleteDays: number;
  hadithSource: { collection: string; number: number; url: string; translation_source: string | null; translated: boolean } | null;
  /** a string by key ({days} filled); English when this deck lacks it */
  t(key: string): string;
  /** the plural impact line for real shared minutes */
  minutes(n: number): string;
}
export declare const EN: Readonly<{ format: string; version: string; lang: string; dir: string; consent_version: string; strings: Record<string, unknown> }>;
export declare function copyFor(lang?: string): Deck;
export declare function registerDeck(lang: string, deck: { format: 'quranlab.sharing-copy/1'; [k: string]: unknown }): void;
export declare function languages(): string[];

export interface SharingController {
  lang: string;
  state: SharingState;
  deck: Deck;
  sessionCompleted(o?: { feedback?: boolean }): Promise<Answer | null>;
  setSharing(on: boolean, o?: { guardianConfirmed?: boolean }): void;
  /** "Delete what I shared": signed with this install's device key (no app credential can delete) */
  deleteShared(): Promise<{ accepted: boolean; sessionsLeft: number | null }>;
  /** "Show my recovery code": for the learner only */
  recoveryCode(): string | null;
  rotateContributor(): Promise<void>;
  impactLine(): Promise<string | null>;
}

/** Turn on the sharing experience for a configured client (contributions: true). */
export declare function enableSharing(ql: QuranLab, o?: { lang?: string; ask?: 'auto' | ((a: Ask) => Promise<Answer>); idle?: () => boolean }): SharingController;
export declare function deleteWithKey(ql: QuranLab, key: import('../platform/index.js').ContributorKey): Promise<{ accepted: boolean; sessionsLeft: number | null }>;

/** The web components (import '@quran-lab/tajweedformer/consent/element' or let enableSharing load them). */
export declare class QuranLabConsent extends HTMLElement {
  static ask(o?: { lang?: string; variant?: AskVariant; guardian?: boolean; parent?: Element }): Promise<{ yes: boolean; guardianConfirmed: boolean }>;
  static thank(o?: { lang?: string; parent?: Element; ms?: number }): HTMLElement;
  show(o?: { lang?: string; variant?: AskVariant; guardian?: boolean }): Promise<{ yes: boolean; guardianConfirmed: boolean }>;
}
export declare class QuranLabSharingSettings extends HTMLElement {
  controller: SharingController;
}
