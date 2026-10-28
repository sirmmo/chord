// chord://easel — a space's freeform canvas: notes, links, clipped text and pictures to arrange.

import type { Easel, EaselItem, Message, State } from '../shared/types.ts';
import { activeSpace } from '../shared/model.ts';
import { hostOf } from '../shared/url.ts';
import { h } from './dom.ts';
import { applyTheme } from './theme.ts';

const api = window.chord;
const dispatch = (m: Message) => void api.dispatch(m);
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const COLORS = ['', 'yellow', 'pink', 'blue', 'green', 'orange'];
const SWATCH: Record<string, string> = { '': 'var(--card)', yellow: '#ffe86b', pink: '#ffb3c8', blue: '#a9cdff', green: '#a9eab0', orange: '#ffcb8a' };
const MIN_Z = 0.25;
const MAX_Z = 3;

const params = new URLSearchParams(location.search);
let spaceId: string | null = params.get('space') && params.get('space') !== 'all' ? params.get('space') : null;
let easelId: string | null = params.get('easel');
let state: State | null = null;
let easels: Easel[] = [];
let view = { x: 0, y: 0, z: 1 };
let selected: string | null = null;
/** an item being dragged or resized: its element is left alone until the pointer is released */
let busy: string | null = null;
const elements = new Map<string, HTMLElement>();

const viewport = $('#viewport');
const canvas = $('#canvas');
const nameInput = $<HTMLInputElement>('#name');
const spacePick = $<HTMLSelectElement>('#space-pick');
const easelPick = $<HTMLSelectElement>('#easel-pick');

api.onState((s) => {
  state = s;
  applyTheme(s.settings.theme, currentSpace());
  render();
});
api.onEasels((st) => {
  easels = st.easels;
  render();
});
void Promise.all([api.getState(), api.getEasels()]).then(([s, st]) => {
  state = s;
  easels = st?.easels ?? [];
  if (!spaceId && !params.has('space')) spaceId = s.activeSpaceId;
  applyTheme(s.settings.theme, currentSpace());
  loadView();
  render();
});

function currentSpace() {
  if (!state) return undefined;
  return state.spaces.find((sp) => sp.id === spaceId) ?? activeSpace(state);
}
function current(): Easel | undefined {
  return easels.find((e) => e.id === easelId && e.spaceId === spaceId);
}
function setUrl(): void {
  history.replaceState(null, '', spaceId ? `?space=${encodeURIComponent(spaceId)}${easelId ? `&easel=${encodeURIComponent(easelId)}` : ''}` : '?space=all');
}

// ---- view (pan and zoom), remembered per easel ----

function loadView(): void {
  view = { x: 0, y: 0, z: 1 };
  if (!easelId) return;
  try {
    const raw = localStorage.getItem(`easel-view-${easelId}`);
    if (raw) {
      const v = JSON.parse(raw) as typeof view;
      if (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) view = { x: v.x, y: v.y, z: Math.min(MAX_Z, Math.max(MIN_Z, v.z)) };
    }
  } catch {
    /* no storage */
  }
}
let viewSaveTimer = 0;
function applyView(): void {
  canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
  viewport.style.backgroundSize = `${24 * view.z}px ${24 * view.z}px`;
  $('#zoom-label').textContent = `${Math.round(view.z * 100)}%`;
  window.clearTimeout(viewSaveTimer);
  viewSaveTimer = window.setTimeout(() => {
    try {
      if (easelId) localStorage.setItem(`easel-view-${easelId}`, JSON.stringify(view));
    } catch {
      /* no storage */
    }
  }, 300);
}
function zoomAt(factor: number, cx: number, cy: number): void {
  const z = Math.min(MAX_Z, Math.max(MIN_Z, view.z * factor));
  const k = z / view.z;
  view = { x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k, z };
  applyView();
}
function fit(): void {
  const e = current();
  if (!e || !e.items.length) {
    view = { x: 0, y: 0, z: 1 };
    applyView();
    return;
  }
  const minX = Math.min(...e.items.map((it) => it.x));
  const minY = Math.min(...e.items.map((it) => it.y));
  const maxX = Math.max(...e.items.map((it) => it.x + it.w));
  const maxY = Math.max(...e.items.map((it) => it.y + it.h));
  const pad = 40;
  const z = Math.min(MAX_Z, Math.max(MIN_Z, Math.min((viewport.clientWidth - pad * 2) / (maxX - minX), (viewport.clientHeight - pad * 2) / (maxY - minY), 1.5)));
  view = { x: (viewport.clientWidth - (maxX - minX) * z) / 2 - minX * z, y: (viewport.clientHeight - (maxY - minY) * z) / 2 - minY * z, z };
  applyView();
}
/** Canvas coordinates of a point in the viewport. */
function toCanvas(px: number, py: number): { x: number; y: number } {
  const r = viewport.getBoundingClientRect();
  return { x: (px - r.left - view.x) / view.z, y: (py - r.top - view.y) / view.z };
}
function centre(): { x: number; y: number } {
  const r = viewport.getBoundingClientRect();
  return toCanvas(r.left + r.width / 2, r.top + r.height / 2);
}

