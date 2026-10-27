// The sidebar page: it is the window's own web page and draws the chrome
// around the tab views (native children painted above it). Rendering is
// keyed: existing elements are updated in place, never rebuilt.

import type { DownloadsStatus, ListName, MediaAction, MediaInfo, MediaStatus, Message, Space, SpaceId, State, Tab, TabId } from '../shared/types.ts';
import { activeSpace } from '../shared/model.ts';
import { hostOf, isInternal, isSecure, searchUrl, toUrl } from '../shared/url.ts';
import { h, svg, ICONS, initialOf } from './dom.ts';
import { applyTheme } from './theme.ts';

const api = window.chord;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const dispatch = (m: Message) => void api.dispatch(m);
const TAB_MIME = 'text/chord-tab';

let state: State | null = null;
let editingSpace: SpaceId | null = null;
let dragging: TabId | null = null;
let renderQueued = false;

document.documentElement.classList.add(`platform-${api.platform}`);

// ---- static chrome ----

const back = $<HTMLButtonElement>('#back');
const forward = $<HTMLButtonElement>('#forward');
const reload = $<HTMLButtonElement>('#reload');
const urlbar = $<HTMLButtonElement>('#urlbar');
const urlHost = urlbar.querySelector('.host') as HTMLElement;
const urlLock = urlbar.querySelector('.lock') as HTMLElement;
back.append(svg(ICONS.back));
forward.append(svg(ICONS.forward));
$('#collapse').append(svg(ICONS.collapse));
$('#space-menu').append(svg(ICONS.more));
$('#add-space').append(svg(ICONS.plus));
$('#new-tab .plus').append(svg(ICONS.plus));

back.onclick = () => dispatch({ type: 'nav.back' });
forward.onclick = () => dispatch({ type: 'nav.forward' });
reload.onclick = () => dispatch(focused()?.loading ? { type: 'nav.stop' } : { type: 'nav.reload' });
urlbar.onclick = () => dispatch({ type: 'palette.open', intent: focused() ? 'current' : 'new' });
$('#collapse').onclick = () => dispatch({ type: 'sidebar.toggle' });
$('#new-tab').onclick = () => dispatch({ type: 'palette.open', intent: 'new' });
$('#clear-today').onclick = () => dispatch({ type: 'today.clear' });
$('#add-space').onclick = () => dispatch({ type: 'space.create' });
$('#space-menu').onclick = () => state && dispatch({ type: 'space.contextmenu', id: state.activeSpaceId });
$('#space-name').ondblclick = () => state && startRename(state.activeSpaceId);
$('.stage-body').ondblclick = () => dispatch({ type: 'palette.open', intent: 'new' });

// Address bar (optional, across the top of the page).
const abBack = $<HTMLButtonElement>('#ab-back');
const abForward = $<HTMLButtonElement>('#ab-forward');
const abReload = $<HTMLButtonElement>('#ab-reload');
const abLock = $('#ab-lock');
const address = $<HTMLInputElement>('#address');
abBack.append(svg(ICONS.back));
abForward.append(svg(ICONS.forward));
abBack.onclick = () => dispatch({ type: 'nav.back' });
abForward.onclick = () => dispatch({ type: 'nav.forward' });
abReload.onclick = () => dispatch(focused()?.loading ? { type: 'nav.stop' } : { type: 'nav.reload' });
address.addEventListener('focus', () => address.select());
address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const q = address.value.trim();
    if (!q || !state) return;
    const url = toUrl(q) ?? searchUrl(state.settings.searchEngine, q);
    dispatch(focused() ? { type: 'tab.navigate', url } : { type: 'tab.new', url, activate: true });
    address.blur();
  } else if (e.key === 'Escape') {
    address.value = focused()?.url ?? '';
    address.blur();
  }
});

// Peek: hovering the left edge while the sidebar is collapsed shows it until the
// pointer leaves it again (or the page is clicked; the main process handles that).
let peeking = false;
let peekTimer = 0;
function setPeek(on: boolean): void {
  clearTimeout(peekTimer);
  if (peeking === on) return;
  peeking = on;
  document.body.classList.toggle('peeking', on);
  dispatch({ type: 'sidebar.peek', on });
}
$('#edge').addEventListener('mouseenter', () => {
  if (state && !state.settings.sidebarOpen) setPeek(true);
});
$('#sidebar').addEventListener('mouseleave', () => {
  if (!peeking) return;
  clearTimeout(peekTimer);
  peekTimer = window.setTimeout(() => setPeek(false), 350);
});
$('#sidebar').addEventListener('mouseenter', () => clearTimeout(peekTimer));
window.addEventListener('blur', () => {
  if (peeking) setPeek(false);
});

