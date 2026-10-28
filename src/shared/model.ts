// Pure state model: no Electron, no side effects. Every transition takes a
// State and returns a new State, so it can be unit-tested in plain Node.

import type { Action, ArchivedTab, Settings, Space, SpaceId, State, Tab, TabGroup, TabId, Theme, WindowState } from './types.ts';
import { titleFor } from './url.ts';
import { importConfig } from './config.ts';
import { mergeBookmarks, normalizeBookmarkUrl, normalizeTags, pruneTombstones, sanitize as sanitizeBookmark } from './bookmarks.ts';
import { cellCount, parseTiling, presetsFor } from './tiling.ts';
import { isBoost } from './boosts.ts';
import { clampPanel, isModeId } from './modes.ts';

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
  return { mode: 'system', tint: 30, accent: null, iconStyle: 'color', iconColor: null, font: 'system', skin: 'chord', favicons: 'on' };
}

export function defaultSettings(): Settings {
  return { theme: defaultTheme(), smartPages: true, askDownloadPath: false, downloadDir: null, closeToTray: false, tilings: [], boosts: [], autoPip: false, panelOpen: true, panelWidth: 360, ai: { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' }, addressBar: false, extensions: [], sidebarOpen: true, sidebarWidth: 260, archiveAfterHours: 12, shields: true, searchEngine: 'duckduckgo', googleSignIn: 'firefox', passkeys: 'chord', sync: { enabled: false, user: '', privateRepo: 'chord-private', publicRepo: 'chord-bookmarks' }, littleWindows: true, autofill: true, passwordLock: false, passwordSync: false, flags: {}, pageTabs: [], updates: { check: true, auto: true }, mcp: { enabled: false, port: 23120 }, sourceror: { server: 'http://127.0.0.1:5010', checkLinks: true, useLlm: true, discover: true } };
}

/** Deep-ish merge of persisted settings over the defaults. */
export function mergeSettings(raw: unknown): Settings {
  const r = (raw ?? {}) as Partial<Settings>;
  const theme = { ...defaultTheme(), ...((r.theme ?? {}) as Partial<Theme>) };
  theme.tint = clampTint(theme.tint);
  if (theme.skin !== 'lcars') theme.skin = 'chord';
  const extensions = Array.isArray(r.extensions)
    ? r.extensions.filter((e): e is Settings['extensions'][number] => typeof e === 'object' && e !== null && typeof e.path === 'string')
    : [];
  const tilings = Array.isArray(r.tilings)
    ? r.tilings.filter((t): t is { name: string; spec: string } => typeof t === 'object' && t !== null && typeof t.name === 'string' && typeof t.spec === 'string' && parseTiling(t.spec) !== null)
    : [];
  const boosts = Array.isArray(r.boosts) ? r.boosts.filter(isBoost) : [];
  const ai = { ...defaultSettings().ai, ...((r.ai ?? {}) as Partial<Settings['ai']>) };
  if (ai.provider !== 'anthropic' && ai.provider !== 'openai') ai.provider = 'openai';
  const rawFlags = (typeof r.flags === 'object' && r.flags !== null ? r.flags : {}) as Record<string, unknown>;
  const flags: Settings['flags'] = {};
  for (const k of ['noHwVideoDecode', 'noMacOverlays', 'noGraphite', 'noGpuCompositing', 'noGpu', 'noPageHooks'] as const) if (rawFlags[k] === true) flags[k] = true;
  const pageTabs = Array.isArray(r.pageTabs) ? r.pageTabs.filter((o): o is string => typeof o === 'string' && /^https?:\/\/[^/]+$/.test(o)) : [];
  const ru = (typeof r.updates === 'object' && r.updates !== null ? r.updates : {}) as Partial<Settings['updates']>;
  const updates = { check: ru.check !== false, auto: ru.auto !== false };
  const rm = (typeof r.mcp === 'object' && r.mcp !== null ? r.mcp : {}) as Partial<Settings['mcp']>;
  const mcp = { enabled: rm.enabled === true, port: typeof rm.port === 'number' && rm.port >= 1024 && rm.port <= 65535 ? Math.round(rm.port) : 23120 };
  const googleSignIn: Settings['googleSignIn'] = r.googleSignIn === 'electron' || r.googleSignIn === 'off' ? r.googleSignIn : 'firefox';
  const passkeys: Settings['passkeys'] = r.passkeys === 'system' ? 'system' : 'chord';
  const rsync = (typeof r.sync === 'object' && r.sync !== null ? r.sync : {}) as Partial<Settings['sync']>;
  const repoName = (v: unknown, d: string) => (typeof v === 'string' && /^[\w.-]{1,100}$/.test(v) ? v : d);
  const sync: Settings['sync'] = { enabled: rsync.enabled === true, user: typeof rsync.user === 'string' ? rsync.user.slice(0, 60) : '', privateRepo: repoName(rsync.privateRepo, 'chord-private'), publicRepo: repoName(rsync.publicRepo, 'chord-bookmarks') };
  if (typeof rsync.clientId === 'string' && /^[\w.]{10,80}$/.test(rsync.clientId)) sync.clientId = rsync.clientId;
  if (rsync.theme === 'pragmatic' || rsync.theme === 'digg' || rsync.theme === 'elegant') sync.theme = rsync.theme;
  const rs = (typeof r.sourceror === 'object' && r.sourceror !== null ? r.sourceror : {}) as Partial<Settings['sourceror']>;
  const sourceror = { server: typeof rs.server === 'string' && /^https?:\/\//.test(rs.server) ? rs.server.replace(/\/+$/, '') : 'http://127.0.0.1:5010', checkLinks: rs.checkLinks !== false, useLlm: rs.useLlm !== false, discover: rs.discover !== false };
  const merged = { ...defaultSettings(), ...r, theme, extensions, tilings, boosts, ai, flags, pageTabs, updates, mcp, googleSignIn, passkeys, sync, sourceror, littleWindows: r.littleWindows !== false, autofill: r.autofill !== false, passwordLock: r.passwordLock === true, passwordSync: r.passwordSync === true };
  merged.panelWidth = clampPanel(typeof merged.panelWidth === 'number' ? merged.panelWidth : 360);
  return merged;
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
    bookmarks: [],
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
    bookmarks: Array.isArray(r.bookmarks) ? r.bookmarks.filter((b) => b && typeof b.id === 'string' && typeof b.url === 'string').map(sanitizeBookmark) : [],
    activeSpaceId: r.activeSpaceId ?? r.spaces[0].id,
    tabs: r.tabs ?? {},
    favorites: r.favorites ?? [],
    archived: r.archived ?? [],
    recentlyClosed: r.recentlyClosed ?? [],
    settings: mergeSettings(r.settings),
  };
  if (Array.isArray(r.windows)) {
    const seen = new Set<string>();
    s.windows = r.windows.filter((w): w is WindowState => typeof w === 'object' && w !== null && typeof w.spaceId === 'string' && !seen.has(w.spaceId) && !!seen.add(w.spaceId));
    if (s.windows.length === 0) delete s.windows;
  }
  const exists = (id: TabId) => id in s.tabs;
  s.favorites = s.favorites.filter(exists);
  for (const sp of s.spaces) {
    sp.pinned = (sp.pinned ?? []).filter(exists);
    sp.today = (sp.today ?? []).filter(exists);
    sp.panes = (sp.panes ?? []).filter(exists);
    sp.focused = sp.focused && exists(sp.focused) ? sp.focused : sp.panes[0] ?? null;
  }
  if (!spaceById(s, s.activeSpaceId)) s.activeSpaceId = s.spaces[0].id;
  for (const sp of s.spaces) {
    const groups = (Array.isArray(sp.groups) ? sp.groups : []).filter((g): g is TabGroup => typeof g === 'object' && g !== null && typeof g.id === 'string' && typeof g.name === 'string');
    for (const g of groups) if (g.owner && !exists(g.owner)) delete g.owner;
    for (const id of [...sp.pinned, ...sp.today]) {
      const t = s.tabs[id];
      if (t.groupId && !groups.some((g) => g.id === t.groupId)) delete t.groupId;
    }
    sp.groups = groups.filter((g) => g.owner || membersOf(s, sp, g.id).length > 0);
    if (sp.groups.length === 0) delete sp.groups;
  }
  for (const t of Object.values(s.tabs)) {
    t.awake = false;
    t.loading = false;
    t.audible = false;
    t.crashed = false;
  }
  // Private spaces start locked; everything else wakes the panes of the active space.
  for (const sp of s.spaces) {
    if (sp.lock) sp.locked = true;
    if (sp.modes) sp.modes = sp.modes.filter(isModeId);
    if (sp.notes !== undefined && typeof sp.notes !== 'string') delete sp.notes;
    if (sp.curators) {
      sp.curators = sp.curators.filter((c) => c && typeof c.id === 'string' && typeof c.feed === 'string' && (c.kind === 'feed' || c.kind === 'github'));
      if (sp.curators.length === 0) delete sp.curators;
    }
    if (sp.panelMode && !(sp.modes ?? []).includes(sp.panelMode)) delete sp.panelMode;
  }
  if (!isLocked(activeSpace(s))) for (const id of activeSpace(s).panes) s.tabs[id].awake = true;
  for (const sp of s.spaces) wakeKept(s, sp);
  return s;
}

/** Tabs marked "keep loaded" are awake whenever their space is unlocked, shown or not. */
function wakeKept(s: State, sp: Space): void {
  if (isLocked(sp)) return;
  for (const id of [...sp.pinned, ...sp.today]) {
    const t = s.tabs[id];
    if (t?.keepLoaded && !t.crashed) t.awake = true;
  }
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
  if (isLocked(sp)) return undefined;
  return sp.focused ? s.tabs[sp.focused] : undefined;
}

/** A private space counts as locked unless it was explicitly unlocked this session. */
export function isLocked(sp: Space): boolean {
  return Boolean(sp.lock) && sp.locked !== false;
}

/** The side panel is visible when the space has modes, is unlocked and the panel is open. */
export function panelVisible(s: State): boolean {
  return panelVisibleFor(s, activeSpace(s));
}

export function panelVisibleFor(s: State, sp: Space): boolean {
  return s.settings.panelOpen && (sp.modes?.length ?? 0) > 0 && !isLocked(sp);
}

/** Panes to show: none while the space is locked. */
export function visiblePanes(sp: Space): TabId[] {
  return isLocked(sp) ? [] : sp.panes;
}

/** Private spaces lock again after this long away from them. */
export const AUTO_LOCK_MS = 15 * 60_000;

function lockSpace(s: State, sp: Space): void {
  sp.locked = true;
  for (const id of [...sp.pinned, ...sp.today]) {
    const t = s.tabs[id];
    if (!t) continue;
    t.awake = false;
    t.loading = false;
    t.audible = false;
  }
}

/** Actions that act on the active space and must wait until it is unlocked. */
const NEEDS_UNLOCKED = new Set<Action['type']>(['tab.closeActive', 'tab.next', 'tab.prev', 'tab.jump', 'tab.split', 'tab.unsplit', 'pane.focus', 'today.clear', 'space.tiling', 'space.tilingNext', 'closed.reopen', 'tab.togglePin']);

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
  if (!spaceOfTab(s, tab).lock) {
    s.archived.unshift(toArchive(tab, now));
    if (s.archived.length > MAX_ARCHIVED) s.archived.length = MAX_ARCHIVED;
  }
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

// ---- subspaces (tab groups) ----

export function membersOf(s: State, space: Space, groupId: string): TabId[] {
  return [...space.pinned, ...space.today].filter((id) => s.tabs[id]?.groupId === groupId);
}

export function groupOf(s: State, tab: Tab): TabGroup | undefined {
  if (!tab.groupId || !tab.spaceId) return undefined;
  return spaceById(s, tab.spaceId)?.groups?.find((g) => g.id === tab.groupId);
}

/** Put `id` into `groupId` of its own space, placed right after the group's last member. */
function setGroup(s: State, id: TabId, groupId: string | null): void {
  const tab = s.tabs[id];
  if (!tab || !tab.spaceId || tab.kind === 'favorite') return;
  const space = spaceById(s, tab.spaceId);
  if (!space) return;
  if (!groupId) {
    delete tab.groupId;
    return;
  }
  if (!space.groups?.some((g) => g.id === groupId)) return;
  const members = membersOf(s, space, groupId).filter((m) => m !== id);
  tab.groupId = groupId;
  const last = members[members.length - 1];
  if (!last) return;
  const lastTab = s.tabs[last];
  const list: 'pinned' | 'today' = lastTab?.kind === 'pinned' ? 'pinned' : 'today';
  if (tab.kind !== list) return; // kinds stay as they are; rendering pulls the group together anyway
  const arr = space[list];
  const from = arr.indexOf(id);
  if (from >= 0) arr.splice(from, 1);
  arr.splice(arr.indexOf(last) + 1, 0, id);
}

function dropGroup(s: State, space: Space, groupId: string): void {
  for (const id of membersOf(s, space, groupId)) delete s.tabs[id]?.groupId;
  space.groups = (space.groups ?? []).filter((g) => g.id !== groupId);
  if (space.groups.length === 0) delete space.groups;
}

function findGroup(s: State, groupId: string): { space: Space; group: TabGroup } | undefined {
  for (const space of s.spaces) {
    const group = space.groups?.find((g) => g.id === groupId);
    if (group) return { space, group };
  }
  return undefined;
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
  // A page that manages a subspace takes it along when it closes.
  if (tab.spaceId) {
    const sp = spaceById(s, tab.spaceId);
    for (const g of (sp?.groups ?? []).filter((g) => g.owner === id)) {
      for (const member of membersOf(s, sp!, g.id)) {
        if (member === id) continue;
        if (s.tabs[member]?.kind === 'today') closeTab(s, member, now);
        else delete s.tabs[member]?.groupId;
      }
      sp!.groups = sp!.groups!.filter((x) => x.id !== g.id);
      if (sp!.groups.length === 0) delete sp!.groups;
    }
  }
  const affected = s.spaces.filter((sp) => sp.panes.includes(id));
  const formerIndexes = new Map(affected.map((sp) => [sp.id, sp.today.indexOf(id)]));
  if (tab.kind === 'today') {
    if (!spaceOfTab(s, tab).lock) {
      s.recentlyClosed.unshift(toArchive(tab, now));
      if (s.recentlyClosed.length > MAX_RECENTLY_CLOSED) s.recentlyClosed.length = MAX_RECENTLY_CLOSED;
    }
    removeEverywhere(s, id);
    delete s.tabs[id];
  } else {
    // Pinned and favorite tabs do not go away: they go to sleep and reset to their home page (kept ones reload it).
    tab.awake = Boolean(tab.keepLoaded);
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
  if (list === 'favorites' || tab.spaceId !== space.id) delete tab.groupId;
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
  if (isLocked(space) && NEEDS_UNLOCKED.has(a.type)) return prev;

  switch (a.type) {
    case 'tab.new': {
      const target = spaceById(s, a.spaceId) ?? space;
      if (isLocked(target)) return prev;
      newTab(s, ctx, a.url, target.id, { id: a.id, activate: a.activate ?? true, adopt: a.adopt });
      return s;
    }
    case 'tab.activate': {
      const tab = s.tabs[a.id];
      if (!tab) return prev;
      const target = spaceOfTab(s, tab);
      if (isLocked(target)) return prev;
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
    case 'tab.volume': {
      const tab = s.tabs[a.id];
      if (!tab) return prev;
      const v = Math.round(Math.max(0, Math.min(1, Number.isFinite(a.volume) ? a.volume : 1)) * 100) / 100;
      if (v >= 1) delete tab.volume;
      else tab.volume = v;
      return s;
    }
    case 'tab.patch': {
      const tab = s.tabs[a.id];
      if (!tab) return prev;
      Object.assign(tab, a.patch);
      return s;
    }
    case 'bookmark.add': {
      const url = normalizeBookmarkUrl(a.url);
      if (!/^(https?|file):/i.test(url)) return prev;
      const existing = s.bookmarks.find((b) => !b.deletedAt && normalizeBookmarkUrl(b.url) === url);
      if (existing) {
        existing.public = a.public;
        if (a.title) existing.title = a.title.slice(0, 300);
        if (a.tags) existing.tags = normalizeTags([...existing.tags, ...a.tags]);
        if (a.note && !existing.note) existing.note = a.note.slice(0, 2000);
        existing.updatedAt = now;
        return s;
      }
      s.bookmarks.unshift({ id: ctx.newId(), url, title: (a.title || url).slice(0, 300), note: (a.note ?? '').slice(0, 2000), tags: normalizeTags(a.tags ?? []), public: a.public, addedAt: now, updatedAt: now, spaceId: a.spaceId ?? null });
      return s;
    }
    case 'bookmark.update': {
      const b = s.bookmarks.find((x) => x.id === a.id && !x.deletedAt);
      if (!b) return prev;
      if (typeof a.patch.title === 'string') b.title = a.patch.title.slice(0, 300);
      if (typeof a.patch.note === 'string') b.note = a.patch.note.slice(0, 2000);
      if (a.patch.tags) b.tags = normalizeTags(a.patch.tags);
      if (typeof a.patch.public === 'boolean') b.public = a.patch.public;
      if (a.patch.spaceId !== undefined) b.spaceId = a.patch.spaceId && spaceById(s, a.patch.spaceId) ? a.patch.spaceId : null;
      if (typeof a.patch.url === 'string' && /^(https?|file):/i.test(a.patch.url)) b.url = normalizeBookmarkUrl(a.patch.url);
      b.updatedAt = now;
      return s;
    }
    case 'bookmark.remove': {
      const b = s.bookmarks.find((x) => x.id === a.id && !x.deletedAt);
      if (!b) return prev;
      b.deletedAt = now;
      b.updatedAt = now;
      return s;
    }
    case 'bookmarks.merge': {
      const { merged, changed } = mergeBookmarks(s.bookmarks, a.remote);
      if (!changed) return prev;
      s.bookmarks = merged;
      return s;
    }
    case 'space.notes': {
      const sp = spaceById(s, a.id);
      if (!sp) return prev;
      const text = a.text.slice(0, 200_000);
      if ((sp.notes ?? '') === text) return prev;
      if (text.trim()) sp.notes = text;
      else delete sp.notes;
      return s;
    }
    case 'space.setCurators': {
      const sp = spaceById(s, a.id);
      if (!sp) return prev;
      sp.curators = a.curators.length ? a.curators.map((c) => ({ ...c })) : undefined;
      if (!sp.curators) delete sp.curators;
      return s;
    }
    case 'tab.keepLoaded': {
      const tab = s.tabs[a.id];
      if (!tab || Boolean(tab.keepLoaded) === a.on) return prev;
      if (a.on) tab.keepLoaded = true;
      else delete tab.keepLoaded;
      const sp = spaceById(s, tab.spaceId);
      if (a.on && (!sp || !isLocked(sp))) {
        tab.awake = true;
        delete tab.crashed;
      }
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
      if (isLocked(target)) return prev;
      insertInto(s, a.id, a.list, target, a.index);
      return s;
    }
    case 'group.create': {
      const target = spaceById(s, a.spaceId) ?? (a.owner ? spaceById(s, s.tabs[a.owner]?.spaceId) : undefined) ?? space;
      if (isLocked(target)) return prev;
      const name = a.name.trim().slice(0, 60) || 'Subspace';
      const id = a.id ?? ctx.newId();
      if (target.groups?.some((g) => g.id === id)) return prev;
      const group: TabGroup = { id, name };
      if (a.owner && s.tabs[a.owner]?.spaceId === target.id) group.owner = a.owner;
      target.groups = [...(target.groups ?? []), group];
      for (const t of a.tabIds ?? []) if (s.tabs[t]?.spaceId === target.id) setGroup(s, t, id);
      return s;
    }
    case 'group.rename': {
      const f = findGroup(s, a.id);
      if (!f) return prev;
      f.group.name = a.name.trim().slice(0, 60) || f.group.name;
      return s;
    }
    case 'group.toggle': {
      const f = findGroup(s, a.id);
      if (!f) return prev;
      if (f.group.collapsed) delete f.group.collapsed;
      else f.group.collapsed = true;
      return s;
    }
    case 'group.dissolve': {
      const f = findGroup(s, a.id);
      if (!f) return prev;
      dropGroup(s, f.space, a.id);
      return s;
    }
    case 'group.close': {
      const f = findGroup(s, a.id);
      if (!f) return prev;
      for (const id of membersOf(s, f.space, a.id)) {
        if (s.tabs[id]?.kind === 'today') closeTab(s, id, now);
        else delete s.tabs[id]?.groupId;
      }
      if (findGroup(s, a.id)) dropGroup(s, f.space, a.id);
      return s;
    }
    case 'windows.set': {
      const windows = a.windows.filter((w) => spaceById(s, w.spaceId));
      if (JSON.stringify(windows) === JSON.stringify(s.windows ?? [])) return prev;
      s.windows = windows;
      return s;
    }
    case 'tab.setGroup': {
      if (!s.tabs[a.id]) return prev;
      setGroup(s, a.id, a.groupId);
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
    case 'space.profile': {
      const sp = spaceById(s, a.id);
      if (!sp) return prev;
      const name = (a.profile ?? '').trim().slice(0, 40);
      if (name) sp.profile = name;
      else delete sp.profile;
      return s;
    }
    case 'space.modes': {
      const sp = spaceById(s, a.id);
      if (!sp) return prev;
      const modes = a.modes.filter(isModeId);
      sp.modes = modes;
      if (!sp.panelMode || !modes.includes(sp.panelMode)) sp.panelMode = modes[0];
      if (modes.length === 0) delete sp.panelMode;
      return s;
    }
    case 'panel.toggle': {
      s.settings.panelOpen = a.open ?? !s.settings.panelOpen;
      return s;
    }
    case 'panel.mode': {
      if (!(space.modes ?? []).includes(a.mode)) return prev;
      space.panelMode = a.mode;
      s.settings.panelOpen = true;
      return s;
    }
    case 'panel.resize': {
      s.settings.panelWidth = clampPanel(a.width);
      return s;
    }
    case 'space.setLock': {
      const sp = spaceById(s, a.id);
      if (!sp) return prev;
      if (a.lock) {
        sp.lock = a.lock;
        sp.locked = false;
      } else {
        delete sp.lock;
        delete sp.locked;
        wakeKept(s, sp);
      }
      return s;
    }
    case 'space.lock': {
      const sp = spaceById(s, a.id);
      if (!sp || !sp.lock || isLocked(sp)) return prev;
      lockSpace(s, sp);
      return s;
    }
    case 'space.lockAll': {
      let changed = false;
      for (const sp of s.spaces) {
        if (sp.lock && !isLocked(sp)) {
          lockSpace(s, sp);
          changed = true;
        }
      }
      return changed ? s : prev;
    }
    case 'space.unlocked': {
      const sp = spaceById(s, a.id);
      if (!sp || !sp.lock) return prev;
      sp.locked = false;
      if (sp.id === s.activeSpaceId) for (const id of sp.panes) show(s, sp, id, now);
      wakeKept(s, sp);
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
      if (space.id !== a.id) space.leftAt = now;
      s.activeSpaceId = a.id;
      const next = activeSpace(s);
      if (!isLocked(next)) for (const id of next.panes) show(s, next, id, now);
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
      if (a.patch.reader !== undefined) {
        if (a.patch.reader) sp.reader = true;
        else delete sp.reader;
      }
      return s;
    }
    case 'space.delete': {
      const sp = spaceById(s, a.id);
      if (!sp || s.spaces.length <= 1 || isLocked(sp)) return prev;
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
      s.settings.extensions.push({ path: a.path, enabled: true, name: a.name, version: a.version, ...(a.storeId ? { storeId: a.storeId } : {}) });
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
      let changed = false;
      const pruned = pruneTombstones(s.bookmarks, now);
      if (pruned.length !== s.bookmarks.length) {
        s.bookmarks = pruned;
        changed = true;
      }
      for (const sp of s.spaces) {
        if (sp.lock && !isLocked(sp) && sp.id !== s.activeSpaceId && now - (sp.leftAt ?? now) >= AUTO_LOCK_MS) {
          lockSpace(s, sp);
          changed = true;
        }
      }
      const ttl = s.settings.archiveAfterHours * 3600_000;
      if (!(ttl > 0)) return changed ? s : prev;
      for (const sp of s.spaces) {
        if (sp.lock) continue; // private spaces leave no trace in the archive
        for (const id of [...sp.today]) {
          const tab = s.tabs[id];
          if (!tab || sp.panes.includes(id) || tab.keepLoaded) continue;
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
