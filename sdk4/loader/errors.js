// An error that crossed from the engine Worker ({ code, message, reason, cause }) as the SDK's TajweedError, with the
// cause the frame made where it reported the failure as its errorCause (4.0.2, ERRORS_40.md 24.13).
import { TajweedError, ERROR_CODES, toTajweedError, setErrorCause } from '../../web/api/errors.js';

export function errorFrom(e, fallback = 'engine_failed') {
  if (e instanceof TajweedError) return e;
  if (e && typeof e.code === 'string' && ERROR_CODES.includes(e.code)) {
    const t = new TajweedError(e.code, { detail: e.message || '' });
    if (e.reason) t.reason = e.reason;
    if (e.qlCause && typeof e.qlCause === 'object') setErrorCause(t, e.qlCause);
    return t;
  }
  return toTajweedError(e, { fallback, sdk: '4.0.3' });
}
