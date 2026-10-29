import { BrowserWindow, WebContentsView, type WebContents } from 'electron';
import { join } from 'node:path';
import type { LittleStatus, Message } from '../shared/types.ts';
import { configureSession } from './session.ts';
import { PAGE_PRELOAD, PRELOAD, RENDERER_DIR } from './paths.ts';
import { isMac } from './platform.ts';
import type { Controller } from './controller.ts';
import { spaceForUrl } from '../shared/routes.ts';

const BAR = 44;

interface Little {
  win: BrowserWindow;
  view: WebContentsView;
}

/**
 * Little windows: a page in a small window of its own, with a thin bar — back,
 * forward, the title, "Open in Chord" — instead of a tab in a space. Links
 * that arrive from other apps open this way (Settings → Tabs & windows), and any page
 * can be sent to one from the command bar. "Open in Chord" moves the page into
 * the active space and closes the little window.
 */
export class LittleWindows {
  private readonly c: Controller;
  private readonly all = new Map<number, Little>();

  constructor(c: Controller) {
    this.c = c;
  }

  owns(wc: WebContents): boolean {
    for (const l of this.all.values()) if (l.win.webContents === wc || l.view.webContents === wc) return true;
    return false;
  }

  count(): number {
    return this.all.size;
  }

  open(url: string): void {
    const parent = this.c.win;
    const pb = parent?.getBounds();
    const width = Math.min(1000, Math.max(640, Math.round((pb?.width ?? 1280) * 0.72)));
    const height = Math.min(760, Math.max(480, Math.round((pb?.height ?? 820) * 0.78)));
    const win = new BrowserWindow({
      width,
      height,
      x: pb ? Math.round(pb.x + (pb.width - width) / 2) : undefined,
      y: pb ? Math.round(pb.y + (pb.height - height) / 2) : undefined,
      minWidth: 420,
      minHeight: 320,
      show: false,
      title: 'Little Chord',
      backgroundColor: this.c.chromeColor(),
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      trafficLightPosition: { x: 14, y: 14 },
      titleBarOverlay: isMac ? undefined : this.c.titleBarOverlay(),
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    void win.loadFile(join(RENDERER_DIR, 'little.html'));
    configureSession();
    const view = new WebContentsView({ webPreferences: { preload: PAGE_PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const little: Little = { win, view };
    this.all.set(win.id, little);
    win.contentView.addChildView(view);
    const layout = () => {
      const { width: w, height: h } = win.getContentBounds();
      view.setBounds({ x: 0, y: BAR, width: w, height: Math.max(0, h - BAR) });
    };
    layout();
    win.on('resize', layout);
    const wc = view.webContents;
    const send = () => {
      if (win.isDestroyed()) return;
      const status: LittleStatus = { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() };
      win.webContents.send('little', status);
      win.setTitle(wc.getTitle() || 'Little Chord');
    };
    wc.on('did-navigate', send);
    wc.on('did-navigate-in-page', send);
    wc.on('page-title-updated', send);
    wc.on('did-start-loading', send);
    wc.on('did-stop-loading', send);
    win.webContents.on('did-finish-load', send);
    wc.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target)) this.open(target);
      return { action: 'deny' };
    });
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const mod = isMac ? input.meta : input.control;
      if (input.key === 'Escape' || (mod && !input.shift && input.key.toLowerCase() === 'w')) {
        event.preventDefault();
        win.close();
      } else if (mod && input.shift && input.key.toLowerCase() === 'o') {
        event.preventDefault();
        this.toChord(win.id);
      }
    });
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        win.close();
      }
    });
    win.once('ready-to-show', () => {
      win.show();
      wc.focus();
    });
    win.on('closed', () => {
      this.all.delete(win.id);
      if (!wc.isDestroyed()) wc.close();
    });
    void wc.loadURL(url);
  }

  /** A command from a little window's bar. */
  command(sender: WebContents, m: Message): void {
    const entry = [...this.all.entries()].find(([, l]) => l.win.webContents === sender || l.view.webContents === sender);
    if (!entry) return;
    const [id, l] = entry;
    const wc = l.view.webContents;
    if (m.type === 'little.nav') {
      if (m.action === 'back') wc.navigationHistory.goBack();
      else if (m.action === 'forward') wc.navigationHistory.goForward();
      else if (m.action === 'reload') wc.reload();
      else if (m.action === 'open') this.toChord(id);
      else if (m.action === 'close') l.win.close();
      return;
    }
    // anything else (open a URL, settings…) acts on the main window
    this.c.dispatch(m);
  }

  /** Move the page into the active space as a tab and close the little window. */
  toChord(id: number): void {
    const l = this.all.get(id);
    if (!l) return;
    const url = l.view.webContents.getURL();
    if (/^https?:/i.test(url)) this.c.apply({ type: 'tab.new', url, spaceId: spaceForUrl(this.c.state.settings.routes, this.c.state.spaces, url), activate: true });
    this.c.focusWindow();
    l.win.close();
  }

  closeAll(): void {
    for (const l of this.all.values()) l.win.close();
  }
}