// Sidebar resizing: the pointer stays inside the sidebar because the width follows it.
$('#resizer').addEventListener('mousedown', (e) => {
  e.preventDefault();
  let frame = 0;
  const move = (ev: MouseEvent) => {
    const width = ev.clientX + 4;
    document.documentElement.style.setProperty('--sidebar-width', `${Math.max(180, Math.min(480, width))}px`);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => dispatch({ type: 'sidebar.resize', width }));
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

dropZone($('#favorites'), 'favorites');
dropZone($('#pinned'), 'pinned');
dropZone($('#today'), 'today');

function focused(): Tab | undefined {
  if (!state) return undefined;
  const sp = activeSpace(state);
  return sp.focused ? state.tabs[sp.focused] : undefined;
}

// ---- rendering ----

api.onState((s) => {
  state = s;
  render();
});
api.getState().then((s) => {
  if (s) {
    state = s;
    render();
  }
});
api.onSidebar((m) => {
  if (m.kind === 'space.renameStart') startRename(m.id);
});

let lastSpaceKey = '';
let media: MediaStatus = {};
let downloads: DownloadsStatus = { items: [], active: 0 };

// ---- downloads: ring in the title bar, a row above the player while something is in flight ----

const dlBtn = $<HTMLButtonElement>('#dl-btn');
const dlRow = $<HTMLButtonElement>('#dl-row');
const dlTitle = $('#dl-title');
const dlSub = $('#dl-sub');
const dlBar = $('#dl-bar');
let dlHideTimer = 0;
dlBtn.replaceChildren(svg(ICONS.download), dlBtn.querySelector('.ring')!, dlBtn.querySelector('.badge')!);
dlBtn.onclick = () => dispatch({ type: 'downloads.open' });
dlRow.onclick = () => dispatch({ type: 'downloads.open' });
api.onDownloads((d) => {
  downloads = d;
  renderDownloads();
});
api.getDownloads().then((d) => {
  if (d) {
    downloads = d;
    renderDownloads();
  }
});

function formatBytesShort(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function renderDownloads(): void {
  const active = downloads.items.filter((e) => e.state === 'progressing');
  const recent = downloads.items.find((e) => e.state === 'completed' && e.finishedAt && Date.now() - e.finishedAt < 8000);
  dlBtn.classList.toggle('hidden', downloads.items.length === 0);
  dlBtn.classList.toggle('active', active.length > 0);
  if (active.length) {
    const total = active.reduce((n, e) => n + e.total, 0);
    const received = active.reduce((n, e) => n + e.received, 0);
    const p = total > 0 ? received / total : 0;
    dlBtn.style.setProperty('--p', String(p));
    setText(dlBtn.querySelector('.badge') as HTMLElement, String(active.length));
    const first = active[0];
    setText(dlTitle, active.length === 1 ? first.filename : `${active.length} downloads`);
    setText(dlSub, total > 0 ? `${Math.round(p * 100)}%` : formatBytesShort(received));
    dlBar.style.width = `${Math.round(p * 100)}%`;
    setClass(dlRow, 'done', false);
    dlRow.classList.remove('hidden');
    window.clearTimeout(dlHideTimer);
  } else if (recent) {
    setText(dlTitle, recent.filename);
    setText(dlSub, 'Done');
    setClass(dlRow, 'done', true);
    dlRow.classList.remove('hidden');
    window.clearTimeout(dlHideTimer);
    dlHideTimer = window.setTimeout(renderDownloads, 8000 - (Date.now() - (recent.finishedAt ?? 0)) + 50);
  } else {
    dlRow.classList.add('hidden');
  }
}

// ---- smart pages: the current player, across spaces ----

api.onMedia((m) => {
  media = m;
  renderMedia();
});
api.getMedia().then((m) => {
  if (m) {
    media = m;
    renderMedia();
  }
});

const now = $('#now');
const nowArt = $('#now-art');
const nowTitle = $('#now-title');
const nowSub = $('#now-sub');
const nowPrev = $<HTMLButtonElement>('#now-prev');
const nowPP = $<HTMLButtonElement>('#now-pp');
const nowNext = $<HTMLButtonElement>('#now-next');
const minis = [
  { pill: $<HTMLButtonElement>('#now-mini'), pp: $<HTMLButtonElement>('#now-mini-pp') },
  { pill: $<HTMLButtonElement>('#ab-now'), pp: $<HTMLButtonElement>('#ab-now-pp') },
];
let playerTab: TabId | null = null;
const mediaAction = (action: MediaAction) => () => {
  if (playerTab) dispatch({ type: 'media.action', id: playerTab, action });
};
const openPlayer = () => {
  if (playerTab) dispatch({ type: 'tab.activate', id: playerTab });
};
const togglePlay = () => {
  const info = playerTab ? media[playerTab] : undefined;
  if (info) mediaAction(info.playing ? 'pause' : 'play')();
};
$('#now-open').onclick = openPlayer;
nowPrev.onclick = mediaAction('previoustrack');
nowNext.onclick = mediaAction('nexttrack');
nowPP.onclick = togglePlay;
for (const m of minis) {
  m.pill.onclick = openPlayer;
  m.pp.onclick = togglePlay;
}

/** The player to show: a playing one first, then the most recently updated. */
function currentPlayer(): [TabId, MediaInfo] | null {
  if (!state || !state.settings.smartPages) return null;
  let best: [TabId, MediaInfo] | null = null;
  for (const [id, info] of Object.entries(media)) {
    if (!state.tabs[id]) continue;
    if (!best || (info.playing && !best[1].playing) || (info.playing === best[1].playing && info.updatedAt > best[1].updatedAt)) best = [id, info];
  }
  return best;
}

function renderMedia(): void {
  const player = currentPlayer();
  playerTab = player ? player[0] : null;
  now.classList.toggle('hidden', !player);
  for (const m of minis) {
    m.pill.classList.toggle('hidden', !player);
    m.pp.classList.toggle('hidden', !player);
  }
  if (!player || !state) return;
  const [id, info] = player;
  const tab = state.tabs[id];
  const title = info.title || tab.title || info.host;
  const sub = [info.artist, info.host].filter(Boolean).join(' · ');
  setText(nowTitle, title);
  setText(nowSub, sub);
  const artKey = info.artwork ? `img:${info.artwork}` : 'icon';
  const makeArt = () => (info.artwork ? document.createTextNode('') : svg(ICONS.music));
  setIconKey(nowArt, artKey, makeArt);
  if (nowArt.style.backgroundImage !== (info.artwork ? `url("${info.artwork}")` : '')) nowArt.style.backgroundImage = info.artwork ? `url("${info.artwork}")` : '';
  setClass(now, 'playing', info.playing);
  const can = (a: MediaAction) => info.actions.length === 0 || info.actions.includes(a);
  nowPrev.disabled = !info.actions.includes('previoustrack');
  nowNext.disabled = !info.actions.includes('nexttrack');
  nowPP.disabled = !(can('play') || can('pause'));
  const ppKey = info.playing ? 'pause' : 'play';
  setIconKey(nowPP, ppKey, () => svg(info.playing ? ICONS.pause : ICONS.play));
  setIconKey(nowPrev, 'prev', () => svg(ICONS.prev));
  setIconKey(nowNext, 'next', () => svg(ICONS.next));
  for (const m of minis) {
    const art = m.pill.querySelector('.art') as HTMLElement;
    setIconKey(art, artKey, makeArt);
    if (art.style.backgroundImage !== nowArt.style.backgroundImage) art.style.backgroundImage = nowArt.style.backgroundImage;
    setText(m.pill.querySelector('.t') as HTMLElement, title);
    m.pill.title = `${title}${sub ? ` — ${sub}` : ''}`;
    setIconKey(m.pp, ppKey, () => svg(info.playing ? ICONS.pause : ICONS.play));
    m.pp.disabled = nowPP.disabled;
  }
}

function render(): void {
  if (!state) return;
  if (dragging) {
    renderQueued = true;
    return;
  }
  const s = state;
  const space = activeSpace(s);
  applyTheme(s.settings.theme, space);
  document.documentElement.style.setProperty('--sidebar-width', `${s.settings.sidebarWidth}px`);
  document.body.classList.toggle('sidebar-closed', !s.settings.sidebarOpen);
  if (s.settings.sidebarOpen && peeking) setPeek(false);

  const tab = focused();
  back.disabled = !tab?.canGoBack;
  forward.disabled = !tab?.canGoForward;
  setIconKey(reload, tab?.loading ? 'stop' : 'reload', () => svg(tab?.loading ? ICONS.stop : ICONS.reload));
  reload.disabled = !tab;
  urlbar.classList.toggle('placeholder', !tab);
  setText(urlHost, tab ? hostOf(tab.url) || tab.url : 'Search or enter URL');
  const lockKey = tab ? (isSecure(tab.url) ? 'lock' : 'globe') : 'search';
  const lockIcon = () => svg(tab ? (isSecure(tab.url) ? ICONS.lock : ICONS.globe) : ICONS.search);
  setIconKey(urlLock, lockKey, lockIcon);

  document.body.classList.toggle('addressbar', s.settings.addressBar);
  if (s.settings.addressBar) {
    abBack.disabled = !tab?.canGoBack;
    abForward.disabled = !tab?.canGoForward;
    abReload.disabled = !tab;
    setIconKey(abReload, tab?.loading ? 'stop' : 'reload', () => svg(tab?.loading ? ICONS.stop : ICONS.reload));
    setIconKey(abLock, lockKey, lockIcon);
    if (document.activeElement !== address) {
      const url = tab?.url ?? '';
      if (address.value !== url) address.value = url;
    }
  }

  syncChildren($('#favorites'), s.favorites.map((id) => s.tabs[id]).filter(Boolean), (t) => t.id, makeFavorite, (el, t) => updateFavorite(el, t, space));
  setText($('#space-icon'), space.icon ?? '');
  renderSpaceName(space);
  const tabsOf = (ids: TabId[]) => ids.map((id) => s.tabs[id]).filter(Boolean);
  syncChildren($('#pinned'), tabsOf(space.pinned), (t) => t.id, makeTab, (el, t) => updateTab(el, t, space));
  $('#pinned-divider').classList.toggle('hidden', space.pinned.length === 0);
  syncChildren($('#today'), tabsOf(space.today), (t) => t.id, makeTab, (el, t) => updateTab(el, t, space));

  const spaceKey = s.spaces.map((sp) => `${sp.id}${sp.name}${sp.color}${sp.icon ?? ''}`).join('|') + s.activeSpaceId;
  if (spaceKey !== lastSpaceKey) {
    lastSpaceKey = spaceKey;
    syncChildren($('#spaces'), s.spaces, (sp) => sp.id, makeSpaceDot, (el, sp) => updateSpaceDot(el, sp, s));
  }
  $('#stage').classList.toggle('empty', space.panes.length === 0);
  renderMedia();
}

/** Keyed child reconciliation: reuse elements by key, reorder, drop the rest. */
function syncChildren<T>(container: HTMLElement, items: T[], key: (item: T) => string, make: (item: T) => HTMLElement, update: (el: HTMLElement, item: T) => void): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children)) existing.set((child as HTMLElement).dataset.key ?? '', child as HTMLElement);
  const keep = new Set<string>();
  let cursor: Element | null = container.firstElementChild;
  for (const item of items) {
    const k = key(item);
    keep.add(k);
    let el = existing.get(k);
    if (!el) {
      el = make(item);
      el.dataset.key = k;
    }
    update(el, item);
    if (el === cursor) cursor = cursor.nextElementSibling;
    else container.insertBefore(el, cursor);
  }
  for (const [k, el] of existing) if (!keep.has(k)) el.remove();
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function setClass(el: HTMLElement, name: string, on: boolean): void {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

/** Replace the children of `slot` only when the icon key changes. */
function setIconKey(slot: HTMLElement, key: string, make: () => Node): void {
  if (slot.dataset.icon === key) return;
  slot.dataset.icon = key;
  slot.replaceChildren(make());
}

function iconKey(tab: Tab, spinner: boolean): string {
  if (spinner && tab.loading) return 'spinner';
  if (isInternal(tab.url)) return `internal:${hostOf(tab.url)}`;
  return tab.favicon ? `img:${tab.favicon}` : `glyph:${initialOf(hostOf(tab.url) || tab.title)}`;
}

function makeIcon(tab: Tab, spinner: boolean): Node {
  if (spinner && tab.loading) return h('div', { class: 'spinner' });
  if (isInternal(tab.url)) return h('div', { class: 'glyph internal' }, svg(hostOf(tab.url) === 'downloads' ? ICONS.download : ICONS.globe, 12));
  const glyph = h('div', { class: 'glyph' }, initialOf(hostOf(tab.url) || tab.title));
  if (!tab.favicon) return glyph;
  const img = h('img', { class: 'favicon', src: tab.favicon, alt: '', draggable: 'false' });
  img.onerror = () => img.replaceWith(glyph);
  return img;
}

function renderSpaceName(space: Space): void {
  const name = $('#space-name');
  if (editingSpace !== space.id) {
    if (name.querySelector('input')) name.replaceChildren();
    setText(name, space.name);
    return;
  }
  if (name.querySelector('input')) return;
  const input = h('input', { type: 'text', spellcheck: 'false' });
  input.value = space.name;
  const finish = (save: boolean) => {
    if (editingSpace !== space.id) return;
    editingSpace = null;
    if (save && input.value.trim()) dispatch({ type: 'space.rename', id: space.id, name: input.value.trim() });
    render();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  name.replaceChildren(input);
  input.focus();
  input.select();
}

function startRename(id: SpaceId): void {
  if (!state) return;
  if (state.activeSpaceId !== id) dispatch({ type: 'space.activate', id });
  editingSpace = id;
  render();
}

// ---- tab rows and favorite tiles ----

function tabId(el: HTMLElement): TabId {
  return el.dataset.id ?? '';
}

function tabEvents(el: HTMLElement): void {
  el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dispatch({ type: 'tab.activate', id: tabId(el) });
  });
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) dispatch({ type: 'tab.close', id: tabId(el) });
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    dispatch({ type: 'tab.contextmenu', id: tabId(el) });
  });
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    const id = tabId(el);
    dragging = id;
    el.classList.add('dragging');
    e.dataTransfer!.setData(TAB_MIME, id);
    e.dataTransfer!.setData('text/uri-list', state?.tabs[id]?.url ?? '');
    e.dataTransfer!.effectAllowed = 'copyMove';
  });
  el.addEventListener('dragend', () => {
    dragging = null;
    el.classList.remove('dragging');
    clearDropMarks();
    if (renderQueued) {
      renderQueued = false;
      render();
    }
  });
}

