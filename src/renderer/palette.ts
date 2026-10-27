// The overlay page: command bar (⌘T / ⌘L) and find bar (⌘F).

import { presetsFor } from '../shared/tiling.ts';
import type { Message, State, Tab } from '../shared/types.ts';
import { activeSpace, focusedTab } from '../shared/model.ts';
import { applyTheme } from './theme.ts';
import { hostOf, searchUrl, SEARCH_ENGINES, toUrl } from '../shared/url.ts';
import { h, svg, ICONS, initialOf } from './dom.ts';

interface Item {
  group: string;
  icon: Node | string;
  title: string;
  subtitle?: string;
  hint?: string;
  run: (opts: { newTab: boolean }) => void;
}

const api = window.chord;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const dispatch = (m: Message) => void api.dispatch(m);

const input = $<HTMLInputElement>('#input');
const results = $<HTMLUListElement>('#results');
const intentHint = $('#intent');
const findInput = $<HTMLInputElement>('#find-input');
const findCount = $('#find-count');

let state: State | null = null;
let mode: 'palette' | 'find' | null = null;
let intent: 'new' | 'current' = 'new';
let items: Item[] = [];
let selected = 0;
let lastFind = '';

$('#input-icon').append(svg(ICONS.command, 18));

api.onState((s) => {
  state = s;
  applyTheme(s.settings.theme, activeSpace(s));
  if (mode === 'palette') update();
});
api.getState().then((s) => {
  if (s) {
    state = s;
    applyTheme(s.settings.theme, activeSpace(s));
  }
});
api.onOverlay((m) => {
  switch (m.kind) {
    case 'show':
      if (m.mode === 'palette') showPalette(m.intent, m.query);
      else showFind();
      break;
    case 'hide':
      mode = null;
      document.body.className = '';
      break;
    case 'find:result':
      findCount.textContent = m.matches ? `${m.active}/${m.matches}` : findInput.value ? '0/0' : '';
      break;
  }
});

// ---- command bar ----

function showPalette(i: 'new' | 'current', query: string): void {
  mode = 'palette';
  intent = i;
  document.body.className = 'mode-palette';
  input.value = query;
  intentHint.textContent = i === 'current' ? 'this tab' : 'new tab';
  update();
  input.focus();
  input.select();
}

$('#backdrop').addEventListener('mousedown', (e) => {
  if (e.target === e.currentTarget) dispatch({ type: 'palette.close' });
});
input.addEventListener('input', update);
input.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      select(selected + 1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      select(selected - 1);
      break;
    case 'n':
    case 'p':
      if (e.ctrlKey) {
        e.preventDefault();
        select(selected + (e.key === 'n' ? 1 : -1));
      }
      break;
    case 'Enter':
      e.preventDefault();
      runSelected(e.metaKey || e.ctrlKey);
      break;
    case 'Escape':
      e.preventDefault();
      dispatch({ type: 'palette.close' });
      break;
  }
});
window.addEventListener('focus', () => {
  if (mode === 'palette') input.focus();
  if (mode === 'find') findInput.focus();
});

function select(i: number): void {
  if (!items.length) return;
  selected = (i + items.length) % items.length;
  results.querySelectorAll('li').forEach((li, k) => li.classList.toggle('selected', k === selected));
  results.querySelector('li.selected')?.scrollIntoView({ block: 'nearest' });
}

function runSelected(newTab: boolean): void {
  const item = items[selected];
  if (!item) return;
  dispatch({ type: 'palette.close' });
  item.run({ newTab });
}

function update(): void {
  items = compute(input.value);
  selected = 0;
  results.replaceChildren();
  let group = '';
  items.forEach((item, k) => {
    if (item.group !== group) {
      group = item.group;
      results.append(h('div', { class: 'group' }, group));
    }
    const li = h(
      'li',
      { class: k === selected ? 'selected' : '', onmousemove: () => select(k), onclick: (e: MouseEvent) => { selected = k; runSelected(e.metaKey || e.ctrlKey); } },
      h('span', { class: 'icon' }, item.icon),
      h('div', { class: 'text' }, h('span', { class: 'title' }, item.title), item.subtitle ? h('span', { class: 'subtitle' }, item.subtitle) : null),
      item.hint ? h('span', { class: 'kbd' }, item.hint) : null,
    );
    results.append(li);
  });
}

function faviconOf(tab: { favicon?: string; url: string; title: string }): Node {
  const glyph = h('span', { class: 'glyph' }, initialOf(hostOf(tab.url) || tab.title));
  if (!tab.favicon) return glyph;
  const img = h('img', { src: tab.favicon, alt: '' });
  img.onerror = () => img.replaceWith(glyph);
  return img;
}

