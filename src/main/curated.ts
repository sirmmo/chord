import { app, ipcMain } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CuratedItem, CuratedStatus, Curator, SpaceId } from '../shared/types.ts';
import { itemKind, resolveCuratorInput, type FeedItem } from '../shared/feed.ts';
import { discoverFeed, fetchFeed } from './feeds.ts';
import { spaceById } from '../shared/model.ts';
import { Store } from './store.ts';
import type { Controller } from './controller.ts';

/**
 * Curated mode: a space follows curators — people and feeds that share sites,
 * repositories and finds — and their items arrive in the side panel. The list
 * of curators lives in the space (exported with it); the items and what was
 * read live here, in curated.json.
 */

interface SpaceData {
  items: CuratedItem[];
  lastRefresh: number;
  errors: Record<string, string>;
}

const MAX_ITEMS = 400;
const REFRESH_MS = 30 * 60_000;
const STALE_MS = 15 * 60_000;

export class CuratedManager {
  private readonly c: Controller;
  private readonly store: Store<Record<SpaceId, SpaceData>>;
  private data: Record<SpaceId, SpaceData> = {};
  private refreshing = new Set<SpaceId>();
  private timer: NodeJS.Timeout | null = null;

  constructor(c: Controller) {
    this.c = c;
    this.store = new Store(join(app.getPath('userData'), 'curated.json'));
  }

  init(): void {
    const raw = this.store.load();
    if (raw && typeof raw === 'object') this.data = raw as Record<SpaceId, SpaceData>;
    ipcMain.handle('curated', (event, spaceId: unknown) => (this.c.trustedEvent(event) && typeof spaceId === 'string' ? this.status(spaceId) : null));
    this.timer = setInterval(() => this.refreshAll(), REFRESH_MS);
    this.timer.unref();
    setTimeout(() => this.refreshAll(), 20_000).unref();
  }

  private get(spaceId: SpaceId): SpaceData {
    return (this.data[spaceId] ??= { items: [], lastRefresh: 0, errors: {} });
  }

  private curators(spaceId: SpaceId): Curator[] {
    return spaceById(this.c.state, spaceId)?.curators ?? [];
  }

  status(spaceId: SpaceId): CuratedStatus {
    const d = this.get(spaceId);
    return { spaceId, curators: this.curators(spaceId), items: d.items, refreshing: this.refreshing.has(spaceId), lastRefresh: d.lastRefresh, errors: d.errors };
  }

  /** The space was shown: refresh if its feed is stale. */
  touch(spaceId: SpaceId): void {
    const sp = spaceById(this.c.state, spaceId);
    if (!sp?.modes?.includes('curated') || !sp.curators?.length) return;
    if (Date.now() - this.get(spaceId).lastRefresh > STALE_MS) void this.refresh(spaceId);
  }

  refreshAll(): void {
    for (const sp of this.c.state.spaces) if (sp.modes?.includes('curated') && sp.curators?.length) void this.refresh(sp.id);
  }

  /** Turn what the user typed into a curator, fetching the page when the feed has to be discovered. */
  async add(spaceId: SpaceId, input: string): Promise<void> {
    const sp = spaceById(this.c.state, spaceId);
    if (!sp) return;
    const resolved = resolveCuratorInput(input);
    const d = this.get(spaceId);
    if (!resolved) {
      d.errors.add = 'That does not look like a site, a feed, an @handle or a GitHub user.';
      this.send(spaceId);
      return;
    }
    let feed = resolved.url;
    let kind: Curator['kind'] = resolved.kind === 'github' ? 'github' : 'feed';
    let name = resolved.name;
    delete d.errors.add;
    this.send(spaceId);
    try {
      if (resolved.kind === 'discover') {
        const found = await discoverFeed(resolved.url);
        if (!found) throw new Error('No feed found on that page. Try the address of its RSS feed.');
        feed = found;
      }
      const parsed = await fetchFeed(feed, kind);
      if (parsed.title) name = parsed.title.slice(0, 100);
    } catch (err) {
      d.errors.add = err instanceof Error ? err.message : String(err);
      this.send(spaceId);
      return;
    }
    if ((sp.curators ?? []).some((c) => c.feed === feed)) {
      d.errors.add = 'Already followed.';
      this.send(spaceId);
      return;
    }
    const curator: Curator = { id: randomUUID(), name: name || feed, input: input.trim(), feed, kind, addedAt: Date.now() };
    this.c.apply({ type: 'space.setCurators', id: spaceId, curators: [...(sp.curators ?? []), curator] });
    void this.refresh(spaceId, [curator.id]);
  }

