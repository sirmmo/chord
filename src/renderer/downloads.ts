// chord://downloads — the downloads page.

import type { DownloadEntry, DownloadsStatus, Message, State } from '../shared/types.ts';
import { activeSpace } from '../shared/model.ts';
import { hostOf } from '../shared/url.ts';
import { h, svg, ICONS } from './dom.ts';
import { applyTheme } from './theme.ts';

const api = window.chord;
const dispatch = (m: Message) => void api.dispatch(m);
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

let status: DownloadsStatus = { items: [], active: 0 };
let state: State | null = null;

api.onState((s) => {
  state = s;
  applyTheme(s.settings.theme, activeSpace(s));
});
api.getState().then((s) => {
  if (s) {
    state = s;
    applyTheme(s.settings.theme, activeSpace(s));
  }
});
api.onDownloads((d) => {
  status = d;
  render();
});
api.getDownloads().then((d) => {
  status = d;
  render();
});

$('#clear').onclick = () => dispatch({ type: 'downloads.clear' });
$('#open-folder').onclick = () => dispatch({ type: 'downloads.openFolder' });

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function eta(e: DownloadEntry): string {
  if (!e.bytesPerSecond || e.total <= 0) return '';
  const s = Math.round((e.total - e.received) / e.bytesPerSecond);
  if (s < 60) return `${s} s left`;
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  return `${(s / 3600).toFixed(1)} h left`;
}

function when(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function describe(e: DownloadEntry): { state: string; rest: string } {
  switch (e.state) {
    case 'progressing':
      if (e.paused) return { state: 'Paused', rest: `${formatBytes(e.received)}${e.total > 0 ? ` of ${formatBytes(e.total)}` : ''}` };
      return {
        state: 'Downloading',
        rest: [`${formatBytes(e.received)}${e.total > 0 ? ` of ${formatBytes(e.total)}` : ''}`, e.bytesPerSecond ? `${formatBytes(e.bytesPerSecond)}/s` : '', eta(e)].filter(Boolean).join(' · '),
      };
    case 'completed':
      return { state: e.exists === false ? 'Deleted' : 'Completed', rest: `${formatBytes(e.total || e.received)} · ${when(e.finishedAt ?? e.startedAt)}` };
    case 'cancelled':
      return { state: 'Cancelled', rest: when(e.finishedAt ?? e.startedAt) };
    default:
      return { state: 'Failed', rest: `${e.received ? `${formatBytes(e.received)} received · ` : ''}${when(e.finishedAt ?? e.startedAt)}` };
  }
}

function actionsFor(e: DownloadEntry): HTMLElement[] {
  const btn = (label: string, m: Message, cls = '') => h('button', { class: `btn ${cls}`.trim(), onclick: () => dispatch(m) }, label);
  const id = e.id;
  switch (e.state) {
    case 'progressing':
      return [
        e.paused ? btn('Resume', { type: 'download.resume', id }) : btn('Pause', { type: 'download.pause', id }),
        btn('Cancel', { type: 'download.cancel', id }, 'danger'),
      ];
    case 'completed':
      return e.exists === false
        ? [btn('Download Again', { type: 'download.retry', id }), btn('Remove', { type: 'download.remove', id })]
        : [btn('Show in Folder', { type: 'download.show', id }), btn('Remove', { type: 'download.remove', id })];
    default:
      return [btn('Retry', { type: 'download.retry', id }), btn('Remove', { type: 'download.remove', id })];
  }
}

function row(e: DownloadEntry): HTMLElement {
  const { state: st, rest } = describe(e);
  const pct = e.total > 0 ? Math.min(100, (e.received / e.total) * 100) : 0;
  const bar = h('div', { class: `bar${e.total > 0 ? '' : ' indeterminate'}` }, h('i'));
  (bar.firstChild as HTMLElement).style.width = `${pct}%`;
  return h(
    'div',
    { class: `dl ${e.state}${e.exists === false ? '' : ' exists'}`, 'data-id': e.id },
    h('div', { class: 'icon' }, svg(ICONS.download)),
    h('div', { class: 'name', title: e.path || e.url, onclick: () => e.state === 'completed' && e.exists !== false && dispatch({ type: 'download.open', id: e.id }) }, e.filename || e.url),
    h('div', { class: 'buttons' }, ...actionsFor(e)),
    h('div', { class: 'meta' }, h('span', { class: 'state' }, st), rest ? ` · ${rest}` : '', e.url ? ` · ${hostOf(e.url) || e.url}` : ''),
    bar,
  );
}

function render(): void {
  const list = $('#list');
  list.replaceChildren(...status.items.map(row));
  const done = status.items.filter((e) => e.state === 'completed').length;
  $('#summary').textContent = status.active ? `${status.active} in progress · ${done} completed` : status.items.length ? `${done} completed` : '';
  const title = status.active ? `Downloads (${status.active})` : 'Downloads';
  if (document.title !== title) document.title = title;
}
