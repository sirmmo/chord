import { app, clipboard, dialog, Menu, shell, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Message, SpaceId, TabId } from '../shared/types.ts';
import { activeSpace, SPACE_COLORS, spaceOfTab } from '../shared/model.ts';
import { searchUrl } from '../shared/url.ts';
import type { Controller } from './controller.ts';

const isMac = process.platform === 'darwin';
const SPACE_ICONS = ['🏠', '💼', '🎨', '📚', '🎮', '🧪', '✈️', '🛒', '🎵', '💬'];
const sep: MenuItemConstructorOptions = { type: 'separator' };

export function buildAppMenu(c: Controller): void {
  const d = (m: Message) => () => c.dispatch(m);
  const spaces = c.state.spaces;

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab…', accelerator: 'CmdOrCtrl+T', click: d({ type: 'palette.open', intent: 'new' }) },
        { label: 'New Space', accelerator: 'CmdOrCtrl+Shift+N', click: d({ type: 'space.create' }) },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: d({ type: 'closed.reopen' }) },
        sep,
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: d({ type: 'tab.closeActive' }) },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        ...(isMac ? [] : [sep, { role: 'quit' } as MenuItemConstructorOptions]),
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
        ...spaces.slice(0, 9).map((sp, i) => ({
          label: `${sp.icon ? sp.icon + ' ' : ''}${sp.name}`,
          accelerator: `Control+${i + 1}`,
          click: d({ type: 'space.activate', id: sp.id }),
        })),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Chord on GitHub', click: () => shell.openExternal('https://github.com/sirmmo/chord') },
        { label: 'Set Chord as Default Browser', click: d({ type: 'app.setDefaultBrowser' }) },
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
  items.push(sep);
  if (tab.awake) {
    items.push({ label: tab.muted ? 'Unmute' : 'Mute', click: d({ type: 'tab.mute', id }) });
    items.push({ label: 'Put to Sleep', click: d({ type: 'tab.sleep', id }) });
  }
  items.push({ label: tab.kind === 'today' ? 'Close Tab' : 'Close', click: d({ type: 'tab.close', id }) });

  Menu.buildFromTemplate(items).popup({ window: c.win });
}

export function spaceContextMenu(c: Controller, id: SpaceId): void {
  const space = c.state.spaces.find((sp) => sp.id === id);
  if (!space || !c.win) return;
  const d = (m: Message) => () => c.dispatch(m);
  const items: MenuItemConstructorOptions[] = [
    { label: 'Rename…', click: () => c.sendSidebar({ kind: 'space.renameStart', id }) },
    {
      label: 'Icon',
      submenu: [
        { label: 'None', type: 'radio', checked: !space.icon, click: d({ type: 'space.update', id, patch: { icon: '' } }) },
        ...SPACE_ICONS.map((icon) => ({ label: icon, type: 'radio' as const, checked: space.icon === icon, click: d({ type: 'space.update', id, patch: { icon } }) })),
      ],
    },
    {
      label: 'Color',
      submenu: SPACE_COLORS.map((color, i) => ({
        label: ['Indigo', 'Coral', 'Teal', 'Amber', 'Violet', 'Sky', 'Pink', 'Lime'][i] ?? color,
        type: 'radio' as const,
        checked: space.color.toLowerCase() === color.toLowerCase(),
        click: d({ type: 'space.update', id, patch: { color } }),
      })),
    },
    sep,
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
  Menu.buildFromTemplate(items).popup({ window: c.win });
}
