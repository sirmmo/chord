// chord://settings — the settings page.

import { cellCount, defaultTiling, formatTiling, parseTiling, tilingRects, TILING_PRESETS, type Tiling } from '../shared/tiling.ts';
import type { AiStatus, Boost, ExtensionsStatus, Message, PasswordsStatus, State, TroubleFlags } from '../shared/types.ts';
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
const sSkin = $('#s-skin');
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
const sAutoPip = $<HTMLInputElement>('#s-autopip');
const sDlDir = $('#s-dldir');
const sDlDirReset = $<HTMLButtonElement>('#s-dldir-reset');
const sExtensions = $('#s-extensions');
let settingsPage = 'general';
let extStatus: ExtensionsStatus = {};

const PAGES = ['general', 'appearance', 'layouts', 'addins', 'boosts', 'passwords', 'ai', 'about'];
const showPage = (raw: string) => {
  const [page, arg] = raw.split(':');
  if (page === 'boosts' && arg) prefillBoost(decodeURIComponent(arg));
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
sAutoPip.onchange = () => dispatch({ type: 'settings.update', patch: { autoPip: sAutoPip.checked } });
const FLAGS: { key: keyof TroubleFlags; label: string; help: string }[] = [
  { key: 'noHwVideoDecode', label: 'Disable hardware video decoding', help: 'Videos decode on the CPU. Try this first when a video stays black or never starts.' },
  { key: 'noMacOverlays', label: 'Disable video overlays (macOS)', help: 'Draws video through the normal compositor instead of a native overlay layer.' },
  { key: 'noGraphite', label: 'Disable Skia Graphite', help: 'Falls back to the older Ganesh renderer for all page drawing.' },
  { key: 'noGpuCompositing', label: 'Disable GPU compositing', help: 'Composites pages on the CPU. Slower, but isolates driver problems.' },
  { key: 'noGpu', label: 'Disable the GPU entirely', help: 'Last resort: software rendering for everything.' },
];
const flagInputs = new Map<keyof TroubleFlags, HTMLInputElement>();
$('#s-flags').replaceChildren(
  ...FLAGS.map((f) => {
    const input = h('input', { type: 'checkbox' });
    input.onchange = () => {
      const flags: TroubleFlags = { ...(state?.settings.flags ?? {}) };
      if (input.checked) flags[f.key] = true;
      else delete flags[f.key];
      dispatch({ type: 'settings.update', patch: { flags } });
    };
    flagInputs.set(f.key, input);
    return h('label', { class: 'check', title: f.help }, input, ` ${f.label}`, h('span', { class: 'help' }, ` — ${f.help}`));
  }),
);
$('#s-relaunch').onclick = () => dispatch({ type: 'app.relaunch' });
$('#s-dldir-choose').onclick = () => dispatch({ type: 'downloads.chooseFolder' });
sDlDirReset.onclick = () => dispatch({ type: 'settings.update', patch: { downloadDir: null } });
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
segment(sSkin, (v) => dispatch({ type: 'theme.update', patch: { skin: v as 'chord' | 'lcars' } }));
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
  pick(sSkin, t.skin);
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
  sAutoPip.checked = s.settings.autoPip;
  for (const [k, input] of flagInputs) input.checked = s.settings.flags[k] === true;
  renderBoosts();
  renderAiSettings();
  sDlDir.textContent = s.settings.downloadDir ?? 'System Downloads folder';
  sDlDirReset.hidden = s.settings.downloadDir === null;
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

// ---- about page ----

interface Credit {
  name: string;
  version: string;
  license: string;
  url: string;
}
const RUNTIME_NAMES: Record<string, string> = {
  electron: 'Electron',
  '@ghostery/adblocker-electron': 'Ghostery adblocker (Electron)',
  '@ghostery/adblocker': 'Ghostery adblocker engine',
  '@ghostery/adblocker-electron-preload': 'Ghostery adblocker preload',
  '@ghostery/adblocker-content': 'Ghostery adblocker content',
  '@ghostery/adblocker-extended-selectors': 'Ghostery extended selectors',
  'tldts-experimental': 'tldts (public suffix list parsing)',
};
const openExternal = (url: string) => dispatch({ type: 'open.external', url });
$('#a-site').onclick = () => openExternal('https://ingmmo.com/chord/');
$('#a-guide').onclick = () => dispatch({ type: 'guide.open' });
$('#a-github').onclick = () => openExternal('https://github.com/sirmmo/chord');
$('#a-releases').onclick = () => openExternal('https://github.com/sirmmo/chord/releases');
$('#a-diag').onclick = () => dispatch({ type: 'diagnostics.copy' });

function creditRow(c: Credit, label = ''): HTMLElement {
  return h(
    'a',
    { class: 'lic', href: c.url, onclick: (e: MouseEvent) => { e.preventDefault(); openExternal(c.url); } },
    h('span', { class: 'n' }, label || RUNTIME_NAMES[c.name] || c.name),
    h('span', { class: 'v' }, c.version),
    h('span', { class: 'l' }, c.license),
  );
}

void api.getInfo().then((info) => {
  if (!info) return;
  $('#a-version').textContent = `v${info.version}`;
  $('#a-runtime').textContent = `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node} · V8 ${info.v8}`;
  $('#a-platform').textContent = `${info.platform} · ${info.arch}`;
  $('#a-userdata').textContent = info.userData;
  const runtimeList = $('#a-runtime-list');
  runtimeList.prepend(
    creditRow({ name: 'electron', version: info.electron, license: 'MIT', url: 'https://www.electronjs.org/' }),
    creditRow({ name: 'chromium', version: info.chrome, license: 'BSD-3-Clause', url: 'https://www.chromium.org/' }, 'Chromium'),
    creditRow({ name: 'node', version: info.node, license: 'MIT', url: 'https://nodejs.org/' }, 'Node.js'),
  );
});
void fetch('licenses.json')
  .then((r) => r.json())
  .then((data: { runtime: Credit[]; tools: Credit[] }) => {
    $('#a-runtime-list').append(...data.runtime.map((c) => creditRow(c)));
    $('#a-tools-list').replaceChildren(...data.tools.map((c) => creditRow(c, { electron: 'Electron', 'electron-builder': 'electron-builder', esbuild: 'esbuild', typescript: 'TypeScript' }[c.name] ?? c.name)));
  })
  .catch(() => {});

// ---- boosts page ----

const bName = $<HTMLInputElement>('#s-boost-name');
const bSites = $<HTMLInputElement>('#s-boost-sites');
const bCss = $<HTMLTextAreaElement>('#s-boost-css');
const bJs = $<HTMLTextAreaElement>('#s-boost-js');
const bSave = $<HTMLButtonElement>('#s-boost-save');
const bCancel = $<HTMLButtonElement>('#s-boost-cancel');
let editingBoost: string | null = null;

function newBoostId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function prefillBoost(host: string): void {
  if (editingBoost) return;
  if (!bSites.value) bSites.value = host;
  if (!bName.value) bName.value = host;
}

function startEditBoost(b: Boost): void {
  editingBoost = b.id;
  bName.value = b.name;
  bSites.value = b.sites;
  bCss.value = b.css;
  bJs.value = b.js;
  $('#s-boost-form-title').textContent = `Edit “${b.name || b.sites}”`;
  bCancel.hidden = false;
  bSave.textContent = 'Save changes';
  bName.focus();
}

function resetBoostForm(): void {
  editingBoost = null;
  bName.value = '';
  bSites.value = '';
  bCss.value = '';
  bJs.value = '';
  $('#s-boost-form-title').textContent = 'New boost';
  bCancel.hidden = true;
  bSave.textContent = 'Save boost';
}
bCancel.onclick = resetBoostForm;
bSave.onclick = () => {
  const s = state;
  if (!s) return;
  const sites = bSites.value.trim();
  const css = bCss.value;
  const js = bJs.value;
  bSites.classList.toggle('bad', !sites);
  if (!sites || (!css.trim() && !js.trim())) return;
  const boost: Boost = { id: editingBoost ?? newBoostId(), name: bName.value.trim() || sites, sites, css, js, enabled: editingBoost ? (s.settings.boosts.find((b) => b.id === editingBoost)?.enabled ?? true) : true };
  const boosts = editingBoost ? s.settings.boosts.map((b) => (b.id === editingBoost ? boost : b)) : [...s.settings.boosts, boost];
  dispatch({ type: 'settings.update', patch: { boosts } });
  resetBoostForm();
};

function renderBoosts(): void {
  const s = state;
  if (!s) return;
  $('#s-boosts').replaceChildren(
    ...s.settings.boosts.map((b) =>
      h(
        'div',
        { class: 'boost' },
        h('label', { class: 'switch' }, Object.assign(h('input', { type: 'checkbox' }), { checked: b.enabled, onchange: (e: Event) => dispatch({ type: 'settings.update', patch: { boosts: s.settings.boosts.map((x) => (x.id === b.id ? { ...x, enabled: (e.target as HTMLInputElement).checked } : x)) } }) }), h('i')),
        h('div', { class: 'text' }, h('strong', {}, b.name || b.sites), h('span', {}, `${b.sites}${b.css.trim() ? ' · CSS' : ''}${b.js.trim() ? ' · JS' : ''}`)),
        h('button', { class: 'btn', onclick: () => startEditBoost(b) }, 'Edit'),
        h('button', { class: 'btn danger', onclick: () => dispatch({ type: 'settings.update', patch: { boosts: s.settings.boosts.filter((x) => x.id !== b.id) } }) }, 'Remove'),
      ),
    ),
    s.settings.boosts.length ? '' : h('span', { class: 's-foot', style: 'margin:0' }, 'No boosts yet. Right-click a page → “Boost this site…” or fill the form below.'),
  );
}

// ---- passwords page ----

let passwords: PasswordsStatus = { available: false, entries: [], never: [] };
api.onPasswords((p) => {
  passwords = p;
  renderPasswords();
});
void api.getPasswords().then((p) => {
  passwords = p;
  renderPasswords();
});

function renderPasswords(): void {
  $('#s-pw-note').textContent = passwords.available
    ? 'Chord offers to save passwords when you sign in on an https site and fills them in when you return. They are encrypted with your operating system’s keychain (macOS Keychain, Windows DPAPI, your Linux keyring), so the file in the profile folder is unreadable without your OS account. Password-manager extensions (1Password, Bitwarden, KeePassXC) need extension popups and native messaging, which Electron does not provide; their web vaults work as ordinary pages.'
    : 'Password storage is unavailable: the operating system keychain cannot be reached (on Linux, install and unlock a keyring such as GNOME Keyring or KWallet). Nothing will be saved.';
  $('#s-passwords').replaceChildren(
    ...passwords.entries
      .slice()
      .sort((a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username))
      .map((e) => {
        const secret = h('span', { class: 'secret' }, '••••••••');
        let shown = false;
        return h(
          'div',
          { class: 'pw' },
          h('div', {}, h('div', { class: 'host' }, e.host), h('div', { class: 'user' }, e.username || '(no username)')),
          secret,
          h(
            'div',
            { class: 'btns' },
            h('button', { class: 'btn', onclick: async () => { if (shown) { secret.textContent = '••••••••'; shown = false; return; } const v = await api.revealPassword(e.id); if (v !== null) { secret.textContent = v; shown = true; } } }, 'Show'),
            h('button', { class: 'btn', onclick: async () => { const v = await api.revealPassword(e.id); if (v !== null) await navigator.clipboard.writeText(v).catch(() => {}); } }, 'Copy'),
            h('button', { class: 'btn danger', onclick: () => dispatch({ type: 'password.delete', id: e.id }) }, 'Delete'),
          ),
        );
      }),
  );
  $('#s-pw-never').replaceChildren(
    ...passwords.never.map((host) => h('div', { class: 'pw' }, h('div', { class: 'host' }, host), h('span'), h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => dispatch({ type: 'password.allowAgain', host }) }, 'Allow again')))),
  );
}

