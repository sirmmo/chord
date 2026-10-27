import { app, clipboard, dialog, shell } from 'electron';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { activeSpace, focusedTab } from '../shared/model.ts';
import { hostOf } from '../shared/url.ts';
import type { Controller } from './controller.ts';
import { isMac } from './platform.ts';
import { shieldsStatus } from './session.ts';

/**
 * Performance diagnostics for "Chord is slow" reports that cannot be reproduced
 * on the developer's machine. Help → Copy Diagnostics gathers everything below
 * into one text block: the environment, main-process event-loop stalls (which
 * also stall every network request once Shields is on, because Electron routes
 * them through the main process), recent page-load timings and the focused
 * page's own navigation timing.
 */

// ---- startup marks: milliseconds since the process was created ----

const marks: { name: string; ms: number }[] = [];
let firstPage = false;

export function mark(name: string): void {
  marks.push({ name, ms: Math.round(Date.now() - process.getCreationTime()!) });
}

export function markFirstPage(): void {
  if (firstPage) return;
  firstPage = true;
  mark('first-page-dom-ready');
}

// ---- main-process event-loop lag ----

const TICK_MS = 100;
const STALL_MS = 50;
let samples = 0;
let totalLag = 0;
let worstLag = 0;
const stalls: { at: number; ms: number }[] = [];

export function startLagMonitor(): void {
  let expected = performance.now() + TICK_MS;
  setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - expected);
    expected = now + TICK_MS;
    samples++;
    totalLag += lag;
    if (lag > worstLag) worstLag = lag;
    if (lag >= STALL_MS) {
      stalls.push({ at: Date.now(), ms: Math.round(lag) });
      if (stalls.length > 40) stalls.shift();
    }
  }, TICK_MS).unref();
}

// ---- page-load timings ----

interface Nav {
  tab: string;
  url: string;
  startedAt: number;
  domReady?: number;
  finished?: number;
  shields: boolean;
}

const navs: Nav[] = [];
const inFlight = new Map<string, Nav>();

export function navStarted(tab: string, url: string): void {
  const nav: Nav = { tab, url, startedAt: Date.now(), shields: shieldsStatus().enabled };
  inFlight.set(tab, nav);
  navs.push(nav);
  if (navs.length > 30) navs.shift();
}

export function navDomReady(tab: string): void {
  markFirstPage();
  const nav = inFlight.get(tab);
  if (nav && nav.domReady === undefined) nav.domReady = Date.now() - nav.startedAt;
}

export function navFinished(tab: string): void {
  const nav = inFlight.get(tab);
  if (!nav) return;
  if (nav.finished === undefined) nav.finished = Date.now() - nav.startedAt;
  inFlight.delete(tab);
}

// ---- report ----

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout, stderr) => resolve((err ? `${stdout}${stderr}`.trim() || err.message : `${stdout}${stderr}`).trim()));
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);
}

const PAGE_TIMING_JS = `(() => {
  const n = performance.getEntriesByType('navigation')[0];
  if (!n) return null;
  const paint = {};
  for (const e of performance.getEntriesByType('paint')) paint[e.name] = Math.round(e.startTime);
  return {
    host: location.host,
    ttfb: Math.round(n.responseStart),
    domInteractive: Math.round(n.domInteractive),
    domContentLoaded: Math.round(n.domContentLoadedEventEnd),
    load: Math.round(n.loadEventEnd),
    resources: performance.getEntriesByType('resource').length,
    paint,
  };
})()`;

async function signingInfo(): Promise<string> {
  if (!isMac || !app.isPackaged) return 'n/a';
  const bundle = dirname(dirname(dirname(app.getPath('exe'))));
  const [sign, quarantine] = await Promise.all([
    run('codesign', ['-dv', '--verbose=1', bundle]),
    run('xattr', ['-p', 'com.apple.quarantine', bundle]),
  ]);
  const authority = sign.split('\n').filter((l) => /Signature=|Authority=|TeamIdentifier=|flags=/.test(l)).join('; ') || sign.split('\n')[0];
  return `${authority || 'unsigned'} | quarantine: ${/No such xattr|does not exist/i.test(quarantine) ? 'no' : quarantine ? `yes (${quarantine})` : 'no'}`;
}

