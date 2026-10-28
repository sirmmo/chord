// chord://little — the bar of a Little window: a page on its own, one click from a space.

import type { LittleStatus, Message, State } from '../shared/types.ts';
import { activeSpace } from '../shared/model.ts';
import { hostOf } from '../shared/url.ts';
import { svg, ICONS } from './dom.ts';
import { applyTheme } from './theme.ts';

const api = window.chord;
const dispatch = (m: Message) => void api.dispatch(m);
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

document.body.classList.add(`platform-${api.platform}`);
api.onState((s: State) => applyTheme(s.settings.theme, activeSpace(s)));
void api.getState().then((s) => s && applyTheme(s.settings.theme, activeSpace(s)));

const back = $<HTMLButtonElement>('#back');
const forward = $<HTMLButtonElement>('#forward');
const reload = $<HTMLButtonElement>('#reload');
back.append(svg(ICONS.back));
forward.append(svg(ICONS.forward));
reload.append(svg(ICONS.reload));
$('#close').append(svg(ICONS.close));
back.onclick = () => dispatch({ type: 'little.nav', action: 'back' });
forward.onclick = () => dispatch({ type: 'little.nav', action: 'forward' });
reload.onclick = () => dispatch({ type: 'little.nav', action: 'reload' });
$('#open').onclick = () => dispatch({ type: 'little.nav', action: 'open' });
$('#close').onclick = () => dispatch({ type: 'little.nav', action: 'close' });

api.onLittle((st) => {
  $('#title').textContent = st.title || st.url || 'Loading…';
  $('#host').textContent = hostOf(st.url);
  $('#pill').title = st.url;
  back.disabled = !st.canGoBack;
  forward.disabled = !st.canGoForward;
  reload.replaceChildren(svg(st.loading ? ICONS.stop : ICONS.reload));
});
