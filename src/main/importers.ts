import { app, dialog } from 'electron';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChordConfig } from '../shared/config.ts';
import { describeImport, importAny } from '../shared/importers.ts';
import type { Controller } from './controller.ts';
import { isMac } from './platform.ts';

interface Candidate {
  id: string;
  name: string;
  path: string;
}

/** Where each browser keeps the file we can import, for the default profile. */
function candidates(): Candidate[] {
  const data = app.getPath('appData'); // ~/Library/Application Support, %APPDATA%, ~/.config
  const local = process.env.LOCALAPPDATA ?? data;
  const win = process.platform === 'win32';
  const chromium = (id: string, name: string, mac: string, w: string, linux: string) => ({
    id,
    name,
    path: isMac ? join(data, mac, 'Default', 'Bookmarks') : win ? join(local, w, 'User Data', 'Default', 'Bookmarks') : join(data, linux, 'Default', 'Bookmarks'),
  });
  return [
    {
      id: 'arc',
      name: 'Arc',
      path: isMac
        ? join(data, 'Arc', 'StorableSidebar.json')
        : join(local, 'Packages', 'TheBrowserCompany.Arc_ttt1ap7aakyb4', 'LocalCache', 'Local', 'Arc', 'StorableSidebar.json'),
    },
    chromium('chrome', 'Chrome', 'Google/Chrome', 'Google/Chrome', 'google-chrome'),
    chromium('brave', 'Brave', 'BraveSoftware/Brave-Browser', 'BraveSoftware/Brave-Browser', 'BraveSoftware/Brave-Browser'),
    chromium('edge', 'Edge', 'Microsoft Edge', 'Microsoft/Edge', 'microsoft-edge'),
    chromium('chromium', 'Chromium', 'Chromium', 'Chromium', 'chromium'),
  ];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectBrowsers(): Promise<Candidate[]> {
  const all = candidates();
  const found = await Promise.all(all.map((c) => exists(c.path)));
  return all.filter((_c, i) => found[i]);
}

/** File → Import from Another Browser…: pick a detected browser or any file, then merge or replace. */
export async function importFromBrowser(c: Controller): Promise<void> {
  const win = c.win;
  if (!win) return;
  const found = await detectBrowsers();
  const buttons = [...found.map((f) => `Import from ${f.name}`), 'Choose File…', 'Cancel'];
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    message: found.length ? `Found ${found.map((f) => f.name).join(', ')} on this computer` : 'No other browser found in the usual places',
    detail:
      'Arc: spaces with their pinned and today tabs, plus favorites, from StorableSidebar.json.\n' +
      'Chrome, Brave, Edge, Chromium: bookmarks become pinned tabs, one space per bookmarks-bar folder, from the profile’s Bookmarks file.\n\n' +
      'Choose File… also accepts a Chord configuration or a Bookmarks file from another profile.',
  });
  if (response === buttons.length - 1) return;

  let path: string;
  let hint: string | undefined;
  if (response < found.length) {
    path = found[response].path;
    hint = found[response].name;
  } else {
    const picked = await dialog.showOpenDialog(win, {
      title: 'Import from another browser',
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: 'Browser data', extensions: ['json', ''] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (picked.canceled || !picked.filePaths[0]) return;
    path = picked.filePaths[0];
  }

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    dialog.showErrorBox('Import failed', err instanceof Error ? err.message : String(err));
    return;
  }
  const result = importAny(text, new Date(), hint);
  if (!result.ok) {
    dialog.showErrorBox('Import failed', `Could not read ${path}: ${result.error}.`);
    return;
  }
  await confirmImport(c, result.config, result.source, result.notes);
}

/** Merge or replace, shared by every import path. */
export async function confirmImport(c: Controller, config: ChordConfig, source: string, notes: string[] = []): Promise<void> {
  if (!c.win) return;
  const { response } = await dialog.showMessageBox(c.win, {
    type: 'question',
    buttons: ['Merge', 'Replace', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: `Import ${describeImport(config)} from ${source}?`,
    detail:
      (notes.length ? notes.join('\n') + '\n\n' : '') +
      'Merge adds what is missing: spaces with the same name receive new tabs, other spaces are created.\n\n' +
      'Replace rebuilds spaces, favorites and settings from the file; your current tabs are moved to the archive.',
  });
  if (response === 2) return;
  c.apply({ type: 'config.import', config, mode: response === 0 ? 'merge' : 'replace' });
}
