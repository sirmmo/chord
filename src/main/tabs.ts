import { WebContentsView, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { State, Tab, TabId } from '../shared/types.ts';
import { activeSpace, isLocked, spaceOfTab, visiblePanes } from '../shared/model.ts';
import { computeLayout } from '../shared/layout.ts';
import { parseTiling } from '../shared/tiling.ts';
import { PARTITION } from './session.ts';
import { PAGE_PRELOAD, PRELOAD } from './paths.ts';
import { externalScheme, isInternal } from '../shared/url.ts';
import { installUrlFrom } from '../shared/installer.ts';
import { openExternalLink } from './external.ts';
import { pageContextMenu } from './menu.ts';
import type { Controller } from './controller.ts';
import { navDomReady, navFinished, navStarted } from './diagnostics.ts';

const CONTENT_RADIUS = 10;

/**
 * Owns one WebContentsView per awake tab and keeps them in sync with the
 * state: reconcile() creates, destroys, shows, hides and lays out views so
 * that reality matches whatever the reducer decided.
 */
export class TabManager {
  readonly views = new Map<TabId, WebContentsView>();
  fullscreenTab: TabId | null = null;
  private lastFocused: TabId | null = null;

  private readonly c: Controller;

  constructor(c: Controller) {
    this.c = c;
  }

  get(id: TabId): WebContentsView | undefined {
    return this.views.get(id);
  }

  /** Views currently showing one of Chord's own pages; they receive state like the sidebar does. */
  internalWebContents(): WebContents[] {
    const out: WebContents[] = [];
    for (const view of this.views.values()) {
      const wc = view.webContents;
      if (!wc.isDestroyed() && isInternal(wc.getURL())) out.push(wc);
    }
    return out;
  }

  /** The tab whose page view owns this WebContents, if it is one of ours. */
  tabIdOf(wc: WebContents): TabId | undefined {
    for (const [id, view] of this.views) if (view.webContents === wc) return id;
    return undefined;
  }

  focusedView(): WebContentsView | undefined {
    const sp = activeSpace(this.c.state);
    if (isLocked(sp)) return undefined;
    return sp.focused ? this.views.get(sp.focused) : undefined;
  }

  reset(): void {
    for (const id of [...this.views.keys()]) this.destroy(id);
    this.lastFocused = null;
    this.fullscreenTab = null;
  }

  reconcile(state: State): void {
    const win = this.c.win;
    if (!win || win.isDestroyed()) return;

    for (const [id] of [...this.views]) {
      const tab = state.tabs[id];
      if (!tab || !tab.awake) this.destroy(id);
    }
    for (const tab of Object.values(state.tabs)) {
      if (tab.awake && !this.views.has(tab.id)) {
        const view = this.create(tab.id, undefined, tab.url);
        view.webContents.loadURL(tab.url).catch(() => {});
      }
    }
    for (const [id, view] of this.views) {
      const muted = Boolean(state.tabs[id]?.muted);
      if (view.webContents.isAudioMuted() !== muted) view.webContents.setAudioMuted(muted);
    }

    const space = activeSpace(state);
    const visible = visiblePanes(space).filter((id) => this.views.has(id));
    for (const [id, view] of this.views) view.setVisible(visible.includes(id));
    this.layout(state);

    const focus = space.focused && visible.includes(space.focused) ? space.focused : null;
    if (focus && focus !== this.lastFocused && !this.c.overlay.isShown()) this.views.get(focus)!.webContents.focus();
    this.lastFocused = focus;
  }

  layout(state: State = this.c.state): void {
    const win = this.c.win;
    if (!win || win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();

    if (this.fullscreenTab && this.views.has(this.fullscreenTab)) {
      const { panes } = computeLayout({ width, height, sidebarOpen: false, sidebarWidth: 0, panes: 1, fullscreen: true });
      for (const [id, view] of this.views) {
        const isFull = id === this.fullscreenTab;
        view.setVisible(isFull);
        if (isFull) view.setBounds(panes[0]);
      }
      return;
    }

    const space = activeSpace(state);
    const visible = visiblePanes(space).filter((id) => this.views.has(id));
    const { panes } = computeLayout({
      width,
      height,
      sidebarOpen: this.c.sidebarVisible(),
      sidebarWidth: state.settings.sidebarWidth,
      panes: visible.length,
      topInset: this.c.topInset(),
      tiling: space.tiling ? parseTiling(space.tiling) : null,
    });
    visible.forEach((id, k) => this.views.get(id)!.setBounds(panes[k]));
  }

  create(id: TabId, existing?: WebContentsView, url = ''): WebContentsView {
    const win = this.c.win!;
    const view =
      existing ??
      new WebContentsView({
        webPreferences: {
          partition: PARTITION,
          // Chord's own pages get the chrome API; web pages only the media bridge.
          preload: isInternal(url) ? PRELOAD : PAGE_PRELOAD,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          spellcheck: true,
          scrollBounce: true,
        },
      });
    view.setBorderRadius(CONTENT_RADIUS);
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    this.views.set(id, view);
    win.contentView.addChildView(view);
    this.c.overlay.raise();
    this.wire(id, view.webContents);
    this.c.wireKeys(view.webContents);
    return view;
  }

  destroy(id: TabId): void {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    this.c.smart.clear(id);
    if (this.fullscreenTab === id) this.fullscreenTab = null;
    if (this.lastFocused === id) this.lastFocused = null;
    const win = this.c.win;
    if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  private wire(id: TabId, wc: WebContents): void {
    const patch = (p: Partial<Tab>) => this.c.apply({ type: 'tab.patch', id, patch: p });
    const navState = () => ({
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });

    wc.on('page-title-updated', (_e, title) => {
      patch({ title });
      this.c.smart.title(id, title);
      this.c.history.title(wc.getURL(), title);
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      if (favicons[0]) patch({ favicon: favicons[0] });
    });
    wc.on('did-navigate', (_e, url) => {
      patch({ url, favicon: undefined, ...navState() });
      const owner = this.c.state.tabs[id];
      if (!owner || !spaceOfTab(this.c.state, owner).lock) this.c.history.record(url, wc.getTitle());
      this.c.passwords.navigated(id);
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) {
        patch({ url, ...navState() });
        this.c.passwords.navigated(id);
      }
    });
    wc.on('did-start-loading', () => patch({ loading: true }));
    wc.on('did-stop-loading', () => {
      navFinished(id);
      patch({ loading: false, ...navState() });
    });
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        navStarted(id, details.url);
        this.c.smart.clear(id);
        this.c.boosts.reset(id);
      }
    });
    wc.on('dom-ready', () => {
      navDomReady(id);
      void this.c.boosts.apply(id, wc);
    });
    wc.on('audio-state-changed', (e) => patch({ audible: e.audible }));
    wc.on('focus', () => this.c.apply({ type: 'pane.focus', id }));
    wc.on('input-event', (_e, input) => {
      if (this.c.peeking && (input.type === 'mouseDown' || input.type === 'mouseMove')) this.c.dispatch({ type: 'sidebar.peek', on: false });
    });
    wc.on('enter-html-full-screen', () => {
      this.fullscreenTab = id;
      this.layout();
    });
    wc.on('leave-html-full-screen', () => {
      if (this.fullscreenTab === id) this.fullscreenTab = null;
      this.layout();
    });
    wc.on('found-in-page', (_e, result) => {
      this.c.overlay.send({ kind: 'find:result', active: result.activeMatchOrdinal, matches: result.matches });
    });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      patch({ crashed: true });
      this.c.apply({ type: 'tab.sleep', id });
    });
    wc.on('destroyed', () => {
      this.c.smart.clear(id);
      if (!this.views.has(id)) return; // we closed it ourselves
      this.views.delete(id);
      if (this.c.state.tabs[id]?.awake) this.c.apply({ type: 'tab.sleep', id });
    });
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.showError(wc, code, description, url);
    });
    wc.on('will-navigate', (e, url) => {
      // Web pages may not navigate into Chord's own pages; the user does that from the chrome.
      // The one exception is an "Add to Chord" link: chord://install/?url=<manifest>.
      if (isInternal(url) && !isInternal(wc.getURL())) {
        e.preventDefault();
        const manifest = installUrlFrom(url);
        if (manifest) this.c.dispatch({ type: 'space.install', url: manifest });
        return;
      }
      if (externalScheme(url)) {
        e.preventDefault();
        void openExternalLink(wc, url);
      }
    });
    wc.on('context-menu', (_e, params) => pageContextMenu(this.c, id, wc, params));

    wc.setWindowOpenHandler((details) => {
      const url = details.url;
      if (externalScheme(url)) {
        void openExternalLink(wc, url);
        return { action: 'deny' };
      }
      const manifest = installUrlFrom(url);
      if (manifest) {
        this.c.dispatch({ type: 'space.install', url: manifest });
        return { action: 'deny' };
      }
      if (isInternal(url)) return { action: 'deny' };
      const background = details.disposition === 'background-tab';
      const opener = this.c.state.tabs[id];
      return {
        action: 'allow',
        outlivesOpener: true,
        createWindow: (options) => {
          // Keep the opener relationship (needed by OAuth style popups) but show it as a tab.
          const view = new WebContentsView({ webPreferences: options.webPreferences });
          const newId = randomUUID();
          this.create(newId, view);
          this.c.apply({
            type: 'tab.new',
            id: newId,
            url,
            spaceId: opener?.spaceId ?? this.c.state.activeSpaceId,
            activate: !background,
            adopt: true,
          });
          return view.webContents;
        },
      };
    });
  }

  private showError(wc: WebContents, code: number, description: string, url: string): void {
    const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
    const html = `<!doctype html><meta charset="utf-8"><title>Cannot open page</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;color:#333;background:#fafafa;margin:0;display:grid;place-items:center;height:100vh}
main{max-width:460px;text-align:center;padding:24px}h1{font-size:20px;margin:0 0 8px}code{color:#888;font-size:13px}</style>
<main><h1>Chord can’t open this page</h1><p>${esc(url)}</p><p><code>${esc(description)} (${code})</code></p></main>`;
    wc.executeJavaScript(`document.open();document.write(${JSON.stringify(html)});document.close();`).catch(() => {
      wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {});
    });
  }
}
