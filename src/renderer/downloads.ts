// chord://downloads — the downloads page.

import type { DownloadsStatus, Message, State } from '../shared/types.ts';
import { activeSpace } from '../shared/model.ts';
import { downloadRow } from './downloads-view.ts';
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

function render(): void {
  const list = $('#list');
  list.replaceChildren(...status.items.map((e) => downloadRow(e, dispatch)));
  const done = status.items.filter((e) => e.state === 'completed').length;
  $('#summary').textContent = status.active ? `${status.active} in progress · ${done} completed` : status.items.length ? `${done} completed` : '';
  const title = status.active ? `Downloads (${status.active})` : 'Downloads';
  if (document.title !== title) document.title = title;
}
