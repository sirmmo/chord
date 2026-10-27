import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Action, Command, Message, SidebarMessage, State, TabId } from '../shared/types.ts';
import { isCommand } from '../shared/types.ts';
import { activeSpace, focusedTab, hydrate, reduce, type Ctx } from '../shared/model.ts';
import { titleFor } from '../shared/url.ts';
import { exportConfig, exportFileName, parseConfig } from '../shared/config.ts';
import { Store } from './store.ts';
import { TabManager } from './tabs.ts';
import { Overlay } from './overlay.ts';
import { setShields } from './session.ts';
import { buildAppMenu, spaceContextMenu, tabContextMenu } from './menu.ts';
import { PRELOAD, RENDERER_DIR } from './paths.ts';
import { isMac, TITLEBAR_HEIGHT, TOP_INSET, ADDRESS_BAR_HEIGHT } from './platform.ts';
import { ExtensionManager } from './extensions.ts';
import { copyDiagnostics, startLagMonitor } from './diagnostics.ts';
import { SmartManager } from './smart.ts';
import { TrayManager } from './tray.ts';
import { confirmImport, importFromBrowser } from './importers.ts';
import { DownloadManager } from './downloads.ts';
import { browsingSession } from './session.ts';
import { isInternal } from '../shared/url.ts';

const CHROME_DARK = '#1b1b22';
const CHROME_LIGHT = '#f4f4f7';
const BROADCAST_INTERVAL_MS = 16;

export class Controller {
  state!: State;
  win: BrowserWindow | null = null;
  readonly store: Store<State>;
  readonly tabs = new TabManager(this);
  readonly overlay = new Overlay(this);
  readonly smart = new SmartManager(this);
  readonly tray = new TrayManager(this);
  /** set once the app is really quitting, so close-to-tray does not swallow the window close */
  quitting = false;
  readonly downloads = new DownloadManager(this);
  readonly extensions = new ExtensionManager({
    apply: (a) => this.apply(a),
    onStatus: (status) => this.sendAll('extensions', status),
  });

  private applying = false;
  private queue: Action[] = [];
  private broadcastTimer: NodeJS.Timeout | null = null;
  private menuKey = '';
  /** The sidebar is shown temporarily while the pointer hovers the left edge. */
  peeking = false;

  constructor() {
    this.store = new Store<State>(join(app.getPath('userData'), 'state.json'));
  }

  ctx(): Ctx {
    return { now: Date.now(), newId: randomUUID };
  }

  init(): void {
    this.state = hydrate(this.store.load(), this.ctx());
    setInterval(() => this.apply({ type: 'tick' }), 60_000).unref();
    startLagMonitor();
    this.smart.init();
    this.tray.sync(this.state.settings.closeToTray);
    this.downloads.init(browsingSession());

    ipcMain.handle('dispatch', (event, message: unknown) => {
      if (!this.trusted(event) || !isMessage(message)) return;
      this.dispatch(message);
    });
    ipcMain.handle('state', (event) => (this.trusted(event) ? this.state : null));
    ipcMain.handle('extensions', (event) => (this.trusted(event) ? this.extensions.getStatus() : {}));
    ipcMain.handle('smart', (event) => (this.trusted(event) ? this.smart.getStatus() : {}));
    ipcMain.handle('downloads', (event) => (this.trusted(event) ? this.downloads.status() : { items: [], active: 0 }));

    void setShields(this.state.settings.shields);
    void this.extensions.sync(this.state);
    this.refreshMenu();
  }

  private trusted(event: IpcMainInvokeEvent): boolean {
    if (event.sender === this.win?.webContents || event.sender === this.overlay.webContents) return true;
    // One of Chord's own pages in a tab view: only while it shows a chord:// document.
    return this.tabs.tabIdOf(event.sender) !== undefined && isInternal(event.senderFrame?.url ?? '');
  }

