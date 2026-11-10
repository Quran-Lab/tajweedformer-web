// The adaptive Opus bitrate of shared sessions (SDK 2.0.1, the same ladder in every SDK; the shared vectors'
// bitrate_ladder.json is replayed by test/sharing_bitrate.test.mjs). One ladder per sharing pipeline (per page or
// process), in memory, starting at the top rung:
//   uploadFailed()          a network failure of an upload request (no connection, timeout, HTTP 408 or 5xx on
//                           POST /v1/uploads, POST /v1/uploads/{id}/urls or a segment PUT): one rung down
//   uploadOk(backlogS)      a segment PUT answered 2xx, backlogS seconds of closed audio still waiting after it:
//                           three in a row with backlogS <= 30 step one rung up
//   segmentClosed(backlogS) a capture closed a segment, backlogS seconds of closed audio waiting (this segment
//                           included, every session of the outbox): at 120 or more, one rung down
// The encoder takes the ladder's bitrate when a segment opens (oggopus.js OggOpusWriter `bitrate`), so a
// segment has one bitrate, kept in its marker.
// Tried and rejected: changing the bitrate mid-segment (a segment would have no single bitrate to record);
// keeping the rung across page loads (a stale bad network would cost quality on a good one); a floor below
// 32 kbit/s (the log-mel features the model reads drift 1.60 dB at 24k and 2.48 at 16k against 1.17 at 32k,
// for about 0.07 MB a minute saved per step).

/** The rungs, bit/s, top first. */
export const BITRATE_RUNGS = Object.freeze([192000, 96000, 64000, 32000]);
/** Successes in a row that step one rung up. */
export const UP_STREAK = 3;
/** The most closed audio (s) still waiting that allows a step up. */
export const UP_MAX_BACKLOG_S = 30;
/** Closed audio (s) waiting when a segment closes that steps one rung down. */
export const DOWN_BACKLOG_S = 120;

export class BitrateLadder {
  constructor() {
    this.rung = 0;
    this.streak = 0;
    this.listeners = new Set();
  }

  /** The bit rate the next segment is encoded at. */
  get bitrate() { return BITRATE_RUNGS[this.rung]; }

  /** Called with the new bitrate whenever it changes; returns the unsubscribe function. */
  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }

  _set(rung) {
    if (rung === this.rung) return;
    this.rung = rung;
    for (const f of this.listeners) { try { f(this.bitrate); } catch (_) { /* a listener's own problem */ } }
  }

  uploadFailed() {
    this.streak = 0;
    this._set(Math.min(this.rung + 1, BITRATE_RUNGS.length - 1));
  }

  uploadOk(backlogS) {
    this.streak = Math.min(this.streak + 1, UP_STREAK);
    if (this.streak >= UP_STREAK && backlogS <= UP_MAX_BACKLOG_S && this.rung > 0) {
      this.streak = 0;
      this._set(this.rung - 1);
    }
  }

  segmentClosed(backlogS) {
    if (backlogS >= DOWN_BACKLOG_S) {
      this.streak = 0;
      this._set(Math.min(this.rung + 1, BITRATE_RUNGS.length - 1));
    }
  }
}

/** Whether an upload request's answer is a network failure for the ladder: no answer (status 0: no
 * connection, timeout, transport error), HTTP 408 or 5xx. Refusals (4xx, 429 volume limits, 403 on an
 * expired URL) are not. */
export const isNetworkFailure = (status) => status === 0 || status === 408 || (status >= 500 && status <= 599);