// ---- items ----

function put(item: EaselItem): void {
  if (!easelId) return;
  dispatch({ type: 'easel.put', id: easelId, item });
  $('#saved').textContent = `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
function topZ(): number {
  const e = current();
  return (e?.items.reduce((m, it) => Math.max(m, it.z), 0) ?? 0) + 1;
}
function newItem(partial: Partial<EaselItem> & { kind: EaselItem['kind'] }, at?: { x: number; y: number }): EaselItem {
  const c = at ?? centre();
  const w = partial.w ?? 240;
  const hh = partial.h ?? 160;
  return { id: crypto.randomUUID(), x: Math.round(c.x - w / 2), y: Math.round(c.y - hh / 2), w, h: hh, z: topZ(), createdAt: Date.now(), updatedAt: Date.now(), ...partial };
}
function addNote(at?: { x: number; y: number }, text = ''): void {
  const it = newItem({ kind: 'note', text, color: 'yellow' }, at);
  put(it);
  selected = it.id;
  window.setTimeout(() => elements.get(it.id)?.querySelector('textarea')?.focus(), 50);
}
function addLink(url: string, at?: { x: number; y: number }): void {
  put(newItem({ kind: 'link', url, title: url, w: 260, h: 90 }, at));
}
function removeItem(id: string): void {
  if (!easelId) return;
  dispatch({ type: 'easel.removeItem', id: easelId, itemId: id });
  if (selected === id) selected = null;
}
function select(id: string | null): void {
  selected = id;
  for (const [k, el] of elements) el.classList.toggle('selected', k === id);
}
function bringToFront(it: EaselItem): void {
  const z = topZ();
  if (it.z >= z - 1) return;
  it.z = z;
  const el = elements.get(it.id);
  if (el) el.style.zIndex = String(z);
}

function build(it: EaselItem): HTMLElement {
  const el = h('div', { class: `item ${it.kind}`, 'data-id': it.id });
  const x = h('button', { class: 'x', title: 'Remove', onclick: (e: MouseEvent) => { e.stopPropagation(); removeItem(it.id); } }, '×');
  if (it.kind === 'note') {
    const grip = h('div', { class: 'grip' }, ...COLORS.map((c) => h('span', { class: 'dot', style: `background:${SWATCH[c]}`, title: c || 'plain', onclick: (e: MouseEvent) => { e.stopPropagation(); const cur = latest(it.id); if (cur) put({ ...cur, color: c || undefined }); } })));
    const ta = h('textarea', { placeholder: 'Write…', spellcheck: 'true' });
    ta.value = it.text ?? '';
    let t = 0;
    ta.addEventListener('input', () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => { const cur = latest(it.id); if (cur) put({ ...cur, text: ta.value }); }, 400);
    });
    ta.addEventListener('blur', () => { const cur = latest(it.id); if (cur && cur.text !== ta.value) put({ ...cur, text: ta.value }); });
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    ta.addEventListener('paste', (e) => e.stopPropagation());
    el.append(grip, ta, x);
  } else if (it.kind === 'link') {
    const host = hostOf(it.url ?? '');
    el.append(
      h('div', { class: 'head' }, h('img', { src: `https://icons.duckduckgo.com/ip3/${host}.ico`, alt: '' }), h('div', { class: 't' }, it.title || it.url || '')),
      h('div', { class: 'u' }, h('a', { href: it.url ?? '#' }, host)),
      x,
    );
  } else if (it.kind === 'image') {
    el.append(h('img', { src: `chord://easel/images/${it.image ?? ''}`, alt: it.title ?? '' }));
    if (it.url) el.append(h('div', { class: 'cap' }, h('a', { href: it.url }, it.title || hostOf(it.url))));
    el.append(x);
  } else {
    el.append(h('blockquote', {}, it.text ?? ''));
    if (it.url) el.append(h('cite', {}, '— ', h('a', { href: it.url }, it.title || hostOf(it.url))));
    el.append(x);
  }
  el.append(h('div', { class: 'rs', title: 'Resize' }));
  el.addEventListener('pointerdown', (e) => onItemPointerDown(e, it.id));
  el.addEventListener('click', (e) => {
    const a = (e.target as Element).closest('a[href]') as HTMLAnchorElement | null;
    if (!a || !/^https?:/i.test(a.href)) return;
    e.preventDefault();
    if (!moved) dispatch({ type: 'tab.new', url: a.href, activate: !(e.metaKey || e.ctrlKey) });
  });
  el.addEventListener('dblclick', (e) => {
    if (it.kind !== 'link' && it.kind !== 'image' && it.kind !== 'clip') return;
    const cur = latest(it.id);
    if (cur?.url && !(e.target as Element).closest('a')) dispatch({ type: 'tab.new', url: cur.url, activate: true });
  });
  return el;
}
function latest(id: string): EaselItem | undefined {
  return current()?.items.find((it) => it.id === id);
}
function place(el: HTMLElement, it: EaselItem): void {
  el.style.left = `${it.x}px`;
  el.style.top = `${it.y}px`;
  el.style.width = `${it.w}px`;
  el.style.height = `${it.h}px`;
  el.style.zIndex = String(it.z);
  el.className = `item ${it.kind}${it.color ? ` c-${it.color}` : ''}${selected === it.id ? ' selected' : ''}`;
}

