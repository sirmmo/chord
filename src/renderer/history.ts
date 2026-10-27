// chord://history — the history page.

import type { HistoryEntry, Message, State } from '../shared/types.ts';
import { activeSpace } from '../shared/model.ts';
import { hostOf } from '../shared/url.ts';
import { h, initialOf } from './dom.ts';
import { applyTheme } from './theme.ts';

const api = window.chord;
const dispatch = (m: Message) => void api.dispatch(m);
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const q = $<HTMLInputElement>('#q');
const list = $('#list');
const summary = $('#summary');
const clearBtn = $<HTMLButtonElement>('#clear');
let entries: HistoryEntry[] = [];
let total = 0;
let armed = false;
let timer = 0;

api.onState((s: State) => applyTheme(s.settings.theme, activeSpace(s)));
api.getState().then((s) => s && applyTheme(s.settings.theme, activeSpace(s)));
api.onHistory(() => load());
q.addEventListener('input', () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(load, 120);
});
q.focus();

clearBtn.onclick = () => {
  if (!armed) {
    armed = true;
    clearBtn.textContent = 'Really clear everything?';
    clearBtn.classList.add('confirm');
    window.setTimeout(disarm, 4000);
    return;
  }
  dispatch({ type: 'history.clear' });
  disarm();
};
function disarm(): void {
  armed = false;
  clearBtn.textContent = 'Clear History';
  clearBtn.classList.remove('confirm');
}

async function load(): Promise<void> {
  const r = await api.getHistory({ query: q.value, limit: 500 });
  entries = r.entries;
  total = r.total;
  render();
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function row(e: HistoryEntry): HTMLElement {
  const host = hostOf(e.url);
  return h(
    'div',
    { class: 'entry', title: e.url },
    h('span', { class: 'time' }, new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
    h('span', { class: 'glyph' }, initialOf(host || e.title)),
    h(
      'a',
      { class: 'text', href: e.url, onclick: (ev: MouseEvent) => { ev.preventDefault(); dispatch({ type: 'tab.new', url: e.url }); } },
      h('span', { class: 'title' }, e.title || e.url),
      h('span', { class: 'host' }, host),
    ),
    h('button', { class: 'remove', title: 'Remove from history', onclick: () => dispatch({ type: 'history.remove', id: e.id }) }, '×'),
  );
}

function render(): void {
  const nodes: HTMLElement[] = [];
  let day = '';
  for (const e of entries) {
    const label = dayLabel(e.at);
    if (label !== day) {
      day = label;
      nodes.push(h('div', { class: 'day' }, label));
    }
    nodes.push(row(e));
  }
  list.replaceChildren(...nodes);
  summary.textContent = total ? (q.value ? `${total} match${total === 1 ? '' : 'es'}${total > entries.length ? `, showing ${entries.length}` : ''}` : `${total} page${total === 1 ? '' : 's'}${total > entries.length ? `, showing the latest ${entries.length}` : ''}`) : '';
}

void load();
