// chord://bookmarks — saved links, private or public, with tags and notes.

import type { Bookmark, Message, State, SyncStatus } from '../shared/types.ts';
import { activeSpace } from '../shared/model.ts';
import { liveBookmarks } from '../shared/bookmarks.ts';
import { renderMarkdown } from '../shared/markdown.ts';
import { hostOf } from '../shared/url.ts';
import { h } from './dom.ts';
import { applyTheme } from './theme.ts';

const api = window.chord;
const dispatch = (m: Message) => void api.dispatch(m);
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

let state: State | null = null;
let sync: SyncStatus | null = null;
/** a space's own bookmarks page, or the global one where spaces are sections */
const spaceParam = new URLSearchParams(location.search).get('space');
const spaceMode: string | null = spaceParam && spaceParam !== 'all' ? spaceParam : null;
let vis: 'all' | 'public' | 'private' = 'all';
let tag = '';
let editing = '';
const q = $<HTMLInputElement>('#q');

api.onState((s) => {
  state = s;
  applyTheme(s.settings.theme, activeSpace(s));
  render();
});
void api.getState().then((s) => {
  if (!s) return;
  state = s;
  applyTheme(s.settings.theme, activeSpace(s));
  render();
});
api.onSync((s) => {
  sync = s;
  render();
});
void api.getSync().then((s) => {
  sync = s;
  render();
});
q.addEventListener('input', render);
$('#add').onclick = () => dispatch({ type: 'bookmark.page', public: false, withNote: true });
$('#sync').onclick = () => dispatch({ type: 'settings.open', page: 'sync' });
$('#vis').querySelectorAll('button').forEach((b) => (b.onclick = () => {
  vis = (b.dataset.v as typeof vis) ?? 'all';
  $('#vis').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  render();
}));

function matches(b: Bookmark, text: string): boolean {
  if (spaceMode && (b.spaceId ?? null) !== spaceMode) return false;
  if (vis === 'public' && !b.public) return false;
  if (vis === 'private' && b.public) return false;
  if (tag && !b.tags.includes(tag)) return false;
  if (!text) return true;
  return `${b.title} ${b.url} ${b.note} ${b.tags.join(' ')}`.toLowerCase().includes(text);
}

function editor(b: Bookmark): HTMLElement {
  const title = h('input', { type: 'text', value: b.title, placeholder: 'Title' });
  const url = h('input', { type: 'url', value: b.url, placeholder: 'https://…' });
  const tags = h('input', { type: 'text', value: b.tags.join(', '), placeholder: 'tags, separated by commas' });
  const note = h('textarea', { placeholder: 'Note in Markdown (shown on the public page too)' });
  note.value = b.note;
  const pub = h('input', { type: 'checkbox' });
  pub.checked = b.public;
  const space = h('select', {}, h('option', { value: '' }, 'No space'), ...(state?.spaces ?? []).filter((sp) => !sp.lock).map((sp) => h('option', { value: sp.id }, sp.name)));
  space.value = b.spaceId ?? '';
  const form = h(
    'form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault();
        dispatch({ type: 'bookmark.update', id: b.id, patch: { title: title.value.trim(), url: url.value.trim(), tags: tags.value.split(','), note: note.value.trim(), public: pub.checked, spaceId: space.value || null } });
        editing = '';
        render();
      },
    },
    title,
    url,
    tags,
    note,
    h('div', { class: 'row' }, h('label', { class: 'check' }, pub, ' Public: published on my linkroll'), space, h('span', { style: 'flex:1' }), h('button', { class: 'btn', type: 'button', onclick: () => { editing = ''; render(); } }, 'Cancel'), h('button', { class: 'btn', type: 'submit' }, 'Save')),
  );
  return form;
}

function noteBlock(md: string): HTMLElement {
  const el = h('div', { class: 'note md' });
  el.innerHTML = renderMarkdown(md);
  el.addEventListener('click', (e) => {
    const a = (e.target as Element).closest('a[href]') as HTMLAnchorElement | null;
    if (!a || !/^https?:/i.test(a.href)) return;
    e.preventDefault();
    dispatch({ type: 'tab.new', url: a.href, activate: !(e.metaKey || e.ctrlKey) });
  });
  return el;
}

const spaceName = (id: string | null | undefined): string => (id ? state?.spaces.find((sp) => sp.id === id)?.name ?? 'Another space' : 'No space');