function makeTab(tab: Tab): HTMLElement {
  const el = h(
    'div',
    { class: 'tab', 'data-id': tab.id },
    h('span', { class: 'icon-slot' }),
    h('span', { class: 'title' }),
    h('button', { class: 'audio', onclick: () => dispatch({ type: 'tab.mute', id: tab.id }) }),
    h('button', { class: 'close', onclick: () => dispatch({ type: 'tab.close', id: tab.id }) }, svg(ICONS.close)),
  );
  tabEvents(el);
  return el;
}

function updateTab(el: HTMLElement, tab: Tab, space: Space): void {
  setClass(el, 'active', space.panes.includes(tab.id));
  setClass(el, 'asleep', !tab.awake);
  setClass(el, 'crashed', Boolean(tab.crashed));
  if (el.title !== tab.url) el.title = tab.url;
  setIconKey(el.querySelector('.icon-slot') as HTMLElement, iconKey(tab, true), () => makeIcon(tab, true));
  setText(el.querySelector('.title') as HTMLElement, tab.title || hostOf(tab.url));
  const audio = el.querySelector('.audio') as HTMLButtonElement;
  const showAudio = Boolean(tab.audible || tab.muted);
  if (audio.hidden === showAudio) audio.hidden = !showAudio;
  if (showAudio) {
    setIconKey(audio, tab.muted ? 'muted' : 'sound', () => svg(tab.muted ? ICONS.muted : ICONS.sound));
    audio.title = tab.muted ? 'Unmute' : 'Mute';
  }
  const close = el.querySelector('.close') as HTMLButtonElement;
  const closeTitle = tab.kind === 'today' ? 'Close' : 'Close and reset';
  if (close.title !== closeTitle) close.title = closeTitle;
}

