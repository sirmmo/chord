// Pure state model: no Electron, no side effects. Every transition takes a
// State and returns a new State, so it can be unit-tested in plain Node.

import type { Action, ArchivedTab, Settings, Space, SpaceId, State, Tab, TabId, Theme } from './types.ts';
import { titleFor } from './url.ts';
import { importConfig } from './config.ts';
import { cellCount, parseTiling, presetsFor } from './tiling.ts';

export const SPACE_COLORS = ['#5B6CFF', '#FF6B6B', '#2EC4B6', '#FFB347', '#B388FF', '#4CC9F0', '#F72585', '#8AC926'];
export const MAX_PANES = 4;
export const MAX_ARCHIVED = 500;
export const MAX_RECENTLY_CLOSED = 50;
export const MIN_SIDEBAR = 180;
export const MAX_SIDEBAR = 480;

export interface Ctx {
  now: number;
  newId: () => string;
}

export function defaultTheme(): Theme {
  return { mode: 'system', tint: 30, accent: null, iconStyle: 'color', iconColor: null, font: 'system' };
}

export function defaultSettings(): Settings {
  return { theme: defaultTheme(), smartPages: true, askDownloadPath: false, closeToTray: false, tilings: [], addressBar: false, extensions: [], sidebarOpen: true, sidebarWidth: 260, archiveAfterHours: 12, shields: true, searchEngine: 'duckduckgo' };
}

/** Deep-ish merge of persisted settings over the defaults. */
export function mergeSettings(raw: unknown): Settings {
  const r = (raw ?? {}) as Partial<Settings>;
  const theme = { ...defaultTheme(), ...((r.theme ?? {}) as Partial<Theme>) };
  theme.tint = clampTint(theme.tint);
  const extensions = Array.isArray(r.extensions)
    ? r.extensions.filter((e): e is Settings['extensions'][number] => typeof e === 'object' && e !== null && typeof e.path === 'string')
    : [];
  const tilings = Array.isArray(r.tilings)
    ? r.tilings.filter((t): t is { name: string; spec: string } => typeof t === 'object' && t !== null && typeof t.name === 'string' && typeof t.spec === 'string' && parseTiling(t.spec) !== null)
    : [];
  return { ...defaultSettings(), ...r, theme, extensions, tilings };
}

export function clampTint(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 30;
  return Math.round(Math.max(0, Math.min(100, n)));
}

export function makeSpace(index: number, ctx: Ctx, name?: string, color?: string, icon?: string): Space {
  return {
    id: ctx.newId(),
    name: name ?? (index === 0 ? 'Personal' : `Space ${index + 1}`),
    color: color ?? SPACE_COLORS[index % SPACE_COLORS.length],
    icon,
    pinned: [],
    today: [],
    panes: [],
    focused: null,
  };
}

export function initialState(ctx: Ctx): State {
  const space = makeSpace(0, ctx);
  return {
    version: 1,
    spaces: [space],
    activeSpaceId: space.id,
    tabs: {},
    favorites: [],
    archived: [],
    recentlyClosed: [],
    settings: defaultSettings(),
  };
}

/** Bring a persisted state back to a consistent shape: nothing awake, dangling ids removed. */
export function hydrate(raw: unknown, ctx: Ctx): State {
  const r = raw as Partial<State> | null;
  if (!r || r.version !== 1 || !Array.isArray(r.spaces) || r.spaces.length === 0 || typeof r.tabs !== 'object') {
    return initialState(ctx);
  }
  const s: State = {
    version: 1,
    spaces: r.spaces,
    activeSpaceId: r.activeSpaceId ?? r.spaces[0].id,
    tabs: r.tabs ?? {},
    favorites: r.favorites ?? [],
    archived: r.archived ?? [],
    recentlyClosed: r.recentlyClosed ?? [],
    settings: mergeSettings(r.settings),
  };
  const exists = (id: TabId) => id in s.tabs;
  s.favorites = s.favorites.filter(exists);
  for (const sp of s.spaces) {
    sp.pinned = (sp.pinned ?? []).filter(exists);
    sp.today = (sp.today ?? []).filter(exists);
    sp.panes = (sp.panes ?? []).filter(exists);
    sp.focused = sp.focused && exists(sp.focused) ? sp.focused : sp.panes[0] ?? null;
  }
  if (!spaceById(s, s.activeSpaceId)) s.activeSpaceId = s.spaces[0].id;
  for (const t of Object.values(s.tabs)) {
    t.awake = false;
    t.loading = false;
    t.audible = false;
    t.crashed = false;
  }
  // Wake the panes of the active space so the window is not empty on launch.
  for (const id of activeSpace(s).panes) s.tabs[id].awake = true;
  return s;
}