  createWindow(): void {
    if (this.win) return;
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 640,
      minHeight: 420,
      show: false,
      backgroundColor: this.chromeColor(),
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      trafficLightPosition: { x: 14, y: 15 },
      titleBarOverlay: isMac ? undefined : this.titleBarOverlay(),
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true },
    });
    this.win = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.loadFile(join(RENDERER_DIR, 'index.html'));
    win.once('ready-to-show', () => {
      win.show();
      this.tabs.reconcile(this.state);
      this.broadcast();
    });
    win.webContents.on('did-finish-load', () => this.broadcast());
    const relayout = () => this.relayout();
    win.on('resize', relayout);
    win.on('enter-full-screen', relayout);
    win.on('leave-full-screen', relayout);
    const onTheme = () => this.applyChromeColors();
    nativeTheme.on('updated', onTheme);
    win.on('closed', () => nativeTheme.off('updated', onTheme));
    // Tear the page views down while the window still exists: child views that
    // outlive their window keep the process alive on Windows.
    win.on('close', (e) => {
      if (this.state.settings.closeToTray && !this.quitting) {
        e.preventDefault();
        win.hide();
        return;
      }
      this.tabs.reset();
      this.overlay.dispose();
      this.win = null; // nothing may reconcile views onto a closing window
      this.store.flush();
    });
  }

  /** Whether the sidebar currently takes up space in the layout. */
  sidebarVisible(): boolean {
    return this.state.settings.sidebarOpen || this.peeking;
  }

  /** Distance from the top of the window to the page: window controls plus the address bar. */
  topInset(): number {
    return TOP_INSET + (this.state.settings.addressBar ? ADDRESS_BAR_HEIGHT : 0);
  }

  private chromeColor(): string {
    const mode = this.state.settings.theme.mode;
    const dark = mode === 'dark' || (mode === 'system' && nativeTheme.shouldUseDarkColors);
    return dark ? CHROME_DARK : CHROME_LIGHT;
  }

  private titleBarOverlay(): { color: string; symbolColor: string; height: number } {
    const dark = this.chromeColor() === CHROME_DARK;
    return { color: this.chromeColor(), symbolColor: dark ? '#dddde3' : '#2a2a33', height: TITLEBAR_HEIGHT };
  }

  private applyChromeColors(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    win.setBackgroundColor(this.chromeColor());
    if (!isMac) win.setTitleBarOverlay(this.titleBarOverlay());
  }

  private relayout(): void {
    this.tabs.layout();
    this.overlay.layout();
  }

  focusWindow(): void {
    if (!this.win) this.createWindow();
    else {
      if (!this.win.isVisible()) this.win.show();
      if (this.win.isMinimized()) this.win.restore();
      this.win.focus();
    }
  }

  openInternalFromTray(url: string): void {
    this.focusWindow();
    this.openInternal(url);
  }

  openUrl(url: string): void {
    this.focusWindow();
    this.apply({ type: 'tab.new', url, activate: true });
  }

  flush(): void {
    this.downloads.flush();
    this.store.save(this.state);
    this.store.flush();
  }

  // ---- state ----

  apply(action: Action): void {
    if (this.applying) {
      this.queue.push(action);
      return;
    }
    this.applying = true;
    try {
      let current: Action | undefined = action;
      while (current) {
        this.applyOne(current);
        current = this.queue.shift();
      }
    } finally {
      this.applying = false;
    }
  }

  private applyOne(action: Action): void {
    const prev = this.state;
    const next = reduce(prev, action, this.ctx());
    if (next === prev) return;
    this.state = next;
    // Title, favicon and loading updates arrive many times per second while pages
    // load; they change nothing about which views exist or where they go.
    if (viewSignature(prev) !== viewSignature(next)) {
      this.tabs.reconcile(next);
      if (this.overlay.isShown()) this.overlay.layout();
    }
    this.store.save(next);
    this.broadcast();
    if (prev.settings.shields !== next.settings.shields) void setShields(next.settings.shields);
    if (prev.settings.smartPages && !next.settings.smartPages) this.smart.clearAll();
    if (prev.settings.closeToTray !== next.settings.closeToTray) this.tray.sync(next.settings.closeToTray);
    const focusedNow = activeSpace(next).focused;
    if (focusedNow && focusedNow !== activeSpace(prev).focused) this.smart.seen(focusedNow);
    if (prev.settings.theme.mode !== next.settings.theme.mode) this.applyChromeColors();
    if (prev.settings.extensions !== next.settings.extensions && JSON.stringify(prev.settings.extensions) !== JSON.stringify(next.settings.extensions)) {
      void this.extensions.sync(next);
    }
    this.refreshMenu();
  }

  private refreshMenu(): void {
    const space = activeSpace(this.state);
    const key = this.state.spaces.map((sp) => `${sp.id}:${sp.icon ?? ''}${sp.name}`).join('|') + `|ab=${this.state.settings.addressBar}|panes=${space.panes.length}|tiling=${space.tiling ?? ''}|custom=${this.state.settings.tilings.map((t) => t.spec).join(',')}`;
    if (key === this.menuKey) return;
    this.menuKey = key;
    buildAppMenu(this);
  }

  /** Coalesces state pushes to the UI pages to at most one per frame. */
  broadcast(): void {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const targets = [this.win?.webContents, this.overlay.webContents, ...this.tabs.internalWebContents()];
      for (const wc of targets) if (wc && !wc.isDestroyed()) wc.send('state', this.state);
    }, BROADCAST_INTERVAL_MS);
  }

  sendSidebar(message: SidebarMessage): void {
    this.win?.webContents.send('sidebar', message);
  }

  sendAll(channel: string, payload: unknown): void {
    for (const wc of [this.win?.webContents, this.overlay.webContents, ...this.tabs.internalWebContents()]) if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  }

  dispatch(message: Message): void {
    if (isCommand(message)) this.command(message);
    else this.apply(message);
  }

  // ---- commands with side effects ----

  private command(cmd: Command): void {
    const wc = () => this.tabs.focusedView()?.webContents;
    switch (cmd.type) {
      case 'tab.navigate': {
        const id = cmd.id ?? activeSpace(this.state).focused;
        const tab = id ? this.state.tabs[id] : undefined;
        if (!tab || !id) {
          this.apply({ type: 'tab.new', url: cmd.url, activate: true });
          return;
        }
        this.navigate(id, cmd.url);
        return;
      }
      case 'tab.home': {
        const tab = this.state.tabs[cmd.id];
        if (tab?.homeUrl) this.navigate(cmd.id, tab.homeUrl);
        return;
      }
      case 'tab.duplicate': {
        const tab = this.state.tabs[cmd.id];
        if (tab) this.apply({ type: 'tab.new', url: tab.url, spaceId: tab.spaceId ?? this.state.activeSpaceId, activate: true });
        return;
      }
      case 'tab.mute': {
        const tab = this.state.tabs[cmd.id];
        if (tab) this.apply({ type: 'tab.patch', id: cmd.id, patch: { muted: !tab.muted } });
        return;
      }
      case 'tab.contextmenu':
        tabContextMenu(this, cmd.id);
        return;
      case 'space.contextmenu':
        spaceContextMenu(this, cmd.id);
        return;
      case 'space.rename':
        this.apply({ type: 'space.update', id: cmd.id, patch: { name: cmd.name } });
        return;
      case 'nav.back':
        wc()?.navigationHistory.goBack();
        return;
      case 'nav.forward':
        wc()?.navigationHistory.goForward();
        return;
      case 'nav.reload':
        wc()?.reload();
        return;
      case 'nav.stop':
        wc()?.stop();
        return;
      case 'palette.open': {
        const tab = focusedTab(this.state);
        const query = cmd.intent === 'current' && tab ? tab.url : '';
        this.overlay.show({ kind: 'show', mode: 'palette', intent: tab ? cmd.intent : 'new', query });
        return;
      }
      case 'palette.close':
        this.overlay.hide();
        return;
      case 'settings.open':
        this.overlay.show({ kind: 'show', mode: 'settings' });
        return;
      case 'sidebar.peek':
        if (this.peeking === cmd.on || this.state.settings.sidebarOpen) {
          this.peeking = cmd.on && !this.state.settings.sidebarOpen;
          return;
        }
        this.peeking = cmd.on;
        this.relayout();
        return;
      case 'find.open':
        if (wc()) this.overlay.show({ kind: 'show', mode: 'find' });
        return;
      case 'find.query': {
        const w = wc();
        if (!w) return;
        if (!cmd.text) {
          w.stopFindInPage('clearSelection');
          this.overlay.send({ kind: 'find:result', active: 0, matches: 0 });
          return;
        }
        w.findInPage(cmd.text, { forward: cmd.forward, findNext: cmd.findNext });
        return;
      }
      case 'find.close':
        wc()?.stopFindInPage('keepSelection');
        this.overlay.hide();
        return;
      case 'url.copy': {
        const tab = focusedTab(this.state);
        if (tab) clipboard.writeText(tab.url);
        return;
      }
      case 'devtools.toggle':
        wc()?.toggleDevTools();
        return;
      case 'zoom.in':
      case 'zoom.out':
      case 'zoom.reset': {
        const w = wc();
        if (!w) return;
        const level = cmd.type === 'zoom.reset' ? 0 : w.getZoomLevel() + (cmd.type === 'zoom.in' ? 0.5 : -0.5);
        w.setZoomLevel(Math.max(-3, Math.min(5, level)));
        return;
      }
      case 'open.external':
        if (/^(https?|mailto):/i.test(cmd.url)) shell.openExternal(cmd.url).catch(() => {});
        return;
      case 'app.setDefaultBrowser':
        app.setAsDefaultProtocolClient('http');
        app.setAsDefaultProtocolClient('https');
        return;
      case 'extension.pickFolder':
        if (this.win) void this.extensions.pickFolder(this.win);
        return;
      case 'config.export':
        void this.exportConfig(cmd.spaceId);
        return;
      case 'config.importFile':
        void this.importConfig();
        return;
      case 'diagnostics.copy':
        void copyDiagnostics(this);
        return;
      case 'media.action':
        this.smart.mediaAction(cmd.id, cmd.action);
        return;
      case 'call.action':
        this.smart.callAction(cmd.id, cmd.action);
        return;
      case 'import.browser':
        void importFromBrowser(this);
        return;
      case 'download.pause':
        this.downloads.pause(cmd.id);
        return;
      case 'download.resume':
        this.downloads.resume(cmd.id);
        return;
      case 'download.cancel':
        this.downloads.cancel(cmd.id);
        return;
      case 'download.open':
        this.downloads.open(cmd.id);
        return;
      case 'download.show':
        this.downloads.show(cmd.id);
        return;
      case 'download.retry':
        this.downloads.retry(cmd.id);
        return;
      case 'download.remove':
        this.downloads.remove(cmd.id);
        return;
      case 'downloads.clear':
        this.downloads.clearFinished();
        return;
      case 'downloads.openFolder':
        void shell.openPath(app.getPath('downloads'));
        return;
      case 'downloads.open':
        this.openInternal('chord://downloads/');
        return;
    }
  }

  // ---- configuration files ----

  private async exportConfig(spaceId?: string): Promise<void> {
    if (!this.win) return;
    const now = Date.now();
    const space = spaceId ? this.state.spaces.find((sp) => sp.id === spaceId) : undefined;
    if (spaceId && !space) return;
    const { canceled, filePath } = await dialog.showSaveDialog(this.win, {
      title: space ? `Export space “${space.name}”` : 'Export Chord configuration',
      defaultPath: join(app.getPath('documents'), exportFileName(now, space?.name)),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return;
    const config = exportConfig(this.state, now, space?.id);
    try {
      await writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } catch (err) {
      dialog.showErrorBox('Export failed', err instanceof Error ? err.message : String(err));
    }
  }

  private async importConfig(): Promise<void> {
    if (!this.win) return;
    const { canceled, filePaths } = await dialog.showOpenDialog(this.win, {
      title: 'Import Chord configuration',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths[0]) return;
    let text: string;
    try {
      text = await readFile(filePaths[0], 'utf8');
    } catch (err) {
      dialog.showErrorBox('Import failed', err instanceof Error ? err.message : String(err));
      return;
    }
    const parsed = parseConfig(text);
    if (!parsed.ok) {
      dialog.showErrorBox('Import failed', `This is not a valid Chord configuration: ${parsed.error}.`);
      return;
    }
    await confirmImport(this, parsed.config, 'a Chord configuration');
  }

  /** Show one of Chord's own pages: reuse it if the active space already has it open. */
  openInternal(url: string): void {
    const space = activeSpace(this.state);
    const existing = [...space.pinned, ...space.today].map((id) => this.state.tabs[id]).find((t) => t && t.url === url);
    if (existing) this.apply({ type: 'tab.activate', id: existing.id });
    else this.apply({ type: 'tab.new', url });
  }

  private navigate(id: TabId, url: string): void {
    const tab = this.state.tabs[id];
    if (!tab) return;
    let live = tab.awake ? this.tabs.get(id) : undefined;
    // Chord pages and web pages run with different preloads, so a view cannot carry a tab across that line.
    if (live && isInternal(url) !== isInternal(tab.url)) {
      this.tabs.destroy(id);
      live = undefined;
    }
    this.apply({ type: 'tab.patch', id, patch: { url, title: titleFor(url), awake: true, favicon: undefined } });
    if (live) live.webContents.loadURL(url).catch(() => {});
    else this.tabs.reconcile(this.state);
    this.apply({ type: 'tab.activate', id });
  }
}

/** Everything that decides which views exist, where they are and which one has focus. */
function viewSignature(s: State): string {
  const space = activeSpace(s);
  const awake: string[] = [];
  for (const t of Object.values(s.tabs)) if (t.awake) awake.push(t.id + (t.muted ? '!' : ''));
  return [s.activeSpaceId, space.panes.join(','), space.tiling ?? '', space.focused ?? '', s.settings.sidebarOpen, s.settings.sidebarWidth, awake.sort().join(',')].join('|');
}

function isMessage(m: unknown): m is Message {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}
