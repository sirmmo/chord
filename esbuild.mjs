// Build script: bundles the main process, the preload bridge and the two UI pages.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync, watch } from 'node:fs';

const watchMode = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: ['es2022'] };

const node = (entry, outfile) => ({ ...common, entryPoints: [entry], outfile, platform: 'node', format: 'cjs', packages: 'external' });

const configs = [
  node('src/main/index.ts', 'dist/main.js'),
  node('src/preload/index.ts', 'dist/preload.js'),
  node('src/preload/page.ts', 'dist/page-preload.js'),
  { ...common, entryPoints: ['src/page/sourceror.ts'], outfile: 'dist/sourceror.js', platform: 'browser', format: 'iife' },
  { ...common, entryPoints: ['src/renderer/sidebar.ts', 'src/renderer/palette.ts', 'src/renderer/downloads.ts', 'src/renderer/settings.ts', 'src/renderer/history.ts', 'src/renderer/bookmarks.ts', 'src/renderer/reader.ts', 'src/renderer/little.ts', 'src/renderer/notes.ts', 'src/renderer/guide.ts', 'src/renderer/panel.ts'], outdir: 'dist/renderer', platform: 'browser', format: 'iife' },
];

function copyStatic() {
  mkdirSync('dist/renderer', { recursive: true });
  cpSync('src/renderer/static', 'dist/renderer', { recursive: true });
  writeLicenses();
}

// Credits for the About page: every production dependency, transitively, and the build tools.
function readPkg(name) {
  try {
    return JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8'));
  } catch {
    return null;
  }
}
function describe(name) {
  const p = readPkg(name);
  if (!p) return null;
  const repo = typeof p.repository === 'string' ? p.repository : p.repository?.url ?? '';
  const url = p.homepage || repo.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '') || `https://www.npmjs.com/package/${name}`;
  return { name, version: p.version, license: p.license ?? p.licenses?.[0]?.type ?? 'unknown', url, deps: Object.keys(p.dependencies ?? {}) };
}
function writeLicenses() {
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
  const runtime = new Map();
  const visit = (name) => {
    if (runtime.has(name)) return;
    const d = describe(name);
    if (!d) return;
    runtime.set(name, d);
    d.deps.forEach(visit);
  };
  Object.keys(root.dependencies ?? {}).forEach(visit);
  const tools = ['electron', 'electron-builder', 'esbuild', 'typescript'].map(describe).filter(Boolean);
  const strip = ({ deps, ...rest }) => rest;
  writeFileSync('dist/renderer/licenses.json', JSON.stringify({ runtime: [...runtime.values()].map(strip), tools: tools.map(strip) }));
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
