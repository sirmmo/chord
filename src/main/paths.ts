import { join } from 'node:path';

// dist/main.js lives next to preload.js and the renderer/ folder.
export const DIST = __dirname;
export const PRELOAD = join(DIST, 'preload.js');
export const RENDERER_DIR = join(DIST, 'renderer');
