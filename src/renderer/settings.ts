// chord://settings — the settings page.

import { cellCount, defaultTiling, formatTiling, parseTiling, tilingRects, TILING_PRESETS, type Tiling } from '../shared/tiling.ts';
import type { Route, AiStatus, Boost, ExtensionsStatus, McpStatus, Message, PasskeysStatus, SyncStatus, PasswordsStatus, State, TroubleFlags, UpdateStatus } from '../shared/types.ts';
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
const sFavicons = $('#s-favicons');
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
let extStatus: ExtensionsStatus = { paths: {}, install: { busy: false, message: '', error: false } };

const PAGES = ['general', 'appearance', 'layouts', 'addins', 'boosts', 'routes', 'passwords', 'sync', 'ai', 'about'];
const showPage = (raw: string) => {
  const [page, arg] = raw.split(':');
  if (page === 'boosts' && arg) prefillBoost(decodeURIComponent(arg));
  if (page === 'routes' && arg) prefillRoute(decodeURIComponent(arg));
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
const sLittle = $<HTMLInputElement>('#s-little');
const sAutofill = $<HTMLInputElement>('#s-autofill');
sAutofill.onchange = () => dispatch({ type: 'settings.update', patch: { autofill: sAutofill.checked } });
const sPwLock = $<HTMLInputElement>('#s-pwlock');
sPwLock.onchange = () => dispatch({ type: 'settings.update', patch: { passwordLock: sPwLock.checked } });
const sKpMaster = $<HTMLInputElement>('#s-kp-master');
$('#s-kp-set').onclick = () => {
  const pw = sKpMaster.value;
  if (pw.length < 8) {
    $('#s-kp-state').textContent = 'Use at least 8 characters.';
    sKpMaster.focus();
    return;
  }
  dispatch({ type: 'passwords.setMaster', password: pw });
  sKpMaster.value = '';
};
$('#s-kp-clear').onclick = () => dispatch({ type: 'passwords.clearMaster' });
sLittle.onchange = () => dispatch({ type: 'settings.update', patch: { littleWindows: sLittle.checked } });
sAutoPip.onchange = () => dispatch({ type: 'settings.update', patch: { autoPip: sAutoPip.checked } });
const FLAGS: { key: keyof TroubleFlags; label: string; help: string }[] = [
  { key: 'noHwVideoDecode', label: 'Disable hardware video decoding', help: 'Videos decode on the CPU. Try this first when a video stays black or never starts.' },
  { key: 'noMacOverlays', label: 'Disable video overlays (macOS)', help: 'Draws video through the normal compositor instead of a native overlay layer.' },
  { key: 'noGraphite', label: 'Disable Skia Graphite', help: 'Falls back to the older Ganesh renderer for all page drawing.' },
  { key: 'noGpuCompositing', label: 'Disable GPU compositing', help: 'Composites pages on the CPU. Slower, but isolates driver problems.' },
  { key: 'noGpu', label: 'Disable the GPU entirely', help: 'Last resort: software rendering for everything.' },
  { key: 'noPageHooks', label: 'Do not patch pages', help: 'Chord adds small hooks to pages for players, calls, passkeys and Google sign-in. Turn them off (new page loads) to find out whether a site that keeps asking you to prove you are human objects to them.' },
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

// ---- MCP server ----
const sMcp = $<HTMLInputElement>('#s-mcp');
const sMcpPort = $<HTMLInputElement>('#s-mcp-port');
sMcp.onchange = () => state && dispatch({ type: 'settings.update', patch: { mcp: { ...state.settings.mcp, enabled: sMcp.checked } } });
sMcpPort.onchange = () => {
  const port = Math.round(Number(sMcpPort.value));
  if (state && port >= 1024 && port <= 65535) dispatch({ type: 'settings.update', patch: { mcp: { ...state.settings.mcp, port } } });
};
$('#s-mcp-copy').onclick = () => dispatch({ type: 'mcp.copyConfig' });
$('#s-mcp-regen').onclick = () => dispatch({ type: 'mcp.regenerate' });
let mcp: McpStatus | null = null;
function renderMcp(): void {
  if (!mcp || !state) return;
  const port = state.settings.mcp.port;
  $('#s-mcp-status').textContent = mcp.error ? `Not running: ${mcp.error}` : mcp.running ? `Running on 127.0.0.1:${mcp.port}${mcp.clients ? ` · ${mcp.clients} client${mcp.clients === 1 ? '' : 's'} seen` : ''}` : 'Off';
  $('#s-mcp-url').textContent = `http://127.0.0.1:${port}/mcp\nAuthorization: Bearer ${mcp.token}`;
}
api.onMcp((m) => {
  mcp = m;
  renderMcp();
});
void api.getMcp().then((m) => {
  if (m) {
    mcp = m;
    renderMcp();
  }
});

// ---- updates ----
const sUpdCheck = $<HTMLInputElement>('#s-upd-check');
const sUpdAuto = $<HTMLInputElement>('#s-upd-auto');
const sUpdAction = $<HTMLButtonElement>('#s-upd-action');
sUpdCheck.onchange = () => state && dispatch({ type: 'settings.update', patch: { updates: { ...state.settings.updates, check: sUpdCheck.checked } } });
sUpdAuto.onchange = () => state && dispatch({ type: 'settings.update', patch: { updates: { ...state.settings.updates, auto: sUpdAuto.checked } } });
$('#s-upd-now').onclick = () => dispatch({ type: 'update.check' });
let updates: UpdateStatus | null = null;
function renderUpdates(): void {
  const u = updates;
  if (!u) return;
  const channelNote: Record<UpdateStatus['channel'], string> = {
    nsis: 'This Windows installer updates itself: the new version is installed when Chord restarts.',
    appimage: 'This AppImage updates itself: the new file replaces the current one when Chord restarts.',
    mac: 'The macOS build is not notarised, so it cannot replace itself: Chord offers the new dmg to download and you drag it over the old copy.',
    'mac-legacy': 'This is the macOS 12 build (Electron 43). It cannot replace itself: Chord offers the new legacy dmg to download and you drag it over the old copy.',
    portable: 'The portable build never writes outside its folder: Chord offers the new zip to download.',
    deb: 'The .deb is managed by your package manager: Chord offers the new package to download.',
    dev: 'Update checks are off in development builds.',
  };
  $('#s-upd-note').textContent = channelNote[u.channel];
  const when = u.checkedAt ? ` (checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : '';
  const text: Record<UpdateStatus['state'], string> = {
    idle: `Chord ${u.current}`,
    checking: 'Checking…',
    none: `Chord ${u.current} is up to date${when}`,
    available: `Chord ${u.version} is available${when}`,
    downloading: `Downloading Chord ${u.version}… ${u.progress ?? 0}%`,
    ready: `Chord ${u.version} is downloaded`,
    error: `Could not check: ${u.error ?? 'unknown error'}`,
  };
  $('#s-upd-status').textContent = text[u.state];
  const action = u.state === 'available' ? (u.canInstall ? 'Download' : 'Open Download') : u.state === 'ready' ? 'Restart to Update' : '';
  sUpdAction.hidden = !action;
  sUpdAction.textContent = action;
  sUpdAction.onclick = () => dispatch(u.state === 'ready' ? { type: 'update.install' } : u.canInstall ? { type: 'update.download' } : { type: 'update.openPage' });
}
api.onUpdates((u) => {
  updates = u;
  renderUpdates();
});
void api.getUpdates().then((u) => {
  if (u) {
    updates = u;
    renderUpdates();
  }
});
$('#s-dldir-choose').onclick = () => dispatch({ type: 'downloads.chooseFolder' });
sDlDirReset.onclick = () => dispatch({ type: 'settings.update', patch: { downloadDir: null } });
$('#s-default').onclick = () => dispatch({ type: 'app.setDefaultBrowser' });
$('#s-export').onclick = () => dispatch({ type: 'config.export' });
$('#s-import').onclick = () => dispatch({ type: 'config.importFile' });
$('#s-ext-add').onclick = () => dispatch({ type: 'extension.pickFolder' });
const sExtStore = $<HTMLInputElement>('#s-ext-store');
const installExt = () => {
  const input = sExtStore.value.trim();
  if (!input) return;
  dispatch({ type: 'extension.install', input });
};
$('#s-ext-install').onclick = installExt;
sExtStore.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') installExt();
});
$('#s-ext-update').onclick = () => dispatch({ type: 'extension.update' });
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
  const msg = $('#s-ext-msg');
  msg.textContent = extStatus.install.message;
  msg.classList.toggle('err', extStatus.install.error);
  ($('#s-ext-install') as HTMLButtonElement).disabled = extStatus.install.busy;
  ($('#s-ext-update') as HTMLButtonElement).disabled = extStatus.install.busy || !s.settings.extensions.some((e) => e.storeId);
  if (!extStatus.install.busy && !extStatus.install.error && extStatus.install.message.startsWith('Installed')) sExtStore.value = '';
  sExtensions.replaceChildren(
    ...s.settings.extensions.map((e) => {
      const st = extStatus.paths[e.path];
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
          h('span', { title: e.path }, `${status}${status ? ' · ' : ''}${e.storeId ? 'Chrome Web Store' : e.path}`),
          st?.error && e.enabled ? h('span', { class: 'err' }, st.error) : null,
        ),
        h('label', { class: 'switch' }, toggle, h('i')),
        e.storeId ? h('button', { class: 'btn', title: 'Open its page in the Chrome Web Store', onclick: () => dispatch({ type: 'tab.new', url: `https://chromewebstore.google.com/detail/${e.storeId}`, activate: true }) }, 'Store') : null,
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
segment(sFavicons, (v) => dispatch({ type: 'theme.update', patch: { favicons: v as 'on' | 'active' | 'off' } }));
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
const sGoogle = $<HTMLSelectElement>('#s-google');
sGoogle.onchange = () => dispatch({ type: 'settings.update', patch: { googleSignIn: sGoogle.value as 'firefox' | 'electron' | 'off' } });
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
  pick(sFavicons, t.favicons);
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
  sGoogle.value = s.settings.googleSignIn;
  sShields.checked = s.settings.shields;
  sAddressBar.checked = s.settings.addressBar;
  sSmart.checked = s.settings.smartPages;
  sAskDl.checked = s.settings.askDownloadPath;
  sTray.checked = s.settings.closeToTray;
  sLittle.checked = s.settings.littleWindows;
  sAutofill.checked = s.settings.autofill;
  sPwLock.checked = s.settings.passwordLock;
  sAutoPip.checked = s.settings.autoPip;
  for (const [k, input] of flagInputs) input.checked = s.settings.flags[k] === true;
  sUpdCheck.checked = s.settings.updates.check;
  sMcp.checked = s.settings.mcp.enabled;
  if (document.activeElement !== sMcpPort) sMcpPort.value = String(s.settings.mcp.port);
  renderMcp();
  sUpdAuto.checked = s.settings.updates.auto;
  $('#s-pagetabs').replaceChildren(
    ...(s.settings.pageTabs.length
      ? s.settings.pageTabs.map((origin) => h('div', { class: 'row' }, h('span', {}, origin), h('button', { class: 'btn', onclick: () => dispatch({ type: 'pageTabs.forget', origin }) }, 'Forget')))
      : [h('span', { class: 'muted' }, 'None yet. A site that calls navigator.chord asks the first time; sites you allow are listed here.')]),
  );
  renderBoosts();
  renderRoutes();
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

// ---- routes page (Air Traffic Control) ----

const rPattern = $<HTMLInputElement>('#s-route-pattern');
const rSpace = $<HTMLSelectElement>('#s-route-space');

function prefillRoute(host: string): void {
  if (!rPattern.value) rPattern.value = host;
}
$('#s-route-save').onclick = () => {
  const s = state;
  if (!s) return;
  const pattern = rPattern.value.trim();
  rPattern.classList.toggle('bad', !pattern);
  if (!pattern || !rSpace.value) return;
  const routes: Route[] = [...s.settings.routes, { id: newBoostId(), pattern, spaceId: rSpace.value, enabled: true }];
  dispatch({ type: 'settings.update', patch: { routes } });
  rPattern.value = '';
};
rPattern.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#s-route-save').click();
});

function renderRoutes(): void {
  const s = state;
  if (!s) return;
  const spaces = s.settings ? s.spaces.filter((sp) => !sp.reader) : [];
  const label = (sp: { name: string; icon?: string }) => `${sp.icon ? `${sp.icon} ` : ''}${sp.name}`;
  const cur = rSpace.value;
  rSpace.replaceChildren(...spaces.map((sp) => h('option', { value: sp.id }, label(sp))));
  rSpace.value = spaces.some((sp) => sp.id === cur) ? cur : s.activeSpaceId;
  const update = (routes: Route[]) => dispatch({ type: 'settings.update', patch: { routes } });
  $('#s-routes').replaceChildren(
    ...s.settings.routes.map((r, i) => {
      const sp = s.spaces.find((x) => x.id === r.spaceId);
      const pick = h('select', { title: 'Space' }, ...spaces.map((x) => h('option', { value: x.id }, label(x)))) as HTMLSelectElement;
      pick.value = r.spaceId;
      pick.onchange = () => update(s.settings.routes.map((x) => (x.id === r.id ? { ...x, spaceId: pick.value } : x)));
      return h(
        'div',
        { class: 'boost' },
        h('label', { class: 'switch' }, Object.assign(h('input', { type: 'checkbox' }), { checked: r.enabled, onchange: (e: Event) => update(s.settings.routes.map((x) => (x.id === r.id ? { ...x, enabled: (e.target as HTMLInputElement).checked } : x))) }), h('i')),
        h('div', { class: 'text' }, h('strong', {}, r.pattern), h('span', {}, sp ? `→ ${label(sp)}` : '→ a space that no longer exists')),
        pick,
        h('button', { class: 'btn', title: 'Earlier rules win', disabled: i === 0, onclick: () => { const routes = [...s.settings.routes]; [routes[i - 1], routes[i]] = [routes[i], routes[i - 1]]; update(routes); } }, '↑'),
        h('button', { class: 'btn danger', onclick: () => update(s.settings.routes.filter((x) => x.id !== r.id)) }, 'Remove'),
      );
    }),
    s.settings.routes.length ? '' : h('span', { class: 's-foot', style: 'margin:0' }, 'No routes yet. Right-click a page → “Route this site to a Space…” or add one below.'),
  );
}

// ---- passwords page ----

let passwords: PasswordsStatus = { available: false, entries: [], never: [], verify: 'dialog', keepassReady: false };
api.onPasswords((p) => {
  passwords = p;
  renderPasswords();
});
void api.getPasswords().then((p) => {
  passwords = p;
  renderPasswords();
});

function renderPasswords(): void {
  const how = passwords.verify === 'touchid' ? 'Touch ID' : passwords.verify === 'hello' ? 'Windows Hello' : 'a confirmation';
  $('#s-pwlock-label').textContent = `Ask for ${how} before revealing or filling a password (then not again for ten minutes)`;
  $('#s-pwlock-note').textContent = passwords.verify === 'dialog' ? 'This computer offers neither Touch ID nor Windows Hello, so the check is a plain confirmation dialog: it guards against a slip, not an intruder.' : `${how} is the same check a passkey uses; the vault itself is encrypted with the operating system keychain either way.`;
  $('#s-kp-clear').hidden = !passwords.keepassReady;
  $('#s-kp-set').textContent = passwords.keepassReady ? 'Change master password' : 'Set and sync';
  $('#s-kp-state').textContent = passwords.keepassReady ? (state?.settings.sync.enabled ? 'A master password is set: passwords.kdbx is kept in the private repository.' : 'A master password is set; turn on GitHub sync (Settings → Sync) to publish the file.') : '';
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

// ---- passkeys ----

let passkeys: PasskeysStatus = { available: false, mode: 'chord', touchId: false, entries: [] };
const sPasskeys = $<HTMLSelectElement>('#s-passkeys');
sPasskeys.onchange = () => dispatch({ type: 'settings.update', patch: { passkeys: sPasskeys.value as 'chord' | 'system' } });
api.onPasskeys((p) => {
  passkeys = p;
  renderPasskeys();
});
void api.getPasskeys().then((p) => {
  passkeys = p;
  renderPasskeys();
});

function renderPasskeys(): void {
  if (document.activeElement !== sPasskeys) sPasskeys.value = passkeys.mode;
  $('#s-pk-note').textContent = !passkeys.available
    ? 'Passkey storage is unavailable because the operating system keychain cannot be reached; sites fall back to security keys.'
    : passkeys.mode === 'chord'
      ? `When a site offers a passkey, Chord asks you${passkeys.touchId ? ' with Touch ID' : ''} and stores it encrypted with your operating system's keychain; signing in later asks again. Passkeys stay on this computer and are not exported. Security keys still work for sites where Chord has no passkey.`
      : 'Requests go to the system: Windows Hello and security keys on Windows, security keys elsewhere. macOS and Linux have no system passkey provider for Chord.';
  const fmt = (t: number) => new Date(t).toLocaleDateString();
  $('#s-passkeys-list').replaceChildren(
    ...passkeys.entries
      .slice()
      .sort((a, b) => a.rpId.localeCompare(b.rpId) || a.userName.localeCompare(b.userName))
      .map((e) =>
        h(
          'div',
          { class: 'pw' },
          h('div', {}, h('div', { class: 'host' }, e.rpId), h('div', { class: 'user' }, [e.userName || e.userDisplayName || '(no account name)', e.userDisplayName && e.userDisplayName !== e.userName ? e.userDisplayName : ''].filter(Boolean).join(' · '))),
          h('span', { class: 'secret' }, `created ${fmt(e.createdAt)} · last used ${fmt(e.lastUsedAt)}`),
          h('div', { class: 'btns' }, h('button', { class: 'btn danger', onclick: () => dispatch({ type: 'passkey.delete', id: e.id }) }, 'Delete')),
        ),
      ),
  );
}

// ---- sync page ----

let syncStatus: SyncStatus | null = null;
const sSyncToken = $<HTMLInputElement>('#s-sync-token');
$('#s-sync-connect').onclick = () => {
  const token = sSyncToken.value.trim();
  if (!token) {
    sSyncToken.focus();
    return;
  }
  dispatch({ type: 'sync.connect', token });
  sSyncToken.value = '';
};
$('#s-sync-token-link').onclick = (e) => {
  e.preventDefault();
  dispatch({ type: 'tab.new', url: 'https://github.com/settings/tokens/new?scopes=repo&description=Chord%20sync', activate: true });
};
$('#s-sync-login').onclick = () => dispatch({ type: 'sync.login' });
$('#s-sync-gh').onclick = () => dispatch({ type: 'sync.loginGh' });
$('#s-sync-cancel').onclick = () => dispatch({ type: 'sync.loginCancel' });
$('#s-sync-copycode').onclick = () => void navigator.clipboard.writeText(syncStatus?.login?.userCode ?? '').catch(() => {});
$('#s-sync-opencode').onclick = () => syncStatus?.login && dispatch({ type: 'tab.new', url: syncStatus.login.url, activate: true });
$('#s-sync-app-link').onclick = (e) => {
  e.preventDefault();
  dispatch({ type: 'tab.new', url: 'https://github.com/settings/applications/new', activate: true });
};
const sSyncClientId = $<HTMLInputElement>('#s-sync-clientid');
sSyncClientId.onchange = () => state && dispatch({ type: 'settings.update', patch: { sync: { ...state.settings.sync, clientId: sSyncClientId.value.trim() || undefined } } });
$('#s-sync-now').onclick = () => dispatch({ type: 'sync.now' });
const sSyncTheme = $('#s-sync-theme');
segment(sSyncTheme, (v) => state && dispatch({ type: 'settings.update', patch: { sync: { ...state.settings.sync, theme: v as 'elegant' | 'pragmatic' | 'digg' } } }));
$('#s-sync-disconnect').onclick = () => dispatch({ type: 'sync.disconnect' });
api.onSync((st) => {
  syncStatus = st;
  renderSync();
});
void api.getSync().then((st) => {
  syncStatus = st;
  renderSync();
});

function renderSync(): void {
  const st = syncStatus;
  if (!st) return;
  $('#s-sync-off').hidden = st.connected;
  $('#s-sync-on').hidden = !st.connected;
  ($('#s-sync-connect') as HTMLButtonElement).disabled = st.busy;
  $('#s-sync-connect').textContent = st.busy ? 'Connecting…' : 'Connect and create the repositories';
  $('#s-sync-error').textContent = st.error;
  if (state && document.activeElement !== sSyncClientId) sSyncClientId.value = state.settings.sync.clientId ?? '';
  const loginBtn = $('#s-sync-login') as HTMLButtonElement;
  loginBtn.disabled = !st.canLogin || Boolean(st.login) || st.busy;
  $('#s-sync-gh').hidden = !st.ghCli;
  $('#s-sync-code').hidden = !st.login;
  if (st.login) $('#s-sync-usercode').textContent = st.login.userCode;
  $('#s-sync-login-note').textContent = st.canLogin ? (st.login ? 'Waiting for GitHub… the code expires in a few minutes.' : 'Opens github.com/login/device in a tab; you type a short code there and Chord gets a token with the repo scope.') : 'Sign-in needs an OAuth App client ID: this build has none yet, so paste a token or your own client ID below.';
  if (!st.connected) return;
  const link = (url: string, text = url) => h('a', { href: url, onclick: (e: MouseEvent) => { e.preventDefault(); dispatch({ type: 'tab.new', url, activate: true }); } }, text);
  $('#s-sync-user').replaceChildren(link(`https://github.com/${st.user}`, st.user));
  $('#s-sync-repos').replaceChildren(link(`https://github.com/${st.user}/${st.privateRepo}`, st.privateRepo), ' (private) · ', link(`https://github.com/${st.user}/${st.publicRepo}`, st.publicRepo), ' (public)');
  $('#s-sync-pages').replaceChildren(link(st.pagesUrl), h('span', { class: 's-foot', style: 'margin-left:8px' }, 'GitHub serves it a minute or two after the first push'));
  if (state) sSyncTheme.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === (state!.settings.sync.theme ?? 'elegant')));
  const t = (ts: number) => (ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never');
  $('#s-sync-state').textContent = `${st.busy ? 'Syncing… · ' : ''}last push ${t(st.lastPush)} · last pull ${t(st.lastPull)}`;
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
