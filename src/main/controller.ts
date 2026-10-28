import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type WebContents, type IpcMainInvokeEvent } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Action, AppInfo, Command, Message, SidebarMessage, SpaceId, State, TabId, WindowState } from '../shared/types.ts';
import { isCommand } from '../shared/types.ts';
import { activeSpace, focusedTab, hydrate, isLocked, panelVisibleFor, reduce, spaceById, spaceOfTab, visiblePanes, type Ctx } from '../shared/model.ts';
import { makeLock, verifyLock } from './locks.ts';
import { titleFor } from '../shared/url.ts';
import { exportConfig, exportFileName, parseConfig } from '../shared/config.ts';
import { Store } from './store.ts';
import { TabManager } from './tabs.ts';
import type { Overlay } from './overlay.ts';
import type { PanelManager } from './panel.ts';
import { ChordWindow } from './window.ts';
import { CaptureManager } from './capture.ts';
import { PageTabsManager } from './pagetabs.ts';
import { UpdateManager } from './updater.ts';
import { McpManager } from './mcp.ts';
import { SourcesManager } from './sources.ts';
import { initIdentityIpc, setGoogleSignIn } from './identity.ts';
import { setShields } from './session.ts';
import { buildAppMenu, spaceContextMenu, tabContextMenu, groupContextMenu } from './menu.ts';
import { PRELOAD, RENDERER_DIR, DIST } from './paths.ts';
import { isMac, TITLEBAR_HEIGHT, TOP_INSET, ADDRESS_BAR_HEIGHT } from './platform.ts';
import { ExtensionManager } from './extensions.ts';
import { copyDiagnostics, mark, startLagMonitor } from './diagnostics.ts';
import { SmartManager } from './smart.ts';
import { TrayManager } from './tray.ts';
import { confirmImport, importFromBrowser } from './importers.ts';
import { DownloadManager } from './downloads.ts';
import { HistoryManager } from './history.ts';
import { BoostManager } from './boosts.ts';
import { PasswordManager } from './passwords.ts';
import { PasskeyManager } from './passkeys.ts';
import { PIP_JS } from './pip.ts';
import { installSpace } from './installer.ts';
import { ResearchManager } from './research.ts';
import { CuratedManager } from './curated.ts';
import { SyncManager } from './sync.ts';
import { ReaderManager } from './reader.ts';
import { LittleWindows } from './little.ts';
import { EaselManager } from './easels.ts';
import { LiveManager } from './live.ts';
import { PeekManager } from './peek.ts';
import { spaceForUrl } from '../shared/routes.ts';
import { shareId } from '../shared/share.ts';
import { openUrlFrom } from '../shared/installer.ts';
import { LIVE_KINDS, type LiveKind, type SharedTab } from '../shared/types.ts';
import { AiManager } from './ai.ts';
import { modesMenu } from './menu.ts';
import { installUrlFrom } from '../shared/installer.ts';
import { browsingSession, configureSession, partitionFor } from './session.ts';
import { hostOf, isInternal } from '../shared/url.ts';

const CHROME_DARK = '#1b1b22';
const CHROME_LIGHT = '#f4f4f7';
const BROADCAST_INTERVAL_MS = 16;

