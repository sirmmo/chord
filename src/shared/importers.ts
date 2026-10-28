// Importers for other browsers. Each one turns a foreign file into a Chord
// configuration (see config.ts), so the normal merge/replace import does the rest.
//
// - Arc: StorableSidebar.json (spaces, pinned and today tabs, favorites).
// - Chrome, Brave, Edge, Chromium: the profile's Bookmarks file. Bookmarks
//   become pinned tabs; each folder in the bookmarks bar becomes a space.

import { CONFIG_FORMAT, CONFIG_VERSION, parseConfig, type ChordConfig, type ConfigSpace, type ConfigTab } from './config.ts';

export type ImportResult = { ok: true; config: ChordConfig; source: string; notes: string[] } | { ok: false; error: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const IMPORTABLE_URL = /^(https?|file|ftp):\/\//i;

function emptyConfig(now: Date): ChordConfig {
  return { format: CONFIG_FORMAT, version: CONFIG_VERSION, exportedAt: now.toISOString(), favorites: [], spaces: [] };
}

function dedupe(tabs: ConfigTab[]): ConfigTab[] {
  const seen = new Set<string>();
  return tabs.filter((t) => {
    if (seen.has(t.url)) return false;
    seen.add(t.url);
    return true;
  });
}

/** Figures out what a file is and converts it. */
export function importAny(text: string, now = new Date(), hint?: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the file is not JSON' };
  }
  if (!isObj(raw)) return { ok: false, error: 'the file is not a JSON object' };
  if (raw.format === CONFIG_FORMAT) {
    const parsed = parseConfig(text);
    return parsed.ok ? { ok: true, config: parsed.config, source: 'Chord', notes: [] } : { ok: false, error: parsed.error };
  }
  if (isObj(raw.sidebar) && Array.isArray((raw.sidebar as Obj).containers)) return arcToConfig(raw, now);
  if (isObj(raw.roots)) return chromiumBookmarksToConfig(raw, hint ?? 'Chrome', now);
  return { ok: false, error: 'not a Chord configuration, an Arc StorableSidebar.json or a Chromium Bookmarks file' };
}

// ---- Arc ----

/** Arc stores lists as [id, object, id, object, …]; sometimes the object carries the id itself. */
function records(list: unknown): Obj[] {
  if (!Array.isArray(list)) return [];
  const out: Obj[] = [];
  let pendingId: string | null = null;
  for (const entry of list) {
    if (typeof entry === 'string') {
      pendingId = entry;
      continue;
    }
    if (isObj(entry)) {
      out.push(pendingId && typeof entry.id !== 'string' ? { ...entry, id: pendingId } : entry);
      pendingId = null;
    }
  }
  return out;
}

function arcContainerIds(space: Obj): { pinned?: string; unpinned?: string } {
  const list = Array.isArray(space.newContainerIDs) ? space.newContainerIDs : Array.isArray(space.containerIDs) ? space.containerIDs : [];
  const out: { pinned?: string; unpinned?: string } = {};
  let kind: 'pinned' | 'unpinned' | null = null;
  for (const e of list) {
    if (typeof e === 'string') {
      if (e === 'pinned' || e === 'unpinned') kind = e;
      else if (kind) {
        out[kind] = e;
        kind = null;
      }
    } else if (isObj(e)) {
      if ('pinned' in e) kind = 'pinned';
      else if ('unpinned' in e) kind = 'unpinned';
    }
  }
  return out;
}

