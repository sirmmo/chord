import { app, dialog, ipcMain, Menu, shell } from 'electron';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ReaderFeed, ReaderGroup, ReaderItem, ReaderQuery, ReaderStatus, TabId } from '../shared/types.ts';
import { resolveCuratorInput, type FeedItem } from '../shared/feed.ts';
import { parseOpml, renderOpml } from '../shared/opml.ts';
import { focusedTab } from '../shared/model.ts';
import { hostOf } from '../shared/url.ts';
import { Store } from './store.ts';
import { discoverFeed, fetchFeed } from './feeds.ts';
import type { Controller } from './controller.ts';

/**
 * The reader behind chord://reader: subscriptions grouped into subspaces, their
 * items and what was read, in reader.json. Feeds come from an address, a site
 * (discovered), the feeds a visited page advertises (the sidebar's subscribe
 * button) or an OPML file, which becomes a subspace of its own.
 */

interface File {
  feeds: Omit<ReaderFeed, 'unread'>[];
  groups: ReaderGroup[];
  items: ReaderItem[];
}

const REFRESH_MS = 20 * 60_000;
const MAX_PER_FEED = 200;
const MAX_ITEMS = 4000;
const KEEP_DAYS = 60;

export class ReaderManager {
  private readonly c: Controller;
  private readonly store: Store<File>;
  private feeds: Omit<ReaderFeed, 'unread'>[] = [];
  private groups: ReaderGroup[] = [];
  private items: ReaderItem[] = [];
  private refreshing = false;
  private error = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(c: Controller) {
    this.c = c;
    this.store = new Store(join(app.getPath('userData'), 'reader.json'));
  }

  init(): void {
    const raw = this.store.load() as Partial<File> | null;
    if (raw) {
      if (Array.isArray(raw.feeds)) this.feeds = raw.feeds.filter((f) => f && typeof f.id === 'string' && typeof f.url === 'string');
      if (Array.isArray(raw.groups)) this.groups = raw.groups.filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string');
      if (Array.isArray(raw.items)) this.items = raw.items.filter((it) => it && typeof it.id === 'string' && typeof it.feedId === 'string');
    }
    ipcMain.handle('reader', (event) => (this.c.trustedEvent(event) ? this.status() : null));
    ipcMain.handle('reader:items', (event, q: unknown) => (this.c.trustedEvent(event) ? this.query((typeof q === 'object' && q !== null ? q : { scope: 'all' }) as ReaderQuery) : []));
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
    if (this.feeds.length) setTimeout(() => void this.refresh(), 25_000).unref();
  }

  status(): ReaderStatus {
    const unreadBy = new Map<string, number>();
    for (const it of this.items) if (!it.read) unreadBy.set(it.feedId, (unreadBy.get(it.feedId) ?? 0) + 1);
    const feeds = this.feeds.map((f) => ({ ...f, unread: unreadBy.get(f.id) ?? 0 }));
    return { feeds, groups: this.groups, unread: feeds.reduce((n, f) => n + f.unread, 0), refreshing: this.refreshing, error: this.error };
  }

  /** Is this feed URL already subscribed? */
  has(url: string): boolean {
    return this.feeds.some((f) => f.url === url);
  }

  query(q: ReaderQuery): ReaderItem[] {
    const text = (q.text ?? '').trim().toLowerCase();
    const feedIds = q.scope.startsWith('group:') ? new Set(this.feeds.filter((f) => f.groupId === q.scope.slice(6)).map((f) => f.id)) : null;
    const out = this.items.filter((it) => {
      if (q.scope === 'starred' && !it.starred) return false;
      if (q.scope === 'unread' && it.read) return false;
      if (feedIds && !feedIds.has(it.feedId)) return false;
      if (!feedIds && q.scope !== 'all' && q.scope !== 'starred' && q.scope !== 'unread' && it.feedId !== q.scope) return false;
      if (text && !`${it.title} ${it.summary} ${it.author}`.toLowerCase().includes(text)) return false;
      return true;
    });
    return out.slice(0, Math.min(q.limit ?? 300, 1000));
  }