function makeFavorite(tab: Tab): HTMLElement {
  const el = h('div', { class: 'fav', 'data-id': tab.id }, h('span', { class: 'icon-slot' }));
  tabEvents(el);
  return el;
}

function updateFavorite(el: HTMLElement, tab: Tab, space: Space): void {
  setClass(el, 'active', space.panes.includes(tab.id));
  setClass(el, 'asleep', !tab.awake);
  const title = `${tab.title}\n${tab.url}`;
  if (el.title !== title) el.title = title;
  setIconKey(el.querySelector('.icon-slot') as HTMLElement, iconKey(tab, false), () => makeIcon(tab, false));
}

// ---- space switcher ----

function makeSpaceDot(space: Space): HTMLElement {
  const el = h('button', {
    class: 'space-dot',
    'data-id': space.id,
    onclick: () => dispatch({ type: 'space.activate', id: space.id }),
    ondblclick: () => startRename(space.id),
    oncontextmenu: (e: MouseEvent) => {
      e.preventDefault();
      dispatch({ type: 'space.contextmenu', id: space.id });
    },
  });
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes(TAB_MIME)) return;
    e.preventDefault();
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-target');
    const id = e.dataTransfer?.getData(TAB_MIME);
    if (id) dispatch({ type: 'tab.move', id, list: 'today', spaceId: space.id, index: 0 });
  });
  return el;
}

