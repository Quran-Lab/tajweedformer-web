import type { FolderReader } from './index.js';
/** Node only: a model folder on disk; paths that would leave it are never read. */
export declare function dirReader(dir: string): FolderReader;
