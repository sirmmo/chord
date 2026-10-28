// Reading other browsers' profile databases (SQLite) for history and, for
// Firefox, bookmarks. The files are copied first: the browser keeps them
// locked while it runs, and a copy is safe to open read-only.

import { app } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromeTimeToMs, cleanVisits, firefoxBookmarksToConfig, firefoxTimeToMs, type FirefoxBookmarkRow, type ImportedVisit, type ImportResult } from '../shared/importers.ts';
import { isMac } from './platform.ts';

const MAX_VISITS = 20_000;

/** A browser profile found on this computer and what it offers. */
export interface ProfileSource {
  id: string;
  name: string;
  /** Arc's sidebar file, a Chromium Bookmarks file, or Firefox's places.sqlite */
  bookmarks?: string;
  /** Chromium History or Firefox places.sqlite */
  history?: string;
  kind: 'arc' | 'chromium' | 'firefox';
}

export async function profileSources(): Promise<ProfileSource[]> {
  const data = app.getPath('appData');
  const local = process.env.LOCALAPPDATA ?? data;
  const win = process.platform === 'win32';
  const chromium = (id: string, name: string, mac: string, w: string, linux: string): ProfileSource => {
    const dir = isMac ? join(data, mac, 'Default') : win ? join(local, w, 'User Data', 'Default') : join(data, linux, 'Default');
    return { id, name, kind: 'chromium', bookmarks: join(dir, 'Bookmarks'), history: join(dir, 'History') };
  };
  const arcDir = isMac ? join(data, 'Arc') : join(local, 'Packages', 'TheBrowserCompany.Arc_ttt1ap7aakyb4', 'LocalCache', 'Local', 'Arc');
  const all: ProfileSource[] = [
    { id: 'arc', name: 'Arc', kind: 'arc', bookmarks: join(arcDir, 'StorableSidebar.json'), history: join(arcDir, 'User Data', 'Default', 'History') },
    chromium('chrome', 'Chrome', 'Google/Chrome', 'Google/Chrome', 'google-chrome'),
    chromium('brave', 'Brave', 'BraveSoftware/Brave-Browser', 'BraveSoftware/Brave-Browser', 'BraveSoftware/Brave-Browser'),
    chromium('edge', 'Edge', 'Microsoft Edge', 'Microsoft/Edge', 'microsoft-edge'),
    chromium('chromium', 'Chromium', 'Chromium', 'Chromium', 'chromium'),
  ];
  const places = await firefoxPlaces();
  if (places) all.push({ id: 'firefox', name: 'Firefox', kind: 'firefox', bookmarks: places, history: places });
  const out: ProfileSource[] = [];
  for (const s of all) {
    const b = s.bookmarks && (await exists(s.bookmarks)) ? s.bookmarks : undefined;
    const h = s.history && (await exists(s.history)) ? s.history : undefined;
    if (b || h) out.push({ ...s, bookmarks: b, history: h });
  }
  return out;
}

/** The most recently used Firefox profile's places.sqlite, if any. */
async function firefoxPlaces(): Promise<string | null> {
  const data = app.getPath('appData');
  const home = app.getPath('home');
  const roots = isMac ? [join(data, 'Firefox', 'Profiles')] : process.platform === 'win32' ? [join(data, 'Mozilla', 'Firefox', 'Profiles')] : [join(home, '.mozilla', 'firefox'), join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'), join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox')];
  let best: { path: string; mtime: number } | null = null;
  for (const root of roots) {
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join(root, n, 'places.sqlite');
      try {
        const st = await stat(p);
        if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs };
      } catch {
        /* not a profile */
      }
    }
  }
  return best?.path ?? null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Copy a database (with its WAL, if any) to a scratch folder and open it read-only. Call close() when done. */
async function openCopy(path: string): Promise<{ db: DatabaseSync; close(): Promise<void> }> {
  const dir = join(app.getPath('temp'), `chord-import-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const copy = join(dir, 'db.sqlite');
  await copyFile(path, copy);
  for (const suffix of ['-wal', '-journal']) {
    try {
      await copyFile(path + suffix, copy + suffix);
    } catch {
      /* none */
    }
  }
  const db = new DatabaseSync(copy, { readOnly: true });
  return {
    db,
    close: async () => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Visits from a Chromium History database (Chrome, Brave, Edge, Chromium, Arc). */
export async function readChromiumHistory(path: string): Promise<ImportedVisit[]> {
  const { db, close } = await openCopy(path);
  try {
    // core transition types 3 and 4 are frames inside pages, 8 is a reload
    const rows = db
      .prepare(`SELECT u.url AS url, u.title AS title, v.visit_time AS t FROM visits v JOIN urls u ON u.id = v.url WHERE u.hidden = 0 AND (v.transition & 255) NOT IN (3, 4, 8) ORDER BY v.visit_time DESC LIMIT ${MAX_VISITS}`)
      .all() as { url: unknown; title: unknown; t: unknown }[];
    return cleanVisits(rows.map((r) => ({ url: r.url, title: r.title, at: typeof r.t === 'number' ? chromeTimeToMs(r.t) : typeof r.t === 'bigint' ? chromeTimeToMs(Number(r.t)) : NaN })));
  } finally {
    await close();
  }
}

/** Visits from a Firefox places.sqlite. */
export async function readFirefoxHistory(path: string): Promise<ImportedVisit[]> {
  const { db, close } = await openCopy(path);
  try {
    // visit types 4 (embed) and 7 (download) are not pages the user read
    const rows = db
      .prepare(`SELECT p.url AS url, p.title AS title, v.visit_date AS t FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id WHERE v.visit_type NOT IN (4, 7) ORDER BY v.visit_date DESC LIMIT ${MAX_VISITS}`)
      .all() as { url: unknown; title: unknown; t: unknown }[];
    return cleanVisits(rows.map((r) => ({ url: r.url, title: r.title, at: typeof r.t === 'number' ? firefoxTimeToMs(r.t) : typeof r.t === 'bigint' ? firefoxTimeToMs(Number(r.t)) : NaN })));
  } finally {
    await close();
  }
}

/** Bookmarks from a Firefox places.sqlite, as a Chord configuration. */
export async function readFirefoxBookmarks(path: string, now = new Date()): Promise<ImportResult> {
  const { db, close } = await openCopy(path);
  try {
    const rows = db.prepare('SELECT b.id AS id, b.parent AS parent, b.type AS type, b.title AS title, b.guid AS guid, p.url AS url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk').all() as Record<string, unknown>[];
    const clean: FirefoxBookmarkRow[] = rows.map((r) => ({ id: Number(r.id), parent: Number(r.parent), type: Number(r.type), title: typeof r.title === 'string' ? r.title : null, url: typeof r.url === 'string' ? r.url : null, guid: typeof r.guid === 'string' ? r.guid : '' }));
    return firefoxBookmarksToConfig(clean, now);
  } finally {
    await close();
  }
}