// ---- ai page ----

const aiProvider = $<HTMLSelectElement>('#s-ai-provider');
const aiBase = $<HTMLInputElement>('#s-ai-base');
const aiModel = $<HTMLInputElement>('#s-ai-model');
const aiKey = $<HTMLInputElement>('#s-ai-key');
const aiState = $('#s-ai-state');
let aiStatus: AiStatus | null = null;

const saveAi = () => {
  if (!state) return;
  dispatch({ type: 'settings.update', patch: { ai: { provider: aiProvider.value as 'anthropic' | 'openai', baseUrl: aiBase.value.trim(), model: aiModel.value.trim() } } });
};
aiProvider.onchange = () => {
  if (aiProvider.value === 'anthropic' && (!aiModel.value || aiModel.value === 'llama3.1')) aiModel.value = 'claude-opus-5-5';
  if (aiProvider.value === 'openai' && aiModel.value === 'claude-opus-5-5') aiModel.value = 'llama3.1';
  saveAi();
};
aiBase.onchange = saveAi;
aiModel.onchange = saveAi;
$('#s-ai-key-save').onclick = () => {
  dispatch({ type: 'ai.setKey', key: aiKey.value });
  aiKey.value = '';
};
$('#s-ai-key-clear').onclick = () => dispatch({ type: 'ai.setKey', key: '' });
$('#s-ai-test').onclick = () => {
  aiState.textContent = 'Testing…';
  dispatch({ type: 'ai.test' });
};
api.onAi((a) => {
  aiStatus = a;
  renderAiSettings();
});
function renderAiSettings(): void {
  const s = state;
  if (!s) return;
  const active = document.activeElement;
  aiProvider.value = s.settings.ai.provider;
  if (active !== aiBase) aiBase.value = s.settings.ai.baseUrl;
  if (active !== aiModel) aiModel.value = s.settings.ai.model;
  aiBase.disabled = s.settings.ai.provider === 'anthropic';
  aiKey.placeholder = aiStatus?.hasKey ? 'A key is saved (enter a new one to replace it)' : s.settings.ai.provider === 'anthropic' ? 'sk-ant-…' : 'Optional for local models';
  if (aiStatus?.error) aiState.textContent = aiStatus.error;
}
void api.getState().then((s) => {
  if (s) void api.getAi(s.activeSpaceId).then((a) => {
    aiStatus = a;
    renderAiSettings();
  });
});
