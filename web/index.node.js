// @quran-lab/tajweedformer in Node (the "node" condition of the package's exports): the same API as web/index.js,
// with Node's parts given to the SDK through web/platform/node-hook.js: files and folders for its state, the
// model cache and the sharing queue, and the wasm files read from dist/. A browser
// bundler resolves the package to web/index.js and never follows this file.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirStore } from './tajweed/node.js';
import { setNode } from './platform/node-hook.js';

setNode({ fs, fsp, path, os, dirStore, execFileSync, wasm: async (name) => new Uint8Array(await fsp.readFile(new URL(`../dist/${name}`, import.meta.url))) });

export * from './index.js';
