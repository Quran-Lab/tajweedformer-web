// An error that crossed from the engine Worker ({ code, message, reason }) as the SDK's TajweedError.
import { TajweedError, ERROR_CODES, toTajweedError } from '../../web/api/errors.js';

export function errorFrom(e, fallback = 'engine_failed') {
  if (e instanceof TajweedError) return e;
  if (e && typeof e.code === 'string' && ERROR_CODES.includes(e.code)) {
    const t = new TajweedError(e.code, { detail: e.message || '' });
    if (e.reason) t.reason = e.reason;
    return t;
  }
  return toTajweedError(e, { fallback, sdk: '4.0.1' });
}