// ---- pointer: move, resize, pan ----

let moved = false;
interface Drag { kind: 'move' | 'resize' | 'pan'; id?: string; startX: number; startY: number; ox: number; oy: number; ow: number; oh: number; pointer: number }
let drag: Drag | null = null;

function onItemPointerDown(e: PointerEvent, id: string): void {
  if (e.button !== 0) return;
  const it = latest(id);
  const el = elements.get(id);
  if (!it || !el) return;
  select(id);
  bringToFront(it);
  const target = e.target as Element;
  if (target.closest('button, a')) return;
  const resize = !!target.closest('.rs');
  if (it.kind === 'note' && !resize && !target.closest('.grip')) return;
  e.preventDefault();
  e.stopPropagation();
  moved = false;
  busy = id;
  drag = { kind: resize ? 'resize' : 'move', id, startX: e.clientX, startY: e.clientY, ox: it.x, oy: it.y, ow: it.w, oh: it.h, pointer: e.pointerId };
  el.setPointerCapture(e.pointerId);
  el.classList.add('dragging');
}
viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  if ((e.target as Element).closest('.item')) return;
  select(null);
  drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, ox: view.x, oy: view.y, ow: 0, oh: 0, pointer: e.pointerId };
  viewport.setPointerCapture(e.pointerId);
  viewport.classList.add('panning');
  e.preventDefault();
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
  if (drag.kind === 'pan') {
    view = { ...view, x: drag.ox + dx, y: drag.oy + dy };
    applyView();
    return;
  }
  const el = drag.id ? elements.get(drag.id) : undefined;
  if (!el) return;
  if (drag.kind === 'move') {
    el.style.left = `${Math.round(drag.ox + dx / view.z)}px`;
    el.style.top = `${Math.round(drag.oy + dy / view.z)}px`;
  } else {
    el.style.width = `${Math.max(60, Math.round(drag.ow + dx / view.z))}px`;
    el.style.height = `${Math.max(40, Math.round(drag.oh + dy / view.z))}px`;
  }
});
function endDrag(): void {
  if (!drag) return;
  const d = drag;
  drag = null;
  viewport.classList.remove('panning');
  if (d.kind === 'pan') return;
  const el = d.id ? elements.get(d.id) : undefined;
  const it = d.id ? latest(d.id) : undefined;
  busy = null;
  if (el) el.classList.remove('dragging');
  if (!el || !it) return;
  const next = { ...it, x: parseInt(el.style.left, 10), y: parseInt(el.style.top, 10), w: parseInt(el.style.width, 10), h: parseInt(el.style.height, 10) };
  if (moved && (next.x !== it.x || next.y !== it.y || next.w !== it.w || next.h !== it.h || next.z !== it.z)) put(next);
  else if (next.z !== it.z) put(next);
  window.setTimeout(() => (moved = false), 0);
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const r = viewport.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
  } else {
    view = { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY };
    applyView();
  }
}, { passive: false });
viewport.addEventListener('dblclick', (e) => {
  if ((e.target as Element).closest('.item')) return;
  if (!easelId) return;
  addNote(toCanvas(e.clientX, e.clientY));
});