function row(b: Bookmark): HTMLElement {
  const host = hostOf(b.url);
  return h(
    'div',
    { class: 'bm', 'data-id': b.id },
    h('a', { class: 'title', href: b.url, title: b.url, onclick: (e: MouseEvent) => { e.preventDefault(); dispatch({ type: 'tab.new', url: b.url, activate: true }); } }, b.title || b.url),
    h(
      'div',
      { class: 'btns' },
      h('button', { onclick: () => dispatch({ type: 'bookmark.update', id: b.id, patch: { public: !b.public } }) }, b.public ? 'Make private' : 'Make public'),
      h('button', { onclick: () => { editing = editing === b.id ? '' : b.id; render(); } }, 'Edit'),
      h('button', { class: 'danger', onclick: () => dispatch({ type: 'bookmark.remove', id: b.id }) }, 'Delete'),
    ),
    b.note && editing !== b.id ? noteBlock(b.note) : '',
    h(
      'div',
      { class: 'meta' },
      h('span', { class: `vis${b.public ? ' pub' : ''}` }, b.public ? 'public' : 'private'),
      h('span', { class: 'host' }, host),
      h('span', {}, new Date(b.addedAt).toLocaleDateString()),
      !spaceMode && b.spaceId ? h('span', { class: 'sp' }, spaceName(b.spaceId)) : '',
      ...b.tags.map((t) => h('a', { class: 'tag', href: '#', onclick: (e: MouseEvent) => { e.preventDefault(); tag = tag === t ? '' : t; render(); } }, `#${t}`)),
    ),
    editing === b.id ? editor(b) : '',
  );
}

function render(): void {
  if (!state) return;
  const all = liveBookmarks(state.bookmarks);
  const text = q.value.trim().toLowerCase();
  const shown = all.filter((b) => matches(b, text));
  const counts = new Map<string, number>();
  for (const b of all) for (const t of b.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  $('#chips').replaceChildren(
    ...[...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t, n]) => h('button', { class: `chip${tag === t ? ' on' : ''}`, onclick: () => { tag = tag === t ? '' : t; render(); } }, `${t} `, h('span', {}, String(n)))),
  );
  if (spaceMode) {
    $('#list').replaceChildren(...shown.map(row));
  } else {
    // the global page: spaces are sections
    const order = [...(state.spaces.map((sp) => sp.id as string | null)), null];
    const known = new Set(order);
    for (const b of shown) if (b.spaceId && !known.has(b.spaceId)) order.push(b.spaceId), known.add(b.spaceId);
    const nodes: HTMLElement[] = [];
    for (const id of order) {
      const list = shown.filter((b) => (b.spaceId ?? null) === id);
      if (!list.length) continue;
      if (shown.some((b) => (b.spaceId ?? null) !== id)) nodes.push(h('h2', { class: 'section' }, spaceName(id), h('a', { href: '#', class: 'open', onclick: (e: MouseEvent) => { e.preventDefault(); if (id) dispatch({ type: 'bookmarks.openSpace', spaceId: id }); } }, id ? 'open' : '')));
      nodes.push(...list.map(row));
    }
    $('#list').replaceChildren(...nodes);
  }
  const heading = spaceMode ? `Bookmarks · ${spaceName(spaceMode)}` : 'Bookmarks';
  document.querySelector('h1')!.textContent = heading;
  document.title = heading;
  const pub = all.filter((b) => b.public).length;
  $('#summary').textContent = all.length ? `${all.length} bookmark${all.length === 1 ? '' : 's'} · ${pub} public${shown.length !== all.length ? ` · showing ${shown.length}` : ''}` : '';
  $('#empty').style.display = all.length ? 'none' : 'block';
  const pages = $('#pages');
  if (sync?.connected) {
    pages.replaceChildren('Public bookmarks are published at ', h('a', { href: sync.pagesUrl, onclick: (e: MouseEvent) => { e.preventDefault(); dispatch({ type: 'tab.new', url: sync!.pagesUrl, activate: true }); } }, sync.pagesUrl), sync.lastPush ? ` · last push ${new Date(sync.lastPush).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '', sync.error ? ` · ${sync.error}` : '');
  } else {
    pages.replaceChildren('Turn on GitHub sync in Settings → Sync to keep bookmarks and spaces on every computer and publish the public ones as a page.');
  }
}