export function spaceById(s: State, id: SpaceId | null | undefined): Space | undefined {
  return id ? s.spaces.find((sp) => sp.id === id) : undefined;
}

export function activeSpace(s: State): Space {
  return spaceById(s, s.activeSpaceId) ?? s.spaces[0];
}

export function spaceOfTab(s: State, tab: Tab): Space {
  return spaceById(s, tab.spaceId) ?? activeSpace(s);
}

export function focusedTab(s: State): Tab | undefined {
  const sp = activeSpace(s);
  return sp.focused ? s.tabs[sp.focused] : undefined;
}

/** The sidebar order used by "next tab", "previous tab" and Cmd+1..9. */
export function orderedTabs(space: Space): TabId[] {
  return [...space.pinned, ...space.today];
}

export function searchTabs(s: State): Tab[] {
  return Object.values(s.tabs);
}

// ---- helpers (mutate the cloned state) ----

function removeEverywhere(s: State, id: TabId): void {
  s.favorites = s.favorites.filter((x) => x !== id);
  for (const sp of s.spaces) {
    sp.pinned = sp.pinned.filter((x) => x !== id);
    sp.today = sp.today.filter((x) => x !== id);
    sp.panes = sp.panes.filter((x) => x !== id);
    if (sp.focused === id) sp.focused = sp.panes[0] ?? null;
  }
}

function show(s: State, space: Space, id: TabId, now: number): void {
  const tab = s.tabs[id];
  if (!tab) return;
  tab.awake = true;
  tab.crashed = false;
  tab.lastActiveAt = now;
  if (!space.panes.includes(id)) {
    const focusedIdx = space.focused ? space.panes.indexOf(space.focused) : -1;
    if (space.panes.length > 1 && focusedIdx >= 0) space.panes[focusedIdx] = id;
    else space.panes = [id];
  }
  space.focused = id;
}

function toArchive(tab: Tab, now: number): ArchivedTab {
  return { id: tab.id, url: tab.url, title: tab.title, favicon: tab.favicon, spaceId: tab.spaceId, archivedAt: now };
}

function archiveTab(s: State, id: TabId, now: number): void {
  const tab = s.tabs[id];
  if (!tab) return;
  s.archived.unshift(toArchive(tab, now));
  if (s.archived.length > MAX_ARCHIVED) s.archived.length = MAX_ARCHIVED;
  removeEverywhere(s, id);
  delete s.tabs[id];
}

function newTab(s: State, ctx: Ctx, url: string, spaceId: SpaceId, opts: { id?: TabId; activate?: boolean; adopt?: boolean; index?: number } = {}): Tab {
  const space = spaceById(s, spaceId) ?? activeSpace(s);
  const id = opts.id ?? ctx.newId();
  const tab: Tab = {
    id,
    spaceId: space.id,
    kind: 'today',
    url,
    title: titleFor(url),
    createdAt: ctx.now,
    lastActiveAt: ctx.now,
    awake: Boolean(opts.activate || opts.adopt),
  };
  s.tabs[id] = tab;
  space.today.splice(opts.index ?? 0, 0, id);
  if (opts.activate) {
    s.activeSpaceId = space.id;
    show(s, space, id, ctx.now);
  }
  return tab;
}

/** After `closedId` left the panes of `space`, decide what to show instead. */
function replaceFocus(s: State, space: Space, closedId: TabId, formerTodayIndex: number, now: number): void {
  if (space.panes.length > 0) {
    if (!space.focused || !space.panes.includes(space.focused)) space.focused = space.panes[0];
    return;
  }
  const list = space.today;
  const candidates = [list[formerTodayIndex], list[formerTodayIndex - 1], list[0], space.pinned[0]];
  const next = candidates.find((id) => id !== undefined && id !== closedId);
  if (next) show(s, space, next, now);
  else space.focused = null;
}

