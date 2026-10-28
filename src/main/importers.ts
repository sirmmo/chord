import { dialog } from 'electron';
import { readFile } from 'node:fs/promises';
import type { ChordConfig } from '../shared/config.ts';
import { describeImport, importAny, type ImportResult } from '../shared/importers.ts';
import type { Controller } from './controller.ts';
import { profileSources, readChromiumHistory, readFirefoxBookmarks, readFirefoxHistory, type ProfileSource } from './profiles.ts';

/**
 * File → Import from Another Browser…: pick a detected browser (or any file), then
 * what to take from it: bookmarks (merge or replace, as for a Chord configuration)
 * and history (always merged, nothing duplicated).
 */
export async function importFromBrowser(c: Controller, only?: 'history'): Promise<void> {
  const win = c.win;
  if (!win) return;
  const found = (await profileSources()).filter((f) => (only === 'history' ? f.history : f.bookmarks || f.history));
  const buttons = [...found.map((f) => `Import from ${f.name}`), ...(only ? [] : ['Choose File…']), 'Cancel'];
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    message: found.length ? `Found ${found.map((f) => f.name).join(', ')} on this computer` : 'No other browser found in the usual places',
    detail:
      only === 'history'
        ? 'History is read from the browser’s profile and merged into Chord’s; nothing is duplicated.'
        : 'Arc: spaces with their pinned and today tabs, plus favorites, from StorableSidebar.json.\n' +
          'Chrome, Brave, Edge, Chromium, Firefox: bookmarks become pinned tabs, one space per bookmarks-bar folder.\n' +
          'History from any of them is merged into Chord’s history.\n\n' +
          'Choose File… also accepts a Chord configuration or a Bookmarks file from another profile.',
  });
  if (response === buttons.length - 1) return;

  if (response < found.length) {
    const src = found[response];
    let what: 'both' | 'bookmarks' | 'history' = only ?? 'both';
    if (!only && src.bookmarks && src.history) {
      const choice = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Bookmarks and History', 'Bookmarks Only', 'History Only', 'Cancel'],
        defaultId: 0,
        cancelId: 3,
        message: `What to import from ${src.name}?`,
        detail: src.kind === 'arc' ? 'Bookmarks: Arc’s spaces, pinned and today tabs and favorites.' : 'Bookmarks become pinned tabs in spaces named after the folders.',
      });
      if (choice.response === 3) return;
      what = (['both', 'bookmarks', 'history'] as const)[choice.response];
    } else if (!only) what = src.bookmarks ? 'bookmarks' : 'history';
    if (what !== 'history' && src.bookmarks) await importBookmarksFrom(c, src);
    if (what !== 'bookmarks' && src.history) await importHistoryFrom(c, src);
    return;
  }

  const picked = await dialog.showOpenDialog(win, {
    title: 'Import from another browser',
    properties: ['openFile', 'showHiddenFiles'],
    filters: [
      { name: 'Browser data', extensions: ['json', 'sqlite', ''] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (picked.canceled || !picked.filePaths[0]) return;
  const path = picked.filePaths[0];
  const base = path.split(/[\\/]/).pop() ?? '';
  if (base === 'places.sqlite') return importBookmarksFrom(c, { id: 'firefox', name: 'Firefox', kind: 'firefox', bookmarks: path, history: path });
  if (base === 'History') {
    const n = await importHistoryFrom(c, { id: 'chromium', name: 'that profile', kind: 'chromium', history: path });
    if (n !== null) return;
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    dialog.showErrorBox('Import failed', err instanceof Error ? err.message : String(err));
    return;
  }
  const result = importAny(text, new Date());
  if (!result.ok) {
    dialog.showErrorBox('Import failed', `Could not read ${path}: ${result.error}.`);
    return;
  }
  await confirmImport(c, result.config, result.source, result.notes);
}

async function importBookmarksFrom(c: Controller, src: ProfileSource): Promise<void> {
  if (!src.bookmarks) return;
  let result: ImportResult;
  try {
    if (src.kind === 'firefox') result = await readFirefoxBookmarks(src.bookmarks);
    else result = importAny(await readFile(src.bookmarks, 'utf8'), new Date(), src.name);
  } catch (err) {
    dialog.showErrorBox('Import failed', `Could not read ${src.bookmarks}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!result.ok) {
    dialog.showErrorBox('Import failed', `Could not read ${src.bookmarks}: ${result.error}.`);
    return;
  }
  await confirmImport(c, result.config, result.source, result.notes);
}

/** Returns how many visits were new, or null when the file could not be read. */
async function importHistoryFrom(c: Controller, src: ProfileSource): Promise<number | null> {
  if (!src.history || !c.win) return null;
  let visits;
  try {
    visits = src.kind === 'firefox' ? await readFirefoxHistory(src.history) : await readChromiumHistory(src.history);
  } catch (err) {
    dialog.showErrorBox('History import failed', `Could not read ${src.history}: ${err instanceof Error ? err.message : String(err)}${process.platform === 'win32' ? '\n\nIf the browser is running, quit it and try again.' : ''}`);
    return null;
  }
  const added = c.history.importVisits(visits);
  await dialog.showMessageBox(c.win, {
    type: 'info',
    buttons: ['OK'],
    message: added ? `Imported ${added.toLocaleString()} visits from ${src.name}` : `Nothing new in ${src.name}’s history`,
    detail: visits.length ? `${visits.length.toLocaleString()} visits read; ${added ? 'the rest were' : 'all'} already in Chord’s history.` : 'The profile has no history.',
  });
  return added;
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
