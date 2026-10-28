import { presetsFor } from '../shared/tiling.ts';
import { MODES } from '../shared/modes.ts';
import { app, clipboard, dialog, Menu, shell, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Message, SpaceId, Tab, TabId } from '../shared/types.ts';
import { activeSpace, SPACE_COLORS, spaceOfTab } from '../shared/model.ts';
import { hostOf, searchUrl } from '../shared/url.ts';
import type { Controller } from './controller.ts';

const isMac = process.platform === 'darwin';
const SPACE_ICONS = ['🏠', '💼', '🎨', '📚', '🎮', '🧪', '✈️', '🛒', '🎵', '💬'];
const sep: MenuItemConstructorOptions = { type: 'separator' };

export function buildAppMenu(c: Controller): void {
  const d = (m: Message) => () => c.dispatch(m);
  const spaces = c.state.spaces;

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              sep,
              { label: 'Settings…', accelerator: 'Command+,', click: d({ type: 'settings.open' }) },
              sep,
              { role: 'services' },
              sep,
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              sep,
              { role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab…', accelerator: 'CmdOrCtrl+T', click: d({ type: 'palette.open', intent: 'new' }) },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: d({ type: 'window.new' }) },
        { label: 'New Space', accelerator: 'CmdOrCtrl+Shift+N', click: d({ type: 'space.create' }) },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: d({ type: 'closed.reopen' }) },
        sep,
        { label: 'Import from Another Browser…', click: d({ type: 'import.browser' }) },
        { label: 'Import Configuration…', click: d({ type: 'config.importFile' }) },
        { label: 'Export Configuration…', click: d({ type: 'config.export' }) },
        sep,
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: d({ type: 'tab.closeActive' }) },
        // Not role:'close' on Windows/Linux: Electron's role defaults to Ctrl+W, which must close the tab.
        isMac ? { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' } : { label: 'Close Window', accelerator: 'Ctrl+Shift+W', click: () => c.win?.close() },
        ...(isMac ? [] : [sep, { role: 'quit', accelerator: 'Ctrl+Q' } as MenuItemConstructorOptions]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        sep,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
        sep,
        { label: 'Find in Page…', accelerator: 'CmdOrCtrl+F', click: d({ type: 'find.open' }) },
        { label: 'Edit URL…', accelerator: 'CmdOrCtrl+L', click: d({ type: 'palette.open', intent: 'current' }) },
        { label: 'Copy URL', accelerator: 'CmdOrCtrl+Shift+C', click: d({ type: 'url.copy' }) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+S', click: d({ type: 'sidebar.toggle' }) },
        { label: 'Show Address Bar', type: 'checkbox', checked: c.state.settings.addressBar, accelerator: 'CmdOrCtrl+Shift+L', click: () => c.apply({ type: 'settings.update', patch: { addressBar: !c.state.settings.addressBar } }) },
        { label: 'Settings…', accelerator: isMac ? undefined : 'Ctrl+,', click: d({ type: 'settings.open' }) },
        { label: 'Downloads', accelerator: 'CmdOrCtrl+Shift+J', click: d({ type: 'downloads.open' }) },
        { label: 'History', accelerator: 'CmdOrCtrl+Y', click: d({ type: 'history.open' }) },
        { label: 'Bookmarks', accelerator: 'CmdOrCtrl+Alt+B', click: d({ type: 'bookmarks.open' }) },
        { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+Shift+B', click: d({ type: 'bookmark.page', public: false }) },
        { label: 'Bookmark This Page Publicly', click: d({ type: 'bookmark.page', public: true }) },
        { label: 'Picture in Picture', accelerator: 'CmdOrCtrl+Alt+P', click: d({ type: 'media.pip' }) },
        { label: 'Side Panel', accelerator: 'CmdOrCtrl+Shift+U', type: 'checkbox', checked: c.state.settings.panelOpen, click: d({ type: 'panel.toggle' }) },
        sep,
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: d({ type: 'nav.reload' }) },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: d({ type: 'nav.back' }) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: d({ type: 'nav.forward' }) },
        sep,
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: d({ type: 'zoom.in' }) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', visible: false, click: d({ type: 'zoom.in' }) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: d({ type: 'zoom.out' }) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: d({ type: 'zoom.reset' }) },
        sep,
        { label: 'Toggle Developer Tools', accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I', click: d({ type: 'devtools.toggle' }) },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next Tab', accelerator: 'Control+Tab', click: d({ type: 'tab.next' }) },
        { label: 'Previous Tab', accelerator: 'Control+Shift+Tab', click: d({ type: 'tab.prev' }) },
        sep,
        { label: 'Pin / Unpin Tab', accelerator: 'CmdOrCtrl+D', click: d({ type: 'tab.togglePin' }) },
        { label: 'Add Focused Tab to Split View', accelerator: 'CmdOrCtrl+Shift+D', click: () => splitFocused(c) },
        { label: 'Remove from Split View', accelerator: 'CmdOrCtrl+Alt+W', click: () => unsplitFocused(c) },
        { label: 'Split Layout', submenu: layoutMenu(c) },
        sep,
        { label: 'Archive Today’s Tabs', click: d({ type: 'today.clear' }) },
        sep,
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, click: d({ type: 'tab.jump', index: n - 1 }) })),
        { label: 'Last Tab', accelerator: 'CmdOrCtrl+9', click: d({ type: 'tab.jump', index: 8 }) },
      ],
    },
    {
      label: 'Spaces',
      submenu: [
        { label: 'Next Space', accelerator: 'CmdOrCtrl+Alt+Right', click: d({ type: 'space.next' }) },
        { label: 'Previous Space', accelerator: 'CmdOrCtrl+Alt+Left', click: d({ type: 'space.prev' }) },
        sep,
        // Ctrl+1…9 jumps to tabs on Windows and Linux (CmdOrCtrl), so spaces take Alt there.
        ...spaces.slice(0, 9).map((sp, i) => ({
          label: `${sp.icon ? sp.icon + ' ' : ''}${sp.name}`,
          accelerator: isMac ? `Control+${i + 1}` : `Alt+${i + 1}`,
          click: d({ type: 'space.activate', id: sp.id }),
        })),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Getting Started', click: d({ type: 'guide.open' }) },
        { label: 'Chord on GitHub', click: () => shell.openExternal('https://github.com/sirmmo/chord') },
        { label: 'Set Chord as Default Browser', click: d({ type: 'app.setDefaultBrowser' }) },
        sep,
        { label: 'Check for Updates…', click: d({ type: 'update.check' }) },
        { label: 'Copy Diagnostics', click: d({ type: 'diagnostics.copy' }) },
        { label: 'About Chord', click: d({ type: 'settings.open', page: 'about' }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function splitFocused(c: Controller): void {
  // Split the focused tab with the next tab in the sidebar.
  const space = activeSpace(c.state);
  const order = [...space.pinned, ...space.today];
  const candidate = order.find((id) => !space.panes.includes(id));
  if (candidate) c.apply({ type: 'tab.split', id: candidate });
}

function unsplitFocused(c: Controller): void {
  const space = activeSpace(c.state);
  if (space.focused) c.apply({ type: 'tab.unsplit', id: space.focused });
}

export function tabContextMenu(c: Controller, id: TabId): void {
  const tab = c.state.tabs[id];
  if (!tab || !c.win) return;
  const space = activeSpace(c.state);
  const d = (m: Message) => () => c.dispatch(m);
  const items: MenuItemConstructorOptions[] = [];

  if (tab.kind === 'today') items.push({ label: 'Pin Tab', click: d({ type: 'tab.pin', id }) });
  if (tab.kind === 'pinned') items.push({ label: 'Unpin Tab', click: d({ type: 'tab.unpin', id }) });
  if (tab.kind !== 'favorite') items.push({ label: 'Add to Favorites', click: d({ type: 'tab.favorite', id }) });
  else items.push({ label: 'Remove from Favorites', click: d({ type: 'tab.unfavorite', id }) });
  if (tab.homeUrl && tab.url !== tab.homeUrl) items.push({ label: 'Reset to Pinned Page', click: d({ type: 'tab.home', id }) });
  items.push(sep);

  const inSplit = space.panes.includes(id);
  if (inSplit && space.panes.length > 1) items.push({ label: 'Remove from Split View', click: d({ type: 'tab.unsplit', id }) });
  else items.push({ label: 'Open in Split View', enabled: !tab.spaceId || tab.spaceId === space.id, click: d({ type: 'tab.split', id }) });
  items.push({ label: 'Duplicate', click: d({ type: 'tab.duplicate', id }) });
  items.push({ label: 'Copy Link', click: () => clipboard.writeText(tab.url) });

  const others = c.state.spaces.filter((sp) => sp.id !== tab.spaceId);
  if (tab.kind !== 'favorite' && others.length) {
    items.push({
      label: 'Move to Space',
      submenu: others.map((sp) => ({
        label: `${sp.icon ? sp.icon + ' ' : ''}${sp.name}`,
        click: d({ type: 'tab.move', id, list: 'today', spaceId: sp.id, index: 0 }),
      })),
    });
  }
  if (tab.kind !== 'favorite' && tab.spaceId) {
    const groups = c.state.spaces.find((sp) => sp.id === tab.spaceId)?.groups ?? [];
    items.push({
      label: 'Subspace',
      submenu: [
        { label: 'New Subspace from This Tab…', click: d({ type: 'group.new', tabId: id }) },
        ...(groups.length ? [sep] : []),
        ...groups.map((g) => ({ label: g.name, type: 'radio' as const, checked: tab.groupId === g.id, click: d({ type: 'tab.setGroup', id, groupId: g.id }) })),
        ...(tab.groupId ? [sep, { label: 'Remove from Subspace', click: d({ type: 'tab.setGroup', id, groupId: null }) }] : []),
      ],
    });
  }
  items.push(sep);
  items.push({ label: 'Keep Loaded', type: 'checkbox', checked: Boolean(tab.keepLoaded), click: d({ type: 'tab.keepLoaded', id, on: !tab.keepLoaded }) });
  items.push({ label: 'Bookmark', submenu: [{ label: 'Private', click: d({ type: 'bookmark.page', public: false, id }) }, { label: 'Public (on your linkroll)', click: d({ type: 'bookmark.page', public: true, id }) }] });
  if (tab.awake) {
    items.push({ label: tab.muted ? 'Unmute' : 'Mute', click: d({ type: 'tab.mute', id }) });
  items.push(volumeMenu(c, tab));
    items.push({ label: 'Put to Sleep', click: d({ type: 'tab.sleep', id }) });
  }
  items.push({ label: tab.kind === 'today' ? 'Close Tab' : 'Close', click: d({ type: 'tab.close', id }) });

  Menu.buildFromTemplate(items).popup({ window: c.win });
}

/** "Volume (50%)" submenu with radio levels; shared by the tab context menu and the tray. */
export function volumeMenu(c: Controller, tab: Tab): MenuItemConstructorOptions {
  const cur = Math.round((tab.volume ?? 1) * 100);
  const levels = [100, 75, 50, 25, 10];
  if (!levels.includes(cur)) levels.push(cur);
  return {
    label: `Volume${tab.volume !== undefined ? ` (${cur}%)` : ''}`,
    submenu: levels
      .sort((a, b) => b - a)
      .map((pct) => ({ label: `${pct}%`, type: 'radio' as const, checked: cur === pct, click: () => c.dispatch({ type: 'tab.volume', id: tab.id, volume: pct / 100 }) })),
  };
}

export function groupContextMenu(c: Controller, id: string): void {
  const space = c.state.spaces.find((sp) => sp.groups?.some((g) => g.id === id));
  const group = space?.groups?.find((g) => g.id === id);
  if (!space || !group || !c.win) return;
  const d = (m: Message) => () => c.dispatch(m);
  const owner = group.owner ? c.state.tabs[group.owner] : undefined;
  const items: MenuItemConstructorOptions[] = [
    { label: 'Rename…', click: d({ type: 'group.renamePrompt', id }) },
    { label: group.collapsed ? 'Expand' : 'Collapse', click: d({ type: 'group.toggle', id }) },
    sep,
    ...(owner ? [{ label: `Managed by ${hostOf(owner.url) || owner.title}`, enabled: false }, sep] : []),
    { label: 'Dissolve Subspace (keep tabs)', click: d({ type: 'group.dissolve', id }) },
    { label: 'Close Subspace', click: d({ type: 'group.close', id }) },
  ];
  Menu.buildFromTemplate(items).popup({ window: c.win });
}

export function spaceContextMenu(c: Controller, id: SpaceId): void {
  const space = c.state.spaces.find((sp) => sp.id === id);
  if (!space || !c.win) return;
  const d = (m: Message) => () => c.dispatch(m);
  const items: MenuItemConstructorOptions[] = [
    { label: 'Rename…', click: () => c.sendSidebar({ kind: 'space.renameStart', id }) },
    { label: c.windowForSpace(id) && c.windowForSpace(id) !== c.active ? 'Show Its Window' : 'Open in New Window', enabled: c.windowForSpace(id) !== c.active, click: d({ type: 'space.openInWindow', id }) },
    {
      label: 'Icon',
      submenu: [
        { label: 'None', type: 'radio', checked: !space.icon, click: d({ type: 'space.update', id, patch: { icon: '' } }) },
        ...SPACE_ICONS.map((icon) => ({ label: icon, type: 'radio' as const, checked: space.icon === icon, click: d({ type: 'space.update', id, patch: { icon } }) })),
      ],
    },
    {
      label: 'Color',
      submenu: [
        ...SPACE_COLORS.map((color, i) => ({
          label: ['Indigo', 'Coral', 'Teal', 'Amber', 'Violet', 'Sky', 'Pink', 'Lime'][i] ?? color,
          type: 'radio' as const,
          checked: space.color.toLowerCase() === color.toLowerCase(),
          click: d({ type: 'space.update', id, patch: { color } }),
        })),
        sep,
        { label: 'Custom…', click: d({ type: 'settings.open' }) },
      ],
    },
    sep,
    { label: 'Modes', submenu: modeItems(c, id) },
    { label: 'Profile', submenu: profileItems(c, id) },
    {
      label: 'Private',
      submenu: space.lock
        ? [
            { label: `${space.name} is private`, enabled: false },
            { label: 'Lock Now', enabled: space.locked === false, click: d({ type: 'space.lock', id }) },
            { label: 'Unlock…', enabled: space.locked !== false, click: d({ type: 'space.passwordPrompt', id, purpose: 'unlock' }) },
            { label: 'Change Password…', enabled: space.locked === false, click: d({ type: 'space.passwordPrompt', id, purpose: 'set' }) },
            { label: 'Remove Password…', click: d({ type: 'space.passwordPrompt', id, purpose: 'remove' }) },
          ]
        : [
            { label: 'Make Private…', click: d({ type: 'space.passwordPrompt', id, purpose: 'set' }) },
            { label: 'Private spaces need a password, are never exported and leave no trace in the archive or history.', enabled: false },
          ],
    },
    { label: 'Export Space…', enabled: !space.lock, click: d({ type: 'config.export', spaceId: id }) },
    { label: 'New Space', click: d({ type: 'space.create' }) },
    {
      label: 'Delete Space…',
      enabled: c.state.spaces.length > 1,
      click: async () => {
        const count = space.pinned.length + space.today.length;
        const { response } = await dialog.showMessageBox(c.win!, {
          type: 'warning',
          buttons: ['Delete', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: `Delete “${space.name}”?`,
          detail: count ? `Its ${count} tab${count === 1 ? '' : 's'} will be moved to the archive.` : 'This space is empty.',
        });
        if (response === 0) c.apply({ type: 'space.delete', id });
      },
    },
  ];
  Menu.buildFromTemplate(items).popup({ window: c.win });
}

export function pageContextMenu(c: Controller, tabId: TabId, wc: WebContents, p: ContextMenuParams): void {
  if (!c.win) return;
  const tab = c.state.tabs[tabId];
  const spaceId = tab ? spaceOfTab(c.state, tab).id : c.state.activeSpaceId;
  const items: MenuItemConstructorOptions[] = [];
  const openInNewTab = (url: string, activate = false) => () => c.apply({ type: 'tab.new', url, spaceId, activate });

  if (p.misspelledWord) {
    for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    items.push({ label: 'Add to Dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, sep);
  }
  if (p.linkURL) {
    items.push(
      { label: 'Open Link in New Tab', click: openInNewTab(p.linkURL) },
      {
        label: 'Open Link in Split View',
        click: () => {
          const id = randomUUID();
          c.apply({ type: 'tab.new', id, url: p.linkURL, spaceId, activate: false });
          c.apply({ type: 'tab.split', id });
        },
      },
      { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
      sep,
    );
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push(
      { label: 'Open Image in New Tab', click: openInNewTab(p.srcURL) },
      { label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) },
      { label: 'Save Image As…', click: () => wc.downloadURL(p.srcURL) },
      sep,
    );
  }
  const selection = p.selectionText.trim();
  if (selection) {
    const short = selection.length > 30 ? selection.slice(0, 30) + '…' : selection;
    items.push(
      { role: 'copy' },
      { label: `Search for “${short}”`, click: openInNewTab(searchUrl(c.state.settings.searchEngine, selection), true) },
      sep,
    );
  }
  if (p.isEditable) {
    items.push({ role: 'undo' }, { role: 'redo' }, sep, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }, sep);
  }
  items.push(
    { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: 'Reload', click: () => wc.reload() },
    sep,
    { label: 'Inspect Element', click: () => wc.inspectElement(p.x, p.y) },
  );
  if (!app.isPackaged) items.push({ label: 'Copy Page URL', click: () => clipboard.writeText(p.pageURL) });
  const d = (m: Message) => () => c.dispatch(m);
  if (p.mediaType === 'video') items.push({ label: 'Picture in Picture', click: d({ type: 'media.pip', id: tabId }) }, sep);
  const sp = activeSpace(c.state);
  if (p.selectionText && (sp.modes ?? []).includes('research')) items.push({ label: 'Clip to Research', click: d({ type: 'research.clip', text: p.selectionText, url: p.pageURL, title: wc.getTitle() }) });
  if ((sp.modes ?? []).includes('research')) items.push({ label: 'Save Page to Zotero', click: d({ type: 'research.zotero', tabId }) }, { label: 'Add Page to Sources', click: d({ type: 'research.source', url: p.pageURL, title: wc.getTitle() }) });
  if (p.selectionText && (sp.modes ?? []).includes('ai')) items.push({ label: 'Ask AI About Selection', click: d({ type: 'ai.send', spaceId: sp.id, text: `About this passage from ${hostOf(p.pageURL)}:\n\n“${p.selectionText.slice(0, 2000)}”\n\nExplain it briefly.` }) });
  if ((sp.modes ?? []).length) items.push(sep);
  items.push({ label: `Boost ${hostOf(p.pageURL) || 'this site'}…`, click: d({ type: 'settings.open', page: `boosts:${hostOf(p.pageURL)}` }) });
  Menu.buildFromTemplate(items).popup({ window: c.win });
}

function layoutMenu(c: Controller): MenuItemConstructorOptions[] {
  const space = activeSpace(c.state);
  const d = (m: Message) => () => c.dispatch(m);
  const presets = presetsFor(space.panes.length, c.state.settings.tilings);
  const items: MenuItemConstructorOptions[] = [
    { label: 'Next Layout', accelerator: 'CmdOrCtrl+Alt+L', enabled: presets.length > 0, click: d({ type: 'space.tilingNext' }) },
    { type: 'separator' },
    { label: 'Equal Columns', type: 'radio', checked: !space.tiling, click: d({ type: 'space.tiling', spec: null }) },
    ...presets.map((p) => ({ label: `${p.name}  (${p.spec})`, type: 'radio' as const, checked: space.tiling === p.spec, click: d({ type: 'space.tiling', spec: p.spec }) })),
  ];
  if (space.panes.length < 2) items.push({ type: 'separator' }, { label: 'Add a second pane with ⌘⇧D to choose a layout', enabled: false });
  return items;
}

function modeItems(c: Controller, id: SpaceId): MenuItemConstructorOptions[] {
  const space = c.state.spaces.find((sp) => sp.id === id);
  const current = space?.modes ?? [];
  return [
    ...MODES.map((m) => ({
      label: m.name,
      type: 'checkbox' as const,
      checked: current.includes(m.id),
      click: () => c.dispatch({ type: 'space.modes', id, modes: current.includes(m.id) ? current.filter((x) => x !== m.id) : [...current, m.id] }),
    })),
    { type: 'separator' },
    { label: 'Show Side Panel', type: 'checkbox', checked: c.state.settings.panelOpen, enabled: current.length > 0, click: () => c.dispatch({ type: 'panel.toggle' }) },
    { label: 'Modes add a panel on the right: research notes and Zotero, or an AI that works on this space’s tabs.', enabled: false },
  ];
}

/** The modes button in the space header. */
export function modesMenu(c: Controller, id: SpaceId): void {
  if (!c.win) return;
  Menu.buildFromTemplate(modeItems(c, id)).popup({ window: c.win });
}

/** Which browsing session a space uses: the shared one, or a named profile other spaces may share. */
function profileItems(c: Controller, id: SpaceId): MenuItemConstructorOptions[] {
  const space = c.state.spaces.find((sp) => sp.id === id);
  const names = [...new Set(c.state.spaces.map((sp) => sp.profile).filter((p): p is string => Boolean(p)))].sort();
  return [
    { label: 'Shared session', type: 'radio', checked: !space?.profile, click: () => c.dispatch({ type: 'space.profile', id, profile: null }) },
    ...names.map((name) => ({ label: name, type: 'radio' as const, checked: space?.profile === name, click: () => c.dispatch({ type: 'space.profile', id, profile: name }) })),
    { type: 'separator' },
    { label: 'New Profile…', click: () => c.dispatch({ type: 'space.newProfile', id }) },
    { label: space?.profile ? `Forget “${space.profile}” Data…` : 'Forget Shared Session Data…', click: () => c.dispatch({ type: 'space.forgetProfile', id }) },
    { type: 'separator' },
    { label: 'A profile has its own cookies, logins and storage. Spaces with the same profile share them.', enabled: false },
  ];
}