// ---- keyboard, paste, drop ----

window.addEventListener('keydown', (e) => {
  const inField = (e.target as Element).matches('input, textarea, select');
  if (inField) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
    e.preventDefault();
    removeItem(selected);
  } else if (e.key === 'Escape') select(null);
  else if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomAt(1.2, viewport.clientWidth / 2, viewport.clientHeight / 2); }
  else if ((e.metaKey || e.ctrlKey) && e.key === '-') { e.preventDefault(); zoomAt(1 / 1.2, viewport.clientWidth / 2, viewport.clientHeight / 2); }
  else if ((e.metaKey || e.ctrlKey) && e.key === '0') { e.preventDefault(); view = { x: 0, y: 0, z: 1 }; applyView(); }
  else if (e.key === 'n' && !e.metaKey && !e.ctrlKey && easelId) { e.preventDefault(); addNote(); }
});

function ingest(data: DataTransfer | null, at?: { x: number; y: number }): boolean {
  if (!data || !easelId) return false;
  const files = [...data.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    files.forEach((f, i) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === 'string' ? reader.result : '';
        const spot = at ? { x: at.x + i * 30, y: at.y + i * 30 } : undefined;
        if (url && easelId) dispatch({ type: 'easel.image', id: easelId, dataUrl: url, title: f.name, x: spot?.x, y: spot?.y });
      };
      reader.readAsDataURL(f);
    });
    return true;
  }
  const uri = data.getData('text/uri-list').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  const text = data.getData('text/plain').trim();
  const url = uri && /^https?:/i.test(uri) ? uri : /^https?:\/\/\S+$/i.test(text) ? text : '';
  if (url) {
    addLink(url, at);
    return true;
  }
  if (text) {
    addNote(at, text.slice(0, 20_000));
    return true;
  }
  return false;
}
document.addEventListener('paste', (e) => {
  if ((e.target as Element).matches('input, textarea')) return;
  if (ingest(e.clipboardData)) e.preventDefault();
});
viewport.addEventListener('dragover', (e) => {
  e.preventDefault();
  viewport.classList.add('dropping');
});
viewport.addEventListener('dragleave', () => viewport.classList.remove('dropping'));
viewport.addEventListener('drop', (e) => {
  e.preventDefault();
  viewport.classList.remove('dropping');
  ingest(e.dataTransfer, toCanvas(e.clientX, e.clientY));
});

// ---- toolbar ----

$('#add-note').onclick = () => addNote();
$('#add-page').onclick = () => easelId && dispatch({ type: 'easel.addPage', id: easelId });
$('#snapshot').onclick = () => easelId && dispatch({ type: 'easel.snapshot', id: easelId });
$('#zoom-in').onclick = () => zoomAt(1.2, viewport.clientWidth / 2, viewport.clientHeight / 2);
$('#zoom-out').onclick = () => zoomAt(1 / 1.2, viewport.clientWidth / 2, viewport.clientHeight / 2);
$('#zoom-fit').onclick = fit;
$('#export').onclick = () => easelId && dispatch({ type: 'easel.export', id: easelId });
$('#delete').onclick = () => {
  if (!easelId) return;
  dispatch({ type: 'easel.remove', id: easelId });
};
nameInput.addEventListener('change', () => {
  if (easelId && nameInput.value.trim()) dispatch({ type: 'easel.rename', id: easelId, name: nameInput.value });
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') nameInput.blur();
});
spacePick.onchange = () => {
  spaceId = spacePick.value || null;
  easelId = null;
  setUrl();
  render();
};
easelPick.onchange = () => {
  if (easelPick.value === '+') {
    if (spaceId) dispatch({ type: 'easel.create', spaceId });
    return;
  }
  easelId = easelPick.value || null;
  setUrl();
  loadView();
  render();
};

