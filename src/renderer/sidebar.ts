// The sidebar page: it is the window's own web page and draws the chrome
// around the tab views (native children painted above it). Rendering is
// keyed: existing elements are updated in place, never rebuilt.

import type { CallAction, CallInfo, DevAction, DevInfo, DownloadsStatus, ListName, MediaAction, MediaInfo, SmartInfo, SmartStatus, TabGroup, TimerInfo, Message, Space, SpaceId, State, Tab, TabId, UpdateStatus } from '../shared/types.ts';
import { activeSpace, isLocked, panelVisible, visiblePanes } from '../shared/model.ts';
import { clampPanel } from '../shared/modes.ts';
import { hostOf, isInternal, isSecure, searchUrl, toUrl } from '../shared/url.ts';
import { h, svg, ICONS, initialOf } from './dom.ts';
import { applyTheme } from './theme.ts';
import { computeLayout, GAP, topInsetFor } from '../shared/layout.ts';
import { cellCount, defaultTiling, formatTiling, parseTiling, resizeColumn, resizeRow, type Tiling } from '../shared/tiling.ts';

const api = window.chord;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const dispatch = (m: Message) => void api.dispatch(m);
const TAB_MIME = 'text/chord-tab';

let state: State | null = null;
let editingSpace: SpaceId | null = null;
let dragging: TabId | null = null;
let renderQueued = false;

document.documentElement.classList.add(`platform-${api.platform}`);

// ---- static chrome ----

const back = $<HTMLButtonElement>('#back');
const forward = $<HTMLButtonElement>('#forward');
const reload = $<HTMLButtonElement>('#reload');
const urlbar = $<HTMLButtonElement>('#urlbar');
const urlHost = urlbar.querySelector('.host') as HTMLElement;
const urlLock = urlbar.querySelector('.lock') as HTMLElement;
back.append(svg(ICONS.back));
forward.append(svg(ICONS.forward));
$('#collapse').append(svg(ICONS.collapse));
$('#space-menu').append(svg(ICONS.more));
$('#add-space').append(svg(ICONS.plus));
$('#new-tab .plus').append(svg(ICONS.plus));

back.onclick = () => dispatch({ type: 'nav.back' });
forward.onclick = () => dispatch({ type: 'nav.forward' });
reload.onclick = () => dispatch(focused()?.loading ? { type: 'nav.stop' } : { type: 'nav.reload' });
urlbar.onclick = () => dispatch({ type: 'palette.open', intent: focused() ? 'current' : 'new' });
$('#collapse').onclick = () => dispatch({ type: 'sidebar.toggle' });
$('#new-tab').onclick = () => dispatch({ type: 'palette.open', intent: 'new' });
$('#clear-today').onclick = () => dispatch({ type: 'today.clear' });
$('#add-space').onclick = () => dispatch({ type: 'space.create' });
$('#space-menu').onclick = () => state && dispatch({ type: 'space.contextmenu', id: state.activeSpaceId });
$('#space-name').ondblclick = () => state && startRename(state.activeSpaceId);
$('.stage-body').ondblclick = () => dispatch({ type: 'palette.open', intent: 'new' });

// Address bar (optional, across the top of the page).
const abBack = $<HTMLButtonElement>('#ab-back');
const abForward = $<HTMLButtonElement>('#ab-forward');
const abReload = $<HTMLButtonElement>('#ab-reload');
const abLock = $('#ab-lock');
const address = $<HTMLInputElement>('#address');
abBack.append(svg(ICONS.back));
abForward.append(svg(ICONS.forward));
abBack.onclick = () => dispatch({ type: 'nav.back' });
abForward.onclick = () => dispatch({ type: 'nav.forward' });
abReload.onclick = () => dispatch(focused()?.loading ? { type: 'nav.stop' } : { type: 'nav.reload' });
address.addEventListener('focus', () => address.select());
address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const q = address.value.trim();
    if (!q || !state) return;
    const url = toUrl(q) ?? searchUrl(state.settings.searchEngine, q);
    dispatch(focused() ? { type: 'tab.navigate', url } : { type: 'tab.new', url, activate: true });
    address.blur();
  } else if (e.key === 'Escape') {
    address.value = focused()?.url ?? '';
    address.blur();
  }
});

// Peek: hovering the left edge while the sidebar is collapsed shows it until the
// pointer leaves it again (or the page is clicked; the main process handles that).
let peeking = false;
let peekTimer = 0;
function setPeek(on: boolean): void {
  clearTimeout(peekTimer);
  if (peeking === on) return;
  peeking = on;
  document.body.classList.toggle('peeking', on);
  dispatch({ type: 'sidebar.peek', on });
}
$('#edge').addEventListener('mouseenter', () => {
  if (state && !state.settings.sidebarOpen) setPeek(true);
});
$('#sidebar').addEventListener('mouseleave', () => {
  if (!peeking) return;
  clearTimeout(peekTimer);
  peekTimer = window.setTimeout(() => setPeek(false), 350);
});
$('#sidebar').addEventListener('mouseenter', () => clearTimeout(peekTimer));
window.addEventListener('blur', () => {
  if (peeking) setPeek(false);
});

