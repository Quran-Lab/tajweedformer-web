/** Node only: a model folder on disk as a reader for TajweedModel.open; paths that would leave it are never read. */
export declare function dirReader(dir: string): { read(path: string): Promise<Uint8Array | null> };