function closeTab(s: State, id: TabId, now: number): void {
  const tab = s.tabs[id];
  if (!tab) return;
  const affected = s.spaces.filter((sp) => sp.panes.includes(id));
  const formerIndexes = new Map(affected.map((sp) => [sp.id, sp.today.indexOf(id)]));
  if (tab.kind === 'today') {
    s.recentlyClosed.unshift(toArchive(tab, now));
    if (s.recentlyClosed.length > MAX_RECENTLY_CLOSED) s.recentlyClosed.length = MAX_RECENTLY_CLOSED;
    removeEverywhere(s, id);
    delete s.tabs[id];
  } else {
    // Pinned and favorite tabs do not go away: they go to sleep and reset to their home page.
    tab.awake = false;
    tab.loading = false;
    tab.audible = false;
    tab.url = tab.homeUrl ?? tab.url;
    tab.title = tab.title || titleFor(tab.url);
    for (const sp of s.spaces) {
      sp.panes = sp.panes.filter((x) => x !== id);
      if (sp.focused === id) sp.focused = sp.panes[0] ?? null;
    }
  }
  for (const sp of affected) replaceFocus(s, sp, id, formerIndexes.get(sp.id) ?? -1, now);
}

function insertInto(s: State, id: TabId, list: 'favorites' | 'pinned' | 'today', space: Space, index: number): void {
  const tab = s.tabs[id];
  if (!tab) return;
  removeEverywhere(s, id);
  const clamp = (arr: TabId[]) => Math.max(0, Math.min(index, arr.length));
  if (list === 'favorites') {
    tab.kind = 'favorite';
    tab.spaceId = null;
    tab.homeUrl = tab.homeUrl ?? tab.url;
    s.favorites.splice(clamp(s.favorites), 0, id);
  } else if (list === 'pinned') {
    tab.kind = 'pinned';
    tab.spaceId = space.id;
    tab.homeUrl = tab.homeUrl ?? tab.url;
    space.pinned.splice(clamp(space.pinned), 0, id);
  } else {
    tab.kind = 'today';
    tab.spaceId = space.id;
    delete tab.homeUrl;
    space.today.splice(clamp(space.today), 0, id);
  }
  // A tab that was being shown somewhere keeps being shown only if it still belongs there.
  if (tab.awake && tab.spaceId) {
    const sp = spaceById(s, tab.spaceId)!;
    if (!sp.panes.includes(id) && sp.panes.length === 0) {
      sp.panes = [id];
      sp.focused = id;
    }
  }
}

function clampSidebar(w: number): number {
  return Math.round(Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, w)));
}

// ---- reducer ----

