// Build script: bundles the main process, the preload bridge and the two UI pages.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, watch } from 'node:fs';

const watchMode = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: ['es2022'] };

const node = (entry, outfile) => ({ ...common, entryPoints: [entry], outfile, platform: 'node', format: 'cjs', packages: 'external' });

const configs = [
  node('src/main/index.ts', 'dist/main.js'),
  node('src/preload/index.ts', 'dist/preload.js'),
  { ...common, entryPoints: ['src/renderer/sidebar.ts', 'src/renderer/palette.ts'], outdir: 'dist/renderer', platform: 'browser', format: 'iife' },
];

function copyStatic() {
  mkdirSync('dist/renderer', { recursive: true });
  cpSync('src/renderer/static', 'dist/renderer', { recursive: true });
}

copyStatic();
if (watchMode) {
  const ctxs = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
  watch('src/renderer/static', { recursive: true }, () => copyStatic());
  console.log('watching…');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
