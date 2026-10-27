// Portable JSON format for everything the user set up: spaces, their tabs,
// favorites and settings. No internal ids, so a file can be hand-edited,
// shared, or imported into another Chord.

import type { Settings, SpaceId, State, Tab, TabId, Theme } from './types.ts';
import { SPACE_COLORS, MAX_ARCHIVED, clampTint, makeSpace, spaceById, type Ctx } from './model.ts';
import { titleFor } from './url.ts';

export const CONFIG_FORMAT = 'chord-config';
export const CONFIG_VERSION = 1;

export interface ConfigTab {
  url: string;
  title?: string;
  favicon?: string;
}

export interface ConfigSpace {
  name: string;
  color?: string;
  icon?: string;
  pinned: ConfigTab[];
  today: ConfigTab[];
}

export interface ChordConfig {
  format: typeof CONFIG_FORMAT;
  version: typeof CONFIG_VERSION;
  exportedAt: string;
  favorites: ConfigTab[];
  spaces: ConfigSpace[];
  settings?: Partial<Settings>;
}

export type ImportMode = 'merge' | 'replace';

const SETTING_KEYS: (keyof Settings)[] = ['theme', 'smartPages', 'askDownloadPath', 'closeToTray', 'tilings', 'addressBar', 'sidebarOpen', 'sidebarWidth', 'archiveAfterHours', 'shields', 'searchEngine'];

function tabToConfig(tab: Tab): ConfigTab {
  const out: ConfigTab = { url: tab.homeUrl ?? tab.url };
  if (tab.title) out.title = tab.title;
  if (tab.favicon) out.favicon = tab.favicon;
  return out;
}

function tabsToConfig(s: State, ids: TabId[]): ConfigTab[] {
  return ids.map((id) => s.tabs[id]).filter(Boolean).map(tabToConfig);
}

/** Export everything, or a single space when `spaceId` is given. */
export function exportConfig(s: State, now: number, spaceId?: SpaceId): ChordConfig {
  const spaces = spaceId ? [spaceById(s, spaceId)].filter((sp) => sp !== undefined) : s.spaces;
  const config: ChordConfig = {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt: new Date(now).toISOString(),
    favorites: spaceId ? [] : tabsToConfig(s, s.favorites),
    spaces: spaces.map((sp) => ({
      name: sp.name,
      color: sp.color,
      icon: sp.icon,
      pinned: tabsToConfig(s, sp.pinned),
      today: tabsToConfig(s, sp.today),
    })),
  };
  if (!spaceId) {
    const { extensions: _extensions, ...rest } = s.settings;
    config.settings = rest;
  }
  return config;
}

export type ParseResult = { ok: true; config: ChordConfig } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

function parseTabs(v: unknown, where: string): ConfigTab[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`${where} must be a list`);
  const out: ConfigTab[] = [];
  v.forEach((item, i) => {
    const raw = typeof item === 'string' ? { url: item } : item;
    if (!isRecord(raw) || typeof raw.url !== 'string') throw new Error(`${where}[${i}] needs a "url"`);
    const url = raw.url.trim();
    if (!/^(https?|file|about):/i.test(url)) throw new Error(`${where}[${i}] has an unsupported url: ${url}`);
    const tab: ConfigTab = { url };
    if (typeof raw.title === 'string' && raw.title) tab.title = raw.title;
    if (typeof raw.favicon === 'string' && /^(https?|data):/i.test(raw.favicon)) tab.favicon = raw.favicon;
    out.push(tab);
  });
  return out;
}

/** Validate a parsed JSON document, filling in defaults for optional fields. */
export function parseConfig(text: string): ParseResult {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw)) throw new Error('the file is not a JSON object');
    if (raw.format !== CONFIG_FORMAT) throw new Error(`"format" must be "${CONFIG_FORMAT}"`);
    if (raw.version !== CONFIG_VERSION) throw new Error(`unsupported version ${String(raw.version)}; this Chord reads version ${CONFIG_VERSION}`);
    if (!Array.isArray(raw.spaces)) throw new Error('"spaces" must be a list');
    const spaces = raw.spaces.map((sp, i): ConfigSpace => {
      if (!isRecord(sp) || typeof sp.name !== 'string' || !sp.name.trim()) throw new Error(`spaces[${i}] needs a "name"`);
      return {
        name: sp.name.trim(),
        color: isHex(sp.color) ? sp.color : undefined,
        icon: typeof sp.icon === 'string' && sp.icon ? sp.icon.slice(0, 4) : undefined,
        pinned: parseTabs(sp.pinned, `spaces[${i}].pinned`),
        today: parseTabs(sp.today, `spaces[${i}].today`),
      };
    });
    const settings: Partial<Settings> = {};
    if (isRecord(raw.settings)) {
      const r = raw.settings;
      if (typeof r.sidebarOpen === 'boolean') settings.sidebarOpen = r.sidebarOpen;
      if (typeof r.sidebarWidth === 'number') settings.sidebarWidth = r.sidebarWidth;
      if (typeof r.archiveAfterHours === 'number' && r.archiveAfterHours >= 0) settings.archiveAfterHours = r.archiveAfterHours;
      if (typeof r.shields === 'boolean') settings.shields = r.shields;
      if (typeof r.addressBar === 'boolean') settings.addressBar = r.addressBar;
      if (typeof r.smartPages === 'boolean') settings.smartPages = r.smartPages;
      if (typeof r.askDownloadPath === 'boolean') settings.askDownloadPath = r.askDownloadPath;
      if (typeof r.closeToTray === 'boolean') settings.closeToTray = r.closeToTray;
      if (Array.isArray(r.tilings)) settings.tilings = r.tilings.filter((t): t is { name: string; spec: string } => typeof t === 'object' && t !== null && typeof (t as { name?: unknown }).name === 'string' && typeof (t as { spec?: unknown }).spec === 'string');
      if (typeof r.searchEngine === 'string' && ['duckduckgo', 'google', 'brave', 'kagi', 'startpage'].includes(r.searchEngine)) {
        settings.searchEngine = r.searchEngine as Settings['searchEngine'];
      }
      if (isRecord(r.theme)) {
        const t = r.theme;
        const theme: Partial<Theme> = {};
        if (t.mode === 'system' || t.mode === 'light' || t.mode === 'dark') theme.mode = t.mode;
        if (typeof t.tint === 'number') theme.tint = clampTint(t.tint);
        if (isHex(t.accent) || t.accent === null) theme.accent = t.accent;
        if (t.iconStyle === 'color' || t.iconStyle === 'mono') theme.iconStyle = t.iconStyle;
        if (isHex(t.iconColor) || t.iconColor === null) theme.iconColor = t.iconColor;
        if (t.font === 'system' || t.font === 'rounded' || t.font === 'mono' || t.font === 'serif') theme.font = t.font;
        if (Object.keys(theme).length) settings.theme = theme as Theme;
      }
    }
    const config: ChordConfig = {
      format: CONFIG_FORMAT,
      version: CONFIG_VERSION,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
      favorites: parseTabs(raw.favorites, 'favorites'),
      spaces,
    };
    if (Object.keys(settings).length) config.settings = settings;
    return { ok: true, config };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- import (mutates the cloned state handed in by the reducer) ----

