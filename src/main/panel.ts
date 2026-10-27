import { WebContentsView, type WebContents } from 'electron';
import { computeLayout } from '../shared/layout.ts';
import { panelVisibleFor } from '../shared/model.ts';
import type { Controller } from './controller.ts';
import type { ChordWindow } from './window.ts';
import { PRELOAD } from './paths.ts';
import { PARTITION } from './session.ts';

/** The side panel on the right of one window: a chrome page (chord://panel/) hosting the window's space's mode views. */
export class PanelManager {
  private readonly c: Controller;
  private readonly w: ChordWindow;
  private view: WebContentsView | null = null;
  private attached = false;

  constructor(c: Controller, w: ChordWindow) {
    this.c = c;
    this.w = w;
  }

  get webContents(): WebContents | undefined {
    return this.view?.webContents;
  }

  /** Width the layout must reserve, 0 when the panel is hidden. */
  width(): number {
    return panelVisibleFor(this.c.state, this.w.space) ? this.c.state.settings.panelWidth : 0;
  }

  private ensure(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView({ webPreferences: { partition: PARTITION, preload: PRELOAD, sandbox: true, contextIsolation: true } });
    view.setBorderRadius(10);
    view.setBackgroundColor('#00000000');
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.c.apply({ type: 'tab.new', url, spaceId: this.w.spaceId });
      return { action: 'deny' };
    });
    this.c.wireKeys(view.webContents);
    view.webContents.loadURL('chord://panel/').catch(() => {});
    this.view = view;
    return view;
  }

  sync(): void {
    if (!this.w.alive()) return;
    const show = this.width() > 0;
    if (show) {
      const view = this.ensure();
      if (!this.attached) {
        this.w.win.contentView.addChildView(view);
        this.attached = true;
      }
      view.setVisible(true);
      this.layout();
      this.w.overlay.raise();
    } else if (this.view && this.attached) {
      this.view.setVisible(false);
    }
  }

  layout(): void {
    if (!this.view || !this.w.alive() || this.width() === 0) return;
    const { width, height } = this.w.win.getContentBounds();
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