// Sidebar resizing: the pointer stays inside the sidebar because the width follows it.
$('#resizer').addEventListener('mousedown', (e) => {
  e.preventDefault();
  let frame = 0;
  const move = (ev: MouseEvent) => {
    const width = ev.clientX + 4;
    document.documentElement.style.setProperty('--sidebar-width', `${Math.max(180, Math.min(480, width))}px`);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => dispatch({ type: 'sidebar.resize', width }));
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

dropZone($('#favorites'), 'favorites');
dropZone($('#pinned'), 'pinned');
dropZone($('#today'), 'today');

function focused(): Tab | undefined {
  if (!state) return undefined;
  const sp = activeSpace(state);
  if (isLocked(sp)) return undefined;
  return sp.focused ? state.tabs[sp.focused] : undefined;
}

$('#locked .lock-icon').append(svg(ICONS.lock, 28));
const modesBtn = $<HTMLButtonElement>('#space-modes');
modesBtn.replaceChildren(svg(ICONS.sparkle));
modesBtn.onclick = () => {
  if (state) dispatch({ type: 'space.modesMenu', id: state.activeSpaceId });
};
$('#unlock').onclick = () => {
  if (state) dispatch({ type: 'space.passwordPrompt', id: state.activeSpaceId, purpose: 'unlock' });
};

// ---- rendering ----

api.onState((s) => {
  state = s;
  render();
});
api.getState().then((s) => {
  if (s) {
    state = s;
    render();
  }
});
api.onSidebar((m) => {
  if (m.kind === 'space.renameStart') startRename(m.id);
});

let lastSpaceKey = '';
let smart: SmartStatus = {};
let downloads: DownloadsStatus = { items: [], active: 0 };

// ---- downloads: ring in the title bar, a row above the player while something is in flight ----

const dlBtn = $<HTMLButtonElement>('#dl-btn');
const dlRow = $<HTMLButtonElement>('#dl-row');
const dlTitle = $('#dl-title');
const dlSub = $('#dl-sub');
const dlBar = $('#dl-bar');
let dlHideTimer = 0;
dlBtn.replaceChildren(svg(ICONS.download), dlBtn.querySelector('.ring')!, dlBtn.querySelector('.badge')!);
dlBtn.onclick = () => dispatch({ type: 'downloads.panel' });
const settingsBtn = $<HTMLButtonElement>('#settings-btn');
settingsBtn.replaceChildren(svg(ICONS.settings));
settingsBtn.onclick = () => dispatch({ type: 'settings.open' });
dlRow.onclick = () => dispatch({ type: 'downloads.panel' });
api.onDownloads((d) => {
  downloads = d;
  renderDownloads();
});
api.getDownloads().then((d) => {
  if (d) {
    downloads = d;
    renderDownloads();
  }
});

function formatBytesShort(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function renderDownloads(): void {
  const active = downloads.items.filter((e) => e.state === 'progressing');
  const recent = downloads.items.find((e) => e.state === 'completed' && e.finishedAt && Date.now() - e.finishedAt < 8000);
  dlBtn.classList.toggle('hidden', downloads.items.length === 0);
  dlBtn.classList.toggle('active', active.length > 0);
  if (active.length) {
    const total = active.reduce((n, e) => n + e.total, 0);
    const received = active.reduce((n, e) => n + e.received, 0);
    const p = total > 0 ? received / total : 0;
    dlBtn.style.setProperty('--p', String(p));
    setText(dlBtn.querySelector('.badge') as HTMLElement, String(active.length));
    const first = active[0];
    setText(dlTitle, active.length === 1 ? first.filename : `${active.length} downloads`);
    setText(dlSub, total > 0 ? `${Math.round(p * 100)}%` : formatBytesShort(received));
    dlBar.style.width = `${Math.round(p * 100)}%`;
    setClass(dlRow, 'done', false);
    dlRow.classList.remove('hidden');
    window.clearTimeout(dlHideTimer);
  } else if (recent) {
    setText(dlTitle, recent.filename);
    setText(dlSub, 'Done');
    setClass(dlRow, 'done', true);
    dlRow.classList.remove('hidden');
    window.clearTimeout(dlHideTimer);
    dlHideTimer = window.setTimeout(renderDownloads, 8000 - (Date.now() - (recent.finishedAt ?? 0)) + 50);
  } else {
    dlRow.classList.add('hidden');
  }
}

// ---- smart pages: players, calls, timers, unread and notifications, across spaces ----

api.onSmart((m) => {
  smart = m;
  renderSmart();
});
api.getSmart().then((m) => {
  if (m) {
    smart = m;
    renderSmart();
  }
});

const players = $('#players');
const minis = [
  { pill: $<HTMLButtonElement>('#now-mini'), pp: $<HTMLButtonElement>('#now-mini-pp') },
  { pill: $<HTMLButtonElement>('#ab-now'), pp: $<HTMLButtonElement>('#ab-now-pp') },
];
let playerTab: TabId | null = null;
const mediaAction = (id: TabId, action: MediaAction) => () => dispatch({ type: 'media.action', id, action });
const togglePlayOf = (id: TabId) => () => {
  const info = smart[id]?.media;
  if (info) mediaAction(id, info.playing ? 'pause' : 'play')();
};
for (const m of minis) {
  m.pill.onclick = () => {
    if (playerTab) dispatch({ type: 'tab.activate', id: playerTab });
  };
  m.pp.onclick = () => {
    if (playerTab) togglePlayOf(playerTab)();
  };
}

const callEl = $('#call');
const callTitle = $('#call-title');
const callSub = $('#call-sub');
const callMute = $<HTMLButtonElement>('#call-mute');
const callCam = $<HTMLButtonElement>('#call-cam');
const callLeave = $<HTMLButtonElement>('#call-leave');
let callTab: TabId | null = null;
let callTick = 0;
const callAction = (action: CallAction) => () => {
  if (callTab) dispatch({ type: 'call.action', id: callTab, action });
};
$('#call-open').onclick = () => {
  if (callTab) dispatch({ type: 'tab.activate', id: callTab });
};
callMute.onclick = callAction('mute');
callCam.onclick = callAction('camera');
callLeave.onclick = callAction('leave');

const chip = $<HTMLButtonElement>('#chip');
const chipIcon = chip.querySelector('.chip-icon') as HTMLElement;
const chipText = chip.querySelector('.t') as HTMLElement;
let chipTab: TabId | null = null;
chip.onclick = () => {
  if (chipTab) dispatch({ type: 'tab.activate', id: chipTab });
};

function entries(): [TabId, SmartInfo][] {
  if (!state || !state.settings.smartPages) return [];
  const tabs = state.tabs;
  return Object.entries(smart).filter(([id]) => tabs[id]);
}

/** Every tab with a player, playing ones first, then the most recently updated. */
function currentPlayers(): [TabId, MediaInfo][] {
  const out: [TabId, MediaInfo][] = [];
  for (const [id, s] of entries()) if (s.media) out.push([id, s.media]);
  return out.sort((a, b) => Number(b[1].playing) - Number(a[1].playing) || b[1].updatedAt - a[1].updatedAt);
}

function currentCall(): [TabId, CallInfo] | null {
  let best: [TabId, CallInfo] | null = null;
  for (const [id, s] of entries()) if (s.call && (!best || s.call.since < best[1].since)) best = [id, s.call];
  return best;
}

/** Developer pages: pending runs first, then the most recently changed. */
function currentDevs(): [TabId, DevInfo][] {
  const out: [TabId, DevInfo][] = [];
  for (const [id, s] of entries()) if (s.dev) out.push([id, s.dev]);
  return out.sort((a, b) => Number(b[1].state === 'pending') - Number(a[1].state === 'pending') || b[1].updatedAt - a[1].updatedAt);
}

function currentTimer(): [TabId, TimerInfo] | null {
  let best: [TabId, SmartInfo] | null = null;
  for (const [id, s] of entries()) if (s.timer && (!best || s.updatedAt > best[1].updatedAt)) best = [id, s];
  return best ? [best[0], best[1].timer!] : null;
}

function notificationsTotal(): { count: number; tab: TabId | null } {
  let count = 0;
  let latest: [TabId, number] | null = null;
  for (const [id, s] of entries()) {
    count += s.notifications;
    const at = s.lastNotification?.at ?? 0;
    if (s.notifications && (!latest || at > latest[1])) latest = [id, at];
  }
  return { count, tab: latest ? latest[0] : null };
}

/** Unread count from the title, or notifications since the tab was last looked at. */
function badgeOf(id: TabId): number {
  const s = smart[id];
  if (!s || !state?.settings.smartPages) return 0;
  return s.unread ?? s.notifications;
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

const rssBtn = $<HTMLButtonElement>('#rss-btn');
let subscribed = new Set<string>();
api.onReader((r) => {
  subscribed = new Set(r.feeds.map((f) => f.url));
  renderRss();
});
void api.getReader().then((r) => {
  if (r) subscribed = new Set(r.feeds.map((f) => f.url));
  renderRss();
});
rssBtn.onclick = () => {
  const tab = focused();
  if (tab) dispatch({ type: 'reader.subscribeFrom', id: tab.id });
};
function renderRss(): void {
  const tab = focused();
  const feeds = tab ? (smart[tab.id]?.feeds ?? []).filter((f) => !subscribed.has(f.url)) : [];
  rssBtn.classList.toggle('hidden', feeds.length === 0);
  if (feeds.length) {
    setIconKey(rssBtn, 'rss', () => svg(ICONS.rss));
    rssBtn.title = feeds.length === 1 ? `Subscribe to “${feeds[0].title || hostOf(feeds[0].url)}” in the reader` : `This site offers ${feeds.length} feeds: subscribe in the reader`;
  }
}

function renderSmart(): void {
  renderInstall();
  renderRss();
  renderDevs();
  renderPlayer();
  renderCall();
  renderChip();
  renderBadges();
}

const devs = $('#devs');
const DEV_BUTTONS: { action: DevAction; icon: string; title: string }[] = [
  { action: 'checks', icon: 'checks', title: 'Show the checks' },
  { action: 'rerun', icon: 'reload', title: 'Re-run all jobs' },
  { action: 'problems', icon: 'warning', title: 'Show problems' },
  { action: 'stopDebug', icon: 'stop', title: 'Stop debugging' },
  { action: 'notifications', icon: 'bell', title: 'Notifications' },
];
const DEV_ICON: Record<string, string> = { checks: ICONS.archive, reload: ICONS.reload, warning: ICONS.warning, stop: ICONS.stop, bell: ICONS.bell };
const STATE_LABEL: Record<string, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed', success: 'Passed', failure: 'Failed', pending: 'Running', cancelled: 'Cancelled', skipped: 'Skipped', neutral: 'Neutral' };

function makeDevCard(entry: [TabId, DevInfo]): HTMLElement {
  const id = entry[0];
  return h(
    'div',
    { class: 'dev', 'data-id': id },
    h(
      'button',
      { class: 'dev-main', title: 'Go to this tab', onclick: () => dispatch({ type: 'tab.activate', id }) },
      h('span', { class: 'ico' }),
      h('span', { class: 'text' }, h('span', { class: 'title' }), h('span', { class: 'sub' })),
    ),
    h('div', { class: 'now-controls' }, ...DEV_BUTTONS.map((b) => h('button', { class: `icon-btn ${b.action}`, title: b.title, onclick: () => dispatch({ type: 'dev.action', id, action: b.action }) }, svg(DEV_ICON[b.icon], 14)))),
  );
}

function devSummary(d: DevInfo): string {
  const parts: string[] = [];
  if (d.kind === 'github') {
    if (d.state) parts.push(STATE_LABEL[d.state] ?? d.state);
    if (d.checks) parts.push(d.checks.pending ? `${d.checks.ok + d.checks.failed}/${d.checks.total} checks` : d.checks.failed ? `${d.checks.failed} of ${d.checks.total} checks failed` : `${d.checks.total} check${d.checks.total === 1 ? '' : 's'} ok`);
    if (d.branch) parts.push(d.branch);
    if (d.unread) parts.push('unread notifications');
  } else {
    if (d.branch) parts.push(d.branch);
    if (d.problems && (d.problems.errors || d.problems.warnings)) parts.push([d.problems.errors ? `${d.problems.errors} error${d.problems.errors === 1 ? '' : 's'}` : '', d.problems.warnings ? `${d.problems.warnings} warning${d.problems.warnings === 1 ? '' : 's'}` : ''].filter(Boolean).join(', '));
    if (d.debugging) parts.push('debugging');
    if (d.tasks) parts.push(`${d.tasks} task${d.tasks === 1 ? '' : 's'} running`);
    if (d.remote) parts.push(d.remote);
    if (d.unread) parts.push(`${d.unread} new notification${d.unread === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

function updateDevCard(el: HTMLElement, entry: [TabId, DevInfo]): void {
  const [, d] = entry;
  for (const cls of ['pending', 'failure', 'success', 'merged', 'closed', 'open']) setClass(el, cls, d.state === cls);
  setIconKey(el.querySelector('.ico') as HTMLElement, d.kind, () => svg(d.kind === 'github' ? ICONS.branch : ICONS.code));
  const title = el.querySelector('.title') as HTMLElement;
  const titleText = d.kind === 'vscode' && d.subject ? `${d.unsaved ? '● ' : ''}${d.subject} — ${d.project}` : d.subject ? `${d.project} · ${d.subject}` : d.project;
  setText(title, titleText);
  setClass(title, 'unsaved', d.kind === 'vscode' && d.unsaved);
  const sub = el.querySelector('.sub') as HTMLElement;
  setText(sub, devSummary(d) || (d.kind === 'github' ? 'GitHub' : 'VS Code'));
  setClass(sub, 'err', d.state === 'failure' || Boolean(d.problems?.errors));
  el.title = `${d.kind === 'github' ? 'GitHub' : 'VS Code'} · ${titleText}\n${devSummary(d)}`;
  for (const b of DEV_BUTTONS) {
    const btn = el.querySelector(`.icon-btn.${b.action}`) as HTMLButtonElement;
    btn.hidden = !d.actions.includes(b.action);
    setClass(btn, 'alert', b.action === 'notifications' && d.unread > 0);
  }
}

function renderDevs(): void {
  syncChildren(devs, currentDevs(), (e) => e[0], makeDevCard, updateDevCard);
}

function makePlayerCard(entry: [TabId, MediaInfo]): HTMLElement {
  const id = entry[0];
  return h(
    'div',
    { class: 'now', 'data-id': id },
    h(
      'button',
      { class: 'now-main', title: 'Go to this tab', onclick: () => dispatch({ type: 'tab.activate', id }) },
      h('span', { class: 'art' }),
      h('span', { class: 'text' }, h('span', { class: 'title' }), h('span', { class: 'sub' })),
    ),
    h(
      'div',
      { class: 'now-controls' },
      h('button', { class: 'icon-btn prev', title: 'Previous', onclick: mediaAction(id, 'previoustrack') }),
      h('button', { class: 'icon-btn pp', title: 'Play/Pause', onclick: togglePlayOf(id) }),
      h('button', { class: 'icon-btn next', title: 'Next', onclick: mediaAction(id, 'nexttrack') }),
      h('button', { class: 'icon-btn pip', title: 'Picture in Picture (⌘⌥P)', onclick: () => dispatch({ type: 'media.pip', id }) }),
    ),
    h('input', { class: 'vol', type: 'range', min: '0', max: '100', step: '5', title: 'Volume', oninput: (e: Event) => dispatch({ type: 'tab.volume', id, volume: Number((e.target as HTMLInputElement).value) / 100 }) }),
  );
}

function updatePlayerCard(el: HTMLElement, entry: [TabId, MediaInfo]): void {
  if (!state) return;
  const [id, info] = entry;
  const tab = state.tabs[id];
  const title = info.title || tab.title || info.host;
  const sub = [info.artist, info.host].filter(Boolean).join(' · ');
  setText(el.querySelector('.title') as HTMLElement, title);
  setText(el.querySelector('.sub') as HTMLElement, sub);
  const art = el.querySelector('.art') as HTMLElement;
  const artKey = info.artwork ? `img:${info.artwork}` : 'icon';
  setIconKey(art, artKey, () => (info.artwork ? document.createTextNode('') : svg(ICONS.music)));
  const bg = info.artwork ? `url("${info.artwork}")` : '';
  if (art.style.backgroundImage !== bg) art.style.backgroundImage = bg;
  setClass(el, 'playing', info.playing);
  const can = (a: MediaAction) => info.actions.length === 0 || info.actions.includes(a);
  const prev = el.querySelector('.prev') as HTMLButtonElement;
  const pp = el.querySelector('.pp') as HTMLButtonElement;
  const next = el.querySelector('.next') as HTMLButtonElement;
  prev.disabled = !info.actions.includes('previoustrack');
  next.disabled = !info.actions.includes('nexttrack');
  pp.disabled = !(can('play') || can('pause'));
  setIconKey(pp, info.playing ? 'pause' : 'play', () => svg(info.playing ? ICONS.pause : ICONS.play));
  setIconKey(prev, 'prev', () => svg(ICONS.prev));
  setIconKey(next, 'next', () => svg(ICONS.next));
  const vol = el.querySelector('.vol') as HTMLInputElement;
  const level = String(Math.round((tab.volume ?? 1) * 100));
  if (document.activeElement !== vol && vol.value !== level) vol.value = level;
  const pip = el.querySelector('.pip') as HTMLButtonElement;
  pip.hidden = !info.video;
  setIconKey(pip, 'pip', () => svg(ICONS.pip));
}

function renderPlayer(): void {
  const list = currentPlayers();
  syncChildren(players, list, (e) => e[0], makePlayerCard, updatePlayerCard);
  const top = list[0];
  playerTab = top ? top[0] : null;
  for (const m of minis) {
    m.pill.classList.toggle('hidden', !top);
    m.pp.classList.toggle('hidden', !top);
  }
  if (!top || !state) return;
  const [id, info] = top;
  const title = info.title || state.tabs[id].title || info.host;
  const sub = [info.artist, info.host].filter(Boolean).join(' · ');
  const artKey = info.artwork ? `img:${info.artwork}` : 'icon';
  const bg = info.artwork ? `url("${info.artwork}")` : '';
  for (const m of minis) {
    const art = m.pill.querySelector('.art') as HTMLElement;
    setIconKey(art, artKey, () => (info.artwork ? document.createTextNode('') : svg(ICONS.music)));
    if (art.style.backgroundImage !== bg) art.style.backgroundImage = bg;
    setText(m.pill.querySelector('.t') as HTMLElement, title);
    m.pill.title = `${list.length > 1 ? `${list.length} players · ` : ''}${title}${sub ? ` — ${sub}` : ''}`;
    setIconKey(m.pp, info.playing ? 'pause' : 'play', () => svg(info.playing ? ICONS.pause : ICONS.play));
    m.pp.disabled = info.actions.length > 0 && !info.actions.includes('play') && !info.actions.includes('pause');
  }
}

function renderCall(): void {
  const call = currentCall();
  callTab = call ? call[0] : null;
  callEl.classList.toggle('hidden', !call);
  window.clearInterval(callTick);
  if (!call || !state) return;
  const [id, info] = call;
  const where = info.site || state.tabs[id].title;
  setText(callTitle, `In a call${info.sharing ? ' · sharing screen' : ''}`);
  const tick = () => {
    setText(callSub, `${fmtDuration(Date.now() - info.since)} · ${where}`);
    if (chipTab === id && chip.classList.contains('call')) setText(chipText, fmtDuration(Date.now() - info.since));
  };
  tick();
  callTick = window.setInterval(tick, 1000);
  setClass(callEl, 'muted', info.muted === true);
  setIconKey(callMute, info.muted ? 'micOff' : 'mic', () => svg(info.muted ? ICONS.micOff : ICONS.mic));
  callMute.title = info.muted ? 'Unmute' : 'Mute';
  setClass(callMute, 'off', info.muted === true);
  setIconKey(callCam, info.cameraOff ? 'camOff' : 'cam', () => svg(info.cameraOff ? ICONS.cameraOff : ICONS.camera));
  callCam.title = info.cameraOff ? 'Turn camera on' : 'Turn camera off';
  setClass(callCam, 'off', info.cameraOff === true);
  setIconKey(callLeave, 'leave', () => svg(ICONS.phoneOff));
}

/** One chip in the title bar: the call, else a running timer, else unseen notifications. */
function renderChip(): void {
  const call = currentCall();
  const dev = call ? null : currentDevs().find(([, d]) => d.state === 'pending') ?? null;
  const timer = call || dev ? null : currentTimer();
  const notes = call || timer || dev ? null : notificationsTotal();
  chip.className = 'chip';
  if (dev) {
    chipTab = dev[0];
    chip.classList.add('dev');
    setIconKey(chipIcon, 'spin', () => svg(ICONS.reload));
    const c = dev[1].checks;
    setText(chipText, c && c.total > 1 ? `${c.ok + c.failed}/${c.total}` : dev[1].subject.split(' · ')[0] || 'running');
    chip.title = `${dev[1].project} · ${dev[1].subject} is running — click to go there`;
  } else if (call) {
    chipTab = call[0];
    chip.classList.add('call');
    setClass(chip, 'muted', call[1].muted === true);
    setIconKey(chipIcon, 'dot', () => document.createTextNode(''));
    setText(chipText, fmtDuration(Date.now() - call[1].since));
    chip.title = `In a call on ${call[1].site} — click to go there`;
  } else if (timer) {
    chipTab = timer[0];
    chip.classList.add('timer');
    setIconKey(chipIcon, 'clock', () => svg(ICONS.clock));
    setText(chipText, timer[1].text);
    chip.title = `${state?.tabs[timer[0]].title ?? ''} — click to go there`;
  } else if (notes && notes.count > 0) {
    chipTab = notes.tab;
    chip.classList.add('notif');
    setIconKey(chipIcon, 'bell', () => svg(ICONS.bell));
    setText(chipText, String(notes.count));
    const last = notes.tab ? smart[notes.tab]?.lastNotification : undefined;
    chip.title = last ? `${last.title}${last.body ? `\n${last.body}` : ''}` : 'Notifications';
  } else {
    chipTab = null;
    chip.classList.add('hidden');
  }
}

/** A new Chord: a banner above the lists while an update is available or downloaded. */
const updateBanner = $('#update');
let updateStatus: UpdateStatus | null = null;
let updateDismissed = '';
$('#update-go').onclick = () => {
  const u = updateStatus;
  if (!u) return;
  dispatch(u.state === 'ready' ? { type: 'update.install' } : u.canInstall ? { type: 'update.download' } : { type: 'update.openPage' });
};
$('#update-no').onclick = () => {
  updateDismissed = `${updateStatus?.version ?? ''}:${updateStatus?.state ?? ''}`;
  renderUpdate();
};
function renderUpdate(): void {
  const u = updateStatus;
  const show = Boolean(u && (u.state === 'available' || u.state === 'ready' || u.state === 'downloading') && updateDismissed !== `${u.version ?? ''}:${u.state}`);
  updateBanner.classList.toggle('hidden', !show);
  if (!u || !show) return;
  setText($('#update-text'), u.state === 'ready' ? `Chord ${u.version} is ready` : u.state === 'downloading' ? `Downloading Chord ${u.version}… ${u.progress ?? 0}%` : `Chord ${u.version} is available`);
  const go = $('#update-go');
  setText(go, u.state === 'ready' ? 'Restart' : u.state === 'downloading' ? '…' : u.canInstall ? 'Update' : 'Download');
  (go as HTMLButtonElement).disabled = u.state === 'downloading';
}
api.onUpdates((u) => {
  updateStatus = u;
  renderUpdate();
});
void api.getUpdates().then((u) => {
  if (u) {
    updateStatus = u;
    renderUpdate();
  }
});

/** A site offering a space: a banner above the lists, dismissable per manifest. */
const installBanner = $('#install');
const dismissedManifests = new Set<string>();
let bannerManifest = '';
$('#install-go').onclick = () => {
  if (bannerManifest) dispatch({ type: 'space.install', url: bannerManifest });
};
$('#install-no').onclick = () => {
  dismissedManifests.add(bannerManifest);
  renderInstall();
};
function renderInstall(): void {
  const tab = focused();
  const manifest = tab ? smart[tab.id]?.manifest : undefined;
  bannerManifest = manifest && !dismissedManifests.has(manifest) ? manifest : '';
  installBanner.classList.toggle('hidden', !bannerManifest);
  if (bannerManifest) setText($('#install-text'), `${hostOf(bannerManifest)} offers a space for Chord`);
}

/** Unread / notification counts on tab rows and space dots. */
function renderBadges(): void {
  if (!state) return;
  for (const el of document.querySelectorAll<HTMLElement>('.tab[data-id]')) {
    const n = badgeOf(el.dataset.id as TabId);
    setClass(el, 'has-badge', n > 0);
    if (n > 0) setText(el.querySelector('.badge') as HTMLElement, n > 99 ? '99+' : String(n));
  }
  for (const sp of state.spaces) {
    const el = document.querySelector<HTMLElement>(`.space-dot[data-id="${sp.id}"]`);
    if (!el) continue;
    const n = [...sp.pinned, ...sp.today].reduce((sum, id) => sum + badgeOf(id), 0);
    let badge = el.querySelector<HTMLElement>('.badge');
    if (!badge) {
      badge = h('span', { class: 'badge' });
      el.append(badge);
    }
    setClass(el, 'has-badge', n > 0);
    if (n > 0) setText(badge, n > 99 ? '99+' : String(n));
  }
}

function render(): void {
  if (!state) return;
  if (dragging) {
    renderQueued = true;
    return;
  }
  renderRss();
  const s = state;
  const space = activeSpace(s);
  applyTheme(s.settings.theme, space);
  document.documentElement.style.setProperty('--sidebar-width', `${s.settings.sidebarWidth}px`);
  document.body.classList.toggle('sidebar-closed', !s.settings.sidebarOpen);
  if (s.settings.sidebarOpen && peeking) setPeek(false);

  document.body.classList.toggle('space-locked', isLocked(space));
  setClass(modesBtn, 'on', (space.modes?.length ?? 0) > 0);
  const pill = $('#space-profile');
  pill.classList.toggle('hidden', !space.profile);
  if (space.profile) setText(pill, space.profile);
  const tab = focused();
  back.disabled = !tab?.canGoBack;
  forward.disabled = !tab?.canGoForward;
  setIconKey(reload, tab?.loading ? 'stop' : 'reload', () => svg(tab?.loading ? ICONS.stop : ICONS.reload));
  reload.disabled = !tab;
  urlbar.classList.toggle('placeholder', !tab);
  setText(urlHost, tab ? hostOf(tab.url) || tab.url : 'Search or enter URL');
  const lockKey = tab ? (isSecure(tab.url) ? 'lock' : 'globe') : 'search';
  const lockIcon = () => svg(tab ? (isSecure(tab.url) ? ICONS.lock : ICONS.globe) : ICONS.search);
  setIconKey(urlLock, lockKey, lockIcon);

  document.body.classList.toggle('addressbar', s.settings.addressBar);
  if (s.settings.addressBar) {
    abBack.disabled = !tab?.canGoBack;
    abForward.disabled = !tab?.canGoForward;
    abReload.disabled = !tab;
    setIconKey(abReload, tab?.loading ? 'stop' : 'reload', () => svg(tab?.loading ? ICONS.stop : ICONS.reload));
    setIconKey(abLock, lockKey, lockIcon);
    if (document.activeElement !== address) {
      const url = tab?.url ?? '';
      if (address.value !== url) address.value = url;
    }
  }

  syncChildren($('#favorites'), s.favorites.map((id) => s.tabs[id]).filter(Boolean), (t) => t.id, makeFavorite, (el, t) => updateFavorite(el, t, space));
  setText($('#space-icon'), space.icon ?? '');
  renderSpaceName(space);
  const rows = (ids: TabId[]) => listRows(s, space, ids);
  const makeRow = (r: Row) => (r.kind === 'tab' ? makeTab(r.tab) : makeGroupHeader(r.group));
  const updateRow = (el: HTMLElement, r: Row) => (r.kind === 'tab' ? updateTab(el, r.tab, space) : updateGroupHeader(el, r.group, r.count));
  syncChildren($('#pinned'), rows(space.pinned), rowKey, makeRow, updateRow);
  $('#pinned-divider').classList.toggle('hidden', space.pinned.length === 0);
  syncChildren($('#today'), rows(space.today), rowKey, makeRow, updateRow);

  const spaceKey = s.spaces.map((sp) => `${sp.id}${sp.name}${sp.color}${sp.icon ?? ''}${sp.lock ? (isLocked(sp) ? 'L' : 'U') : ''}`).join('|') + s.activeSpaceId;
  if (spaceKey !== lastSpaceKey) {
    lastSpaceKey = spaceKey;
    syncChildren($('#spaces'), s.spaces, (sp) => sp.id, makeSpaceDot, (el, sp) => updateSpaceDot(el, sp, s));
  }
  $('#stage').classList.toggle('empty', visiblePanes(space).length === 0);
  renderGutters(s, space);
  renderSmart();
}

/** Keyed child reconciliation: reuse elements by key, reorder, drop the rest. */
function syncChildren<T>(container: HTMLElement, items: T[], key: (item: T) => string, make: (item: T) => HTMLElement, update: (el: HTMLElement, item: T) => void): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children)) existing.set((child as HTMLElement).dataset.key ?? '', child as HTMLElement);
  const keep = new Set<string>();
  let cursor: Element | null = container.firstElementChild;
  for (const item of items) {
    const k = key(item);
    keep.add(k);
    let el = existing.get(k);
    if (!el) {
      el = make(item);
      el.dataset.key = k;
    }
    update(el, item);
    if (el === cursor) cursor = cursor.nextElementSibling;
    else container.insertBefore(el, cursor);
  }
  for (const [k, el] of existing) if (!keep.has(k)) el.remove();
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function setClass(el: HTMLElement, name: string, on: boolean): void {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

/** Replace the children of `slot` only when the icon key changes. */
function setIconKey(slot: HTMLElement, key: string, make: () => Node): void {
  if (slot.dataset.icon === key) return;
  slot.dataset.icon = key;
  slot.replaceChildren(make());
}

function iconKey(tab: Tab, spinner: boolean): string {
  if (spinner && tab.loading) return 'spinner';
  if (isInternal(tab.url)) return `internal:${hostOf(tab.url)}`;
  return tab.favicon && faviconsOn() ? `img:${tab.favicon}` : `glyph:${initialOf(hostOf(tab.url) || tab.title)}`;
}

const faviconsOn = (): boolean => state?.settings.theme.favicons !== 'off';

function makeIcon(tab: Tab, spinner: boolean): Node {
  if (spinner && tab.loading) return h('div', { class: 'spinner' });
  if (isInternal(tab.url)) return h('div', { class: 'glyph internal' }, svg(hostOf(tab.url) === 'downloads' ? ICONS.download : hostOf(tab.url) === 'settings' ? ICONS.settings : hostOf(tab.url) === 'history' ? ICONS.clock : hostOf(tab.url) === 'bookmarks' ? ICONS.star : hostOf(tab.url) === 'reader' ? ICONS.rss : ICONS.globe, 12));
  const glyph = h('div', { class: 'glyph' }, initialOf(hostOf(tab.url) || tab.title));
  if (!tab.favicon || !faviconsOn()) return glyph;
  const img = h('img', { class: 'favicon', src: tab.favicon, alt: '', draggable: 'false' });
  img.onerror = () => img.replaceWith(glyph);
  return img;
}

function renderSpaceName(space: Space): void {
  const name = $('#space-name');
  if (editingSpace !== space.id) {
    if (name.querySelector('input')) name.replaceChildren();
    setText(name, space.name);
    return;
  }
  if (name.querySelector('input')) return;
  const input = h('input', { type: 'text', spellcheck: 'false' });
  input.value = space.name;
  const finish = (save: boolean) => {
    if (editingSpace !== space.id) return;
    editingSpace = null;
    if (save && input.value.trim()) dispatch({ type: 'space.rename', id: space.id, name: input.value.trim() });
    render();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  name.replaceChildren(input);
  input.focus();
  input.select();
}

function startRename(id: SpaceId): void {
  if (!state) return;
  if (state.activeSpaceId !== id) dispatch({ type: 'space.activate', id });
  editingSpace = id;
  render();
}

// ---- subspaces: a group's members render together under a header, at the first member's slot ----

type Row = { kind: 'tab'; tab: Tab } | { kind: 'group'; group: TabGroup; count: number };
const rowKey = (r: Row) => (r.kind === 'tab' ? r.tab.id : `g:${r.group.id}`);

function listRows(s: State, space: Space, ids: TabId[]): Row[] {
  const out: Row[] = [];
  const done = new Set<string>();
  const tabs = ids.map((id) => s.tabs[id]).filter(Boolean);
  for (const tab of tabs) {
    const group = tab.groupId ? space.groups?.find((g) => g.id === tab.groupId) : undefined;
    if (!group) {
      if (!tab.groupId) out.push({ kind: 'tab', tab });
      continue;
    }
    if (done.has(group.id)) continue;
    done.add(group.id);
    const members = tabs.filter((t) => t.groupId === group.id);
    out.push({ kind: 'group', group, count: members.length });
    if (!group.collapsed) for (const m of members) out.push({ kind: 'tab', tab: m });
  }
  return out;
}

function makeGroupHeader(group: TabGroup): HTMLElement {
  const el = h(
    'div',
    { class: 'group-header', 'data-group': group.id },
    h('button', { class: 'chev', onclick: () => dispatch({ type: 'group.toggle', id: group.id }) }, svg(ICONS.forward)),
    h('span', { class: 'name' }),
    h('span', { class: 'count' }),
    h('button', { class: 'close', title: 'Close subspace', onclick: () => dispatch({ type: 'group.close', id: group.id }) }, svg(ICONS.close)),
  );
  el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dispatch({ type: 'group.toggle', id: group.id });
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dispatch({ type: 'group.contextmenu', id: group.id });
  });
  // dropping a tab on the header puts it into the subspace
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes(TAB_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    const id = e.dataTransfer?.getData(TAB_MIME);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks();
    dispatch({ type: 'tab.setGroup', id, groupId: group.id });
  });
  return el;
}

function updateGroupHeader(el: HTMLElement, group: TabGroup, count: number): void {
  setText(el.querySelector('.name') as HTMLElement, group.name);
  setText(el.querySelector('.count') as HTMLElement, String(count));
  setClass(el, 'collapsed', Boolean(group.collapsed));
  setClass(el, 'managed', Boolean(group.owner));
}

// ---- tab rows and favorite tiles ----

function tabId(el: HTMLElement): TabId {
  return el.dataset.id ?? '';
}

function tabEvents(el: HTMLElement): void {
  el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dispatch({ type: 'tab.activate', id: tabId(el) });
  });
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) dispatch({ type: 'tab.close', id: tabId(el) });
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    dispatch({ type: 'tab.contextmenu', id: tabId(el) });
  });
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    const id = tabId(el);
    dragging = id;
    el.classList.add('dragging');
    e.dataTransfer!.setData(TAB_MIME, id);
    e.dataTransfer!.setData('text/uri-list', state?.tabs[id]?.url ?? '');
    e.dataTransfer!.effectAllowed = 'copyMove';
  });
  el.addEventListener('dragend', () => {
    dragging = null;
    el.classList.remove('dragging');
    clearDropMarks();
    if (renderQueued) {
      renderQueued = false;
      render();
    }
  });
}

function makeTab(tab: Tab): HTMLElement {
  const el = h(
    'div',
    { class: 'tab', 'data-id': tab.id },
    h('span', { class: 'icon-slot' }),
    h('span', { class: 'title' }),
    h('span', { class: 'badge' }),
    h('button', { class: 'audio', onclick: () => dispatch({ type: 'tab.mute', id: tab.id }), onwheel: (e: WheelEvent) => { e.preventDefault(); const cur = state?.tabs[tab.id]?.volume ?? 1; dispatch({ type: 'tab.volume', id: tab.id, volume: Math.max(0, Math.min(1, cur - Math.sign(e.deltaY) * 0.05)) }); } }),
    h('button', { class: 'close', onclick: () => dispatch({ type: 'tab.close', id: tab.id }) }, svg(ICONS.close)),
  );
  tabEvents(el);
  return el;
}

function updateTab(el: HTMLElement, tab: Tab, space: Space): void {
  setClass(el, 'active', space.panes.includes(tab.id));
  setClass(el, 'grouped', Boolean(tab.groupId));
  setClass(el, 'asleep', !tab.awake);
  setClass(el, 'kept', Boolean(tab.keepLoaded));
  setClass(el, 'crashed', Boolean(tab.crashed));
  const tip = tab.keepLoaded ? `${tab.url}\nKept loaded` : tab.url;
  if (el.title !== tip) el.title = tip;
  setIconKey(el.querySelector('.icon-slot') as HTMLElement, iconKey(tab, true), () => makeIcon(tab, true));
  setText(el.querySelector('.title') as HTMLElement, tab.title || hostOf(tab.url));
  const audio = el.querySelector('.audio') as HTMLButtonElement;
  const showAudio = Boolean(tab.audible || tab.muted || (tab.volume !== undefined && tab.volume < 1));
  if (audio.hidden === showAudio) audio.hidden = !showAudio;
  if (showAudio) {
    const level = tab.volume ?? 1;
    const key = tab.muted ? 'muted' : level < 0.5 ? 'low' : 'sound';
    setIconKey(audio, key, () => svg(tab.muted ? ICONS.muted : level < 0.5 ? ICONS.soundLow : ICONS.sound));
    audio.title = `${tab.muted ? 'Muted' : `Volume ${Math.round(level * 100)}%`} · click to ${tab.muted ? 'unmute' : 'mute'} · scroll to change volume`;
  }
  const close = el.querySelector('.close') as HTMLButtonElement;
  const closeTitle = tab.kind === 'today' ? 'Close' : 'Close and reset';
  if (close.title !== closeTitle) close.title = closeTitle;
}

function makeFavorite(tab: Tab): HTMLElement {
  const el = h('div', { class: 'fav', 'data-id': tab.id }, h('span', { class: 'icon-slot' }));
  tabEvents(el);
  return el;
}

function updateFavorite(el: HTMLElement, tab: Tab, space: Space): void {
  setClass(el, 'active', space.panes.includes(tab.id));
  setClass(el, 'asleep', !tab.awake);
  setClass(el, 'kept', Boolean(tab.keepLoaded));
  const title = `${tab.title}\n${tab.url}${tab.keepLoaded ? '\nKept loaded' : ''}`;
  if (el.title !== title) el.title = title;
  setIconKey(el.querySelector('.icon-slot') as HTMLElement, iconKey(tab, false), () => makeIcon(tab, false));
}

// ---- space switcher ----

function makeSpaceDot(space: Space): HTMLElement {
  const el = h('button', {
    class: 'space-dot',
    'data-id': space.id,
    onclick: () => dispatch({ type: 'space.activate', id: space.id }),
    ondblclick: () => startRename(space.id),
    oncontextmenu: (e: MouseEvent) => {
      e.preventDefault();
      dispatch({ type: 'space.contextmenu', id: space.id });
    },
  });
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes(TAB_MIME)) return;
    e.preventDefault();
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-target');
    const id = e.dataTransfer?.getData(TAB_MIME);
    if (id) dispatch({ type: 'tab.move', id, list: 'today', spaceId: space.id, index: 0 });
  });
  return el;
}

function updateSpaceDot(el: HTMLElement, space: Space, s: State): void {
  setClass(el, 'active', space.id === s.activeSpaceId);
  setClass(el, 'private', Boolean(space.lock));
  setClass(el, 'open', Boolean(space.lock) && !isLocked(space));
  if (el.title !== space.name) el.title = space.name;
  el.style.setProperty('--dot', space.color);
  setIconKey(el, space.icon ? `emoji:${space.icon}` : 'initial', () => (space.icon ? document.createTextNode(space.icon) : h('span', { class: 'initial' })));
  if (space.lock && !el.querySelector('.lockmark')) el.append(h('span', { class: 'lockmark' }, svg(ICONS.lock)));
}

// ---- drag and drop between lists ----

function clearDropMarks(): void {
  for (const el of document.querySelectorAll('.drop-target, .drop-before, .drop-end')) {
    el.classList.remove('drop-target', 'drop-before', 'drop-end');
  }
}

/** Index where a drop at the pointer position would insert, ignoring the dragged element. */
function dropIndex(list: HTMLElement, e: DragEvent): number {
  const items = [...list.children].filter((c) => (c as HTMLElement).dataset.id !== dragging) as HTMLElement[];
  const grid = list.classList.contains('grid');
  let index = 0;
  for (const item of items) {
    const r = item.getBoundingClientRect();
    const after = grid ? e.clientY > r.bottom || (e.clientY >= r.top && e.clientX > r.left + r.width / 2) : e.clientY > r.top + r.height / 2;
    if (after) index++;
    else break;
  }
  return index;
}

/** The position in the space's id list that corresponds to a DOM slot (group headers take no slot). */
function listIndex(list: HTMLElement, domIndex: number): number {
  const items = [...list.children].filter((c) => (c as HTMLElement).dataset.id !== dragging) as HTMLElement[];
  return items.slice(0, domIndex).filter((c) => c.dataset.id).length;
}

function dropZone(list: HTMLElement, name: ListName): void {
  list.addEventListener('dragover', (e) => {
    const types = e.dataTransfer?.types ?? [];
    const isTab = types.includes(TAB_MIME);
    if (!isTab && !types.includes('text/uri-list')) return;
    if (!isTab && name === 'favorites') return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = isTab ? 'move' : 'copy';
    clearDropMarks();
    list.classList.add('drop-target');
    const items = [...list.children].filter((c) => (c as HTMLElement).dataset.id !== dragging);
    const index = dropIndex(list, e);
    if (items[index]) items[index].classList.add('drop-before');
    else if (items.length) list.classList.add('drop-end');
  });
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget as Node)) clearDropMarks();
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const index = listIndex(list, dropIndex(list, e));
    clearDropMarks();
    const spaceId = state?.activeSpaceId;
    const id = e.dataTransfer?.getData(TAB_MIME);
    if (id) {
      dispatch({ type: 'tab.move', id, list: name, spaceId, index });
      return;
    }
    const url = (e.dataTransfer?.getData('text/uri-list') ?? '').split('\n').find((l) => l && !l.startsWith('#'))?.trim();
    if (url && /^https?:\/\//i.test(url) && name !== 'favorites') {
      dispatch({ type: 'tab.new', url, spaceId, activate: false });
    }
  });
}

// ---- split-view gutters: drag the gaps between panes to reshape the tiling ----

const gutters = $('#gutters');
let draggingGutter = false;
window.addEventListener('resize', () => {
  if (state) renderGutters(state, activeSpace(state));
});

function effectiveTiling(space: Space): Tiling {
  const n = space.panes.length;
  const t = space.tiling ? parseTiling(space.tiling) : null;
  return t && cellCount(t) === n ? t : defaultTiling(n);
}

function renderGutters(s: State, space: Space): void {
  if (draggingGutter) return;
  const n = visiblePanes(space).length;
  if (n < 2 && !panelVisible(s)) {
    if (gutters.childElementCount) gutters.replaceChildren();
    return;
  }
  if (n < 2) {
    const { content, panel } = computeLayout({ width: window.innerWidth, height: window.innerHeight, sidebarOpen: s.settings.sidebarOpen || peeking, sidebarWidth: s.settings.sidebarWidth, panes: 1, topInset: topInsetFor(api.platform, s.settings.addressBar), panelWidth: s.settings.panelWidth });
    gutters.replaceChildren(panel ? panelGutter(content, panel) : '');
    return;
  }
  const tiling = effectiveTiling(space);
  const { content, panes, panel } = computeLayout({
    width: window.innerWidth,
    height: window.innerHeight,
    sidebarOpen: s.settings.sidebarOpen || peeking,
    sidebarWidth: s.settings.sidebarWidth,
    panes: n,
    topInset: topInsetFor(api.platform, s.settings.addressBar),
    tiling,
    panelWidth: panelVisible(s) ? s.settings.panelWidth : 0,
  });
  const els: HTMLElement[] = [];
  if (panel) els.push(panelGutter(content, panel));
  let k = 0;
  tiling.rows.forEach((row, r) => {
    const first = panes[k];
    row.cols.forEach((_c, c) => {
      const rect = panes[k + c];
      if (c < row.cols.length - 1) els.push(gutter('v', { x: rect.x + rect.width, y: rect.y, width: GAP, height: rect.height }, r, c, content, tiling));
    });
    if (r < tiling.rows.length - 1) els.push(gutter('h', { x: content.x, y: first.y + first.height, width: content.width, height: GAP }, r, -1, content, tiling));
    k += row.cols.length;
  });
  gutters.replaceChildren(...els);
}

function gutter(kind: 'v' | 'h', rect: { x: number; y: number; width: number; height: number }, row: number, col: number, content: { x: number; y: number; width: number; height: number }, tiling: Tiling): HTMLElement {
  const el = h('div', { class: `gutter ${kind}` });
  // a little wider than the gap so it is easy to grab; the native views hide the excess
  const pad = 2;
  el.style.left = `${rect.x - (kind === 'v' ? pad : 0)}px`;
  el.style.top = `${rect.y - (kind === 'h' ? pad : 0)}px`;
  el.style.width = `${rect.width + (kind === 'v' ? pad * 2 : 0)}px`;
  el.style.height = `${rect.height + (kind === 'h' ? pad * 2 : 0)}px`;
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    draggingGutter = true;
    el.classList.add('dragging');
    let current = tiling;
    let frame = 0;
    const move = (ev: MouseEvent) => {
      const at = kind === 'v' ? (ev.clientX - content.x) / content.width : (ev.clientY - content.y) / content.height;
      current = kind === 'v' ? resizeColumn(tiling, row, col, at) : resizeRow(tiling, row, at);
      const shift = kind === 'v' ? ev.clientX - (rect.x + rect.width / 2) : ev.clientY - (rect.y + rect.height / 2);
      el.style.transform = kind === 'v' ? `translateX(${shift}px)` : `translateY(${shift}px)`;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => dispatch({ type: 'space.tiling', spec: formatTiling(current) }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      draggingGutter = false;
      cancelAnimationFrame(frame);
      dispatch({ type: 'space.tiling', spec: formatTiling(current) });
      if (state) renderGutters(state, activeSpace(state));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  return el;
}

/** The gap between the content and the side panel: drag to resize the panel. */
function panelGutter(content: { x: number; y: number; width: number; height: number }, panel: { x: number; y: number; width: number; height: number }): HTMLElement {
  const el = h('div', { class: 'gutter v panel-gutter' });
  el.style.left = `${content.x + content.width - 2}px`;
  el.style.top = `${panel.y}px`;
  el.style.width = `${panel.x - (content.x + content.width) + 4}px`;
  el.style.height = `${panel.height}px`;
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    draggingGutter = true;
    el.classList.add('dragging');
    const right = panel.x + panel.width;
    let frame = 0;
    let width = panel.width;
    const move = (ev: MouseEvent) => {
      width = clampPanel(right - ev.clientX);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => dispatch({ type: 'panel.resize', width }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      draggingGutter = false;
      cancelAnimationFrame(frame);
      dispatch({ type: 'panel.resize', width });
      if (state) renderGutters(state, activeSpace(state));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  return el;
}