function addTab(s: State, ctx: Ctx, c: ConfigTab, spaceId: SpaceId | null, kind: Tab['kind']): TabId {
  const id = ctx.newId();
  s.tabs[id] = {
    id,
    spaceId,
    kind,
    url: c.url,
    homeUrl: kind === 'today' ? undefined : c.url,
    title: c.title ?? titleFor(c.url),
    favicon: c.favicon,
    createdAt: ctx.now,
    lastActiveAt: ctx.now,
    awake: false,
  };
  return id;
}

function urlsIn(s: State, ids: TabId[]): Set<string> {
  return new Set(ids.map((id) => s.tabs[id]).filter(Boolean).map((t) => t.homeUrl ?? t.url));
}

/**
 * Merge: spaces with the same name receive the tabs they do not have yet, other
 * spaces are created, favorites are added when missing, settings are left alone.
 * Replace: existing tabs go to the archive, spaces and favorites are rebuilt from
 * the file, settings from the file are applied.
 */
export function importConfig(s: State, config: ChordConfig, mode: ImportMode, ctx: Ctx): void {
  if (mode === 'replace') {
    const all = Object.values(s.tabs);
    for (const t of all) {
      s.archived.unshift({ id: t.id, url: t.url, title: t.title, favicon: t.favicon, spaceId: t.spaceId, archivedAt: ctx.now });
    }
    if (s.archived.length > MAX_ARCHIVED) s.archived.length = MAX_ARCHIVED;
    s.tabs = {};
    s.favorites = [];
    s.spaces = [];
    if (config.settings) {
      for (const key of SETTING_KEYS) {
        const v = config.settings[key];
        if (v === undefined) continue;
        if (key === 'theme') Object.assign(s.settings.theme, v);
        else Object.assign(s.settings, { [key]: v });
      }
    }
  }

  const haveFav = urlsIn(s, s.favorites);
  for (const c of config.favorites) {
    if (haveFav.has(c.url)) continue;
    haveFav.add(c.url);
    s.favorites.push(addTab(s, ctx, c, null, 'favorite'));
  }

  for (const cs of config.spaces) {
    let space = mode === 'merge' ? s.spaces.find((sp) => sp.name.toLowerCase() === cs.name.toLowerCase()) : undefined;
    if (!space) {
      space = makeSpace(s.spaces.length, ctx, cs.name, cs.color ?? SPACE_COLORS[s.spaces.length % SPACE_COLORS.length], cs.icon);
      s.spaces.push(space);
    } else {
      if (cs.color) space.color = cs.color;
      if (cs.icon) space.icon = cs.icon;
    }
    const have = urlsIn(s, [...space.pinned, ...space.today]);
    for (const c of cs.pinned) {
      if (have.has(c.url)) continue;
      have.add(c.url);
      space.pinned.push(addTab(s, ctx, c, space.id, 'pinned'));
    }
    for (const c of cs.today) {
      if (have.has(c.url)) continue;
      have.add(c.url);
      space.today.push(addTab(s, ctx, c, space.id, 'today'));
    }
  }

  if (s.spaces.length === 0) s.spaces.push(makeSpace(0, ctx));
  if (!spaceById(s, s.activeSpaceId)) {
    s.activeSpaceId = s.spaces[0].id;
  }
  for (const sp of s.spaces) {
    sp.panes = sp.panes.filter((id) => id in s.tabs);
    sp.focused = sp.focused && sp.focused in s.tabs ? sp.focused : sp.panes[0] ?? null;
  }
}

/** A safe file name for an export. */
export function exportFileName(now: number, spaceName?: string): string {
  const date = new Date(now).toISOString().slice(0, 10);
  const base = spaceName ? `Chord-space-${spaceName.replace(/[^\w-]+/g, '_')}` : 'Chord-config';
  return `${base}-${date}.json`;
}
