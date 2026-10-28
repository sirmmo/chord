import { app } from 'electron';
import { join } from 'node:path';

// dist/main.js lives next to preload.js and the renderer/ folder.
export const DIST = __dirname;
export const PRELOAD = join(DIST, 'preload.js');
export const PAGE_PRELOAD = join(DIST, 'page-preload.js');
export const RENDERER_DIR = join(DIST, 'renderer');
/** Easel images: PNG snapshots and pasted pictures, served as chord://easel/images/<file>. */
export const EASEL_IMAGES_DIR = join(app.getPath('userData'), 'easels');
