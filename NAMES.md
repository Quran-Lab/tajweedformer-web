# Public names of the web SDK 4.0 (API 4)

Every public type and function, and nothing else. The names are the four SDKs';
`reportRecited`'s `outcome` and `perAyah` are contract draft 17.9. The same objects are reached two ways:

- the hosted loader `https://web.quranlab.ai/4/loader.js` sets `globalThis.QuranLab` (and `QuranLab.v4`);
- the npm package `@quran-lab/tajweedformer` 4.x exports the same names and loads that loader on first use.

## Entry points

| Name | Where | What |
|---|---|---|
| `QuranLab.api` | loader | `4` |
| `QuranLab.version` | loader | `"4.0.0"` (the loader's version; the engine's is in `diagnose().sdk.engine`) |
| `QuranLab.v4` | loader | the same object, by API number |
| `LOADER_URL` | npm | `"https://web.quranlab.ai/4/loader.js"` |
| `API` | npm | `4` |
| `loadQuranLab({ src?, integrity? })` | npm | loads the loader once (a pinned URL and its SRI value); resolves with `QuranLab.v4` |

## Classes

| Class | Members |
|---|---|
| `TajweedClient` | `static create(options)`, `model(version?)`, `prefetch({ unmeteredOnly?, onProgress?, version? })`, `storage()`, `removeModels()`, `diagnose()`, `sharing`, `analytics`, `pin`, `background()`, `foreground()`, `close()` |
| `TajweedModel` | `id`, `version`, `build`, `contexts`, `defaultContext`, `chunkMs(context?)`, `tokens`, `calibration`, `reference` (null in 4.0.0), `sampleClips`, `backend`, `listen(options?)`, `session(options?)`, `close()` |
| `TajweedSession` | `push(samples)`, `chunks`, `events`, `finish()`, `cancel()`, `backend`, `reportRecited(surah, ayahFrom, ayahTo, { outcome?, perAyah? }?)` |
| `TajweedHeads` | `names`, `get(name)`, `greedy(name?)`, `decoded()` |
| `TajweedError` | `code`, `message`, `fix`, `docs` (the catalogue's 26 codes) |
| `Microphone` | `static open()`, `sampleRate`, `samples()`, `close()` |

`TajweedModel`, `TajweedSession` and `TajweedHeads` are made by the SDK only (`client.model()`, `model.listen()`,
`model.session()`, `session.finish()`); their constructors refuse anything else.

## Objects on the classes

| Name | Members |
|---|---|
| `client.analytics` (`TajweedAnalytics`) | `reportChecks(rule, checked, flagged)` |
| `client.sharing` (`TajweedSharing`) | `isAvailable`, `isOn`, `setOn(on)`, `ask()`, `feed(samples, sampleRate)`, `items()`, `summary()`, `delete()`, `recoveryCode`, `setWording(overrides)` |
| `model.tokens` (`TajweedTokens`) | `count`, `blank`, `wordBar`, `name(id)`, `id(name)` |
| `model.calibration` (`TajweedCalibration`) | `format`, `sha256`, `text`, `json`, `contexts`, `classes`, `presets`, `context(name)`, `threshold(context, cls, preset)` |
| `model.sampleClips[i]` (`TajweedClip`) | `name`, `kind`, `durationMs` |

## Custom elements (defined by the loader's sharing chunk when a Client starts)

| Element | Class (`customElements.get(...)`) | Members |
|---|---|---|
| `<quranlab-consent>` | `QuranLabConsent` | the SDK's consent sheet, the same in every app, shown by the SDK when an ask is due under its rules: every learner is asked, and the choice is theirs |
| `<quranlab-sharing-settings>` | `QuranLabSharingSettings` | `client` (set it to the TajweedClient): the switch, what is shared, delete, the recovery code |

## Plain data types (TypeScript, `web/index.d.ts`)

`TajweedClientOptions` (`key`, `appVersion?`, `appId?` (Node only: the desktop key's app id, required there),
`storage?`, `threads?`: `'off'` by default or `'auto'`),
`TajweedSessionOptions` (`context?`, `sampleRate?`, `heads?`, `backend?`, `topK?`, `endOnSilenceMs?`, `pace?`,
`onChunk?`, `onEvent?`), `TajweedChunk`, `TajweedEvent`, `TajweedDecoded`, `TajweedToken`, `TajweedWord`,
`TajweedFrame`, `TajweedHead`, `TajweedBackend`, `TajweedDiagnosis`, `TajweedReference`, `RecitedOutcome`
(`{ correct: true }` or `{ correct: false, mistakes?, rules? }`), `TajweedErrorCode`.

## Changed from 3.x

- New: `loadQuranLab`, `LOADER_URL`, `API`, `QuranLab.*`, `TajweedClientOptions.threads`, `RecitedOutcome`,
  `reportRecited`'s fourth argument, `diagnose().sdk.engine`, `diagnose().sdk.core`, `diagnose().lease`.
- Node ships in 4.0: `@quran-lab/tajweedformer/node` (and the package's `node` condition) runs the same API for a
  desktop app, with a desktop key and `TajweedClientOptions.appId`, in a worker thread with no frame; its lease is a
  desktop app's, 24 hours, kept in the storage folder across runs.
- Gone: the `analytics` and `audience` options of `TajweedClientOptions` (an `analytics` or `audience` key passed from
  JavaScript, whatever its value, is `invalid_argument`; see docs/migrating-to-4.md). `client.sharing.ask()` resolves
  with `{ yes }` alone.
- Gone from the web package: `model.reference` data. The two sharing elements are no longer module exports: they
  are defined by name.
- Unchanged: every other name and meaning above.
