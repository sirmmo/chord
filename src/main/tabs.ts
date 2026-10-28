import { WebContentsView, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { spaceForUrl } from '../shared/routes.ts';
import { hostOf, siteOf } from '../shared/url.ts';
import type { State, Tab, TabId } from '../shared/types.ts';
import { isLocked, spaceOfTab, visiblePanes } from '../shared/model.ts';
import type { ChordWindow } from './window.ts';
import { computeLayout } from '../shared/layout.ts';
import { parseTiling } from '../shared/tiling.ts';
import { PARTITION, configureSession, partitionFor } from './session.ts';
import { PAGE_PRELOAD, PRELOAD } from './paths.ts';
import { externalScheme, isInternal } from '../shared/url.ts';
import { installUrlFrom } from '../shared/installer.ts';
import { openExternalLink } from './external.ts';
import { pageContextMenu } from './menu.ts';
import type { Controller } from './controller.ts';
import { navDomReady, navFinished, navStarted, pageLine } from './diagnostics.ts';

const CONTENT_RADIUS = 10;

/**
 * Owns one WebContentsView per awake tab and keeps them in sync with the
 * state: reconcile() creates, destroys, shows, hides and lays out views so
 * that reality matches whatever the reducer decided.
 */
export class TabManager {
  readonly views = new Map<TabId, WebContentsView>();
  /** which window each view is attached to */
  private readonly parents = new Map<TabId, number>();
  fullscreenTab: TabId | null = null;

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

  /** The focused pane of the active window. */
  focusedView(): WebContentsView | undefined {
    const w = this.c.active;
    return w ? this.focusedViewIn(w) : undefined;
  }

  /** The focused pane of one window. */
  focusedViewIn(w: ChordWindow): WebContentsView | undefined {
    const sp = w.space;
    if (isLocked(sp)) return undefined;
    return sp.focused ? this.views.get(sp.focused) : undefined;
  }

  /** The window a tab's view belongs in: the one showing its space, else the active window. */
  windowOfTab(id: TabId, state: State = this.c.state): ChordWindow | undefined {
    const tab = state.tabs[id];
    return (tab?.spaceId ? this.c.windowForSpace(tab.spaceId) : undefined) ?? this.c.active;
  }

  /** The window a view is currently attached to. */
  windowOfView(id: TabId): ChordWindow | undefined {
    const wid = this.parents.get(id);
    return wid === undefined ? undefined : this.c.windows.get(wid);
  }

  reset(): void {
    for (const id of [...this.views.keys()]) this.destroy(id);
    this.fullscreenTab = null;
  }

  /** A window is closing: drop its views and put their tabs to sleep. */
  releaseWindow(w: ChordWindow): void {
    for (const [id, wid] of [...this.parents]) {
      if (wid !== w.id) continue;
      this.destroy(id);
      if (this.c.state.tabs[id]?.awake) this.c.apply({ type: 'tab.sleep', id });
    }
  }

  reconcile(state: State): void {
    if (this.c.windows.size === 0) return;

    for (const [id] of [...this.views]) {
      const tab = state.tabs[id];
      // Gone, asleep, or moved to a space with another profile: the view cannot be kept.
      if (!tab || !tab.awake || this.partitions.get(id) !== partitionFor(spaceOfTab(state, tab).profile)) this.destroy(id);
    }
    for (const tab of Object.values(state.tabs)) {
      if (tab.awake && !this.views.has(tab.id)) {
        const view = this.create(tab.id, undefined, tab.url, partitionFor(spaceOfTab(state, tab).profile), this.windowOfTab(tab.id, state));
        view.webContents.loadURL(tab.url).catch(() => {});
      }
    }
    for (const [id, view] of this.views) {
      const muted = Boolean(state.tabs[id]?.muted);
      if (view.webContents.isAudioMuted() !== muted) view.webContents.setAudioMuted(muted);
      // A tab whose space now lives in another window follows it there.
      const wanted = this.windowOfTab(id, state);
      const current = this.windowOfView(id);
      if (wanted && wanted.alive() && current !== wanted) {
        if (current?.alive()) current.win.contentView.removeChildView(view);
        wanted.win.contentView.addChildView(view);
        this.parents.set(id, wanted.id);
        wanted.overlay.raise();
      }
    }

    const visible = new Set<TabId>();
    for (const w of this.c.windows.values()) for (const id of visiblePanes(w.space)) if (this.views.has(id) && this.parents.get(id) === w.id) visible.add(id);
    for (const [id, view] of this.views) view.setVisible(visible.has(id));
    this.layout(state);

    for (const w of this.c.windows.values()) {
      const sp = w.space;
      const focus = sp.focused && visible.has(sp.focused) ? sp.focused : null;
      if (focus && focus !== w.lastFocused && !w.overlay.isShown() && w === this.c.active) this.views.get(focus)!.webContents.focus();
      w.lastFocused = focus;
    }
  }

  layout(state: State = this.c.state): void {
    for (const w of this.c.windows.values()) this.layoutWindow(w, state);
  }

  private layoutWindow(w: ChordWindow, state: State): void {
    if (!w.alive()) return;
    const { width, height } = w.win.getContentBounds();

    if (this.fullscreenTab && this.views.has(this.fullscreenTab) && this.parents.get(this.fullscreenTab) === w.id) {
      const { panes } = computeLayout({ width, height, sidebarOpen: false, sidebarWidth: 0, panes: 1, fullscreen: true });
      for (const [id, view] of this.views) {
        if (this.parents.get(id) !== w.id) continue;
        const isFull = id === this.fullscreenTab;
        view.setVisible(isFull);
        if (isFull) view.setBounds(panes[0]);
      }
      return;
    }

    const space = w.space;
    const visible = visiblePanes(space).filter((id) => this.views.has(id) && this.parents.get(id) === w.id);
    const { panes } = computeLayout({
      width,
      height,
      sidebarOpen: this.c.sidebarVisible(),
      sidebarWidth: state.settings.sidebarWidth,
      panes: visible.length,
      topInset: this.c.topInset(),
      tiling: space.tiling ? parseTiling(space.tiling) : null,
      panelWidth: w.panel.width(),
    });
    visible.forEach((id, k) => this.views.get(id)!.setBounds(panes[k]));
  }

  private readonly partitions = new Map<TabId, string>();

  /** The session a tab's page belongs to: its space's profile, or the shared one. */
  partitionOf(id: TabId): string {
    const tab = this.c.state.tabs[id];
    return tab ? partitionFor(spaceOfTab(this.c.state, tab).profile) : PARTITION;
  }

  create(id: TabId, existing?: WebContentsView, url = '', partition = PARTITION, w: ChordWindow | undefined = this.windowOfTab(id)): WebContentsView {
    configureSession(partition);
    this.partitions.set(id, partition);
    const view =
      existing ??
      new WebContentsView({
        webPreferences: {
          partition,
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
    const host = w && w.alive() ? w : this.c.active;
    if (host && host.alive()) {
      host.win.contentView.addChildView(view);
      this.parents.set(id, host.id);
      host.overlay.raise();
    }
    this.wire(id, view.webContents);
    this.c.wireKeys(view.webContents);
    return view;
  }

  destroy(id: TabId): void {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    this.partitions.delete(id);
    this.c.smart.clear(id);
    this.c.sources.forget(id);
    if (this.fullscreenTab === id) this.fullscreenTab = null;
    const parent = this.windowOfView(id);
    this.parents.delete(id);
    for (const w of this.c.windows.values()) if (w.lastFocused === id) w.lastFocused = null;
    if (parent?.alive()) parent.win.contentView.removeChildView(view);
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
      this.c.sources.refresh();
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
        this.c.sources.navigated(id);
      }
    });
    wc.on('dom-ready', () => {
      navDomReady(id);
      const volume = this.c.state.tabs[id]?.volume;
      if (volume !== undefined && volume < 1) wc.send('smart:action', `volume:${volume}`);
      void this.c.boosts.apply(id, wc);
    });
    wc.on('audio-state-changed', (e) => patch({ audible: e.audible }));
    wc.on('focus', () => this.c.apply({ type: 'pane.focus', id }));
    wc.on('input-event', (_e, input) => {
      if (input.type !== 'mouseDown' && input.type !== 'mouseMove') return;
      const m = input as Electron.InputEvent & { x?: number };
      if (this.c.peeking) {
        // the pointer wandered into the page: the peek is over (unless it is still hugging the edge)
        if (!(input.type === 'mouseMove' && typeof m.x === 'number' && m.x <= 2)) this.c.dispatch({ type: 'sidebar.peek', on: false });
      } else if (input.type === 'mouseMove' && typeof m.x === 'number' && m.x <= 1 && !this.c.state.settings.sidebarOpen && this.windowOfView(id)?.win.isFocused()) {
        // the pointer reached the page's left edge: show the sidebar, like hovering the gutter does
        this.c.dispatch({ type: 'sidebar.peek', on: true });
      }
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
      this.windowOfView(id)?.overlay.send({ kind: 'find:result', active: result.activeMatchOrdinal, matches: result.matches });
    });
    wc.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') pageLine(id, `${event.level}: ${event.message} (${event.sourceId.split('/').pop() ?? ''}:${event.lineNumber})`);
    });
    wc.on('render-process-gone', (_e, details) => {
      pageLine(id, `renderer gone: ${details.reason} exit=${details.exitCode}`);
      if (details.reason === 'clean-exit') return;
      patch({ crashed: true });
      this.c.apply({ type: 'tab.sleep', id });
    });
    wc.on('destroyed', () => {
      this.c.smart.clear(id);
      if (!this.views.has(id)) return; // we closed it ourselves
      this.views.delete(id);
      this.parents.delete(id);
      if (this.c.state.tabs[id]?.awake) this.c.apply({ type: 'tab.sleep', id });
    });
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (code !== -3) pageLine(id, `load failed ${code} ${description} ${isMainFrame ? '' : '(subframe) '}${url.slice(0, 120)}`);
      if (isMainFrame && code !== -3 && !this.c.privacy.failed(wc, url, code)) this.showError(wc, code, description, url);
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
        return;
      }
      // Peek: a pinned or favorite tab stays on its site; a link elsewhere opens in a preview
      const tab = this.c.state.tabs[id];
      if (tab && this.c.state.settings.peek && (tab.kind === 'pinned' || tab.kind === 'favorite') && /^https?:/i.test(url)) {
        const home = hostOf(tab.homeUrl ?? tab.url);
        const target = hostOf(url);
        if (home && target && siteOf(home) !== siteOf(target) && !isInternal(wc.getURL())) {
          e.preventDefault();
          this.c.peek.open(url, id);
        }
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
          // When Electron has already created the popup's WebContents (window.open with an
          // opener), the view must wrap that very object or the handler throws.
          const guest = (options as { webContents?: WebContents }).webContents;
          const view = guest ? new WebContentsView({ webContents: guest }) : new WebContentsView({ webPreferences: options.webPreferences });
          const newId = randomUUID();
          this.create(newId, view, '', this.partitions.get(id) ?? PARTITION, this.windowOfView(id));
          this.c.apply({
            type: 'tab.new',
            id: newId,
            url,
            spaceId: spaceForUrl(this.c.state.settings.routes, this.c.state.spaces, url) ?? opener?.spaceId ?? this.c.state.activeSpaceId,
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