// ---- render ----

function render(): void {
  if (!state) return;
  const spaces = state.spaces.filter((sp) => !sp.reader && (!sp.lock || !sp.locked));
  spacePick.hidden = false;
  spacePick.replaceChildren(h('option', { value: '' }, 'All spaces'), ...spaces.map((sp) => h('option', { value: sp.id }, `${sp.icon ? `${sp.icon} ` : ''}${sp.name}`)));
  spacePick.value = spaceId ?? '';
  const all = $('#all');
  if (!spaceId) {
    document.title = 'Easels · all spaces';
    $('#space-label').textContent = 'Easels of every space';
    nameInput.hidden = true;
    easelPick.hidden = true;
    $('#tools').hidden = true;
    viewport.hidden = true;
    all.hidden = false;
    let total = 0;
    all.replaceChildren(
      ...spaces.map((sp) => {
        const mine = easels.filter((e) => e.spaceId === sp.id);
        total += mine.length;
        return h('section', {},
          h('h2', { class: 'space' }, h('span', { class: 'dot', style: `background:${sp.color}` }), `${sp.icon ? `${sp.icon} ` : ''}${sp.name}`, h('button', { class: 'btn', onclick: () => dispatch({ type: 'easel.create', spaceId: sp.id }) }, 'New easel')),
          h('div', { class: 'row' }, ...mine.map((e) => h('div', { class: 'ecard', onclick: () => { spaceId = sp.id; easelId = e.id; setUrl(); loadView(); render(); } }, h('b', {}, e.name), h('span', {}, `${e.items.length} item${e.items.length === 1 ? '' : 's'} · ${new Date(e.updatedAt).toLocaleDateString()}`))), mine.length ? '' : h('span', { class: 'empty' }, 'No easel yet.')),
        );
      }),
    );
    $('#count').textContent = `${total} easel${total === 1 ? '' : 's'}`;
    return;
  }
  const sp = state.spaces.find((x) => x.id === spaceId);
  if (!sp) {
    spaceId = null;
    render();
    return;
  }
  const mine = easels.filter((e) => e.spaceId === sp.id);
  if (!easelId || !mine.some((e) => e.id === easelId)) {
    easelId = mine[0]?.id ?? null;
    setUrl();
    loadView();
  }
  const e = current();
  all.hidden = true;
  viewport.hidden = false;
  $('#tools').hidden = false;
  easelPick.hidden = false;
  easelPick.replaceChildren(...mine.map((x) => h('option', { value: x.id }, x.name)), h('option', { value: '+' }, 'New easel…'));
  easelPick.value = easelId ?? '';
  $('#space-label').textContent = `${sp.icon ? `${sp.icon} ` : ''}${sp.name} ·`;
  nameInput.hidden = !e;
  if (e && document.activeElement !== nameInput) nameInput.value = e.name;
  document.title = e ? `${e.name} · ${sp.name}` : `Easel · ${sp.name}`;
  if (!e) {
    canvas.replaceChildren();
    elements.clear();
    $('#hint').hidden = false;
    $('#count').textContent = '';
    return;
  }
  const seen = new Set<string>();
  for (const it of e.items) {
    seen.add(it.id);
    let el = elements.get(it.id);
    if (!el) {
      el = build(it);
      elements.set(it.id, el);
      canvas.append(el);
    } else if (it.id !== busy) {
      const ta = el.querySelector('textarea');
      if (ta && document.activeElement !== ta && ta.value !== (it.text ?? '')) ta.value = it.text ?? '';
      if (it.kind === 'link') {
        const t = el.querySelector('.t');
        if (t && t.textContent !== (it.title || it.url)) t.textContent = it.title || it.url || '';
      }
    }
    if (it.id !== busy) place(el, it);
  }
  for (const [id, el] of elements) {
    if (!seen.has(id)) {
      el.remove();
      elements.delete(id);
    }
  }
  $('#hint').hidden = e.items.length > 0;
  $('#count').textContent = `${e.items.length} item${e.items.length === 1 ? '' : 's'}`;
  applyView();
}