  remove(spaceId: SpaceId, id: string): void {
    const sp = spaceById(this.c.state, spaceId);
    if (!sp) return;
    this.c.apply({ type: 'space.setCurators', id: spaceId, curators: (sp.curators ?? []).filter((c) => c.id !== id) });
    const d = this.get(spaceId);
    d.items = d.items.filter((it) => it.curatorId !== id);
    delete d.errors[id];
    this.save(spaceId);
  }

  markRead(spaceId: SpaceId, id?: string): void {
    const d = this.get(spaceId);
    for (const it of d.items) if (!id || it.id === id) it.read = true;
    this.save(spaceId);
  }

  toggleSaved(spaceId: SpaceId, id: string): void {
    const it = this.get(spaceId).items.find((x) => x.id === id);
    if (!it) return;
    it.saved = !it.saved;
    if (it.saved) this.c.apply({ type: 'bookmark.add', url: it.url, title: it.title, public: false, tags: ['curated'], note: it.summary });
    this.save(spaceId);
  }

  /** Open an item in its space and mark it read. */
  open(spaceId: SpaceId, id: string): void {
    const it = this.get(spaceId).items.find((x) => x.id === id);
    if (!it) return;
    it.read = true;
    this.save(spaceId);
    this.c.apply({ type: 'tab.new', url: it.url, spaceId, activate: true });
  }

  async refresh(spaceId: SpaceId, only?: string[]): Promise<void> {
    if (this.refreshing.has(spaceId)) return;
    const curators = this.curators(spaceId).filter((c) => !only || only.includes(c.id));
    if (curators.length === 0) return;
    this.refreshing.add(spaceId);
    this.send(spaceId);
    const d = this.get(spaceId);
    const now = Date.now();
    await Promise.all(
      curators.map(async (cur) => {
        try {
          const parsed = await fetchFeed(cur.feed, cur.kind);
          delete d.errors[cur.id];
          this.merge(d, cur, parsed.items, now);
        } catch (err) {
          d.errors[cur.id] = err instanceof Error ? err.message : String(err);
        }
      }),
    );
    d.lastRefresh = now;
    this.refreshing.delete(spaceId);
    this.save(spaceId);
  }

  private merge(d: SpaceData, cur: Curator, items: FeedItem[], now: number): void {
    const byUrl = new Map(d.items.map((it) => [it.url, it]));
    for (const f of items) {
      if (!f.url || !/^https?:\/\//i.test(f.url)) continue;
      const existing = byUrl.get(f.url);
      if (existing) {
        if (!existing.title && f.title) existing.title = f.title;
        continue;
      }
      const item: CuratedItem = {
        id: randomUUID(),
        curatorId: cur.id,
        title: (f.title || f.url).slice(0, 200),
        url: f.url,
        summary: f.summary.slice(0, 400),
        author: f.author.slice(0, 100),
        publishedAt: f.publishedAt || now,
        fetchedAt: now,
        kind: itemKind(f.url),
      };
      d.items.push(item);
      byUrl.set(item.url, item);
    }
    d.items.sort((a, b) => b.publishedAt - a.publishedAt);
    if (d.items.length > MAX_ITEMS) {
      // keep saved items and the newest of the rest
      const saved = d.items.filter((it) => it.saved);
      const rest = d.items.filter((it) => !it.saved).slice(0, MAX_ITEMS - saved.length);
      d.items = [...saved, ...rest].sort((a, b) => b.publishedAt - a.publishedAt);
    }
  }

  private send(spaceId: SpaceId): void {
    this.c.sendAll('curated', this.status(spaceId));
  }

  private save(spaceId: SpaceId): void {
    this.store.save(this.data);
    this.send(spaceId);
  }

  flush(): void {
    this.store.flush();
  }

  prune(): void {
    const ids = new Set(this.c.state.spaces.map((sp) => sp.id));
    for (const id of Object.keys(this.data)) if (!ids.has(id)) delete this.data[id];
    this.store.save(this.data);
  }
}
