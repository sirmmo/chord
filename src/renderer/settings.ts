// chord://settings — the settings page.

import { cellCount, defaultTiling, formatTiling, parseTiling, tilingRects, TILING_PRESETS, type Tiling } from '../shared/tiling.ts';
import type { ExtensionsStatus, Message, State } from '../shared/types.ts';
import { activeSpace, SPACE_COLORS } from '../shared/model.ts';
import { applyTheme } from './theme.ts';
import { SEARCH_ENGINES } from '../shared/url.ts';
import { h } from './dom.ts';

const api = window.chord;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const dispatch = (m: Message) => void api.dispatch(m);

let state: State | null = null;

api.onState((s) => {
  state = s;
  applyTheme(s.settings.theme, activeSpace(s));
  fillSettings();
});
api.getState().then((s) => {
  if (s) {
    state = s;
    applyTheme(s.settings.theme, activeSpace(s));
    fillSettings();
  }
});

// ---- appearance panel ----

const sMode = $('#s-mode');
const sIcons = $('#s-icons');
const sSwatches = $('#s-swatches');
const sSpaceColor = $<HTMLInputElement>('#s-space-color');
const sTint = $<HTMLInputElement>('#s-tint');
const sTintVal = $('#s-tint-val');
const sAccentFollow = $<HTMLInputElement>('#s-accent-follow');
const sAccent = $<HTMLInputElement>('#s-accent');
const sIconFollow = $<HTMLInputElement>('#s-icon-follow');
const sIconColor = $<HTMLInputElement>('#s-icon-color');
const sFont = $<HTMLSelectElement>('#s-font');
const sArchive = $<HTMLSelectElement>('#s-archive');
const sEngine = $<HTMLSelectElement>('#s-engine');
const sShields = $<HTMLInputElement>('#s-shields');
const sAddressBar = $<HTMLInputElement>('#s-addressbar');
const sSmart = $<HTMLInputElement>('#s-smart');
const sAskDl = $<HTMLInputElement>('#s-askdl');
const sTray = $<HTMLInputElement>('#s-tray');
const sExtensions = $('#s-extensions');
let settingsPage = 'general';
let extStatus: ExtensionsStatus = {};

const PAGES = ['general', 'appearance', 'layouts', 'addins'];
const showPage = (page: string) => {
  settingsPage = PAGES.includes(page) ? page : 'general';
  $('#s-tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === settingsPage));
  document.querySelectorAll<HTMLElement>('.s-page').forEach((p) => p.classList.toggle('on', p.dataset.page === settingsPage));
  if (location.hash.slice(1) !== settingsPage) history.replaceState(null, '', `#${settingsPage}`);
};
$('#s-tabs').querySelectorAll('button').forEach((b) => (b.onclick = () => showPage(b.dataset.v ?? 'general')));
window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));
showPage(location.hash.slice(1));
sAddressBar.onchange = () => dispatch({ type: 'settings.update', patch: { addressBar: sAddressBar.checked } });
sSmart.onchange = () => dispatch({ type: 'settings.update', patch: { smartPages: sSmart.checked } });
sAskDl.onchange = () => dispatch({ type: 'settings.update', patch: { askDownloadPath: sAskDl.checked } });
sTray.onchange = () => dispatch({ type: 'settings.update', patch: { closeToTray: sTray.checked } });
$('#s-default').onclick = () => dispatch({ type: 'app.setDefaultBrowser' });
$('#s-export').onclick = () => dispatch({ type: 'config.export' });
$('#s-import').onclick = () => dispatch({ type: 'config.importFile' });
$('#s-ext-add').onclick = () => dispatch({ type: 'extension.pickFolder' });
$('#s-browser').onclick = () => dispatch({ type: 'import.browser' });
api.onExtensions((st) => {
  extStatus = st;
  renderExtensions();
});
api.getExtensions().then((st) => {
  extStatus = st;
  renderExtensions();
});

