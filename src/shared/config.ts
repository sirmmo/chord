// Portable JSON format for everything the user set up: spaces, their tabs,
// favorites and settings. No internal ids, so a file can be hand-edited,
// shared, or imported into another Chord.

import type { ModeId, Settings, Space, SpaceId, State, Tab, TabId, Theme } from './types.ts';
import { isModeId } from './modes.ts';
import { SPACE_COLORS, MAX_ARCHIVED, clampTint, makeSpace, spaceById, type Ctx } from './model.ts';
import { titleFor } from './url.ts';
import { isBoost } from './boosts.ts';

export const CONFIG_FORMAT = 'chord-config';
export const CONFIG_VERSION = 1;

export interface ConfigTab {
  url: string;
  title?: string;
  favicon?: string;
  /** subspace the tab belongs to, by name */
  group?: string;
  /** always loaded, even in the background */
  keepLoaded?: boolean;
}

export interface ConfigSpace {
  name: string;
  color?: string;
  icon?: string;
  modes?: ModeId[];
  profile?: string;
  /** curated mode: who the space follows */
  curators?: ConfigCurator[];
  pinned: ConfigTab[];
  today: ConfigTab[];
}
export interface ConfigCurator {
  name: string;
  input: string;
  feed: string;
  kind: 'feed' | 'github';
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

const SETTING_KEYS: (keyof Settings)[] = ['theme', 'smartPages', 'askDownloadPath', 'downloadDir', 'closeToTray', 'tilings', 'boosts', 'autoPip', 'ai', 'addressBar', 'sidebarOpen', 'sidebarWidth', 'archiveAfterHours', 'shields', 'searchEngine', 'googleSignIn', 'passkeys', 'sourceror'];

function tabToConfig(tab: Tab): ConfigTab {
  const out: ConfigTab = { url: tab.homeUrl ?? tab.url };
  if (tab.title) out.title = tab.title;
  if (tab.favicon) out.favicon = tab.favicon;
  if (tab.keepLoaded) out.keepLoaded = true;
  return out;
}

function tabsToConfig(s: State, ids: TabId[], space?: Space): ConfigTab[] {
  return ids
    .map((id) => s.tabs[id])
    .filter(Boolean)
    .map((t) => {
      const c = tabToConfig(t);
      const group = space?.groups?.find((g) => g.id === t.groupId);
      if (group) c.group = group.name;
      return c;
    });
}

/** Export everything, or a single space when `spaceId` is given. */
export function exportConfig(s: State, now: number, spaceId?: SpaceId): ChordConfig {
  const spaces = (spaceId ? [spaceById(s, spaceId)].filter((sp) => sp !== undefined) : s.spaces).filter((sp) => !sp.lock);
  const config: ChordConfig = {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt: new Date(now).toISOString(),
    favorites: spaceId ? [] : tabsToConfig(s, s.favorites),
    spaces: spaces.map((sp) => ({
      name: sp.name,
      color: sp.color,
      icon: sp.icon,
      modes: sp.modes && sp.modes.length ? sp.modes : undefined,
      curators: sp.curators && sp.curators.length ? sp.curators.map((c) => ({ name: c.name, input: c.input, feed: c.feed, kind: c.kind })) : undefined,
      profile: sp.profile,
      pinned: tabsToConfig(s, sp.pinned, sp),
      today: tabsToConfig(s, sp.today, sp),
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
    if (typeof raw.group === 'string' && raw.group.trim()) tab.group = raw.group.trim().slice(0, 60);
    if (raw.keepLoaded === true) tab.keepLoaded = true;
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
        modes: Array.isArray(sp.modes) ? sp.modes.filter(isModeId) : undefined,
        curators: Array.isArray(sp.curators) ? sp.curators.filter((c): c is ConfigCurator => isRecord(c) && typeof c.feed === 'string' && /^https?:\/\//i.test(c.feed) && (c.kind === 'feed' || c.kind === 'github')).map((c) => ({ name: typeof c.name === 'string' ? c.name.slice(0, 100) : '', input: typeof c.input === 'string' ? c.input.slice(0, 300) : c.feed, feed: c.feed, kind: c.kind })) : undefined,
        profile: typeof sp.profile === 'string' && sp.profile.trim() ? sp.profile.trim().slice(0, 40) : undefined,
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
      if (typeof r.downloadDir === 'string' || r.downloadDir === null) settings.downloadDir = r.downloadDir;
      if (typeof r.closeToTray === 'boolean') settings.closeToTray = r.closeToTray;
      if (Array.isArray(r.boosts)) settings.boosts = r.boosts.filter(isBoost);
      if (typeof r.autoPip === 'boolean') settings.autoPip = r.autoPip;
      if (isRecord(r.ai) && (r.ai.provider === 'anthropic' || r.ai.provider === 'openai')) settings.ai = { provider: r.ai.provider, baseUrl: typeof r.ai.baseUrl === 'string' ? r.ai.baseUrl : '', model: typeof r.ai.model === 'string' ? r.ai.model : '' };
      if (Array.isArray(r.tilings)) settings.tilings = r.tilings.filter((t): t is { name: string; spec: string } => typeof t === 'object' && t !== null && typeof (t as { name?: unknown }).name === 'string' && typeof (t as { spec?: unknown }).spec === 'string');
      if (typeof r.searchEngine === 'string' && ['duckduckgo', 'google', 'brave', 'kagi', 'startpage'].includes(r.searchEngine)) {
        settings.searchEngine = r.searchEngine as Settings['searchEngine'];
      if (r.googleSignIn === 'firefox' || r.googleSignIn === 'electron' || r.googleSignIn === 'off') settings.googleSignIn = r.googleSignIn;
      if (r.passkeys === 'chord' || r.passkeys === 'system') settings.passkeys = r.passkeys;
      if (isRecord(r.sourceror)) settings.sourceror = { server: typeof r.sourceror.server === 'string' ? r.sourceror.server : 'http://127.0.0.1:5010', checkLinks: r.sourceror.checkLinks !== false, useLlm: r.sourceror.useLlm !== false, discover: r.sourceror.discover !== false };
      }
      if (isRecord(r.theme)) {
        const t = r.theme;
        const theme: Partial<Theme> = {};
        if (t.mode === 'system' || t.mode === 'light' || t.mode === 'dark') theme.mode = t.mode;
        if (typeof t.tint === 'number') theme.tint = clampTint(t.tint);
        if (isHex(t.accent) || t.accent === null) theme.accent = t.accent;
        if (t.iconStyle === 'color' || t.iconStyle === 'mono') theme.iconStyle = t.iconStyle;
      if (t.favicons === 'on' || t.favicons === 'active' || t.favicons === 'off') theme.favicons = t.favicons;
        if (isHex(t.iconColor) || t.iconColor === null) theme.iconColor = t.iconColor;
        if (t.font === 'system' || t.font === 'rounded' || t.font === 'mono' || t.font === 'serif') theme.font = t.font;
        if (t.skin === 'chord' || t.skin === 'lcars') theme.skin = t.skin;
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
    keepLoaded: c.keepLoaded || undefined,
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
    // Private spaces are untouched: they are neither exported nor replaced.
    const privateIds = new Set(s.spaces.filter((sp) => sp.lock).map((sp) => sp.id));
    const all = Object.values(s.tabs).filter((t) => !(t.spaceId && privateIds.has(t.spaceId)));
    for (const t of all) {
      s.archived.unshift({ id: t.id, url: t.url, title: t.title, favicon: t.favicon, spaceId: t.spaceId, archivedAt: ctx.now });
      delete s.tabs[t.id];
    }
    if (s.archived.length > MAX_ARCHIVED) s.archived.length = MAX_ARCHIVED;
    s.favorites = [];
    s.spaces = s.spaces.filter((sp) => sp.lock);
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
    if (cs.profile && !space.profile) space.profile = cs.profile;
    if (cs.curators && cs.curators.length) {
      const have = new Set((space.curators ?? []).map((c) => c.feed));
      const add = cs.curators.filter((c) => !have.has(c.feed)).map((c) => ({ id: ctx.newId(), name: c.name, input: c.input, feed: c.feed, kind: c.kind, addedAt: ctx.now }));
      if (add.length) space.curators = [...(space.curators ?? []), ...add];
    }
    if (cs.modes && cs.modes.length) {
      space.modes = [...new Set([...(space.modes ?? []), ...cs.modes])];
      if (!space.panelMode) space.panelMode = space.modes[0];
    }
    const have = urlsIn(s, [...space.pinned, ...space.today]);
    const groupFor = (name: string | undefined): string | undefined => {
      if (!name) return undefined;
      let g = space.groups?.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!g) {
        g = { id: ctx.newId(), name };
        space.groups = [...(space.groups ?? []), g];
      }
      return g.id;
    };
    for (const c of cs.pinned) {
      if (have.has(c.url)) continue;
      have.add(c.url);
      const id = addTab(s, ctx, c, space.id, 'pinned');
      space.pinned.push(id);
      const gid = groupFor(c.group);
      if (gid) s.tabs[id].groupId = gid;
    }
    for (const c of cs.today) {
      if (have.has(c.url)) continue;
      have.add(c.url);
      const id = addTab(s, ctx, c, space.id, 'today');
      space.today.push(id);
      const gid = groupFor(c.group);
      if (gid) s.tabs[id].groupId = gid;
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
