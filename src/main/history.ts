import { app, ipcMain } from 'electron';
import { join } from 'node:path';
import type { HistoryEntry, HistoryQuery, HistoryResult } from '../shared/types.ts';
import { isInternal } from '../shared/url.ts';
import { Store } from './store.ts';
import type { Controller } from './controller.ts';

const MAX_ENTRIES = 20_000;
const BROADCAST_MS = 500;

/** Browsing history: one entry per main-frame navigation, newest first, persisted to history.json. */
export class HistoryManager {
  private readonly c: Controller;
  private items: HistoryEntry[] = [];
  private readonly store: Store<HistoryEntry[]>;
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;

  constructor(c: Controller) {
    this.c = c;
    this.store = new Store(join(app.getPath('userData'), 'history.json'));
  }

  init(): void {
    const raw = this.store.load();
    if (Array.isArray(raw)) this.items = raw.filter(isEntry).slice(0, MAX_ENTRIES);
    this.seq = this.items.length;
    ipcMain.handle('history', (event, q: unknown) => (this.c.trustedEvent(event) ? this.query(q) : { entries: [], total: 0 }));
  }

  record(url: string, title: string): void {
    if (!/^(https?|file|ftp):/i.test(url) || isInternal(url)) return;
    const last = this.items[0];
    const now = Date.now();
    if (last && last.url === url && now - last.at < 2000) return; // reload or redirect bounce
    this.items = [{ id: `${now}-${++this.seq}`, url, title: title || url, at: now }, ...this.items].slice(0, MAX_ENTRIES);
    this.changed();
  }

  /** Titles arrive after navigation: attach them to the entry just recorded. */
  title(url: string, title: string): void {
    if (!title) return;
    const e = this.items.find((x) => x.url === url);
    if (!e || e.title === title || Date.now() - e.at > 60_000) return;
    e.title = title;
    this.changed();
  }

  query(raw: unknown): HistoryResult {
    const q = (typeof raw === 'object' && raw !== null ? raw : {}) as HistoryQuery;
    const terms = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Math.min(2000, Math.max(1, q.limit ?? 500));
    const matches = terms.length ? this.items.filter((e) => terms.every((t) => e.url.toLowerCase().includes(t) || e.title.toLowerCase().includes(t))) : this.items;
    return { entries: matches.slice(0, limit), total: matches.length };
  }

  /** Merge visits from another browser: nothing is duplicated, newest stays first. Returns how many were new. */
  importVisits(visits: { url: string; title: string; at: number }[]): number {
    const have = new Set(this.items.map((e) => `${e.url}@${Math.round(e.at / 1000)}`));
    const fresh: HistoryEntry[] = [];
    for (const v of visits) {
      const key = `${v.url}@${Math.round(v.at / 1000)}`;
      if (have.has(key)) continue;
      have.add(key);
      fresh.push({ id: `${v.at}-i${++this.seq}`, url: v.url, title: v.title || v.url, at: v.at });
    }
    if (!fresh.length) return 0;
    this.items = [...this.items, ...fresh].sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES);
    this.changed();
    return fresh.length;
  }

  remove(id: string): void {
    this.items = this.items.filter((e) => e.id !== id);
    this.changed();
  }

  clear(): void {
    this.items = [];
    this.changed();
  }

  flush(): void {
    this.store.flush();
  }

  private changed(): void {
    this.store.save(this.items);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.c.sendAll('history', { total: this.items.length });
    }, BROADCAST_MS);
  }
}

function isEntry(v: unknown): v is HistoryEntry {
  const e = v as HistoryEntry;
  return typeof v === 'object' && v !== null && typeof e.id === 'string' && typeof e.url === 'string' && typeof e.title === 'string' && typeof e.at === 'number';
}