  // ---- subscriptions ----

  /** Subscribe from an address, a site, an @handle…; feeds a page advertises come with their title. */
  async subscribe(input: string, groupId: string | null = null, title?: string): Promise<ReaderFeed | null> {
    const resolved = resolveCuratorInput(input);
    this.error = '';
    if (!resolved || resolved.kind === 'github') {
      this.error = resolved ? 'GitHub stars are for curated spaces; the reader takes feeds.' : 'That does not look like a site or a feed address.';
      this.send();
      return null;
    }
    this.send();
    try {
      const url = resolved.kind === 'discover' ? await discoverFeed(resolved.url) : resolved.url;
      if (!url) throw new Error('No feed found on that page. Try the address of its RSS feed.');
      const existing = this.feeds.find((f) => f.url === url);
      if (existing) return { ...existing, unread: 0 };
      const parsed = await fetchFeed(url);
      const site = resolved.kind === 'discover' ? resolved.url : '';
      const feed: Omit<ReaderFeed, 'unread'> = { id: randomUUID(), title: (title || parsed.title || resolved.name || hostOf(url)).slice(0, 120), url, site, groupId, addedAt: Date.now(), lastFetch: Date.now() };
      this.feeds.push(feed);
      this.merge(feed, parsed.items, Date.now(), true);
      this.save();
      return { ...feed, unread: 0 };
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.send();
      return null;
    }
  }

  /** The sidebar's button: one advertised feed subscribes at once, several offer a choice. */
  subscribeFrom(tabId?: TabId): void {
    const tab = tabId ? this.c.state.tabs[tabId] : focusedTab(this.c.state);
    if (!tab) return;
    const feeds = (this.c.smart.getStatus()[tab.id]?.feeds ?? []).filter((f) => !this.has(f.url));
    const win = this.c.win;
    if (feeds.length === 0) {
      void this.subscribe(tab.url).then((f) => f && this.c.openInternal('chord://reader/'));
      return;
    }
    if (feeds.length === 1 || !win) {
      void this.subscribe(feeds[0].url, null, feeds[0].title).then((f) => f && this.c.openInternal('chord://reader/'));
      return;
    }
    Menu.buildFromTemplate([
      { label: `Subscribe in the reader (${hostOf(tab.url)})`, enabled: false },
      { type: 'separator' },
      ...feeds.map((f) => ({ label: (f.title || f.url).slice(0, 80), click: () => void this.subscribe(f.url, null, f.title).then((r) => r && this.c.openInternal('chord://reader/')) })),
    ]).popup({ window: win });
  }

  unsubscribe(id: string): void {
    this.feeds = this.feeds.filter((f) => f.id !== id);
    this.items = this.items.filter((it) => it.feedId !== id);
    this.save();
  }

  move(id: string, groupId: string | null): void {
    const f = this.feeds.find((x) => x.id === id);
    if (!f) return;
    f.groupId = groupId && this.groups.some((g) => g.id === groupId) ? groupId : null;
    this.save();
  }

  group(op: 'create' | 'rename' | 'delete' | 'toggle', id?: string, name?: string): ReaderGroup | null {
    if (op === 'create') {
      const g = { id: randomUUID(), name: (name ?? 'Subspace').trim().slice(0, 80) || 'Subspace' };
      this.groups.push(g);
      this.save();
      return g;
    }
    const g = this.groups.find((x) => x.id === id);
    if (!g) return null;
    if (op === 'rename' && name?.trim()) g.name = name.trim().slice(0, 80);
    else if (op === 'toggle') g.collapsed = !g.collapsed;
    else if (op === 'delete') {
      this.groups = this.groups.filter((x) => x.id !== g.id);
      for (const f of this.feeds) if (f.groupId === g.id) f.groupId = null;
    }
    this.save();
    return g;
  }

