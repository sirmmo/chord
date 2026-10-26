// The sidebar page: it is the window's own web page and draws the chrome
// around the tab views (which are native children painted above it).

import type { ListName, Message, Space, SpaceId, State, Tab, TabId } from '../shared/types.ts';
import { activeSpace } from '../shared/model.ts';
import { hostOf, isSecure } from '../shared/url.ts';
import { h, svg, ICONS, initialOf } from './dom.ts';

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
back.append(svg(ICONS.back));
forward.append(svg(ICONS.forward));
$('#space-menu').append(svg(ICONS.more));
$('#add-space').append(svg(ICONS.plus));
$('#new-tab .plus').append(svg(ICONS.plus));

back.onclick = () => dispatch({ type: 'nav.back' });
forward.onclick = () => dispatch({ type: 'nav.forward' });
reload.onclick = () => dispatch(focused()?.loading ? { type: 'nav.stop' } : { type: 'nav.reload' });
urlbar.onclick = () => dispatch({ type: 'palette.open', intent: focused() ? 'current' : 'new' });
$('#new-tab').onclick = () => dispatch({ type: 'palette.open', intent: 'new' });
$('#clear-today').onclick = () => dispatch({ type: 'today.clear' });
$('#add-space').onclick = () => dispatch({ type: 'space.create' });
$('#space-menu').onclick = () => state && dispatch({ type: 'space.contextmenu', id: state.activeSpaceId });
$('#space-name').ondblclick = () => state && startRename(state.activeSpaceId);
$('#stage').ondblclick = () => dispatch({ type: 'palette.open', intent: 'new' });

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

function render(): void {
  if (!state) return;
  if (dragging) {
    renderQueued = true;
    return;
  }
  const s = state;
  const space = activeSpace(s);
  const root = document.documentElement;
  root.style.setProperty('--space', space.color);
  root.style.setProperty('--sidebar-width', `${s.settings.sidebarWidth}px`);
  document.body.classList.toggle('sidebar-closed', !s.settings.sidebarOpen);

  const tab = focused();
  back.disabled = !tab?.canGoBack;
  forward.disabled = !tab?.canGoForward;
  reload.replaceChildren(svg(tab?.loading ? ICONS.stop : ICONS.reload));
  reload.disabled = !tab;
  urlbar.classList.toggle('placeholder', !tab);
  urlbar.querySelector('.host')!.textContent = tab ? hostOf(tab.url) || tab.url : 'Search or enter URL';
  urlbar.querySelector('.lock')!.replaceChildren(tab ? svg(isSecure(tab.url) ? ICONS.lock : ICONS.globe) : svg(ICONS.search));

  $('#favorites').replaceChildren(...s.favorites.map((id) => renderFavorite(s.tabs[id], space)));
  $('#space-icon').textContent = space.icon ?? '';
  renderSpaceName(space);
  $('#pinned').replaceChildren(...space.pinned.map((id) => renderTab(s.tabs[id], space)));
  $('#pinned-divider').classList.toggle('hidden', space.pinned.length === 0);
  $('#today').replaceChildren(...space.today.map((id) => renderTab(s.tabs[id], space)));
  renderSpaces(s);
  $('#stage').classList.toggle('empty', space.panes.length === 0);
}

function renderSpaceName(space: Space): void {
  const name = $('#space-name');
  if (editingSpace !== space.id) {
    name.textContent = space.name;
    return;
  }
  if (name.querySelector('input')) return;
  const input = h('input', { type: 'text', value: space.name, spellcheck: 'false' });
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

function favicon(tab: Tab, size: 'tab' | 'fav'): HTMLElement {
  if (tab.loading && size === 'tab') return h('div', { class: 'spinner' });
  const glyph = h('div', { class: 'glyph' }, initialOf(hostOf(tab.url) || tab.title));
  if (!tab.favicon) return glyph;
  const img = h('img', { class: 'favicon', src: tab.favicon, alt: '', draggable: 'false' });
  img.onerror = () => img.replaceWith(glyph);
  return img;
}

function tabEvents(el: HTMLElement, tab: Tab): void {
  el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dispatch({ type: 'tab.activate', id: tab.id });
  });
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) dispatch({ type: 'tab.close', id: tab.id });
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    dispatch({ type: 'tab.contextmenu', id: tab.id });
  });
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    dragging = tab.id;
    el.classList.add('dragging');
    e.dataTransfer!.setData(TAB_MIME, tab.id);
    e.dataTransfer!.setData('text/uri-list', tab.url);
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

function renderTab(tab: Tab, space: Space): HTMLElement {
  const inPanes = space.panes.includes(tab.id);
  const el = h(
    'div',
    {
      class: ['tab', inPanes && 'active', !tab.awake && 'asleep', tab.crashed && 'crashed'].filter(Boolean).join(' '),
      'data-id': tab.id,
      title: tab.url,
    },
    favicon(tab, 'tab'),
    h('span', { class: 'title' }, tab.title || hostOf(tab.url)),
    tab.audible || tab.muted
      ? h('button', { class: 'audio', title: tab.muted ? 'Unmute' : 'Mute', onclick: () => dispatch({ type: 'tab.mute', id: tab.id }) }, svg(tab.muted ? ICONS.muted : ICONS.sound))
      : null,
    h('button', { class: 'close', title: tab.kind === 'today' ? 'Close' : 'Close and reset', onclick: () => dispatch({ type: 'tab.close', id: tab.id }) }, svg(ICONS.close)),
  );
  tabEvents(el, tab);
  return el;
}

function renderFavorite(tab: Tab, space: Space): HTMLElement {
  const el = h(
    'div',
    {
      class: ['fav', space.panes.includes(tab.id) && 'active', !tab.awake && 'asleep'].filter(Boolean).join(' '),
      'data-id': tab.id,
      title: `${tab.title}\n${tab.url}`,
    },
    favicon(tab, 'fav'),
  );
  tabEvents(el, tab);
  return el;
}

function renderSpaces(s: State): void {
  const container = $('#spaces');
  container.replaceChildren(
    ...s.spaces.map((space) => {
      const el = h(
        'button',
        {
          class: 'space-dot' + (space.id === s.activeSpaceId ? ' active' : ''),
          title: space.name,
          style: `--dot: ${space.color}`,
          onclick: () => dispatch({ type: 'space.activate', id: space.id }),
          ondblclick: () => startRename(space.id),
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            dispatch({ type: 'space.contextmenu', id: space.id });
          },
        },
        space.icon ? space.icon : h('span', { class: 'initial' }),
      );
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
    }),
  );
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
