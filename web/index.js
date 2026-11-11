// @quran-lab/tajweedformer: TajweedFormer for browsers and Node, a pure inference SDK. The exact engine in
// WebAssembly (bit-identical to the native engine; in a Worker in browsers), verified model delivery, every
// head of the network, the decoded layer, and the link to Quran Lab (signed config, telemetry, opt-in sharing).
//
//   import { TajweedClient } from '@quran-lab/tajweedformer';
//   const client = await TajweedClient.create({ key: 'qlk_v1_...' });
//   const model = await client.model();
//   const session = await model.listen({ endOnSilenceMs: 1500 });
//   for await (const chunk of session.chunks) console.log(chunk.decoded.text);
//
// This is the whole public surface. Everything else under web/ is internal and may change in any release.
export { TajweedClient } from './api/client.js';
export { TajweedModel } from './api/model.js';
export { TajweedSession } from './api/session.js';
export { TajweedHeads } from './api/heads.js';
export { TajweedError } from './api/errors.js';
export { Microphone } from './api/microphone.js';
// the sharing UI components (custom elements; each takes the Client: element.client = client)
export { QuranLabConsent, QuranLabSharingSettings } from './consent/element.js';