export function reduce(prev: State, a: Action, ctx: Ctx): State {
  const s: State = structuredClone(prev);
  const now = ctx.now;
  const space = activeSpace(s);

  switch (a.type) {
    case 'tab.new': {
      newTab(s, ctx, a.url, a.spaceId ?? s.activeSpaceId, { id: a.id, activate: a.activate ?? true, adopt: a.adopt });
      return s;
    }
    case 'tab.activate': {
      const tab = s.tabs[a.id];
      if (!tab) return prev;
      const target = spaceOfTab(s, tab);
      s.activeSpaceId = target.id;
      show(s, target, a.id, now);
      return s;
    }
    case 'tab.close': {
      closeTab(s, a.id, now);
      return s;
    }
    case 'tab.closeActive': {
      if (!space.focused) return prev;
      closeTab(s, space.focused, now);
      return s;
    }
    case 'tab.patch': {
      const tab = s.tabs[a.id];
      if (!tab) return prev;
      Object.assign(tab, a.patch);
      return s;
    }
    case 'tab.sleep': {
      const tab = s.tabs[a.id];
      if (!tab) return prev;
      tab.awake = false;
      tab.loading = false;
      tab.audible = false;
      for (const sp of s.spaces) {
        if (!sp.panes.includes(a.id)) continue;
        const idx = sp.today.indexOf(a.id);
        sp.panes = sp.panes.filter((x) => x !== a.id);
        if (sp.focused === a.id) sp.focused = null;
        replaceFocus(s, sp, a.id, idx, now);
      }
      return s;
    }
    case 'tab.pin': {
      const tab = s.tabs[a.id];
      if (!tab) return prev;
      const target = spaceOfTab(s, tab);
      insertInto(s, a.id, 'pinned', target, target.pinned.length);
      return s;
    }
    case 'tab.unpin': {
      const tab = s.tabs[a.id];
      if (!tab) return prev;
      insertInto(s, a.id, 'today', spaceOfTab(s, tab), 0);
      return s;
    }
    case 'tab.togglePin': {
      const id = a.id ?? space.focused;
      const tab = id ? s.tabs[id] : undefined;
      if (!tab) return prev;
      const target = spaceOfTab(s, tab);
      if (tab.kind === 'today') insertInto(s, tab.id, 'pinned', target, target.pinned.length);
      else if (tab.kind === 'pinned') insertInto(s, tab.id, 'today', target, 0);
      else return prev;
      return s;
    }
    case 'tab.favorite': {
      if (!s.tabs[a.id]) return prev;
      insertInto(s, a.id, 'favorites', space, s.favorites.length);
      return s;
    }
    case 'tab.unfavorite': {
      const tab = s.tabs[a.id];
      if (!tab) return prev;
      insertInto(s, a.id, 'pinned', space, space.pinned.length);
      return s;
    }
    case 'tab.move': {
      const target = spaceById(s, a.spaceId) ?? space;
      insertInto(s, a.id, a.list, target, a.index);
      return s;
    }
    case 'tab.split': {
      const tab = s.tabs[a.id];
      if (!tab) return prev;
      if (tab.spaceId && tab.spaceId !== space.id) return prev;
      if (space.panes.includes(a.id)) {
        space.focused = a.id;
        return s;
      }
      if (space.panes.length >= MAX_PANES) return prev;
      tab.awake = true;
      tab.lastActiveAt = now;
      space.panes.push(a.id);
      space.focused = a.id;
      return s;
    }
    case 'space.tiling': {
      const target = a.spaceId ? spaceById(s, a.spaceId) : space;
      if (!target) return prev;
      if (a.spec === null) delete target.tiling;
      else {
        const t = parseTiling(a.spec);
        if (!t) return prev;
        target.tiling = a.spec;
      }
      return s;
    }
    case 'space.tilingNext': {
      const options = presetsFor(space.panes.length, s.settings.tilings).map((p) => p.spec);
      if (options.length === 0) return prev;
      const current = space.tiling && parseTiling(space.tiling) && cellCount(parseTiling(space.tiling)!) === space.panes.length ? options.indexOf(space.tiling) : -1;
      space.tiling = options[(current + 1) % options.length];
      return s;
    }
    case 'tab.unsplit': {
      if (!space.panes.includes(a.id) || space.panes.length <= 1) return prev;
      space.panes = space.panes.filter((x) => x !== a.id);
      if (space.focused === a.id) space.focused = space.panes[0];
      return s;
    }
    case 'pane.focus': {
      if (!space.panes.includes(a.id) || space.focused === a.id) return prev;
      space.focused = a.id;
      s.tabs[a.id].lastActiveAt = now;
      return s;
    }
    case 'tab.next':
    case 'tab.prev': {
      const order = orderedTabs(space);
      if (order.length === 0) return prev;
      const idx = space.focused ? order.indexOf(space.focused) : -1;
      const step = a.type === 'tab.next' ? 1 : -1;
      const next = order[(idx + step + order.length) % order.length];
      show(s, space, next, now);
      return s;
    }
    case 'tab.jump': {
      const order = orderedTabs(space);
      const id = a.index === 8 ? order[order.length - 1] : order[a.index];
      if (!id) return prev;
      show(s, space, id, now);
      return s;
    }
    case 'today.clear': {
      for (const id of [...space.today]) archiveTab(s, id, now);
      space.panes = space.panes.filter((id) => id in s.tabs);
      space.focused = space.panes[0] ?? null;
      return s;
    }
    case 'space.create': {
      const sp = makeSpace(s.spaces.length, ctx, a.name, a.color, a.icon);
      s.spaces.push(sp);
      s.activeSpaceId = sp.id;
      return s;
    }
    case 'space.activate': {
      if (!spaceById(s, a.id)) return prev;
      s.activeSpaceId = a.id;
      for (const id of activeSpace(s).panes) show(s, activeSpace(s), id, now);
      return s;
    }
    case 'space.next':
    case 'space.prev': {
      const idx = s.spaces.findIndex((sp) => sp.id === s.activeSpaceId);
      const step = a.type === 'space.next' ? 1 : -1;
      const target = s.spaces[(idx + step + s.spaces.length) % s.spaces.length];
      s.activeSpaceId = target.id;
      for (const id of target.panes) show(s, target, id, now);
      return s;
    }
    case 'space.update': {
      const sp = spaceById(s, a.id);
      if (!sp) return prev;
      if (a.patch.name !== undefined) sp.name = a.patch.name.trim() || sp.name;
      if (a.patch.color !== undefined) sp.color = a.patch.color;
      if (a.patch.icon !== undefined) sp.icon = a.patch.icon || undefined;
      return s;
    }
    case 'space.delete': {
      const sp = spaceById(s, a.id);
      if (!sp || s.spaces.length <= 1) return prev;
      for (const id of [...sp.pinned, ...sp.today]) archiveTab(s, id, now);
      const idx = s.spaces.indexOf(sp);
      s.spaces.splice(idx, 1);
      if (s.activeSpaceId === sp.id) {
        const fallback = s.spaces[Math.min(idx, s.spaces.length - 1)];
        s.activeSpaceId = fallback.id;
        for (const id of fallback.panes) show(s, fallback, id, now);
      }
      return s;
    }
    case 'sidebar.toggle': {
      s.settings.sidebarOpen = !s.settings.sidebarOpen;
      return s;
    }
    case 'sidebar.resize': {
      s.settings.sidebarWidth = clampSidebar(a.width);
      s.settings.sidebarOpen = true;
      return s;
    }
    case 'settings.update': {
      Object.assign(s.settings, a.patch);
      s.settings.sidebarWidth = clampSidebar(s.settings.sidebarWidth);
      return s;
    }
    case 'extension.add': {
      if (s.settings.extensions.some((e) => e.path === a.path)) return prev;
      s.settings.extensions.push({ path: a.path, enabled: true, name: a.name, version: a.version });
      return s;
    }
    case 'extension.remove': {
      const before = s.settings.extensions.length;
      s.settings.extensions = s.settings.extensions.filter((e) => e.path !== a.path);
      return s.settings.extensions.length === before ? prev : s;
    }
    case 'extension.toggle': {
      const e = s.settings.extensions.find((x) => x.path === a.path);
      if (!e || e.enabled === a.enabled) return prev;
      e.enabled = a.enabled;
      return s;
    }
    case 'extension.info': {
      const e = s.settings.extensions.find((x) => x.path === a.path);
      if (!e || (e.name === a.name && e.version === a.version)) return prev;
      e.name = a.name;
      e.version = a.version;
      return s;
    }
    case 'theme.update': {
      Object.assign(s.settings.theme, a.patch);
      s.settings.theme.tint = clampTint(s.settings.theme.tint);
      return s;
    }
    case 'archived.restore': {
      const idx = s.archived.findIndex((x) => x.id === a.id);
      if (idx < 0) return prev;
      const [entry] = s.archived.splice(idx, 1);
      const target = spaceById(s, entry.spaceId) ?? space;
      const tab = newTab(s, ctx, entry.url, target.id, { activate: true });
      tab.title = entry.title;
      tab.favicon = entry.favicon;
      return s;
    }
    case 'archived.clear': {
      s.archived = [];
      return s;
    }
    case 'closed.reopen': {
      const entry = s.recentlyClosed.shift();
      if (!entry) return prev;
      const target = spaceById(s, entry.spaceId) ?? space;
      const tab = newTab(s, ctx, entry.url, target.id, { activate: true });
      tab.title = entry.title;
      tab.favicon = entry.favicon;
      return s;
    }
    case 'config.import': {
      importConfig(s, a.config, a.mode, ctx);
      return s;
    }
    case 'tick': {
      const ttl = s.settings.archiveAfterHours * 3600_000;
      if (!(ttl > 0)) return prev;
      let changed = false;
      for (const sp of s.spaces) {
        for (const id of [...sp.today]) {
          const tab = s.tabs[id];
          if (!tab || sp.panes.includes(id)) continue;
          if (now - tab.lastActiveAt > ttl) {
            archiveTab(s, id, now);
            changed = true;
          }
        }
      }
      return changed ? s : prev;
    }
    default:
      return prev;
  }
}
