import { WebContentsView } from 'electron';
import { join } from 'node:path';
import type { OverlayMessage } from '../shared/types.ts';
import { computeLayout } from '../shared/layout.ts';
import type { Controller } from './controller.ts';
import { PRELOAD, RENDERER_DIR } from './paths.ts';

type ShowMessage = Extract<OverlayMessage, { kind: 'show' }>;

/**
 * A transparent web view layered above the tabs. It hosts the command bar and
 * the find bar, which could not be drawn by the sidebar page because native
 * child views always paint above the window's own page.
 */
export class Overlay {
  private view: WebContentsView | null = null;
  private ready = false;
  private queue: OverlayMessage[] = [];
  private attached = false;
  mode: 'palette' | 'find' | 'password' | null = null;

  private readonly c: Controller;

  constructor(c: Controller) {
    this.c = c;
  }

  get webContents() {
    return this.view?.webContents;
  }

  isShown(): boolean {
    return this.mode !== null;
  }

  private ensure(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView({
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, transparent: true },
    });
    view.setBackgroundColor('#00000000');
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.c.wireKeys(view.webContents);
    view.webContents.on('did-finish-load', () => {
      this.ready = true;
      for (const m of this.queue.splice(0)) this.send(m);
      this.c.broadcast();
    });
    view.webContents.loadFile(join(RENDERER_DIR, 'palette.html'));
    this.view = view;
    return view;
  }

  show(message: ShowMessage): void {
    const win = this.c.win;
    if (!win) return;
    const view = this.ensure();
    this.mode = message.mode;
    this.layout();
    this.raise();
    view.setVisible(true);
    this.send(message);
    view.webContents.focus();
  }

  hide(): void {
    if (!this.view || !this.mode) return;
    this.mode = null;
    this.send({ kind: 'hide' });
    this.view.setVisible(false);
    if (this.attached && this.c.win) {
      this.c.win.contentView.removeChildView(this.view);
      this.attached = false;
    }
    this.c.tabs.focusedView()?.webContents.focus();
  }

  /** Keep the overlay above tab views that were added after it. */
  raise(): void {
    const win = this.c.win;
    if (!this.view || !this.mode || !win) return;
    if (this.attached) win.contentView.removeChildView(this.view);
    win.contentView.addChildView(this.view);
    this.attached = true;
  }

  layout(): void {
    const win = this.c.win;
    if (!this.view || !this.mode || !win) return;
    const { width, height } = win.getContentBounds();
    const { settings } = this.c.state;
    const { content } = computeLayout({ width, height, sidebarOpen: this.c.sidebarVisible(), sidebarWidth: settings.sidebarWidth, panes: 1, topInset: this.c.topInset() });
    if (this.mode === 'palette' || this.mode === 'password') {
      this.view.setBounds(content);
    } else {
      const w = Math.min(360, content.width);
      this.view.setBounds({ x: content.x + content.width - w - 12, y: content.y + 10, width: w, height: 48 });
    }
  }

  send(message: OverlayMessage): void {
    if (!this.view) return;
    if (!this.ready) {
      this.queue.push(message);
      return;
    }
    this.view.webContents.send('overlay', message);
  }

  dispose(): void {
    this.mode = null;
    this.attached = false;
    this.ready = false;
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
  }
}