  feedMenu(id: string): void {
    const f = this.feeds.find((x) => x.id === id);
    const win = this.c.win;
    if (!f || !win) return;
    Menu.buildFromTemplate([
      { label: f.title, enabled: false },
      { label: 'Refresh', click: () => void this.refresh(id) },
      { label: 'Mark All Read', click: () => this.markRead({ feedId: id }) },
      { label: 'Open Site', enabled: Boolean(f.site), click: () => this.c.apply({ type: 'tab.new', url: f.site, activate: true }) },
      { label: 'Copy Feed Address', click: () => void import('electron').then(({ clipboard }) => clipboard.writeText(f.url)) },
      { type: 'separator' },
      {
        label: 'Move to Subspace',
        submenu: [
          { label: 'None', type: 'radio', checked: !f.groupId, click: () => this.move(id, null) },
          ...this.groups.map((g) => ({ label: g.name, type: 'radio' as const, checked: f.groupId === g.id, click: () => this.move(id, g.id) })),
        ],
      },
      { type: 'separator' },
      { label: 'Unsubscribe', click: () => this.unsubscribe(id) },
    ]).popup({ window: win });
  }

  // ---- OPML ----

  async importOpml(): Promise<void> {
    const win = this.c.win;
    if (!win) return;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Import OPML', filters: [{ name: 'OPML', extensions: ['opml', 'xml'] }], properties: ['openFile'] });
    if (canceled || !filePaths[0]) return;
    let text = '';
    try {
      text = await readFile(filePaths[0], 'utf8');
    } catch (err) {
      dialog.showErrorBox('Import OPML', `Could not read the file: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const doc = parseOpml(text);
    if (!doc || doc.feeds.length === 0) {
      dialog.showErrorBox('Import OPML', 'No feeds found in that file.');
      return;
    }
    const base = (doc.title || filePaths[0].split(/[\\/]/).pop()?.replace(/\.(opml|xml)$/i, '') || 'Imported').slice(0, 80);
    // the file becomes a subspace; its own folders become subspaces too
    const groupFor = new Map<string, string>();
    const ensureGroup = (name: string): string => {
      let id = groupFor.get(name);
      if (id) return id;
      const existing = this.groups.find((g) => g.name === name);
      id = existing ? existing.id : this.group('create', undefined, name)!.id;
      groupFor.set(name, id);
      return id;
    };
    let added = 0;
    for (const f of doc.feeds) {
      if (this.has(f.xmlUrl)) continue;
      const groupId = ensureGroup(f.folder ? `${base} / ${f.folder}` : base);
      this.feeds.push({ id: randomUUID(), title: f.title.slice(0, 120), url: f.xmlUrl, site: f.htmlUrl, groupId, addedAt: Date.now(), lastFetch: 0 });
      added++;
    }
    this.save();
    this.c.openInternal('chord://reader/');
    void this.refresh();
    if (added === 0) dialog.showMessageBox(win, { type: 'info', message: 'Every feed in that file was already subscribed.' }).catch(() => {});
  }

  /** Everything, or one subspace as its own OPML file (the other way round of importing one). */
  async exportOpml(groupId?: string): Promise<void> {
    const win = this.c.win;
    if (!win) return;
    const only = groupId ? this.groups.find((g) => g.id === groupId) : undefined;
    const name = only ? only.name : 'Chord subscriptions';
    const file = `${(only ? only.name : 'chord-feeds').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'feeds'}.opml`;
    const { canceled, filePath } = await dialog.showSaveDialog(win, { title: only ? `Export the subspace “${only.name}” as OPML` : 'Export OPML', defaultPath: join(app.getPath('documents'), file), filters: [{ name: 'OPML', extensions: ['opml'] }] });
    if (canceled || !filePath) return;
    const groups = only
      ? [{ name: '', feeds: this.feeds.filter((f) => f.groupId === only.id) }]
      : [{ name: '', feeds: this.feeds.filter((f) => !f.groupId) }, ...this.groups.map((g) => ({ name: g.name, feeds: this.feeds.filter((f) => f.groupId === g.id) }))];
    await writeFile(filePath, renderOpml(name, groups.map((g) => ({ name: g.name, feeds: g.feeds.map((f) => ({ title: f.title, xmlUrl: f.url, htmlUrl: f.site })) }))));
    shell.showItemInFolder(filePath);
  }

  // ---- items ----

  markRead(what: { ids?: string[]; feedId?: string; groupId?: string; on?: boolean }): void {
    const on = what.on !== false;
    const ids = what.ids ? new Set(what.ids) : null;
    const feedIds = what.groupId ? new Set(this.feeds.filter((f) => f.groupId === what.groupId).map((f) => f.id)) : null;
    let changed = false;
    for (const it of this.items) {
      if (ids && !ids.has(it.id)) continue;
      if (what.feedId && it.feedId !== what.feedId) continue;
      if (feedIds && !feedIds.has(it.feedId)) continue;
      if (it.read !== on) {
        it.read = on;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  star(id: string): void {
    const it = this.items.find((x) => x.id === id);
    if (!it) return;
    it.starred = !it.starred;
    this.save();
  }

  openItem(id: string): void {
    const it = this.items.find((x) => x.id === id);
    if (!it) return;
    it.read = true;
    this.save();
    this.c.apply({ type: 'tab.new', url: it.url, activate: true });
  }

  async refresh(id?: string): Promise<void> {
    if (this.refreshing) return;
    const feeds = this.feeds.filter((f) => !id || f.id === id);
    if (feeds.length === 0) return;
    this.refreshing = true;
    this.send();
    const now = Date.now();
    let i = 0;
    const worker = async () => {
      while (i < feeds.length) {
        const f = feeds[i++];
        try {
          const parsed = await fetchFeed(f.url);
          if (!f.title && parsed.title) f.title = parsed.title.slice(0, 120);
          delete f.error;
          this.merge(f, parsed.items, now, false);
        } catch (err) {
          f.error = err instanceof Error ? err.message : String(err);
        }
        f.lastFetch = now;
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, feeds.length) }, worker));
    this.prune(now);
    this.refreshing = false;
    this.save();
  }

  private merge(feed: Omit<ReaderFeed, 'unread'>, items: FeedItem[], now: number, initial: boolean): void {
    const have = new Set(this.items.filter((it) => it.feedId === feed.id).map((it) => it.id));
    let n = 0;
    for (const f of items) {
      if (!f.url || !/^https?:\/\//i.test(f.url)) continue;
      const id = `${feed.id}:${f.id || f.url}`.slice(0, 500);
      if (have.has(id)) continue;
      have.add(id);
      this.items.push({
        id,
        feedId: feed.id,
        title: (f.title || f.url).slice(0, 300),
        url: f.url,
        summary: f.summary,
        author: f.author.slice(0, 100),
        publishedAt: f.publishedAt || now,
        fetchedAt: now,
        // a first fetch brings the backlog: only the newest few count as unread
        read: initial && ++n > 10,
        starred: false,
        content: f.content,
      });
    }
    this.items.sort((a, b) => b.publishedAt - a.publishedAt);
  }

  private prune(now: number): void {
    const perFeed = new Map<string, number>();
    const limit = now - KEEP_DAYS * 86_400_000;
    this.items = this.items.filter((it) => {
      if (it.starred) return true;
      const n = (perFeed.get(it.feedId) ?? 0) + 1;
      perFeed.set(it.feedId, n);
      if (n > MAX_PER_FEED) return false;
      return it.publishedAt > limit || !it.read;
    });
    if (this.items.length > MAX_ITEMS) this.items = [...this.items.filter((it) => it.starred), ...this.items.filter((it) => !it.starred).slice(0, MAX_ITEMS)];
  }

  private send(): void {
    this.c.sendAll('reader', this.status());
  }

  private save(): void {
    this.store.save({ feeds: this.feeds, groups: this.groups, items: this.items });
    this.send();
  }

  flush(): void {
    this.store.flush();
  }
}