function renderExtensions(): void {
  const s = state;
  if (!s) return;
  sExtensions.replaceChildren(
    ...s.settings.extensions.map((e) => {
      const st = extStatus[e.path];
      const status = !e.enabled ? 'Off' : st?.loaded ? 'Loaded' : st?.error ? '' : 'Loading…';
      const toggle = h('input', { type: 'checkbox' }) as HTMLInputElement;
      toggle.checked = e.enabled;
      toggle.onchange = () => dispatch({ type: 'extension.toggle', path: e.path, enabled: toggle.checked });
      return h(
        'div',
        { class: 'addin' },
        h(
          'div',
          { class: 'addin-text' },
          h('strong', {}, (e.name ?? e.path.split(/[\\/]/).filter(Boolean).pop() ?? e.path) + (e.version ? ` ${e.version}` : '')),
          h('span', { title: e.path }, `${status}${status ? ' · ' : ''}${e.path}`),
          st?.error && e.enabled ? h('span', { class: 'err' }, st.error) : null,
        ),
        h('label', { class: 'switch' }, toggle, h('i')),
        h('button', { class: 'btn danger', onclick: () => dispatch({ type: 'extension.remove', path: e.path }) }, 'Remove'),
      );
    }),
  );
}

for (const [key, e] of Object.entries(SEARCH_ENGINES)) sEngine.append(h('option', { value: key }, e.name));
for (const color of SPACE_COLORS) {
  sSwatches.append(h('button', { style: `--c: ${color}`, title: color, onclick: () => state && dispatch({ type: 'space.update', id: state.activeSpaceId, patch: { color } }) }));
}
const segment = (el: HTMLElement, onPick: (v: string) => void) => {
  el.querySelectorAll('button').forEach((b) => (b.onclick = () => onPick(b.dataset.v ?? '')));
};
segment(sMode, (v) => dispatch({ type: 'theme.update', patch: { mode: v as 'system' | 'light' | 'dark' } }));
segment(sIcons, (v) => dispatch({ type: 'theme.update', patch: { iconStyle: v as 'color' | 'mono' } }));
sSpaceColor.oninput = () => state && dispatch({ type: 'space.update', id: state.activeSpaceId, patch: { color: sSpaceColor.value } });
sTint.oninput = () => {
  sTintVal.textContent = `${sTint.value}%`;
  dispatch({ type: 'theme.update', patch: { tint: Number(sTint.value) } });
};
sAccentFollow.onchange = () => dispatch({ type: 'theme.update', patch: { accent: sAccentFollow.checked ? null : sAccent.value } });
sAccent.oninput = () => dispatch({ type: 'theme.update', patch: { accent: sAccent.value } });
sIconFollow.onchange = () => dispatch({ type: 'theme.update', patch: { iconColor: sIconFollow.checked ? null : sIconColor.value } });
sIconColor.oninput = () => dispatch({ type: 'theme.update', patch: { iconColor: sIconColor.value } });
sFont.onchange = () => dispatch({ type: 'theme.update', patch: { font: sFont.value as 'system' | 'rounded' | 'mono' | 'serif' } });
sArchive.onchange = () => dispatch({ type: 'settings.update', patch: { archiveAfterHours: Number(sArchive.value) } });
sEngine.onchange = () => dispatch({ type: 'settings.update', patch: { searchEngine: sEngine.value as keyof typeof SEARCH_ENGINES } });
sShields.onchange = () => dispatch({ type: 'settings.update', patch: { shields: sShields.checked } });

function textColorHex(): string {
  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  return dark ? '#ececf1' : '#1c1c24';
}

function fillSettings(): void {
  const s = state;
  if (!s) return;
  renderLayouts();
  const t = s.settings.theme;
  const space = activeSpace(s);
  const active = document.activeElement;
  const pick = (el: HTMLElement, v: string) => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  pick(sMode, t.mode);
  pick(sIcons, t.iconStyle);
  $('#s-space-name').textContent = `“${space.name}”`;
  sSwatches.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.title.toLowerCase() === space.color.toLowerCase()));
  if (active !== sSpaceColor) sSpaceColor.value = space.color;
  if (active !== sTint) sTint.value = String(t.tint);
  sTintVal.textContent = `${t.tint}%`;
  sAccentFollow.checked = t.accent === null;
  sAccent.disabled = t.accent === null;
  if (active !== sAccent) sAccent.value = t.accent ?? space.color;
  sIconFollow.checked = t.iconColor === null;
  sIconColor.disabled = t.iconColor === null;
  if (active !== sIconColor) sIconColor.value = t.iconColor ?? textColorHex();
  sFont.value = t.font;
  sArchive.value = String(s.settings.archiveAfterHours);
  sEngine.value = s.settings.searchEngine;
  sShields.checked = s.settings.shields;
  sAddressBar.checked = s.settings.addressBar;
  sSmart.checked = s.settings.smartPages;
  sAskDl.checked = s.settings.askDownloadPath;
  sTray.checked = s.settings.closeToTray;
  renderExtensions();
}


