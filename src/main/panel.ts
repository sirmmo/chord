import { WebContentsView, type WebContents } from 'electron';
import { computeLayout } from '../shared/layout.ts';
import { panelVisible } from '../shared/model.ts';
import type { Controller } from './controller.ts';
import { PRELOAD } from './paths.ts';
import { PARTITION } from './session.ts';

/** The side panel on the right: one chrome page (chord://panel/) that hosts the active space's mode views. */
export class PanelManager {
  private readonly c: Controller;
  private view: WebContentsView | null = null;
  private attached = false;

  constructor(c: Controller) {
    this.c = c;
  }

  get webContents(): WebContents | undefined {
    return this.view?.webContents;
  }

  /** Width the layout must reserve, 0 when the panel is hidden. */
  width(): number {
    return panelVisible(this.c.state) ? this.c.state.settings.panelWidth : 0;
  }

  private ensure(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView({ webPreferences: { partition: PARTITION, preload: PRELOAD, sandbox: true, contextIsolation: true } });
    view.setBorderRadius(10);
    view.setBackgroundColor('#00000000');
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.c.apply({ type: 'tab.new', url });
      return { action: 'deny' };
    });
    this.c.wireKeys(view.webContents);
    view.webContents.loadURL('chord://panel/').catch(() => {});
    this.view = view;
    return view;
  }

  sync(): void {
    const win = this.c.win;
    if (!win || win.isDestroyed()) return;
    const show = this.width() > 0;
    if (show) {
      const view = this.ensure();
      if (!this.attached) {
        win.contentView.addChildView(view);
        this.attached = true;
      }
      view.setVisible(true);
      this.layout();
      this.c.overlay.raise();
    } else if (this.view && this.attached) {
      this.view.setVisible(false);
    }
  }

  layout(): void {
    const win = this.c.win;
    if (!this.view || !win || win.isDestroyed() || this.width() === 0) return;
    const { width, height } = win.getContentBounds();
    const { settings } = this.c.state;
    const { panel } = computeLayout({ width, height, sidebarOpen: this.c.sidebarVisible(), sidebarWidth: settings.sidebarWidth, panes: 1, topInset: this.c.topInset(), panelWidth: this.width() });
    if (panel) this.view.setBounds(panel);
  }

  dispose(): void {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    this.attached = false;
  }
}
