import { app, BrowserWindow, clipboard, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Action, Command, Message, SidebarMessage, State, TabId } from '../shared/types.ts';
import { isCommand } from '../shared/types.ts';
import { activeSpace, focusedTab, hydrate, reduce, type Ctx } from '../shared/model.ts';
import { titleFor } from '../shared/url.ts';
import { Store } from './store.ts';
import { TabManager } from './tabs.ts';
import { Overlay } from './overlay.ts';
import { setShields } from './session.ts';
import { buildAppMenu, spaceContextMenu, tabContextMenu } from './menu.ts';
import { PRELOAD, RENDERER_DIR } from './paths.ts';

const isMac = process.platform === 'darwin';
const CHROME_BG = '#1b1b22';

export class Controller {
  state!: State;
  win: BrowserWindow | null = null;
  readonly store: Store<State>;
  readonly tabs = new TabManager(this);
  readonly overlay = new Overlay(this);

  private applying = false;
  private queue: Action[] = [];
  private broadcastPending = false;
  private menuKey = '';

  constructor() {
    this.store = new Store<State>(join(app.getPath('userData'), 'state.json'));
  }

  ctx(): Ctx {
    return { now: Date.now(), newId: randomUUID };
  }

  init(): void {
    this.state = hydrate(this.store.load(), this.ctx());
    setInterval(() => this.apply({ type: 'tick' }), 60_000).unref();

    ipcMain.handle('dispatch', (event, message: unknown) => {
      if (!this.trusted(event) || !isMessage(message)) return;
      this.dispatch(message);
    });
    ipcMain.handle('state', (event) => (this.trusted(event) ? this.state : null));

    void setShields(this.state.settings.shields);
    this.refreshMenu();
  }

  private trusted(event: IpcMainInvokeEvent): boolean {
    return event.sender === this.win?.webContents || event.sender === this.overlay.webContents;
  }

  createWindow(): void {
    if (this.win) return;
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 640,
      minHeight: 420,
      show: false,
      backgroundColor: CHROME_BG,
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      trafficLightPosition: { x: 14, y: 15 },
      titleBarOverlay: isMac ? undefined : { color: CHROME_BG, symbolColor: '#dddde3', height: 40 },
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
    const relayout = () => {
      this.tabs.layout();
      this.overlay.layout();
    };
    win.on('resize', relayout);
    win.on('enter-full-screen', relayout);
    win.on('leave-full-screen', relayout);
    win.on('closed', () => {
      this.win = null;
      this.tabs.reset();
      this.overlay.dispose();
      this.store.flush();
    });
  }

  focusWindow(): void {
    if (!this.win) this.createWindow();
    else {
      if (this.win.isMinimized()) this.win.restore();
      this.win.focus();
    }
  }

  openUrl(url: string): void {
    this.focusWindow();
    this.apply({ type: 'tab.new', url, activate: true });
  }

  flush(): void {
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
    this.tabs.reconcile(next);
    if (this.overlay.isShown()) this.overlay.layout();
    this.store.save(next);
    this.broadcast();
    if (prev.settings.shields !== next.settings.shields) void setShields(next.settings.shields);
    this.refreshMenu();
  }

  private refreshMenu(): void {
    const key = this.state.spaces.map((sp) => `${sp.id}:${sp.icon ?? ''}${sp.name}`).join('|');
    if (key === this.menuKey) return;
    this.menuKey = key;
    buildAppMenu(this);
  }

  broadcast(): void {
    if (this.broadcastPending) return;
    this.broadcastPending = true;
    setImmediate(() => {
      this.broadcastPending = false;
      const targets = [this.win?.webContents, this.overlay.webContents];
      for (const wc of targets) if (wc && !wc.isDestroyed()) wc.send('state', this.state);
    });
  }

  sendSidebar(message: SidebarMessage): void {
    this.win?.webContents.send('sidebar', message);
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
    }
  }

  private navigate(id: TabId, url: string): void {
    const tab = this.state.tabs[id];
    if (!tab) return;
    const live = tab.awake ? this.tabs.get(id) : undefined;
    this.apply({ type: 'tab.patch', id, patch: { url, title: titleFor(url), awake: true, favicon: undefined } });
    if (live) live.webContents.loadURL(url).catch(() => {});
    this.apply({ type: 'tab.activate', id });
  }
}

function isMessage(m: unknown): m is Message {
  return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';
}