function score(query: string, ...fields: string[]): number {
  const q = query.toLowerCase();
  const text = fields.join(' ').toLowerCase();
  if (!q) return 1;
  if (text.includes(q)) return 3;
  const words = q.split(/\s+/).filter(Boolean);
  return words.every((w) => text.includes(w)) ? 1 : 0;
}

function compute(raw: string): Item[] {
  const s = state;
  if (!s) return [];
  const query = raw.trim();
  const out: Item[] = [];
  const space = activeSpace(s);
  const current = focusedTab(s);
  const engine = SEARCH_ENGINES[s.settings.searchEngine];
  const navigate = (url: string) => (o: { newTab: boolean }) =>
    dispatch(o.newTab || intent === 'new' || !current ? { type: 'tab.new', url, activate: true } : { type: 'tab.navigate', url });

  if (query) {
    const url = toUrl(query);
    if (url) out.push({ group: 'Go', icon: svg(ICONS.globe, 18), title: url, subtitle: 'Open page', hint: '↩', run: navigate(url) });
    out.push({ group: 'Go', icon: svg(ICONS.search, 18), title: query, subtitle: `Search with ${engine.name}`, hint: url ? undefined : '↩', run: navigate(searchUrl(s.settings.searchEngine, query)) });
  }

  const kind = (t: Tab) => (t.kind === 'favorite' ? 'Favorite' : t.kind === 'pinned' ? 'Pinned' : 'Today');
  const spaceName = (t: Tab) => (t.spaceId ? s.spaces.find((sp) => sp.id === t.spaceId)?.name ?? '' : 'All spaces');
  const tabs = Object.values(s.tabs)
    .filter((t) => t.id !== current?.id)
    .map((t) => ({ t, score: score(query, t.title, t.url) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.t.lastActiveAt - a.t.lastActiveAt)
    .slice(0, query ? 6 : 8);
  for (const { t } of tabs) {
    out.push({
      group: 'Open tabs',
      icon: faviconOf(t),
      title: t.title || hostOf(t.url),
      subtitle: `${hostOf(t.url)} · ${kind(t)} · ${spaceName(t)}`,
      hint: 'Switch',
      run: () => dispatch({ type: 'tab.activate', id: t.id }),
    });
  }

  const nextForSplit = [...space.pinned, ...space.today].find((id) => !space.panes.includes(id));
  const archiveOptions: [string, number][] = [['12 hours', 12], ['24 hours', 24], ['7 days', 168], ['30 days', 720], ['never', 0]];
  const commands: { title: string; keywords?: string; subtitle?: string; when?: boolean; run: () => void }[] = [
    { title: 'New Space', run: () => dispatch({ type: 'space.create' }) },
    { title: s.settings.sidebarOpen ? 'Hide Sidebar' : 'Show Sidebar', keywords: 'toggle sidebar', subtitle: '⌘S', run: () => dispatch({ type: 'sidebar.toggle' }) },
    { title: current?.kind === 'pinned' ? 'Unpin Tab' : 'Pin Tab', keywords: 'pin', subtitle: '⌘D', when: !!current && current.kind !== 'favorite', run: () => dispatch({ type: 'tab.togglePin' }) },
    { title: 'Add Tab to Favorites', keywords: 'favorite star', when: !!current && current.kind !== 'favorite', run: () => dispatch({ type: 'tab.favorite', id: current!.id }) },
    { title: 'Split View with Next Tab', keywords: 'split', subtitle: '⌘⇧D', when: !!nextForSplit, run: () => dispatch({ type: 'tab.split', id: nextForSplit! }) },
    { title: 'Remove from Split View', keywords: 'unsplit', when: space.panes.length > 1 && !!space.focused, run: () => dispatch({ type: 'tab.unsplit', id: space.focused! }) },
    { title: 'Duplicate Tab', when: !!current, run: () => dispatch({ type: 'tab.duplicate', id: current!.id }) },
    { title: 'Copy URL', subtitle: '⌘⇧C', when: !!current, run: () => dispatch({ type: 'url.copy' }) },
    { title: 'Find in Page', subtitle: '⌘F', when: !!current, run: () => dispatch({ type: 'find.open' }) },
    { title: 'Archive Today’s Tabs', keywords: 'clear close all', when: space.today.length > 0, run: () => dispatch({ type: 'today.clear' }) },
    { title: 'Reopen Closed Tab', subtitle: '⌘⇧T', when: s.recentlyClosed.length > 0, run: () => dispatch({ type: 'closed.reopen' }) },
    { title: `Shields: ${s.settings.shields ? 'On' : 'Off'}`, keywords: 'adblock tracker shields toggle', subtitle: 'Block ads and trackers', run: () => dispatch({ type: 'settings.update', patch: { shields: !s.settings.shields } }) },
    ...archiveOptions.map(([label, hours]) => ({
      title: `Archive Tabs After: ${label}`,
      keywords: 'archive auto settings',
      subtitle: s.settings.archiveAfterHours === hours ? 'Current setting' : undefined,
      run: () => dispatch({ type: 'settings.update', patch: { archiveAfterHours: hours } }),
    })),
    ...Object.entries(SEARCH_ENGINES).map(([key, e]) => ({
      title: `Search Engine: ${e.name}`,
      keywords: 'search engine settings default',
      subtitle: s.settings.searchEngine === key ? 'Current setting' : undefined,
      run: () => dispatch({ type: 'settings.update', patch: { searchEngine: key as keyof typeof SEARCH_ENGINES } }),
    })),
    { title: 'Clear Archive', keywords: 'archive delete', when: s.archived.length > 0, run: () => dispatch({ type: 'archived.clear' }) },
    { title: 'Export Configuration', keywords: 'export json backup spaces', subtitle: 'Save spaces, tabs and settings to a JSON file', run: () => dispatch({ type: 'config.export' }) },
    { title: `Export Space: ${space.name}`, keywords: 'export json space', run: () => dispatch({ type: 'config.export', spaceId: space.id }) },
    { title: 'Next Split Layout', keywords: 'layout tiling split grid', subtitle: '⌘⌥L', when: space.panes.length > 1, run: () => dispatch({ type: 'space.tilingNext' }) },
    ...presetsFor(space.panes.length, s.settings.tilings).map((p) => ({ title: `Layout: ${p.name}`, keywords: `layout tiling split ${p.spec}`, subtitle: p.spec, when: space.panes.length > 1, run: () => dispatch({ type: 'space.tiling', spec: p.spec }) })),
    { title: 'Downloads', keywords: 'downloads files progress', subtitle: '⌘⇧J', run: () => dispatch({ type: 'downloads.open' }) },
    { title: 'Import from Arc, Chrome, Brave…', keywords: 'import arc chrome brave edge bookmarks migrate browser', subtitle: 'Spaces and bookmarks from another browser', run: () => dispatch({ type: 'import.browser' }) },
    { title: 'Import Configuration', keywords: 'import json restore spaces', subtitle: 'Merge or replace from a JSON file', run: () => dispatch({ type: 'config.importFile' }) },
    { title: 'Settings…', keywords: 'settings preferences appearance theme add-ins extensions address bar', subtitle: 'General, appearance, add-ins', run: () => dispatch({ type: 'settings.open' }) },
    { title: s.settings.addressBar ? 'Hide Address Bar' : 'Show Address Bar', keywords: 'address bar url toggle', subtitle: '⌘⇧L', run: () => dispatch({ type: 'settings.update', patch: { addressBar: !s.settings.addressBar } }) },
    { title: 'Add Unpacked Extension…', keywords: 'extension add-in addin chrome', run: () => dispatch({ type: 'extension.pickFolder' }) },
    { title: 'Set Chord as Default Browser', keywords: 'default', run: () => dispatch({ type: 'app.setDefaultBrowser' }) },
    { title: 'Toggle Developer Tools', keywords: 'devtools inspect', when: !!current, run: () => dispatch({ type: 'devtools.toggle' }) },
    { title: 'Copy Diagnostics', keywords: 'diagnostics slow performance debug report', subtitle: 'Environment, event-loop stalls and page timings for bug reports', run: () => dispatch({ type: 'diagnostics.copy' }) },
  ];
  const matched = commands.filter((c) => c.when !== false && score(query, c.title, c.keywords ?? '') > 0).slice(0, query ? 6 : 4);
  for (const c of matched) out.push({ group: 'Commands', icon: '⌘', title: c.title, subtitle: c.subtitle, run: c.run });

  if (query) {
    const archived = s.archived.filter((a) => score(query, a.title, a.url) > 0).slice(0, 4);
    for (const a of archived) {
      out.push({ group: 'Archived', icon: faviconOf(a), title: a.title || hostOf(a.url), subtitle: hostOf(a.url), hint: 'Restore', run: () => dispatch({ type: 'archived.restore', id: a.id }) });
    }
  }
  return out;
}

// ---- find bar ----

function showFind(): void {
  mode = 'find';
  document.body.className = 'mode-find';
  findCount.textContent = '';
  findInput.focus();
  findInput.select();
  if (findInput.value) sendFind(true, false);
}

function sendFind(forward: boolean, findNext: boolean): void {
  const text = findInput.value;
  dispatch({ type: 'find.query', text, forward, findNext: findNext && text === lastFind });
  lastFind = text;
}

findInput.addEventListener('input', () => sendFind(true, false));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendFind(!e.shiftKey, true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    dispatch({ type: 'find.close' });
  }
});
$('#find-prev').onclick = () => sendFind(false, true);
$('#find-next').onclick = () => sendFind(true, true);
$('#find-close').onclick = () => dispatch({ type: 'find.close' });
