// @quran-lab/tajweedformer/platform: the Quran Lab platform client:
// key, token, register, the signed config, telemetry v2 (on by default, anonymous), issues.
//   import { QuranLab } from '@quran-lab/tajweedformer/platform';
export { QuranLab, PlatformError, verifySignedConfig, keyId, SDK_VERSION, API_URL, CDN_URL, DELTA_INTERVAL_MS } from './client.js';
export { Telemetry, bucket, utcDay, deviceInfo, COUNTERS, newReportId } from './telemetry.js';
export { memoryState, localState, dirState } from './storage.js';
export { compareVersions, sdkLatestOf, noticeSdkLatest, isDevelopment, resetSdkLatestNoticeForTests } from './update-notice.js';
export { contributorKey, forgetContributorKey, recoveryCodeFromBytes, normaliseRecoveryCode, recoveryHash, newRecoveryCode, deletionMessage, b64url } from './contributor-key.js';