function arcIcon(space: Obj): string | undefined {
  const info = isObj(space.customInfo) ? space.customInfo : {};
  const icon = isObj(info.iconType) ? info.iconType : {};
  if (typeof icon.emoji_v2 === 'string' && icon.emoji_v2) return icon.emoji_v2;
  if (typeof icon.emoji === 'number' && icon.emoji > 0) {
    try {
      return String.fromCodePoint(icon.emoji);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** First {red, green, blue} triple (0–1 floats) found in the space's window theme. */
function arcColor(space: Obj): string | undefined {
  const info = isObj(space.customInfo) ? space.customInfo : {};
  const stack: unknown[] = [info.windowTheme];
  let steps = 0;
  while (stack.length && steps++ < 2000) {
    const v = stack.pop();
    if (!isObj(v)) {
      if (Array.isArray(v)) stack.push(...v);
      continue;
    }
    const { red, green, blue } = v;
    if (typeof red === 'number' && typeof green === 'number' && typeof blue === 'number') {
      const hex = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
      return `#${hex(red)}${hex(green)}${hex(blue)}`;
    }
    stack.push(...Object.values(v));
  }
  return undefined;
}

export function arcToConfig(raw: Obj, now = new Date()): ImportResult {
  const sidebar = isObj(raw.sidebar) ? raw.sidebar : {};
  const containers = Array.isArray(sidebar.containers) ? sidebar.containers.filter(isObj) : [];
  if (containers.length === 0) return { ok: false, error: 'no sidebar containers found in this Arc file' };

  const items = new Map<string, Obj>();
  const childrenOf = new Map<string, string[]>();
  const spaces: Obj[] = [];
  const topAppIds: string[] = [];
  for (const container of containers) {
    for (const item of records(container.items)) {
      const id = str(item.id);
      if (!id) continue;
      items.set(id, item);
      if (Array.isArray(item.childrenIds)) childrenOf.set(id, item.childrenIds.filter((c): c is string => typeof c === 'string'));
      const data = isObj(item.data) ? item.data : {};
      const ic = isObj(data.itemContainer) ? data.itemContainer : null;
      const ct = ic && isObj(ic.containerType) ? ic.containerType : null;
      if (ct && 'topApps' in ct) topAppIds.push(id);
    }
    if (Array.isArray(container.topAppsContainerIDs)) topAppIds.push(...container.topAppsContainerIDs.filter((c): c is string => typeof c === 'string'));
    spaces.push(...records(container.spaces));
  }
  // Fallback for files without childrenIds: group by parentID in file order.
  if (childrenOf.size === 0) {
    for (const [id, item] of items) {
      const parent = str(item.parentID);
      if (!parent) continue;
      const list = childrenOf.get(parent) ?? [];
      list.push(id);
      childrenOf.set(parent, list);
    }
  }

  let skipped = 0;
  const collect = (id: string, out: ConfigTab[], seen: Set<string>, depth = 0): void => {
    if (depth > 30 || seen.has(id)) return;
    seen.add(id);
    const item = items.get(id);
    if (!item) return;
    const data = isObj(item.data) ? item.data : {};
    const tab = isObj(data.tab) ? data.tab : null;
    if (tab) {
      const url = str(tab.savedURL);
      if (IMPORTABLE_URL.test(url)) out.push({ url, title: str(item.title) || str(tab.savedTitle) || undefined });
      else skipped++;
    }
    for (const child of childrenOf.get(id) ?? []) collect(child, out, seen, depth + 1);
  };
  const tabsUnder = (id: string | undefined): ConfigTab[] => {
    const out: ConfigTab[] = [];
    if (id) collect(id, out, new Set(), 0);
    return dedupe(out);
  };

  const config = emptyConfig(now);
  const favoriteTabs: ConfigTab[] = [];
  for (const id of topAppIds) favoriteTabs.push(...tabsUnder(id));
  config.favorites = dedupe(favoriteTabs);

  spaces.forEach((space, i) => {
    const ids = arcContainerIds(space);
    const sp: ConfigSpace = {
      name: str(space.title) || `Space ${i + 1}`,
      pinned: tabsUnder(ids.pinned),
      today: tabsUnder(ids.unpinned),
    };
    const icon = arcIcon(space);
    const color = arcColor(space);
    if (icon) sp.icon = icon;
    if (color) sp.color = color;
    config.spaces.push(sp);
  });

  if (config.spaces.length === 0 && config.favorites.length === 0) return { ok: false, error: 'no spaces or favorites found in this Arc file' };
  const notes: string[] = [];
  if (skipped) notes.push(`${skipped} internal page${skipped === 1 ? '' : 's'} (arc:// and the like) skipped`);
  notes.push('Folders are flattened: Chord has no folders yet. Archived Arc tabs are not imported.');
  return { ok: true, config, source: 'Arc', notes };
}

// ---- Chrome, Brave, Edge, Chromium: the profile's Bookmarks file ----

function flattenBookmarks(node: unknown, out: ConfigTab[], depth = 0): void {
  if (!isObj(node) || depth > 50) return;
  if (node.type === 'url') {
    const url = str(node.url);
    if (IMPORTABLE_URL.test(url)) out.push({ url, title: str(node.name) || undefined });
    return;
  }
  if (Array.isArray(node.children)) for (const child of node.children) flattenBookmarks(child, out, depth + 1);
}

export function chromiumBookmarksToConfig(raw: Obj, browser: string, now = new Date()): ImportResult {
  const roots = isObj(raw.roots) ? raw.roots : null;
  if (!roots) return { ok: false, error: 'no bookmark roots found in this file' };
  const config = emptyConfig(now);

  const bar = isObj(roots.bookmark_bar) ? roots.bookmark_bar : null;
  const barChildren = bar && Array.isArray(bar.children) ? bar.children.filter(isObj) : [];
  const loose: ConfigTab[] = [];
  for (const child of barChildren) {
    if (child.type === 'folder') {
      const pinned: ConfigTab[] = [];
      flattenBookmarks(child, pinned);
      if (pinned.length) config.spaces.push({ name: str(child.name) || 'Bookmarks', pinned: dedupe(pinned), today: [] });
    } else {
      flattenBookmarks(child, loose);
    }
  }
  if (loose.length) config.spaces.unshift({ name: `${browser} Bookmarks`, pinned: dedupe(loose), today: [] });

  for (const [key, name] of [
    ['other', 'Other Bookmarks'],
    ['synced', 'Mobile Bookmarks'],
  ] as const) {
    const pinned: ConfigTab[] = [];
    flattenBookmarks(roots[key], pinned);
    if (pinned.length) config.spaces.push({ name, pinned: dedupe(pinned), today: [] });
  }

  if (config.spaces.length === 0) return { ok: false, error: `no bookmarks found in this ${browser} file` };
  return { ok: true, config, source: browser, notes: ['Bookmarks become pinned tabs; each folder in the bookmarks bar becomes a space. Open tabs and history are not imported.'] };
}

/** One-line description of what an import result contains. */
export function describeImport(config: ChordConfig): string {
  const tabs = config.favorites.length + config.spaces.reduce((n, sp) => n + sp.pinned.length + sp.today.length, 0);
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  return `${n(config.spaces.length, 'space')}, ${n(tabs, 'tab')}${config.favorites.length ? ` (${config.favorites.length} favorites)` : ''}`;
}

// ---- Firefox: rows from places.sqlite ----

/** One row of moz_bookmarks joined with moz_places (url is null for folders). */
export interface FirefoxBookmarkRow {
  id: number;
  parent: number;
  /** 1 bookmark, 2 folder, 3 separator */
  type: number;
  title: string | null;
  url: string | null;
  guid: string;
}

/** Firefox bookmarks: toolbar folders become spaces, loose toolbar bookmarks a "Firefox Bookmarks" space, the menu and unfiled roots a space each. */
export function firefoxBookmarksToConfig(rows: FirefoxBookmarkRow[], now = new Date()): ImportResult {
  const byParent = new Map<number, FirefoxBookmarkRow[]>();
  for (const r of rows) {
    const list = byParent.get(r.parent) ?? [];
    list.push(r);
    byParent.set(r.parent, list);
  }
  const collect = (id: number, out: ConfigTab[], depth = 0): void => {
    if (depth > 50) return;
    for (const r of byParent.get(id) ?? []) {
      if (r.type === 1 && r.url && IMPORTABLE_URL.test(r.url)) out.push({ url: r.url, title: r.title || undefined });
      else if (r.type === 2) collect(r.id, out, depth + 1);
    }
  };
  const root = (guid: string) => rows.find((r) => r.guid === guid);
  const config = emptyConfig(now);
  const toolbar = root('toolbar_____');
  if (toolbar) {
    const loose: ConfigTab[] = [];
    for (const child of byParent.get(toolbar.id) ?? []) {
      if (child.type === 2) {
        const pinned: ConfigTab[] = [];
        collect(child.id, pinned);
        if (pinned.length) config.spaces.push({ name: child.title || 'Bookmarks', pinned: dedupe(pinned), today: [] });
      } else if (child.type === 1 && child.url && IMPORTABLE_URL.test(child.url)) loose.push({ url: child.url, title: child.title || undefined });
    }
    if (loose.length) config.spaces.unshift({ name: 'Firefox Bookmarks', pinned: dedupe(loose), today: [] });
  }
  for (const [guid, name] of [
    ['menu________', 'Bookmarks Menu'],
    ['unfiled_____', 'Other Bookmarks'],
    ['mobile______', 'Mobile Bookmarks'],
  ] as const) {
    const r = root(guid);
    if (!r) continue;
    const pinned: ConfigTab[] = [];
    collect(r.id, pinned);
    if (pinned.length) config.spaces.push({ name, pinned: dedupe(pinned), today: [] });
  }
  if (config.spaces.length === 0) return { ok: false, error: 'no bookmarks found in this Firefox profile' };
  return { ok: true, config, source: 'Firefox', notes: ['Bookmarks become pinned tabs; each folder in the bookmarks toolbar becomes a space.'] };
}

// ---- history ----

export interface ImportedVisit {
  url: string;
  title: string;
  /** ms since the epoch */
  at: number;
}

/** Chromium stores times as microseconds since 1601-01-01. */
export function chromeTimeToMs(t: number): number {
  return Math.round(t / 1000 - 11_644_473_600_000);
}

/** Firefox stores times as microseconds since the epoch. */
export function firefoxTimeToMs(t: number): number {
  return Math.round(t / 1000);
}

/** Keep visits worth importing: web pages, a sane time, newest first, no exact repeats. */
export function cleanVisits(raw: { url: unknown; title: unknown; at: unknown }[], now = Date.now()): ImportedVisit[] {
  const seen = new Set<string>();
  const out: ImportedVisit[] = [];
  for (const r of raw) {
    const url = typeof r.url === 'string' ? r.url : '';
    const at = typeof r.at === 'number' ? r.at : NaN;
    if (!IMPORTABLE_URL.test(url) || !Number.isFinite(at) || at <= 0 || at > now + 86_400_000) continue;
    const key = `${url}@${Math.round(at / 1000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, title: typeof r.title === 'string' && r.title ? r.title : url, at: Math.round(at) });
  }
  return out.sort((a, b) => b.at - a.at);
}