// ---- layouts page ----

const sLayoutName = $<HTMLInputElement>('#s-layout-name');
const sLayoutSpec = $<HTMLInputElement>('#s-layout-spec');
const sLayoutPreview = $('#s-layout-preview');

function layoutPreview(t: Tiling): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 64 40');
  for (const r of tilingRects(t, { x: 1, y: 1, width: 62, height: 38 }, 3)) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(r.x));
    rect.setAttribute('y', String(r.y));
    rect.setAttribute('width', String(Math.max(1, r.width)));
    rect.setAttribute('height', String(Math.max(1, r.height)));
    rect.setAttribute('rx', '2');
    el.append(rect);
  }
  return el;
}

function layoutCard(name: string, spec: string, on: boolean, onRemove?: () => void): HTMLElement {
  const t = parseTiling(spec);
  const card = h(
    'button',
    { class: `layout-card${on ? ' on' : ''}`, title: `${name} (${spec})`, onclick: () => dispatch({ type: 'space.tiling', spec }) },
    h('span', { class: 'layout-preview' }, t ? layoutPreview(t) : ''),
    h('span', { class: 'name' }, name),
    h('span', { class: 'spec' }, spec),
  );
  if (onRemove) {
    card.append(
      h('button', { class: 'remove', title: 'Remove', onclick: (e: MouseEvent) => { e.stopPropagation(); onRemove(); } }, '×'),
    );
  }
  return card;
}

function renderLayouts(): void {
  const s = state;
  if (!s) return;
  const space = activeSpace(s);
  const n = space.panes.length;
  const current = $('#s-layout-current');
  const chosen = space.tiling ?? null;
  const effective = chosen && parseTiling(chosen) && cellCount(parseTiling(chosen)!) === n ? parseTiling(chosen)! : defaultTiling(n);
  current.replaceChildren(
    h('span', { class: 'layout-preview' }, layoutPreview(effective)),
    h('span', { class: 's-foot', style: 'margin:0' }, n > 1 ? `${n} panes · ${chosen ?? 'equal columns'}` : 'One pane. Add another with ⌘⇧D, then pick a layout here, from the Tabs menu, or with ⌘⌥L.'),
    n > 1 && chosen ? h('button', { class: 'btn', onclick: () => dispatch({ type: 'space.tiling', spec: null }) }, 'Equal columns') : '',
  );
  const custom = s.settings.tilings;
  $('#s-layouts').replaceChildren(
    ...custom.map((p, i) =>
      layoutCard(p.name, p.spec, chosen === p.spec, () => dispatch({ type: 'settings.update', patch: { tilings: custom.filter((_x, k) => k !== i) } })),
    ),
    custom.length ? '' : h('span', { class: 's-foot', style: 'margin:0' }, 'None yet. Add one below.'),
  );
  $('#s-layouts-builtin').replaceChildren(...TILING_PRESETS.map((p) => layoutCard(p.name, p.spec, chosen === p.spec)));
}

function previewInput(): void {
  const t = parseTiling(sLayoutSpec.value);
  sLayoutSpec.classList.toggle('bad', sLayoutSpec.value.trim() !== '' && !t);
  sLayoutPreview.replaceChildren(t ? layoutPreview(t) : '');
}
sLayoutSpec.oninput = previewInput;
$('#s-layout-add').onclick = () => {
  const s = state;
  const t = parseTiling(sLayoutSpec.value);
  if (!s || !t) {
    sLayoutSpec.classList.add('bad');
    return;
  }
  const spec = formatTiling(t);
  const name = sLayoutName.value.trim() || `${cellCount(t)} panes: ${spec}`;
  dispatch({ type: 'settings.update', patch: { tilings: [...s.settings.tilings, { name, spec }] } });
  sLayoutName.value = '';
  sLayoutSpec.value = '';
  previewInput();
};