function updateSpaceDot(el: HTMLElement, space: Space, s: State): void {
  setClass(el, 'active', space.id === s.activeSpaceId);
  if (el.title !== space.name) el.title = space.name;
  el.style.setProperty('--dot', space.color);
  setIconKey(el, space.icon ? `emoji:${space.icon}` : 'initial', () => (space.icon ? document.createTextNode(space.icon) : h('span', { class: 'initial' })));
}

// ---- drag and drop between lists ----

function clearDropMarks(): void {
  for (const el of document.querySelectorAll('.drop-target, .drop-before, .drop-end')) {
    el.classList.remove('drop-target', 'drop-before', 'drop-end');
  }
}

/** Index where a drop at the pointer position would insert, ignoring the dragged element. */
function dropIndex(list: HTMLElement, e: DragEvent): number {
  const items = [...list.children].filter((c) => (c as HTMLElement).dataset.id !== dragging) as HTMLElement[];
  const grid = list.classList.contains('grid');
  let index = 0;
  for (const item of items) {
    const r = item.getBoundingClientRect();
    const after = grid ? e.clientY > r.bottom || (e.clientY >= r.top && e.clientX > r.left + r.width / 2) : e.clientY > r.top + r.height / 2;
    if (after) index++;
    else break;
  }
  return index;
}

