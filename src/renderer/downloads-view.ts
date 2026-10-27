// Download rows shared by the chord://downloads page and the overlay panel.

import type { DownloadEntry, Message } from '../shared/types.ts';
import { hostOf } from '../shared/url.ts';
import { h, svg, ICONS } from './dom.ts';

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
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export function describe(e: DownloadEntry): { state: string; rest: string } {
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

export function actionsFor(e: DownloadEntry, dispatch: (m: Message) => void, compact = false): HTMLElement[] {
  const btn = (label: string, m: Message, cls = '') => h('button', { class: `btn ${cls}`.trim(), onclick: (ev: MouseEvent) => { ev.stopPropagation(); dispatch(m); } }, label);
  const id = e.id;
  switch (e.state) {
    case 'progressing':
      return [e.paused ? btn('Resume', { type: 'download.resume', id }) : btn('Pause', { type: 'download.pause', id }), btn('Cancel', { type: 'download.cancel', id }, 'danger')];
    case 'completed':
      return e.exists === false
        ? [btn(compact ? 'Again' : 'Download Again', { type: 'download.retry', id }), btn('Remove', { type: 'download.remove', id })]
        : [btn(compact ? 'Show' : 'Show in Folder', { type: 'download.show', id }), btn('Remove', { type: 'download.remove', id })];
    default:
      return [btn('Retry', { type: 'download.retry', id }), btn('Remove', { type: 'download.remove', id })];
  }
}

export function downloadRow(e: DownloadEntry, dispatch: (m: Message) => void, compact = false): HTMLElement {
  const { state: st, rest } = describe(e);
  const pct = e.total > 0 ? Math.min(100, (e.received / e.total) * 100) : 0;
  const bar = h('div', { class: `bar${e.total > 0 ? '' : ' indeterminate'}` }, h('i'));
  (bar.firstChild as HTMLElement).style.width = `${pct}%`;
  const open = () => e.state === 'completed' && e.exists !== false && dispatch({ type: 'download.open', id: e.id });
  return h(
    'div',
    { class: `dl ${e.state}${e.exists === false ? '' : ' exists'}${compact ? ' compact' : ''}`, 'data-id': e.id },
    h('div', { class: 'icon' }, svg(ICONS.download)),
    h('div', { class: 'name', title: e.path || e.url, onclick: open }, e.filename || e.url),
    h('div', { class: 'buttons' }, ...actionsFor(e, dispatch, compact)),
    h('div', { class: 'meta' }, h('span', { class: 'state' }, st), rest ? ` · ${rest}` : '', !compact && e.url ? ` · ${hostOf(e.url) || e.url}` : ''),
    bar,
  );
}
