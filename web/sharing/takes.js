// Back-to-back takes share one recording (SDK 2.0.3, the same rules in every SDK; the shared vectors'
// takes_join.json is replayed by test/sharing_takes.test.mjs). A take is one model session; the RECORDING (the
// capture: its Ogg stream, outbox item and session id) is what is shared, and it is decoupled from the take:
// - When a take ends while sharing is on, its recording stays open for the JOIN WINDOW: the signed config's
//   `flags.share_join_ms` (a whole number 0 to 10000; absent or anything else: 3000; 0: never join).
// - A take that starts within the window (wall ms since the previous take with audio ended <= the window) at the
//   same input rate continues the same stream: no new headers, the encoder and the resampler keep their state (a
//   partial Opus frame left by the previous take is completed by the next take's first samples), granules and
//   page sequence continue, segments are cut by the same plan counted across takes, the bitrate ladder applies as
//   before. The gap gets no audio: the stream continues with the next take's first sample.
// - Otherwise the open recording closes as a 2.0.2 session ends (its last page with EOS, end.json) and the take
//   starts a new recording. Closed at once as well: the window expiring, the app going to the background, sharing
//   turned off (its queue deleted), and a recording that has reached 20 minutes of audio or 256 takes.
//   A crash leaves it open; recovery closes it at its last whole page at the next load (outbox.js).
// - end.json's `completed` is that of the last take with audio; the 2 s minimum of a partial session applies to
//   the recording's total audio; the session JSON is written once, at the first take (its input route, backend
//   and rate are the first take's), so a take under another contributor id, consent version (or consent text
//   hash) or model revision starts a new recording.
// - The takes of a recording: [{start_ms, gap_ms}] in order, start_ms the stream position of the take's first
//   sample (floor(1000 * input samples before it / input rate)), gap_ms the wall gap to the previous take rounded
//   to the nearest 100 (half up), the first {0, 0}. A take without audio adds no entry, nor does one whose
//   start_ms is not above the last entry's (its audio still joins). Kept in takes.json (rewritten as each take
//   joins, so recovery keeps it) and sent after the recording's last segment, POST /v1/uploads/{id}/takes
//   (outbox.js). A recording of one take has none.
// - The 20 minute cap, live (a take's length is unknown when it starts): with more than 30 s of room the take
//   joins at once and stays whole even when it runs past the cap (the recording then closes when it ends). With
//   30 s of room or less its audio is held in memory until it ends: it joins when the recording and the take
//   together stay within the cap, and when it outgrows the room the recording closes without it and the take
//   starts a new recording with the held audio.
// Tried and rejected: silence in the gap (made-up audio in training data); holding the upload until the recording
// closes so the session JSON could list the takes (a long recording would wait to upload, and its backlog would
// push the bitrate ladder down); cutting a take at the 20 minute mark (it would split a recitation, the thing
// joining is for); holding every joining take until it ends (a crash would lose it, and its segments would wait).

/** The join window when the config sets none (ms). */
export const DEFAULT_JOIN_MS = 3000;
/** The longest join window a config may set (ms). */
export const MAX_JOIN_MS = 10000;
/** A recording that has reached this much audio (ms) takes no further take. */
export const RECORDING_CAP_MS = 20 * 60 * 1000;
/** The most takes one recording holds (the server's take list takes at most this many). */
export const MAX_TAKES = 256;
/** With this much room or less under the cap (ms), a joining take's audio is held until the take ends. */
export const HOLD_MS = 30000;

/** The join window of a signed config's flags: `share_join_ms`, a whole number 0 to 10000; anything else
 * (absent, a boolean, a string, a fraction, a negative or larger number) is 3000. */
export function joinWindowMs(flags) {
  const v = flags && typeof flags === 'object' ? flags.share_join_ms : undefined;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_JOIN_MS ? v : DEFAULT_JOIN_MS;
}

/** Milliseconds of `samples` at `rate`, floored (a take's start in its recording's stream: the input samples
 * before it). */
export const takeStartMs = (samples, rate) => Math.floor(samples * 1000 / rate);

/** A wall gap (ms) rounded to the nearest 100, half up, within 0 to 10000 (a clock set backwards gives 0). */
export const roundGap = (ms) => Math.floor((Math.min(Math.max(ms, 0), MAX_JOIN_MS) + 50) / 100) * 100;

/** The longest lead-in before the first take that the server takes (ms; the SDK's own pre-roll is at most 1000). */
export const MAX_LEAD_MS = 5000;

/**
 * A take list as the server takes it, or null: 2 to MAX_TAKES entries, the first with gap_ms 0 and start_ms 0 or
 * its pre-roll (SDK 3.0.0: the feed's audio before the first take; 0 to 5000), start_ms whole and
 * strictly increasing, gap_ms 0 to 10000 in steps of 100. With `durationMs` (a recording recovered at its last
 * whole page), the takes that start at or after it are left out: none of their audio was kept.
 */
export function takeList(takes, durationMs = Infinity) {
  if (!Array.isArray(takes)) return null;
  const out = [];
  for (const t of takes) {
    if (!t || !Number.isInteger(t.start_ms) || !Number.isInteger(t.gap_ms)) return null;
    if (out.length === 0 ? t.start_ms < 0 || t.start_ms > MAX_LEAD_MS || t.gap_ms !== 0 : t.start_ms <= out[out.length - 1].start_ms) return null;
    if (t.gap_ms < 0 || t.gap_ms > MAX_JOIN_MS || t.gap_ms % 100 !== 0) return null;
    if (out.length > 0 && t.start_ms >= durationMs) break;
    out.push({ start_ms: t.start_ms, gap_ms: t.gap_ms });
  }
  return out.length >= 2 && out.length <= MAX_TAKES ? out : null;
}

/** The exact body of POST /v1/uploads/{id}/takes, also what takes.json holds: {"takes":[{"start_ms","gap_ms"}]}. */
export const takesBody = (takes) => JSON.stringify({ takes: takes.map((t) => ({ start_ms: t.start_ms, gap_ms: t.gap_ms })) });