function dropZone(list: HTMLElement, name: ListName): void {
  list.addEventListener('dragover', (e) => {
    const types = e.dataTransfer?.types ?? [];
    const isTab = types.includes(TAB_MIME);
    if (!isTab && !types.includes('text/uri-list')) return;
    if (!isTab && name === 'favorites') return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = isTab ? 'move' : 'copy';
    clearDropMarks();
    list.classList.add('drop-target');
    const items = [...list.children].filter((c) => (c as HTMLElement).dataset.id !== dragging);
    const index = dropIndex(list, e);
    if (items[index]) items[index].classList.add('drop-before');
    else if (items.length) list.classList.add('drop-end');
  });
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget as Node)) clearDropMarks();
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const index = dropIndex(list, e);
    clearDropMarks();
    const spaceId = state?.activeSpaceId;
    const id = e.dataTransfer?.getData(TAB_MIME);
    if (id) {
      dispatch({ type: 'tab.move', id, list: name, spaceId, index });
      return;
    }
    const url = (e.dataTransfer?.getData('text/uri-list') ?? '').split('\n').find((l) => l && !l.startsWith('#'))?.trim();
    if (url && /^https?:\/\//i.test(url) && name !== 'favorites') {
      dispatch({ type: 'tab.new', url, spaceId, activate: false });
    }
  });
}