export async function collectDiagnostics(c: Controller): Promise<string> {
  const s = c.state;
  const space = activeSpace(s);
  const tabs = Object.values(s.tabs);
  const mem = process.getSystemMemoryInfo();
  const gpu = app.getGPUFeatureStatus() as unknown as Record<string, string>;
  const shields = shieldsStatus();
  const metrics = app.getAppMetrics();
  const rosetta = (isMac || process.platform === 'win32') && app.runningUnderARM64Translation;
  const focused = focusedTab(s);
  const wc = c.tabs.focusedView()?.webContents;
  const pageTiming =
    wc && !wc.isDestroyed()
      ? await withTimeout(wc.executeJavaScript(PAGE_TIMING_JS, true).catch((e: Error) => `error: ${e.message}`), 2000, 'timeout')
      : null;

  const lines: string[] = [];
  const push = (k: string, v: unknown) => lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

  lines.push(`# Chord diagnostics ${new Date().toISOString()}`);
  push('chord', app.getVersion());
  push('electron', `${process.versions.electron} (chrome ${process.versions.chrome}, node ${process.versions.node})`);
  push('platform', `${process.platform} ${process.getSystemVersion()} ${process.arch}${rosetta ? ' RUNNING UNDER ROSETTA/ARM64 TRANSLATION' : ''}`);
  push('packaged', app.isPackaged);
  push('signing', await signingInfo());
  push('memory', `${Math.round(mem.total / 1024)} MB total, ${Math.round(mem.free / 1024)} MB free`);
  push('gpu', Object.entries(gpu).map(([k, v]) => `${k}=${v}`).join(' '));
  push('processes', metrics.map((m) => `${m.type}${m.name ? `(${m.name})` : ''} cpu=${m.cpu.percentCPUUsage.toFixed(0)}% mem=${Math.round((m.memory.workingSetSize ?? 0) / 1024)}MB`).join(' | '));
  lines.push('');
  lines.push('## State');
  push('spaces', s.spaces.length);
  push('tabs', `${tabs.length} total, ${tabs.filter((t) => t.awake).length} awake, ${space.panes.length} pane(s) shown, ${s.archived.length} archived`);
  push('focused', focused ? `${hostOf(focused.url) || focused.url} loading=${focused.loading}` : 'none');
  push('shields', `setting=${s.settings.shields} active=${shields.enabled} engineLoaded=${shields.loaded}`);
  push('extensions', `${s.settings.extensions.filter((e) => e.enabled).length} enabled of ${s.settings.extensions.length}`);
  push('ui', `sidebar=${s.settings.sidebarOpen} width=${s.settings.sidebarWidth} addressBar=${s.settings.addressBar} theme=${s.settings.theme.mode}`);
  lines.push('');
  lines.push('## Startup (ms after process start)');
  push('marks', marks.map((m) => `${m.name}=${m.ms}`).join(' '));
  push('portable', Boolean(process.env.PORTABLE_EXECUTABLE_DIR) || app.getPath('userData').endsWith('ChordData'));
  lines.push('');
  lines.push('## Main process event loop (100 ms ticks)');
  push('samples', samples);
  push('average lag', `${samples ? (totalLag / samples).toFixed(1) : '0'} ms`);
  push('worst lag', `${Math.round(worstLag)} ms`);
  push('stalls >= 50 ms', stalls.length ? stalls.map((x) => `${new Date(x.at).toISOString().slice(11, 19)} ${x.ms}ms`).join(', ') : 'none');
  lines.push('');
  lines.push('## Recent page loads (ms from navigation start)');
  for (const n of navs.slice(-15)) {
    lines.push(`- ${hostOf(n.url) || n.url}: domReady=${n.domReady ?? '-'} finished=${n.finished ?? (inFlight.has(n.tab) ? 'in flight' : '-')} shields=${n.shields}`);
  }
  if (!navs.length) lines.push('- none yet');
  lines.push('');
  lines.push('## Focused page navigation timing');
  push('timing', pageTiming ?? 'no focused page');
  return lines.join('\n');
}

export async function copyDiagnostics(c: Controller): Promise<void> {
  const text = await collectDiagnostics(c);
  const file = join(app.getPath('userData'), 'diagnostics.txt');
  await writeFile(file, text, 'utf8').catch(() => {});
  clipboard.writeText(text);
  const opts = {
    type: 'info' as const,
    message: 'Diagnostics copied to the clipboard',
    detail: `Paste them into a GitHub issue. Also saved to ${file}.`,
    buttons: ['OK', 'Show File'],
    defaultId: 0,
  };
  const { response } = c.win ? await dialog.showMessageBox(c.win, opts) : await dialog.showMessageBox(opts);
  if (response === 1) shell.showItemInFolder(file);
}

/** Warn once per launch when an old Intel-only build runs translated on an Apple Silicon Mac. */
export function warnIfTranslated(c: Controller): void {
  if (!isMac || !app.runningUnderARM64Translation || !c.win) return;
  const universal = `https://github.com/sirmmo/chord/releases/latest/download/Chord-${app.getVersion()}-mac-universal.dmg`;
  void dialog.showMessageBox(c.win, {
    type: 'warning',
    message: 'Chord is running through Rosetta: this is the Intel build on an Apple Silicon Mac',
    detail:
      'Pages load several times slower this way and startup takes much longer.\n\n' +
      'Download the universal build, which runs natively on M-series and Intel Macs, drag it over the copy in Applications, and relaunch.',
    buttons: ['Download Universal Build', 'Keep Using This One'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) void shell.openExternal(universal);
  });
}
