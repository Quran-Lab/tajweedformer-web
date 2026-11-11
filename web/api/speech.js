// Speech and silence from the model's own output (SPEC 6.2 and 13.2; the shared vector speech.json). One
// definition for everything that says "speech": the events, chunk.speech and the telemetry sums.
//
// A 40 ms frame f is ACTIVE when the greedy id of log_probs is non-blank on it, or the greedy id of
// timing_log_probs is non-blank on one of its two 20 ms frames (2f and 2f + 1). The CTC head shows a sound on
// a few frames and blank while the sound is held; the timing head holds the sound's id for as long as it
// sounds, so a held vowel (a madd lasts seconds) stays active. A speech frame is an active frame; there is no
// padding around a token. No energy threshold, no rule about the recitation: only where the model heard something.
//
// The tracker is fed each chunk's greedy ids of both heads as they arrive and gives: whether the chunk holds
// an active frame, the speechStarted and speechEnded events, and the take's speech and silence frame counts.
import { BLANK, VOCAB } from '../tajweed/heads.js';

/** The silence after speech that raises speechEnded when the app set no endOnSilenceMs. */
export const DEFAULT_SILENCE_MS = 1500;
/** The range of the endOnSilenceMs option (0 or null: off). */
export const MIN_SILENCE_MS = 500;
export const MAX_SILENCE_MS = 60000;
export const FRAME_MS = 40;
/** The heads whose greedy ids decide whether a frame is active. */
export const ACTIVE_HEADS = Object.freeze(['log_probs', 'timing_log_probs']);

/** The greedy id of every row of a CTC head's values ([frames x 38]): the largest value, the lowest id on ties. */
export function greedyIds(values) {
  const n = Math.floor(values.length / VOCAB);
  const out = new Array(n);
  for (let f = 0; f < n; f++) {
    let best = 0, v = values[f * VOCAB];
    for (let i = 1; i < VOCAB; i++) { const x = values[f * VOCAB + i]; if (x > v) { v = x; best = i; } }
    out[f] = best;
  }
  return out;
}

/** Active (true) or inactive per 40 ms frame: `ids` of log_probs (one per frame), `timing` of timing_log_probs (two per frame). */
export function activeFrames(ids, timing) {
  return ids.map((id, f) => id !== BLANK || (timing[2 * f] || BLANK) !== BLANK || (timing[2 * f + 1] || BLANK) !== BLANK);
}

/**
 * The timing of speechEnded, in one place (a change of the rule is a change of this function): with `last` the
 * last active frame and a silence window of `windowMs`, the event is raised when frame `trigger` arrives, every
 * frame after `last` being inactive: W = ceil(window / 40) inactive frames in a row. `atMs` is the end of the
 * last active frame; `silenceMs` is the window in whole frames.
 */
export function speechEndedTiming(last, windowMs) {
  const w = Math.ceil(windowMs / FRAME_MS);
  return { trigger: last + w, atMs: FRAME_MS * (last + 1), silenceMs: FRAME_MS * w };
}

export class SpeechTracker {
  /** @param {number} windowMs  the silence after speech that raises speechEnded */
  constructor(windowMs = DEFAULT_SILENCE_MS) {
    this.windowMs = windowMs;
    this.frames = 0;
    this.active = 0;
    this.last = -1; // the last active frame
    this.speaking = false;
    this.ending = null; // speechEndedTiming(last) while speaking
  }

  /**
   * The next chunk: the greedy ids of log_probs (one per 40 ms frame) and of timing_log_probs (two per frame).
   * Returns { speech, events }: whether the chunk holds an active frame, and the events its frames raised, in order.
   */
  feed(ids, timing) {
    const events = [];
    let speech = false;
    const act = activeFrames(ids, timing);
    for (let i = 0; i < ids.length; i++) {
      const t = this.frames++;
      if (act[i]) {
        speech = true;
        this.active++;
        if (!this.speaking) { this.speaking = true; events.push({ type: 'speechStarted', atMs: FRAME_MS * t }); }
        this.last = t;
        this.ending = speechEndedTiming(t, this.windowMs);
      } else if (this.speaking && t === this.ending.trigger) {
        this.speaking = false;
        events.push({ type: 'speechEnded', atMs: this.ending.atMs, silenceMs: this.ending.silenceMs });
      }
    }
    return { speech, events };
  }

  /** The take's speech (active) and silence (inactive) frame counts, over every frame fed. */
  counts() { return { speech: this.active, silence: this.frames - this.active }; }
}
