// The options of 3.x that 4.0 removed, not deprecated and not kept as no-ops: the TypeScript types have no such field,
// so typed code that sets one does not build, and plain JavaScript that passes one, whatever its value, is refused at
// once with invalid_argument. The message names the option, says why it was removed and points to the migration
// guide. A key that is read and ignored would let a developer believe it still does something.
// - `analytics` (ANALYTICS_40 22.2; owner, 11-16): the anonymous analytics are always on in 4.0.
// - `audience` (ONE_SHEET_40 26.1; owner, 11-19): every app shows the same sharing sheet under the same ask rules;
//   there is no other sheet for an app to select.
import { invalid } from '../../web/api/errors.js';

export const ANALYTICS_REMOVED = 'the analytics option was removed in SDK 4.0 because the anonymous analytics are '
  + 'always on (daily counts and durations only, never audio, text, names or device identifiers): delete it; see '
  + 'docs/migrating-to-4.md';

export const AUDIENCE_REMOVED = 'the audience option was removed in SDK 4.0 because every app shows the same sharing '
  + 'sheet: delete it; see docs/migrating-to-4.md';

const REMOVED = Object.freeze({ analytics: ANALYTICS_REMOVED, audience: AUDIENCE_REMOVED });
/** The option names 4.0 refuses. */
export const REMOVED_OPTIONS = Object.freeze(Object.keys(REMOVED));

/** Throws invalid_argument when `options` carries a key of a removed option (`names`, default all), whatever its value. */
export function refuseRemovedOptions(options, names = REMOVED_OPTIONS) {
  if (!options || typeof options !== 'object') return;
  for (const k of names) if (k in options) throw invalid(REMOVED[k]);
}
