// chord://reader — subscriptions in subspaces, items, a reading pane.

import type { Message, ReaderItem, ReaderStatus, State } from '../shared/types.ts';
import { activeSpace } from '../shared/model.ts';
import { hostOf } from '../shared/url.ts';
import { h } from './dom.ts';
import { applyTheme } from './theme.ts';

const api = window.chord;
const dispatch = (m: Message) => void api.dispatch(m);
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

let status: ReaderStatus | null = null;
let items: ReaderItem[] = [];
let scope = 'all';
let onlyUnread = false;
let selected: string | null = null;
let itemsTimer = 0;
const q = $<HTMLInputElement>('#q');

api.onState((s: State) => applyTheme(s.settings.theme, activeSpace(s)));
void api.getState().then((s) => s && applyTheme(s.settings.theme, activeSpace(s)));
api.onReader((st) => {
  status = st;
  renderNav();
  void loadItems();
});
void api.getReader().then((st) => {
  if (!st) return;
  status = st;
  renderNav();
  void loadItems();
});

// ---- subscriptions column ----

$('#refresh').onclick = () => dispatch({ type: 'reader.refresh' });
$('#more').onclick = () => {
  const menu = h(
    'div',
    { class: 'menu', style: 'position:absolute;z-index:9;top:40px;left:120px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:4px;display:grid;box-shadow:0 8px 24px rgba(0,0,0,.18)' },
    h('button', { class: 'ib', onclick: () => { dispatch({ type: 'reader.importOpml' }); menu.remove(); } }, 'Import OPML… (becomes a subspace)'),
    h('button', { class: 'ib', onclick: () => { dispatch({ type: 'reader.exportOpml' }); menu.remove(); } }, 'Export OPML…'),
    h('button', { class: 'ib', onclick: () => { const name = prompt('Name of the new subspace'); if (name) dispatch({ type: 'reader.group', op: 'create', name }); menu.remove(); } }, 'New subspace…'),
  );
  document.body.append(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
};
$<HTMLFormElement>('#add-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('#add-input');
  const v = input.value.trim();
  if (!v) return;
  dispatch({ type: 'reader.subscribe', input: v, groupId: $<HTMLSelectElement>('#add-group').value || null });
  input.value = '';
};

function navRow(label: string, key: string, count: number, extra: Record<string, string> = {}): HTMLElement {
  return h('div', { class: `row${scope === key ? ' on' : ''}`, ...extra, onclick: () => { scope = key; selected = null; renderNav(); void loadItems(); } }, h('span', { class: 't' }, label), count ? h('span', { class: 'n' }, String(count)) : '');
}

function renderNav(): void {
  const st = status;
  if (!st) return;
  const nav = $('#nav');
  const nodes: HTMLElement[] = [navRow('All', 'all', st.unread), navRow('Starred', 'starred', 0)];
  const feedRow = (f: ReaderStatus['feeds'][number]) => {
    const row = navRow(f.title || hostOf(f.url), f.id, f.unread, { title: f.error ? `${f.url}\n${f.error}` : f.url });
    if (f.error) row.classList.add('err');
    row.oncontextmenu = (e) => { e.preventDefault(); dispatch({ type: 'reader.feedMenu', id: f.id }); };
    return row;
  };
  const loose = st.feeds.filter((f) => !f.groupId);
  if (loose.length) {
    nodes.push(h('div', { class: 'group' }, h('span', { class: 't', style: 'padding-left:20px' }, 'Feeds')));
    nodes.push(h('div', { class: 'feeds' }, ...loose.map(feedRow)));
  }
  for (const g of st.groups) {
    const feeds = st.feeds.filter((f) => f.groupId === g.id);
    const unread = feeds.reduce((n, f) => n + f.unread, 0);
    nodes.push(
      h(
        'div',
        { class: `group${g.collapsed ? ' closed' : ''}`, oncontextmenu: (e: MouseEvent) => { e.preventDefault(); const name = prompt('Rename the subspace', g.name); if (name === null) return; if (name.trim()) dispatch({ type: 'reader.group', op: 'rename', id: g.id, name }); } },
        h('span', { class: 'chev', onclick: () => dispatch({ type: 'reader.group', op: 'toggle', id: g.id }) }, '▾'),
        h('span', { class: 't', onclick: () => { scope = `group:${g.id}`; selected = null; renderNav(); void loadItems(); } }, g.name),
        unread ? h('span', { class: 'n' }, String(unread)) : '',
        h('button', { class: 'x', title: 'Export this subspace as OPML', onclick: () => dispatch({ type: 'reader.exportOpml', groupId: g.id }) }, '⤓'),
        h('button', { class: 'x', title: 'Delete the subspace (its feeds stay)', onclick: () => dispatch({ type: 'reader.group', op: 'delete', id: g.id }) }, '×'),
      ),
    );
    nodes.push(h('div', { class: 'feeds' }, ...feeds.map(feedRow)));
  }
  if (st.feeds.length === 0) nodes.push(h('div', { class: 'placeholder', style: 'padding:20px 12px' }, 'No subscriptions yet. Add a site below, press the feed button in the sidebar on a site that offers one, or import an OPML file.'));
  nav.replaceChildren(...nodes);
  const sel = $<HTMLSelectElement>('#add-group');
  const cur = sel.value;
  sel.replaceChildren(h('option', { value: '' }, 'No subspace'), ...st.groups.map((g) => h('option', { value: g.id }, g.name)));
  sel.value = cur;
  $('#add-error').textContent = st.error;
  $('#refresh').classList.toggle('on', st.refreshing);
  document.title = st.unread ? `(${st.unread}) Reader` : 'Reader';
  const title = scope === 'all' ? 'All' : scope === 'starred' ? 'Starred' : scope.startsWith('group:') ? st.groups.find((g) => g.id === scope.slice(6))?.name ?? 'Subspace' : st.feeds.find((f) => f.id === scope)?.title ?? 'Feed';
  $('#scope-title').textContent = title;
}

// ---- items column ----

q.addEventListener('input', () => {
  window.clearTimeout(itemsTimer);
  itemsTimer = window.setTimeout(() => void loadItems(), 120);
});
$('#only-unread').onclick = () => {
  onlyUnread = !onlyUnread;
  $('#only-unread').classList.toggle('on', onlyUnread);
  void loadItems();
};
$('#read-all').onclick = () => {
  const ids = items.filter((it) => !it.read).map((it) => it.id);
  if (ids.length) dispatch({ type: 'reader.read', ids });
};

async function loadItems(): Promise<void> {
  const list = await api.getReaderItems({ scope, text: q.value, limit: 400 });
  items = onlyUnread ? list.filter((it) => !it.read || it.id === selected) : list;
  renderItems();
  if (selected && !items.some((it) => it.id === selected)) selected = null;
  renderArticle();
}

function renderItems(): void {
  const st = status;
  const feedName = (id: string) => st?.feeds.find((f) => f.id === id)?.title ?? '';
  $('#items').replaceChildren(
    ...items.map((it) =>
      h(
        'div',
        { class: `it${it.read ? ' read' : ''}${it.id === selected ? ' on' : ''}`, 'data-id': it.id, onclick: () => select(it.id) },
        h('div', { class: 't' }, it.title),
        it.summary ? h('div', { class: 's' }, it.summary) : '',
        h('div', { class: 'm' }, it.starred ? h('span', { class: 'star' }, '★') : '', h('span', {}, [feedName(it.feedId), ago(it.publishedAt)].filter(Boolean).join(' · '))),
      ),
    ),
    items.length ? '' : h('div', { class: 'placeholder' }, onlyUnread ? 'Nothing unread here.' : 'Nothing here.'),
  );
}

function ago(ts: number): string {
  const d = Date.now() - ts;
  if (d < 3600_000) return `${Math.max(1, Math.round(d / 60_000))} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3600_000)} h ago`;
  if (d < 14 * 86_400_000) return `${Math.round(d / 86_400_000)} d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function select(id: string): void {
  selected = id;
  const it = items.find((x) => x.id === id);
  if (it && !it.read) {
    it.read = true;
    dispatch({ type: 'reader.read', ids: [id] });
  }
  renderItems();
  renderArticle();
  document.querySelector<HTMLElement>(`.it[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

// ---- reading pane ----

const ALLOWED = new Set(['p', 'br', 'a', 'em', 'strong', 'b', 'i', 'u', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'span', 'div', 'small', 'sub', 'sup', 'video', 'audio', 'source', 'picture', 'dl', 'dt', 'dd', 'abbr', 'cite', 'q', 'mark', 'del', 'ins', 'kbd', 'time']);
const ALLOWED_ATTR: Record<string, string[]> = { a: ['href', 'title'], img: ['src', 'alt', 'title', 'width', 'height'], video: ['src', 'controls', 'poster'], audio: ['src', 'controls'], source: ['src', 'type'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], time: ['datetime'], abbr: ['title'], q: ['cite'] };

/** The feed's HTML, reduced to harmless markup: no scripts, handlers, frames or odd URLs. */
function sanitize(html: string, base: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = document.createDocumentFragment();
  const walk = (node: Node, into: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        into.appendChild(document.createTextNode(child.textContent ?? ''));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (!ALLOWED.has(tag)) {
        if (!['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'form', 'input', 'button'].includes(tag)) walk(el, into);
        continue;
      }
      const clean = document.createElement(tag);
      for (const attr of ALLOWED_ATTR[tag] ?? []) {
        const v = el.getAttribute(attr);
        if (v === null) continue;
        if (['href', 'src', 'poster', 'cite'].includes(attr)) {
          let abs = '';
          try {
            abs = new URL(v, base).href;
          } catch {
            continue;
          }
          if (!/^(https?|data:image\/)/i.test(abs)) continue;
          clean.setAttribute(attr, abs);
        } else clean.setAttribute(attr, v);
      }
      if (tag === 'a') clean.setAttribute('rel', 'noopener');
      if (tag === 'img') clean.setAttribute('loading', 'lazy');
      walk(el, clean);
      into.appendChild(clean);
    }
  };
  walk(doc.body, out);
  return out;
}

function renderArticle(): void {
  const it = items.find((x) => x.id === selected);
  const art = $('#article');
  const feed = it ? status?.feeds.find((f) => f.id === it.feedId) : undefined;
  $('#feed-name').textContent = feed?.title ?? '';
  ($('#star') as HTMLButtonElement).disabled = !it;
  ($('#toggle-read') as HTMLButtonElement).disabled = !it;
  ($('#open') as HTMLButtonElement).disabled = !it;
  if (!it) return;
  $('#star').textContent = it.starred ? '★' : '☆';
  $('#star').classList.toggle('on', it.starred);
  $('#toggle-read').textContent = it.read ? 'Mark unread' : 'Mark read';
  const content = h('div', { class: 'content' });
  if (it.content) content.append(sanitize(it.content, it.url));
  else if (it.summary) content.append(h('p', {}, it.summary));
  else content.append(h('p', { class: 'placeholder', style: 'padding:0' }, 'This feed carries no text; open the page.'));
  content.addEventListener('click', (e) => {
    const a = (e.target as Element).closest('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    dispatch({ type: 'tab.new', url: a.href, activate: !(e.metaKey || e.ctrlKey) });
  });
  art.replaceChildren(
    h(
      'article',
      { class: 'art' },
      h('h1', {}, h('a', { href: it.url, onclick: (e: MouseEvent) => { e.preventDefault(); dispatch({ type: 'reader.openItem', id: it.id }); } }, it.title)),
      h('p', { class: 'meta' }, [feed?.title, it.author, hostOf(it.url), new Date(it.publishedAt).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' · ')),
      content,
    ),
  );
  art.scrollTop = 0;
}

$('#star').onclick = () => selected && dispatch({ type: 'reader.star', id: selected });
$('#toggle-read').onclick = () => {
  const it = items.find((x) => x.id === selected);
  if (it) dispatch({ type: 'reader.read', ids: [it.id], on: !it.read });
};
$('#open').onclick = () => selected && dispatch({ type: 'reader.openItem', id: selected });

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  const idx = items.findIndex((it) => it.id === selected);
  if (e.key === 'j' || e.key === 'ArrowDown') {
    if (items[idx + 1]) select(items[idx + 1].id);
    e.preventDefault();
  } else if (e.key === 'k' || e.key === 'ArrowUp') {
    if (idx > 0) select(items[idx - 1].id);
    e.preventDefault();
  } else if (e.key === 'o' || e.key === 'Enter') {
    if (selected) dispatch({ type: 'reader.openItem', id: selected });
  } else if (e.key === 's') {
    if (selected) dispatch({ type: 'reader.star', id: selected });
  } else if (e.key === 'm') {
    $('#toggle-read').click();
  } else if (e.key === 'r') {
    dispatch({ type: 'reader.refresh' });
  } else if (e.key === 'u') {
    $('#only-unread').click();
  } else if (e.key === 'A' && e.shiftKey) {
    $('#read-all').click();
  }
});
