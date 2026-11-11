// @quran-lab/tajweedformer/node: Node only. A model folder on disk as a reader for TajweedModel.open.
//   import { TajweedModel } from '@quran-lab/tajweedformer';
//   import { dirReader } from '@quran-lab/tajweedformer/node';
//   const model = await TajweedModel.open(dirReader('models/sdk/v4.0'));
export { dirReader } from './tajweed/node.js';