export class Controller {
  state!: State;
  /** true when no state.json existed at launch: the guide opens as the first tab */
  firstRun = false;
  readonly windows = new Map<number, ChordWindow>();
  private activeWindowId: number | null = null;
  private lastSignature = '';
  private windowsSaveTimer: NodeJS.Timeout | null = null;
  private heavyScheduled = false;
  readonly store: Store<State>;
  readonly tabs = new TabManager(this);
  readonly capture = new CaptureManager(this);
  readonly pageTabs = new PageTabsManager(this);
  readonly updates = new UpdateManager(this);
  readonly mcp = new McpManager(this);
  readonly sources = new SourcesManager(this);
  readonly smart = new SmartManager(this);
  readonly tray = new TrayManager(this);
  /** set once the app is really quitting, so close-to-tray does not swallow the window close */
  quitting = false;
  readonly downloads = new DownloadManager(this);
  readonly history = new HistoryManager(this);
  readonly boosts = new BoostManager(this);
  readonly passwords = new PasswordManager(this);
  readonly passkeys = new PasskeyManager(this);
  readonly research = new ResearchManager(this);
  readonly curated = new CuratedManager(this);
  readonly sync = new SyncManager(this);
  readonly reader = new ReaderManager(this);
  readonly little = new LittleWindows(this);
  readonly easels = new EaselManager(this);
  readonly live = new LiveManager(this);
  readonly peek = new PeekManager(this);
  readonly ai = new AiManager(this);
  readonly extensions = new ExtensionManager({
    apply: (a) => this.apply(a),
    onStatus: (status) => this.sendAll('extensions', status),
    entries: () => this.state.settings.extensions,
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

  // ---- windows ----

  /** The window the user is working in: the focused one, else the last focused, else any. */
  get active(): ChordWindow | undefined {
    const w = this.activeWindowId !== null ? this.windows.get(this.activeWindowId) : undefined;
    if (w && w.alive()) return w;
    for (const other of this.windows.values()) if (other.alive()) return other;
    return undefined;
  }

  /** The active window's BrowserWindow, for dialogs and menus. */
  get win(): BrowserWindow | null {
    return this.active?.win ?? null;
  }

  get overlay(): Overlay | undefined {
    return this.active?.overlay;
  }

  get panel(): PanelManager | undefined {
    return this.active?.panel;
  }

  windowForSpace(spaceId: SpaceId | null | undefined): ChordWindow | undefined {
    if (!spaceId) return undefined;
    for (const w of this.windows.values()) if (w.alive() && w.spaceId === spaceId) return w;
    return undefined;
  }

  /** The window a chrome page or tab view belongs to. */
  windowOf(wc: WebContents): ChordWindow | undefined {
    for (const w of this.windows.values()) {
      if (!w.alive()) continue;
      if (w.win.webContents === wc || w.overlay.webContents === wc || w.panel.webContents === wc) return w;
    }
    const tabId = this.tabs.tabIdOf(wc);
    return tabId ? this.tabs.windowOfView(tabId) : undefined;
  }

  /** Make `w` the window whose space is the active space. */
  setActive(w: ChordWindow): void {
    if (!w.alive()) return;
    this.activeWindowId = w.id;
    if (this.state.activeSpaceId !== w.spaceId) this.apply({ type: 'space.activate', id: w.spaceId });
  }

  /** State as one window's pages see it: its own space is the active one. */
  stateFor(w: ChordWindow | undefined): State {
    return !w || w.spaceId === this.state.activeSpaceId ? this.state : { ...this.state, activeSpaceId: w.spaceId };
  }

  /** A space nobody is showing yet, for a new window. */
  private freeSpace(): SpaceId | undefined {
    return this.state.spaces.find((sp) => !this.windowForSpace(sp.id))?.id;
  }

  private saveWindows(): void {
    if (this.windowsSaveTimer) return;
    this.windowsSaveTimer = setTimeout(() => {
      this.windowsSaveTimer = null;
      const windows: WindowState[] = [];
      for (const w of this.windows.values()) if (w.alive()) windows.push({ spaceId: w.spaceId, bounds: w.win.getNormalBounds() });
      this.apply({ type: 'windows.set', windows });
    }, 500);
  }

  init(): void {
    const stored = this.store.load();
    this.firstRun = stored === null;
    this.state = hydrate(stored, this.ctx());
    setInterval(() => this.apply({ type: 'tick' }), 60_000).unref();
    startLagMonitor();
    this.smart.init();
    this.tray.sync(this.state.settings.closeToTray);
    this.downloads.init(browsingSession());
    this.history.init();
    this.passwords.init();
    this.passkeys.init();
    ipcMain.on('page:hooks', (event) => {
      event.returnValue = !this.state.settings.flags.noPageHooks;
    });
    // a horizontal two-finger swipe on a page that cannot scroll sideways (see preload/page.ts)
    ipcMain.on('nav:gesture', (event, direction: unknown) => {
      if (!this.tabs.tabIdOf(event.sender)) return;
      if (direction === 'back' || direction === 'forward') this.gesture(direction, event.sender);
    });
    this.research.init();
    this.curated.init();
    this.sync.init();
    this.reader.init();
    this.easels.init();
    this.live.init();
    this.ai.init();
    this.capture.init();
    this.pageTabs.init();
    this.updates.init();
    this.mcp.init();
    this.sources.init();
    initIdentityIpc();
    setGoogleSignIn(this.state.settings.googleSignIn);

    ipcMain.handle('dispatch', (event, message: unknown) => {
      if (!this.trusted(event) || !isMessage(message)) return;
      if (this.little.owns(event.sender)) return this.little.command(event.sender, message);
      if (this.peek.owns(event.sender)) return this.peek.command(event.sender, message);
      const w = this.windowOf(event.sender);
      if (w && w !== this.active) this.setActive(w);
      this.dispatch(message);
    });
    ipcMain.handle('state', (event) => (this.trusted(event) ? this.stateFor(this.windowOf(event.sender)) : null));
    ipcMain.handle('extensions', (event) => (this.trusted(event) ? this.extensions.getStatus() : {}));
    ipcMain.handle('info', (event) => (this.trusted(event) ? this.appInfo() : null));
    ipcMain.handle('updates', (event) => (this.trusted(event) ? this.updates.status : null));
    ipcMain.handle('mcp', (event) => (this.trusted(event) ? this.mcp.status : null));
    ipcMain.handle('smart', (event) => (this.trusted(event) ? this.smart.getStatus() : {}));
    ipcMain.handle('downloads', (event) => (this.trusted(event) ? this.downloads.status() : { items: [], active: 0 }));

    this.refreshMenu();
  }

  trustedEvent(event: IpcMainInvokeEvent): boolean {
    return this.trusted(event);
  }

  private trusted(event: IpcMainInvokeEvent): boolean {
    for (const w of this.windows.values()) {
      if (!w.alive()) continue;
      if (event.sender === w.win.webContents || event.sender === w.overlay.webContents || event.sender === w.panel.webContents) return true;
    }
    if ((this.little.owns(event.sender) || this.peek.owns(event.sender)) && isInternal(event.senderFrame?.url ?? '')) return true;
    // One of Chord's own pages in a tab view: only while it shows a chord:// document.
    return this.tabs.tabIdOf(event.sender) !== undefined && isInternal(event.senderFrame?.url ?? '');
  }

  /** Open the windows of the last session (one per remembered space), or a single one. */
  openInitialWindows(): void {
    const remembered = (this.state.windows ?? []).filter((w) => this.state.spaces.some((sp) => sp.id === w.spaceId));
    const list: WindowState[] = remembered.length ? remembered : [{ spaceId: this.state.activeSpaceId }];
    let first: ChordWindow | undefined;
    for (const entry of list) {
      const w = this.openWindow(entry.spaceId, entry.bounds);
      if (!first || entry.spaceId === this.state.activeSpaceId) first = w;
    }
    if (first) this.setActive(first);
  }

  openWindow(spaceId: SpaceId = this.state.activeSpaceId, bounds?: WindowState['bounds']): ChordWindow {
    if (this.windows.size === 0) mark('window-created');
    const win = new BrowserWindow({
      width: bounds?.width ?? 1280,
      height: bounds?.height ?? 820,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 640,
      minHeight: 420,
      show: false,
      backgroundColor: this.chromeColor(),
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      trafficLightPosition: { x: 14, y: 15 },
      titleBarOverlay: isMac ? undefined : this.titleBarOverlay(),
      icon: join(DIST, 'renderer', 'icon.png'),
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true },
    });
    const w = new ChordWindow(this, win, spaceId);
    this.windows.set(w.id, w);
    if (this.activeWindowId === null) this.activeWindowId = w.id;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.wireKeys(win.webContents);
    win.loadFile(join(RENDERER_DIR, 'index.html'));
    win.once('ready-to-show', () => {
      win.show();
      if (this.windows.size === 1) mark('window-shown');
      this.reconcileViews();
      this.broadcast();
      if (this.firstRun) {
        this.firstRun = false;
        this.openInternal('chord://guide/');
      }
      if (!this.heavyScheduled) {
        this.heavyScheduled = true;
        // Filter lists and extensions are heavy to load: let the first page start first.
        setTimeout(() => {
          void setShields(this.state.settings.shields).then(() => mark('shields-ready'));
          void this.extensions.sync(this.state);
        }, 400);
      }
      this.saveWindows();
    });
    win.webContents.on('did-finish-load', () => this.broadcast());
    win.on('focus', () => this.setActive(w));
    // macOS with "swipe between pages" set to two or three fingers: the system reports the swipe
    win.on('swipe', (_e, direction) => {
      if (direction === 'right') this.gesture('back', this.tabs.focusedViewIn(w)?.webContents);
      else if (direction === 'left') this.gesture('forward', this.tabs.focusedViewIn(w)?.webContents);
    });
    win.on('hide', () => this.apply({ type: 'space.lockAll' }));
    const relayout = () => {
      this.relayoutWindow(w);
      this.saveWindows();
    };
    win.on('resize', relayout);
    win.on('move', () => this.saveWindows());
    win.on('enter-full-screen', relayout);
    win.on('leave-full-screen', relayout);
    const onTheme = () => this.applyChromeColors();
    nativeTheme.on('updated', onTheme);
    win.on('closed', () => {
      nativeTheme.off('updated', onTheme);
      this.windows.delete(w.id);
    });
    // Tear the page views down while the window still exists: child views that
    // outlive their window keep the process alive on Windows.
    win.on('close', (e) => {
      const last = [...this.windows.values()].filter((x) => x.alive()).length <= 1;
      if (last && this.state.settings.closeToTray && !this.quitting) {
        e.preventDefault();
        win.hide();
        return;
      }
      if (last) this.tabs.reset();
      else this.tabs.releaseWindow(w);
      w.overlay.dispose();
      w.panel.dispose();
      this.windows.delete(w.id);
      if (this.activeWindowId === w.id) {
        this.activeWindowId = null;
        const next = this.active;
        if (next) this.setActive(next);
      }
      if (!last) this.saveWindows();
      this.store.flush();
    });
    return w;
  }

  /** Views and panels of every window follow the state. */
  private reconcileViews(): void {
    this.tabs.reconcile(this.state);
    this.peek.raise();
    for (const w of this.windows.values()) {
      if (!w.alive()) continue;
      w.panel.sync();
      if (w.overlay.isShown()) w.overlay.layout();
    }
  }

  /** Whether the sidebar currently takes up space in the layout. */
  sidebarVisible(): boolean {
    return this.state.settings.sidebarOpen || this.peeking;
  }

  /** Distance from the top of the window to the page: window controls plus the address bar. */
  topInset(): number {
    return TOP_INSET + (this.state.settings.addressBar ? ADDRESS_BAR_HEIGHT : 0);
  }

  chromeColor(): string {
    if (this.state.settings.theme.skin === 'lcars') return '#000000';
    const mode = this.state.settings.theme.mode;
    const dark = mode === 'dark' || (mode === 'system' && nativeTheme.shouldUseDarkColors);
    return dark ? CHROME_DARK : CHROME_LIGHT;
  }

  titleBarOverlay(): { color: string; symbolColor: string; height: number } {
    const color = this.chromeColor();
    const symbolColor = this.state.settings.theme.skin === 'lcars' ? '#ff9966' : color === CHROME_DARK ? '#dddde3' : '#2a2a33';
    return { color, symbolColor, height: TITLEBAR_HEIGHT };
  }

  private applyChromeColors(): void {
    for (const w of this.windows.values()) {
      if (!w.alive()) continue;
      w.win.setBackgroundColor(this.chromeColor());
      if (!isMac) w.win.setTitleBarOverlay(this.titleBarOverlay());
    }
  }

  private relayout(): void {
    for (const w of this.windows.values()) this.relayoutWindow(w);
  }

  private relayoutWindow(w: ChordWindow): void {
    if (!w.alive()) return;
    this.tabs.layout();
    w.panel.layout();
    this.peek.layout();
    w.overlay.layout();
  }

  private lastGesture = 0;
  /** Back or forward from a swipe; the system event and the wheel detector may both report one. */
  gesture(direction: 'back' | 'forward', wc: WebContents | undefined): void {
    if (!wc || wc.isDestroyed()) return;
    const now = Date.now();
    if (now - this.lastGesture < 600) return;
    this.lastGesture = now;
    if (direction === 'back') wc.navigationHistory.goBack();
    else wc.navigationHistory.goForward();
  }

  focusWindow(): void {
    const w = this.active;
    if (!w) {
      this.openWindow();
      return;
    }
    if (!w.win.isVisible()) w.win.show();
    if (w.win.isMinimized()) w.win.restore();
    w.win.focus();
  }

  openInternalFromTray(url: string): void {
    this.focusWindow();
    this.openInternal(url);
  }

  openUrl(url: string): void {
    // chord://open/?url=… from a shared page: open the page itself
    const opened = openUrlFrom(url);
    if (opened) url = opened;
    const manifest = installUrlFrom(url);
    if (manifest) {
      this.focusWindow();
      void installSpace(this, manifest);
      return;
    }
    // Air Traffic Control: a rule for this site sends the link straight into its space
    const routed = spaceForUrl(this.state.settings.routes, this.state.spaces, url);
    if (routed) {
      this.focusWindow();
      this.apply({ type: 'tab.new', url, spaceId: routed, activate: true });
      return;
    }
    // a link from another app: a Little window, unless the user prefers tabs
    if (this.state.settings.littleWindows && /^https?:/i.test(url) && this.windows.size > 0) {
      this.little.open(url);
      return;
    }
    this.focusWindow();
    this.apply({ type: 'tab.new', url, activate: true });
  }

  flush(): void {
    this.downloads.flush();
    this.history.flush();
    this.passwords.flush();
    this.passkeys.flush();
    this.research.flush();
    this.curated.flush();
    this.reader.flush();
    this.ai.flush();
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
    // The active space changed: if another window already shows it, that window takes
    // over; otherwise the active window switches to it.
    if (next.activeSpaceId !== prev.activeSpaceId) {
      const active = this.active;
      const other = this.windowForSpace(next.activeSpaceId);
      if (other && other !== active) {
        this.activeWindowId = other.id;
        if (!other.win.isFocused()) other.win.focus();
      } else if (active) active.spaceId = next.activeSpaceId;
    }
    // Title, favicon and loading updates arrive many times per second while pages
    // load; they change nothing about which views exist or where they go.
    const signature = viewSignature(next, this.windows);
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.reconcileViews();
    }
    this.store.save(next);
    this.broadcast();
    if (prev.settings.shields !== next.settings.shields) void setShields(next.settings.shields);
    if (prev.settings.smartPages && !next.settings.smartPages) this.smart.clearAll();
    if (prev.settings.passkeys !== next.settings.passkeys) this.sendAll('passkeys', this.passkeys.status());
    if (prev.settings.closeToTray !== next.settings.closeToTray) this.tray.sync(next.settings.closeToTray);
    if (prev.settings.boosts !== next.settings.boosts && JSON.stringify(prev.settings.boosts) !== JSON.stringify(next.settings.boosts)) void this.boosts.refresh();
    this.autoPip(prev, next);
    let soundChanged = false;
    for (const [id, tab] of Object.entries(next.tabs)) {
      if ((prev.tabs[id]?.volume ?? 1) !== (tab.volume ?? 1)) {
        this.tabs.get(id)?.webContents.send('smart:action', `volume:${tab.volume ?? 1}`);
        soundChanged = true;
      }
      if (!!prev.tabs[id]?.muted !== !!tab.muted) soundChanged = true;
    }
    if (soundChanged) this.tray.refresh();
    this.pageTabs.diff(prev, next);
    if (prev.settings.updates.check !== next.settings.updates.check) this.updates.schedule();
    if (prev.settings.mcp.enabled !== next.settings.mcp.enabled || prev.settings.mcp.port !== next.settings.mcp.port) this.mcp.sync();
    if (prev.settings.googleSignIn !== next.settings.googleSignIn) setGoogleSignIn(next.settings.googleSignIn);
    if (prev.spaces.length > next.spaces.length) this.easels.keepOnly(new Set(next.spaces.map((sp) => sp.id)));
    if (prev.activeSpaceId !== next.activeSpaceId || activeSpace(prev).focused !== activeSpace(next).focused) this.peek.close();
    if (prev.shares !== next.shares) for (const old of prev.shares ?? []) if (!(next.shares ?? []).some((x) => x.id === old.id)) void this.sync.unpublish(`t/${old.id}`);
    const focusedNow = activeSpace(next).focused;
    if (focusedNow && focusedNow !== activeSpace(prev).focused) this.smart.seen(focusedNow);
    if (prev.activeSpaceId !== next.activeSpaceId || JSON.stringify(activeSpace(prev).modes) !== JSON.stringify(activeSpace(next).modes)) this.curated.touch(next.activeSpaceId);
    if (prev.bookmarks !== next.bookmarks || prev.spaces !== next.spaces || prev.shares !== next.shares || prev.favorites !== next.favorites || prev.settings.theme !== next.settings.theme || prev.settings.sync.theme !== next.settings.sync.theme || prev.tabs !== next.tabs) this.sync.schedulePush();
    if (prev.spaces.map((sp) => `${sp.id}:${sp.focused ?? ''}`).join() !== next.spaces.map((sp) => `${sp.id}:${sp.focused ?? ''}`).join() || JSON.stringify(prev.settings.sourceror) !== JSON.stringify(next.settings.sourceror)) this.sources.refresh();
    if (prev.settings.theme.mode !== next.settings.theme.mode || prev.settings.theme.skin !== next.settings.theme.skin) this.applyChromeColors();
    if (prev.settings.theme !== next.settings.theme || prev.spaces.map((sp) => `${sp.id}:${sp.color}:${sp.name}:${sp.icon ?? ''}`).join() !== next.spaces.map((sp) => `${sp.id}:${sp.color}:${sp.name}:${sp.icon ?? ''}`).join()) this.pushTheme();
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
      for (const w of this.windows.values()) {
        if (!w.alive()) continue;
        const projected = this.stateFor(w);
        for (const wc of [w.win.webContents, w.overlay.webContents, w.panel.webContents]) if (wc && !wc.isDestroyed()) wc.send('state', projected);
      }
      for (const wc of this.tabs.internalWebContents()) {
        const id = this.tabs.tabIdOf(wc);
        wc.send('state', this.stateFor(id ? this.tabs.windowOfView(id) : undefined));
      }
    }, BROADCAST_INTERVAL_MS);
  }

  sendSidebar(message: SidebarMessage): void {
    this.win?.webContents.send('sidebar', message);
  }

  sendAll(channel: string, payload: unknown): void {
    const targets: (WebContents | undefined)[] = [];
    for (const w of this.windows.values()) if (w.alive()) targets.push(w.win.webContents, w.overlay.webContents, w.panel.webContents);
    targets.push(...this.tabs.internalWebContents());
    for (const wc of targets) if (wc && !wc.isDestroyed()) wc.send(channel, payload);
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
        this.overlay?.show({ kind: 'show', mode: 'palette', intent: tab ? cmd.intent : 'new', query });
        return;
      }
      case 'palette.close':
        this.overlay?.hide();
        return;
      case 'settings.open':
        this.openInternal('chord://settings/', cmd.page);
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
        if (wc()) this.overlay?.show({ kind: 'show', mode: 'find' });
        return;
      case 'find.query': {
        const w = wc();
        if (!w) return;
        if (!cmd.text) {
          w.stopFindInPage('clearSelection');
          this.overlay?.send({ kind: 'find:result', active: 0, matches: 0 });
          return;
        }
        w.findInPage(cmd.text, { forward: cmd.forward, findNext: cmd.findNext });
        return;
      }
      case 'find.close':
        wc()?.stopFindInPage('keepSelection');
        this.overlay?.hide();
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
      case 'extension.install':
        void this.extensions.installFromStore(cmd.input);
        return;
      case 'extension.update':
        void this.extensions.updateFromStore(cmd.path);
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
      case 'media.pip': {
        const target = cmd.id ? this.tabs.get(cmd.id)?.webContents : wc();
        if (target && !target.isDestroyed()) void target.executeJavaScript(PIP_JS('toggle'), true).catch(() => {});
        return;
      }
      case 'downloads.panel':
        if (this.overlay?.mode === 'downloads') this.overlay?.hide();
        else this.overlay?.show({ kind: 'show', mode: 'downloads' });
        return;
      case 'password.delete':
        this.passwords.remove(cmd.id);
        return;
      case 'password.allowAgain':
        this.passwords.allowAgain(cmd.host);
        return;
      case 'passkey.delete':
        this.passkeys.remove(cmd.id);
        return;
      case 'passwords.setMaster':
        this.passwords.setMasterPassword(cmd.password);
        return;
      case 'passwords.clearMaster':
        this.passwords.clearMasterPassword();
        return;
      case 'call.action':
        this.smart.callAction(cmd.id, cmd.action);
        return;
      case 'dev.action':
        this.smart.devAction(cmd.id, cmd.action);
        return;
      case 'card.action':
        this.smart.cardAction(cmd.id, cmd.action);
        return;
      case 'import.browser':
        void importFromBrowser(this, cmd.only);
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
        void shell.openPath(this.downloads.dir());
        return;
      case 'downloads.chooseFolder':
        void this.downloads.chooseDir();
        return;
      case 'downloads.open':
        this.openInternal('chord://downloads/');
        return;
      case 'history.open':
        this.openInternal('chord://history/');
        return;
      case 'bookmarks.open':
        this.openInternal('chord://bookmarks/');
        return;
      case 'reader.open':
        this.openInternal('chord://reader/');
        return;
      case 'easel.open': {
        const spaceId = cmd.spaceId === undefined ? this.state.activeSpaceId : cmd.spaceId;
        const sp = spaceId ? spaceById(this.state, spaceId) : undefined;
        if (sp && !sp.reader) {
          if (this.state.activeSpaceId !== sp.id) this.apply({ type: 'space.activate', id: sp.id });
          const easel = cmd.easelId ? this.easels.get(cmd.easelId) : (this.easels.forSpace(sp.id)[0] ?? this.easels.create(sp.id));
          this.openInternal(`chord://easel/?space=${encodeURIComponent(sp.id)}${easel ? `&easel=${encodeURIComponent(easel.id)}` : ''}`);
        } else this.openInternal('chord://easel/?space=all');
        return;
      }
      case 'easel.create': {
        const easel = this.easels.create(cmd.spaceId, cmd.name);
        this.openInternal(`chord://easel/?space=${encodeURIComponent(cmd.spaceId)}&easel=${encodeURIComponent(easel.id)}`);
        return;
      }
      case 'easel.rename':
        this.easels.rename(cmd.id, cmd.name);
        return;
      case 'easel.remove':
        void this.easels.remove(cmd.id);
        return;
      case 'easel.put':
        this.easels.put(cmd.id, cmd.item);
        return;
      case 'easel.removeItem':
        this.easels.removeItem(cmd.id, cmd.itemId);
        return;
      case 'easel.addPage':
        this.easels.addPage(cmd.id, cmd.tabId);
        return;
      case 'easel.snapshot':
        void this.easels.snapshot(cmd.id, cmd.tabId);
        return;
      case 'easel.clip':
        this.easels.clip(cmd.id, cmd.text, cmd.url, cmd.title);
        return;
      case 'easel.image':
        void this.easels.image(cmd.id, cmd.dataUrl, cmd.url, cmd.title, cmd.x, cmd.y);
        return;
      case 'easel.imageUrl':
        void this.easels.imageUrl(cmd.id, cmd.src, cmd.url, cmd.title);
        return;
      case 'easel.export':
        void this.easels.export(cmd.id);
        return;
      case 'little.open': {
        const url = cmd.url ?? focusedTab(this.state)?.url;
        if (url && /^https?:/i.test(url)) this.little.open(url);
        return;
      }
      case 'little.nav':
        return; // only meaningful from a Little window's own bar
      case 'peek.nav':
        return; // only meaningful from the peek bar
      case 'peek.open': {
        const from = cmd.fromTab ?? focusedTab(this.state)?.id;
        if (from && /^https?:/i.test(cmd.url)) this.peek.open(cmd.url, from);
        return;
      }
      case 'peek.close':
        this.peek.close();
        return;
      case 'reader.subscribe':
        void this.reader.subscribe(cmd.input, cmd.groupId ?? null, cmd.title);
        return;
      case 'reader.subscribeFrom':
        this.reader.subscribeFrom(cmd.id);
        return;
      case 'reader.unsubscribe':
        this.reader.unsubscribe(cmd.id);
        return;
      case 'reader.refresh':
        void this.reader.refresh(cmd.id);
        return;
      case 'reader.read':
        this.reader.markRead({ ids: cmd.ids, feedId: cmd.feedId, groupId: cmd.groupId, on: cmd.on });
        return;
      case 'reader.star':
        this.reader.star(cmd.id);
        return;
      case 'reader.openItem':
        this.reader.openItem(cmd.id);
        return;
      case 'reader.importOpml':
        void this.reader.importOpml(cmd.spaceId ?? null);
        return;
      case 'reader.exportOpml':
        void this.reader.exportOpml(cmd.groupId);
        return;
      case 'reader.group':
        this.reader.group(cmd.op, cmd.id, cmd.name);
        return;
      case 'reader.move':
        this.reader.move(cmd.id, cmd.groupId);
        return;
      case 'reader.feedMenu':
        this.reader.feedMenu(cmd.id);
        return;
      case 'bookmark.page': {
        const tab = cmd.id ? this.state.tabs[cmd.id] : focusedTab(this.state);
        if (!tab || isInternal(tab.url)) return;
        const space = tab.spaceId ? spaceById(this.state, tab.spaceId) : undefined;
        const spaceId = space && !space.reader ? space.id : null;
        if (cmd.withNote) {
          void this.prompt(`Bookmark “${tab.title || tab.url}” with a note`, 'A note, in Markdown (optional)').then((note) => {
            if (note === null) return;
            this.apply({ type: 'bookmark.add', url: tab.url, title: tab.title, public: cmd.public, note, spaceId });
          });
          return;
        }
        this.apply({ type: 'bookmark.add', url: tab.url, title: tab.title, public: cmd.public, spaceId });
        return;
      }
      case 'bookmarks.openSpace':
        this.openSpacePage('bookmarks', cmd.spaceId ?? this.state.activeSpaceId);
        return;
      case 'notes.open':
        this.openSpacePage('notes', cmd.spaceId === undefined ? this.state.activeSpaceId : cmd.spaceId);
        return;
      case 'sync.connect':
        void this.sync.connect(cmd.token);
        return;
      case 'sync.login':
        void this.sync.startLogin();
        return;
      case 'sync.loginCancel':
        this.sync.cancelLogin();
        return;
      case 'sync.loginGh':
        void this.sync.connectWithGh();
        return;
      case 'sync.disconnect':
        this.sync.disconnect();
        return;
      case 'sync.now':
        void this.sync.syncNow();
        return;
      case 'guide.open':
        this.openInternal('chord://guide/');
        return;
      case 'group.contextmenu':
        groupContextMenu(this, cmd.id);
        return;
      case 'group.new':
        void this.newGroup(cmd.tabId);
        return;
      case 'group.renamePrompt':
        void this.renameGroup(cmd.id);
        return;
      case 'group.newLive':
        void this.newLiveFolder(cmd.spaceId ?? this.state.activeSpaceId, cmd.kind, cmd.query);
        return;
      case 'group.refresh':
        void this.live.refresh(cmd.id);
        return;
      case 'group.liveEdit': {
        const g = this.state.spaces.flatMap((sp) => sp.groups ?? []).find((x) => x.id === cmd.id);
        if (!g?.live) return;
        void this.prompt(`Query for “${g.name}”`, LIVE_KINDS[g.live.kind].hint, g.live.query).then((q) => {
          this.overlay?.hide();
          if (q === null || !g.live) return;
          this.apply({ type: 'group.live', id: cmd.id, live: { ...g.live, query: q.trim() } });
          void this.live.refresh(cmd.id);
        });
        return;
      }
      case 'space.shareToggle': {
        const sp = spaceById(this.state, cmd.id);
        if (!sp) return;
        if (sp.shared) {
          const slug = sp.shared.slug;
          this.apply({ type: 'space.share', id: cmd.id, on: false });
          void this.sync.unpublish(`spaces/${slug}`);
          this.sendSidebar({ kind: 'toast', text: 'Space no longer shared', detail: sp.name });
          return;
        }
        if (!this.sync.connected()) {
          this.sendSidebar({ kind: 'toast', text: 'Sharing needs GitHub sync', detail: 'Sign in under Settings → Sync first' });
          this.openInternal('chord://settings/', 'sync');
          return;
        }
        if (sp.lock) {
          this.sendSidebar({ kind: 'toast', text: 'Private spaces cannot be shared' });
          return;
        }
        this.apply({ type: 'space.share', id: cmd.id, on: true });
        this.copyShareLink(cmd.id);
        void this.sync.push();
        return;
      }
      case 'space.copyShareLink':
        this.copyShareLink(cmd.id);
        return;
      case 'tab.share': {
        const tab = cmd.id ? this.state.tabs[cmd.id] : focusedTab(this.state);
        if (!tab || isInternal(tab.url)) return;
        if (!this.sync.connected()) {
          this.sendSidebar({ kind: 'toast', text: 'Sharing needs GitHub sync', detail: 'Sign in under Settings → Sync first' });
          this.openInternal('chord://settings/', 'sync');
          return;
        }
        const publish = (note: string) => {
          const share: SharedTab = { id: shareId(), url: tab.url, title: tab.title || tab.url, note, at: Date.now() };
          this.apply({ type: 'share.add', share });
          const url = this.sync.shareUrl(`t/${share.id}/`);
          clipboard.writeText(url);
          this.sendSidebar({ kind: 'toast', text: 'Share link copied', detail: `${url} · live in a minute or two` });
          void this.sync.push();
        };
        if (cmd.withNote) {
          void this.prompt(`Share “${tab.title || tab.url}”`, 'A note for whoever opens the link (optional)').then((note) => {
            this.overlay?.hide();
            if (note !== null) publish(note.trim());
          });
        } else publish('');
        return;
      }
      case 'share.copy': {
        const sh = (this.state.shares ?? []).find((x) => x.id === cmd.id);
        if (!sh) return;
        clipboard.writeText(this.sync.shareUrl(`t/${sh.id}/`));
        this.sendSidebar({ kind: 'toast', text: 'Share link copied' });
        return;
      }
      case 'tab.renamePrompt': {
        const tab = this.state.tabs[cmd.id];
        if (!tab) return;
        void this.prompt('Rename tab', 'Leave empty to show the page title again', tab.name ?? tab.title).then((name) => {
          this.overlay?.hide();
          if (name !== null) this.apply({ type: 'tab.rename', id: cmd.id, name: name.trim() === tab.title ? null : name });
        });
        return;
      }
      case 'tab.iconPrompt': {
        const tab = this.state.tabs[cmd.id];
        if (!tab) return;
        void this.prompt('Tab icon', 'An emoji, or empty for the site icon', tab.icon ?? '').then((icon) => {
          this.overlay?.hide();
          if (icon !== null) this.apply({ type: 'tab.icon', id: cmd.id, icon });
        });
        return;
      }
      case 'update.check':
        void this.updates.check(true);
        return;
      case 'update.download':
        void this.updates.download();
        return;
      case 'update.install':
        this.updates.install();
        return;
      case 'update.openPage':
        this.updates.openPage();
        return;
      case 'mcp.copyConfig':
        this.mcp.copyConfig();
        return;
      case 'mcp.regenerate':
        this.mcp.regenerateToken();
        return;
      case 'sources.analyze':
        void this.sources.analyze(cmd.spaceId);
        return;
      case 'sources.clear':
        void this.sources.clear(cmd.spaceId);
        return;
      case 'sources.focus':
        void this.sources.focus(cmd.spaceId, cmd.kind, cmd.id);
        return;
      case 'window.new': {
        const free = this.freeSpace();
        if (free) {
          this.openWindow(free);
          return;
        }
        const current = this.active;
        const before = this.state.activeSpaceId;
        this.apply({ type: 'space.create' });
        const created = this.state.activeSpaceId;
        if (created === before) return;
        if (current) {
          current.spaceId = before;
          this.lastSignature = '';
          this.reconcileViews();
        }
        this.openWindow(created);
        return;
      }
      case 'space.openInWindow': {
        const shown = this.windowForSpace(cmd.id);
        if (shown) shown.win.focus();
        else if (this.state.spaces.some((sp) => sp.id === cmd.id)) this.openWindow(cmd.id);
        return;
      }
      case 'pageTabs.forget':
        this.apply({ type: 'settings.update', patch: { pageTabs: this.state.settings.pageTabs.filter((o) => o !== cmd.origin) } });
        return;
      case 'space.install':
        void installSpace(this, cmd.url);
        return;
      case 'space.modesMenu':
        modesMenu(this, cmd.id);
        return;
      case 'space.newProfile':
        void this.newProfile(cmd.id);
        return;
      case 'space.forgetProfile':
        void this.forgetProfile(cmd.id);
        return;
      case 'capture.pick':
        this.capture.pick(cmd.token, cmd.id);
        return;
      case 'capture.settings':
        this.capture.openPermissionSettings();
        return;
      case 'app.relaunch':
        this.store.flush();
        this.quitting = true;
        app.relaunch();
        app.quit();
        return;
      case 'prompt.answer': {
        const resolve = this.prompts.get(cmd.token);
        this.prompts.delete(cmd.token);
        resolve?.(cmd.text);
        return;
      }
      case 'curated.add':
        void this.curated.add(cmd.spaceId, cmd.input);
        return;
      case 'curated.remove':
        this.curated.remove(cmd.spaceId, cmd.id);
        return;
      case 'curated.refresh':
        void this.curated.refresh(cmd.spaceId);
        return;
      case 'curated.read':
        this.curated.markRead(cmd.spaceId, cmd.id);
        return;
      case 'curated.save':
        this.curated.toggleSaved(cmd.spaceId, cmd.id);
        return;
      case 'curated.open':
        this.curated.open(cmd.spaceId, cmd.id);
        return;
      case 'research.note':
        this.research.note(cmd.spaceId, cmd.text);
        return;
      case 'research.clip':
        void this.research.clip(cmd.spaceId, cmd.text, cmd.url, cmd.title);
        return;
      case 'research.remove':
        this.research.remove(cmd.spaceId, cmd.kind, cmd.id);
        return;
      case 'research.source':
        this.research.source(cmd.spaceId, cmd.url, cmd.title);
        return;
      case 'research.zotero':
        void this.research.zoteroSave(cmd.spaceId, cmd.tabId).then((r) => {
          if (!r.ok) dialog.showErrorBox('Zotero', r.error ?? 'could not save');
        });
        return;
      case 'ai.send':
        void this.ai.send(cmd.spaceId, cmd.text);
        return;
      case 'ai.stop':
        this.ai.stop(cmd.spaceId);
        return;
      case 'ai.clear':
        this.ai.clear(cmd.spaceId);
        return;
      case 'ai.setKey':
        this.ai.setKey(cmd.key);
        return;
      case 'ai.test':
        void this.ai.test();
        return;
      case 'space.passwordPrompt': {
        const sp = this.state.spaces.find((x) => x.id === cmd.id);
        if (!sp) return;
        if (cmd.purpose !== 'set' && !sp.lock) return;
        this.overlay?.show({ kind: 'show', mode: 'password', spaceId: sp.id, purpose: cmd.purpose, name: sp.name });
        return;
      }
      case 'space.password': {
        const sp = this.state.spaces.find((x) => x.id === cmd.id);
        if (!sp) return;
        if (cmd.purpose === 'set') {
          if (!cmd.password) return;
          this.apply({ type: 'space.setLock', id: sp.id, lock: makeLock(cmd.password) });
          this.overlay?.hide();
          return;
        }
        if (!sp.lock || !verifyLock(sp.lock, cmd.password)) {
          this.overlay?.send({ kind: 'password:error' });
          return;
        }
        if (cmd.purpose === 'remove') this.apply({ type: 'space.setLock', id: sp.id, lock: null });
        else {
          this.apply({ type: 'space.unlocked', id: sp.id });
          this.apply({ type: 'space.activate', id: sp.id });
        }
        this.overlay?.hide();
        return;
      }
      case 'history.remove':
        this.history.remove(cmd.id);
        return;
      case 'history.clear':
        this.history.clear();
        return;
    }
  }

  // ---- configuration files ----

  private async exportConfig(spaceId?: string): Promise<void> {
    if (!this.win) return;
    const now = Date.now();
    const space = spaceId ? this.state.spaces.find((sp) => sp.id === spaceId) : undefined;
    if (spaceId && !space) return;
    if (space?.lock) {
      dialog.showErrorBox('Private space', `“${space.name}” is private: private spaces are never exported.`);
      return;
    }
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

  /**
   * Keys Chord must own on every view, handled before the page and before the menu.
   * Ctrl+W closes the tab and never the window (Electron's close role defaults to Ctrl+W).
   */
  wireKeys(wc: WebContents): void {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const mod = isMac ? input.meta : input.control;
      if (!mod || input.alt || input.key.length !== 1) return;
      const key = input.key.toLowerCase();
      if (key === 'w' && !input.shift) {
        event.preventDefault();
        this.apply({ type: 'tab.closeActive' });
      }
    });
  }

  /** Auto picture-in-picture: a playing video follows the user to the next tab, and comes back when they return. */
  private autoPip(prev: State, next: State): void {
    if (!next.settings.autoPip) return;
    const before = focusedTab(prev)?.id;
    const after = focusedTab(next)?.id;
    if (before === after) return;
    const run = (id: TabId | undefined, mode: 'enter' | 'exit') => {
      if (!id) return;
      const info = this.smart.getStatus()[id]?.media;
      const wc = this.tabs.get(id)?.webContents;
      if (!wc || wc.isDestroyed()) return;
      if (mode === 'enter' && !(info?.playing && info.video)) return;
      void wc.executeJavaScript(PIP_JS(mode), true).catch(() => {});
    };
    run(before, 'enter');
    run(after, 'exit');
  }

  private readonly prompts = new Map<string, (text: string | null) => void>();

  /** Ask the user for a line of text through the overlay; null when dismissed. */
  prompt(title: string, placeholder = '', value = ''): Promise<string | null> {
    const token = randomUUID();
    return new Promise((resolve) => {
      this.prompts.set(token, resolve);
      this.overlay?.show({ kind: 'show', mode: 'prompt', token, title, placeholder, value });
    });
  }

  cancelPrompts(): void {
    for (const resolve of this.prompts.values()) resolve(null);
    this.prompts.clear();
  }

  private async newGroup(tabId: string): Promise<void> {
    const tab = this.state.tabs[tabId];
    if (!tab || !tab.spaceId) return;
    const name = await this.prompt('New subspace', 'Subspace name', tab.title.slice(0, 30));
    this.overlay?.hide();
    if (name && name.trim()) this.apply({ type: 'group.create', spaceId: tab.spaceId, name: name.trim(), tabIds: [tabId] });
  }

  private copyShareLink(spaceId: SpaceId): void {
    const sp = spaceById(this.state, spaceId);
    if (!sp?.shared) return;
    const url = this.sync.shareUrl(`spaces/${sp.shared.slug}/`);
    if (!url) return;
    clipboard.writeText(url);
    this.sendSidebar({ kind: 'toast', text: 'Share link copied', detail: `${url} · live in a minute or two` });
  }

  private async newLiveFolder(spaceId: SpaceId, kind: LiveKind, query?: string): Promise<void> {
    const meta = LIVE_KINDS[kind];
    let q = query ?? '';
    if (meta.needsQuery && !q) {
      const answer = await this.prompt(meta.label.replace(/…$/, ''), meta.hint);
      this.overlay?.hide();
      if (!answer || !answer.trim()) return;
      q = answer.trim();
    }
    const name = meta.needsQuery ? (kind === 'feed' ? hostOf(q) || 'Feed' : kind === 'bookmarks' ? `#${q.replace(/^#/, '')}` : q.slice(0, 40)) : meta.label.replace(/^GitHub: /, '').replace(/^\w/, (ch) => ch.toUpperCase());
    const id = randomUUID();
    this.apply({ type: 'group.create', spaceId, id, name, live: { kind, query: q } });
    void this.live.refresh(id);
  }

  private async renameGroup(id: string): Promise<void> {
    const group = this.state.spaces.flatMap((sp) => sp.groups ?? []).find((g) => g.id === id);
    if (!group) return;
    const name = await this.prompt('Rename subspace', 'Subspace name', group.name);
    this.overlay?.hide();
    if (name && name.trim()) this.apply({ type: 'group.rename', id, name: name.trim() });
  }

  private async newProfile(spaceId: string): Promise<void> {
    const sp = this.state.spaces.find((x) => x.id === spaceId);
    if (!sp) return;
    const name = await this.prompt(`Profile for “${sp.name}”`, 'Profile name, e.g. Work');
    this.overlay?.hide();
    if (name && name.trim()) this.apply({ type: 'space.profile', id: spaceId, profile: name.trim() });
  }

  private async forgetProfile(spaceId: string): Promise<void> {
    const sp = this.state.spaces.find((x) => x.id === spaceId);
    if (!sp || !this.win) return;
    const partition = partitionFor(sp.profile);
    const others = this.state.spaces.filter((x) => x.id !== sp.id && partitionFor(x.profile) === partition).map((x) => x.name);
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'warning',
      buttons: ['Forget', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Forget all data of the ${sp.profile ? `profile “${sp.profile}”` : 'shared session'}?`,
      detail: `Cookies, logins, storage and cache go away${others.length ? `, also for ${others.join(', ')}` : ''}. Open pages reload.`,
    });
    if (response !== 0) return;
    const ses = configureSession(partition);
    await ses.clearStorageData().catch(() => {});
    await ses.clearCache().catch(() => {});
    for (const [id, tab] of Object.entries(this.state.tabs)) {
      if (!tab.awake || partitionFor(spaceOfTab(this.state, tab).profile) !== partition) continue;
      this.tabs.get(id)?.webContents.reload();
    }
  }

  /** Show one of Chord's own pages: reuse it if the active space already has it open. */
  /**
   * The reader: a space's own page (its feeds only), or the Reader space, which is
   * created on first use and lists every feed with spaces as tags.
   */
  openReader(spaceId: SpaceId | null): void {
    if (spaceId) {
      const sp = spaceById(this.state, spaceId);
      if (!sp || sp.reader) return this.openReader(null);
      if (this.state.activeSpaceId !== spaceId) this.apply({ type: 'space.activate', id: spaceId });
      this.openInternal(`chord://reader/?space=${encodeURIComponent(spaceId)}`);
      return;
    }
    let readerSpace = this.state.spaces.find((sp) => sp.reader);
    if (!readerSpace) {
      this.apply({ type: 'space.create', name: 'Reader', icon: '📰' });
      readerSpace = activeSpace(this.state);
      this.apply({ type: 'space.update', id: readerSpace.id, patch: { reader: true } });
    }
    if (this.state.activeSpaceId !== readerSpace.id) this.apply({ type: 'space.activate', id: readerSpace.id });
    this.openInternal('chord://reader/');
    // the page lives pinned and always loaded in that space
    const space = activeSpace(this.state);
    const tab = [...space.pinned, ...space.today].map((id) => this.state.tabs[id]).find((t) => t && t.url.startsWith('chord://reader/'));
    if (tab) {
      if (tab.kind === 'today') this.apply({ type: 'tab.pin', id: tab.id });
      if (!tab.keepLoaded) this.apply({ type: 'tab.keepLoaded', id: tab.id, on: true });
    }
  }

  /** What an integrated page may know about its surroundings: the space and the look. */
  themeFor(tabId: TabId): { space: { id: string; name: string; color: string; icon: string }; accent: string; dark: boolean; font: string } {
    const tab = this.state.tabs[tabId];
    const space = (tab?.spaceId && spaceById(this.state, tab.spaceId)) || activeSpace(this.state);
    const t = this.state.settings.theme;
    const dark = t.mode === 'dark' || (t.mode === 'system' && nativeTheme.shouldUseDarkColors);
    return { space: { id: space.id, name: space.name, color: space.color, icon: space.icon ?? '' }, accent: t.accent ?? space.color, dark, font: t.font };
  }

  /** Tell the pages that integrate with Chord (boosted or granted) that the look changed. */
  pushTheme(): void {
    for (const id of this.boosts.boostedTabs()) {
      const wc = this.tabs.get(id)?.webContents;
      if (wc && !wc.isDestroyed()) wc.send('smart:action', `theme:${JSON.stringify(this.themeFor(id))}`);
    }
  }

  /** A space's own notes or bookmarks page (null: the global page listing every space). */
  openSpacePage(page: 'notes' | 'bookmarks', spaceId: SpaceId | null): void {
    const sp = spaceId ? spaceById(this.state, spaceId) : undefined;
    if (sp && !sp.reader) {
      if (this.state.activeSpaceId !== sp.id) this.apply({ type: 'space.activate', id: sp.id });
      this.openInternal(`chord://${page}/?space=${encodeURIComponent(sp.id)}`);
    } else this.openInternal(`chord://${page}/?space=all`);
  }

  openInternal(url: string, hash?: string): void {
    const space = activeSpace(this.state);
    const base = url.split('#')[0];
    const target = hash ? `${base}#${hash}` : url;
    const existing = [...space.pinned, ...space.today].map((id) => this.state.tabs[id]).find((t) => t && t.url.split('#')[0] === base);
    if (existing) {
      this.apply({ type: 'tab.activate', id: existing.id });
      if (hash && existing.url !== target) this.navigate(existing.id, target);
    } else this.apply({ type: 'tab.new', url: target });
  }

  appInfo(): AppInfo {
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
      platform: `${process.platform} ${process.getSystemVersion()}`,
      arch: process.arch,
      userData: app.getPath('userData'),
    };
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
function viewSignature(s: State, windows: Map<number, ChordWindow>): string {
  const awake: string[] = [];
  for (const t of Object.values(s.tabs)) if (t.awake) awake.push(t.id + (t.muted ? '!' : ''));
  const perWindow: string[] = [];
  for (const w of windows.values()) {
    if (!w.alive()) continue;
    const space = w.space;
    perWindow.push([w.id, space.id, visiblePanes(space).join(','), isLocked(space), panelVisibleFor(s, space) ? s.settings.panelWidth : 0, space.tiling ?? '', space.focused ?? ''].join(':'));
  }
  return [s.activeSpaceId, s.spaces.map((sp) => sp.profile ?? '').join(','), perWindow.join('#'), s.settings.sidebarOpen, s.settings.sidebarWidth, awake.sort().join(',')].join('|');
}

function isMessage(m: unknown): m is Message {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}
