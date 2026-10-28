import { WebContentsView, type WebContents } from 'electron';
import type { LittleStatus, Message, TabId } from '../shared/types.ts';
import { computeLayout } from '../shared/layout.ts';
import { configureSession } from './session.ts';
import { PAGE_PRELOAD, PRELOAD } from './paths.ts';
import { isMac } from './platform.ts';
import type { Controller } from './controller.ts';
import type { ChordWindow } from './window.ts';

const BAR = 40;
const MARGIN = 28;
const MAX_WIDTH = 1180;

interface Peek {
  w: ChordWindow;
  backdrop: WebContentsView;
  bar: WebContentsView;
  view: WebContentsView;
  fromTab: TabId;
}

/**
 * Peek: a link that leaves the site of a pinned or favorite tab opens in a
 * floating preview over the page instead of taking the tab away. The preview
 * has a thin bar (back, forward, title, "Open as Tab") and a dimmed backdrop
 * that closes it on click; Esc closes it too, ⌘⇧O turns it into a tab.
 */
export class PeekManager {
  private readonly c: Controller;
  private current: Peek | null = null;

  constructor(c: Controller) {
    this.c = c;
  }

  owns(wc: WebContents): boolean {
    const p = this.current;
    return !!p && (p.bar.webContents === wc || p.backdrop.webContents === wc || p.view.webContents === wc);
  }

  isOpen(): boolean {
    return this.current !== null;
  }

  /** The page view, for things that act on "the current page" while a peek is up. */
  pageContents(): WebContents | null {
    return this.current?.view.webContents ?? null;
  }

  open(url: string, fromTab: TabId): void {
    const w = this.c.tabs.windowOfView(fromTab) ?? this.c.active;
    if (!w || !w.alive()) return;
    if (this.current && this.current.w === w) {
      this.current.fromTab = fromTab;
      void this.current.view.webContents.loadURL(url);
      this.raise();
      return;
    }
    this.close();
    configureSession();
    const chrome = { preload: PRELOAD, sandbox: true, contextIsolation: true };
    const backdrop = new WebContentsView({ webPreferences: { ...chrome, transparent: true } });
    const bar = new WebContentsView({ webPreferences: chrome });
    const view = new WebContentsView({ webPreferences: { preload: PAGE_PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    backdrop.setBackgroundColor('#00000000');
    const peek: Peek = { w, backdrop, bar, view, fromTab };
    this.current = peek;
    for (const v of [backdrop, bar, view]) w.win.contentView.addChildView(v);
    this.layout();
    w.overlay.raise();
    void backdrop.webContents.loadURL('chord://peek/#backdrop');
    void bar.webContents.loadURL('chord://peek/');
    const wc = view.webContents;
    const send = () => {
      if (this.current !== peek || bar.webContents.isDestroyed()) return;
      const status: LittleStatus = { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() };
      bar.webContents.send('peek', status);
    };
    wc.on('did-navigate', send);
    wc.on('did-navigate-in-page', send);
    wc.on('page-title-updated', send);
    wc.on('did-start-loading', send);
    wc.on('did-stop-loading', send);
    bar.webContents.on('did-finish-load', send);
    wc.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target)) void wc.loadURL(target);
      return { action: 'deny' };
    });
    wc.on('context-menu', (e) => e.preventDefault());
    const keys = (event: Electron.Event, input: Electron.Input) => {
      if (input.type !== 'keyDown') return;
      const mod = isMac ? input.meta : input.control;
      if (input.key === 'Escape' || (mod && !input.shift && input.key.toLowerCase() === 'w')) {
        event.preventDefault();
        this.close();
      } else if (mod && input.shift && input.key.toLowerCase() === 'o') {
        event.preventDefault();
        this.toTab();
      }
    };
    wc.on('before-input-event', keys);
    bar.webContents.on('before-input-event', keys);
    backdrop.webContents.on('before-input-event', keys);
    for (const v of [bar, backdrop]) v.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    void wc.loadURL(url);
    wc.focus();
  }

  close(): void {
    const p = this.current;
    if (!p) return;
    this.current = null;
    if (p.w.alive()) for (const v of [p.view, p.bar, p.backdrop]) p.w.win.contentView.removeChildView(v);
    for (const v of [p.view, p.bar, p.backdrop]) if (!v.webContents.isDestroyed()) v.webContents.close();
    if (p.w.alive()) this.c.tabs.focusedViewIn(p.w)?.webContents.focus();
  }

  /** Turn the preview into a tab next to the one it came from, and close it. */
  toTab(): void {
    const p = this.current;
    if (!p) return;
    const url = p.view.webContents.getURL();
    const from = this.c.state.tabs[p.fromTab];
    this.close();
    if (/^https?:/i.test(url)) this.c.apply({ type: 'tab.new', url, spaceId: from?.spaceId ?? undefined, activate: true });
  }

  /** Keep the preview above tab views added after it. */
  raise(): void {
    const p = this.current;
    if (!p || !p.w.alive()) return;
    for (const v of [p.backdrop, p.bar, p.view]) {
      p.w.win.contentView.removeChildView(v);
      p.w.win.contentView.addChildView(v);
    }
    p.w.overlay.raise();
  }

  layout(): void {
    const p = this.current;
    if (!p || !p.w.alive()) return;
    const { width, height } = p.w.win.getContentBounds();
    const { settings } = this.c.state;
    const { content } = computeLayout({ width, height, sidebarOpen: this.c.sidebarVisible(), sidebarWidth: settings.sidebarWidth, panes: 1, topInset: this.c.topInset(), panelWidth: p.w.panel.width() });
    p.backdrop.setBounds(content);
    const cw = Math.max(320, Math.min(MAX_WIDTH, content.width - MARGIN * 2));
    const ch = Math.max(240, content.height - MARGIN * 2);
    const x = content.x + Math.round((content.width - cw) / 2);
    const y = content.y + MARGIN;
    p.bar.setBounds({ x, y, width: cw, height: BAR });
    p.view.setBounds({ x, y: y + BAR, width: cw, height: ch - BAR });
  }

  /** A command from the bar or the backdrop. */
  command(sender: WebContents, m: Message): void {
    const p = this.current;
    if (!p) return;
    const wc = p.view.webContents;
    if (m.type === 'peek.nav') {
      if (m.action === 'back') wc.navigationHistory.goBack();
      else if (m.action === 'forward') wc.navigationHistory.goForward();
      else if (m.action === 'reload') wc.reload();
      else if (m.action === 'open') this.toTab();
      else if (m.action === 'little') {
        const url = wc.getURL();
        this.close();
        if (/^https?:/i.test(url)) this.c.little.open(url);
      } else if (m.action === 'close') this.close();
      return;
    }
    if (sender === p.view.webContents) return;
    this.c.dispatch(m);
  }
}
