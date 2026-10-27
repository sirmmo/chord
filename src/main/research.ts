import { app, ipcMain, net } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ResearchData, ResearchStatus, SpaceId, TabId } from '../shared/types.ts';
import { activeSpace, focusedTab } from '../shared/model.ts';
import { Store } from './store.ts';
import type { Controller } from './controller.ts';

const ZOTERO = 'http://127.0.0.1:23119';
const ZOTERO_HEADERS = { 'Content-Type': 'application/json', 'X-Zotero-Connector-API-Version': '3', 'X-Zotero-Version': '7.0' };
const MAX_CLIPS = 500;

/**
 * Research mode: per-space notes, clipped passages and sources, kept in
 * research.json (never exported), plus "save to Zotero" through the Zotero
 * connector server that Zotero desktop runs on localhost:23119.
 */
export class ResearchManager {
  private readonly c: Controller;
  private readonly store: Store<Record<SpaceId, ResearchData>>;
  private data: Record<SpaceId, ResearchData> = {};
  private zotero = { available: false, checkedAt: 0 };

  constructor(c: Controller) {
    this.c = c;
    this.store = new Store(join(app.getPath('userData'), 'research.json'));
  }

  init(): void {
    const raw = this.store.load();
    if (raw && typeof raw === 'object') this.data = raw as Record<SpaceId, ResearchData>;
    ipcMain.handle('research', async (event, spaceId: unknown) => (this.c.trustedEvent(event) && typeof spaceId === 'string' ? this.status(spaceId) : null));
    void this.checkZotero();
  }

  private get(spaceId: SpaceId): ResearchData {
    return (this.data[spaceId] ??= { notes: '', clips: [], sources: [] });
  }

  async status(spaceId: SpaceId): Promise<ResearchStatus> {
    if (Date.now() - this.zotero.checkedAt > 30_000) await this.checkZotero();
    return { spaceId, data: this.get(spaceId), zotero: this.zotero };
  }

  async checkZotero(): Promise<boolean> {
    try {
      const res = await net.fetch(`${ZOTERO}/connector/ping`, { signal: AbortSignal.timeout(1500) });
      this.zotero = { available: res.ok, checkedAt: Date.now() };
    } catch {
      this.zotero = { available: false, checkedAt: Date.now() };
    }
    return this.zotero.available;
  }

  note(spaceId: SpaceId, text: string): void {
    this.get(spaceId).notes = text.slice(0, 200_000);
    this.save(spaceId);
  }

  /** Clip a passage; without text, the focused tab's selection. */
  async clip(spaceId: SpaceId | undefined, text?: string, url?: string, title?: string): Promise<void> {
    const sid = spaceId ?? this.c.state.activeSpaceId;
    const tab = focusedTab(this.c.state);
    let passage = text ?? '';
    if (!passage && tab) {
      const wc = this.c.tabs.get(tab.id)?.webContents;
      if (wc && !wc.isDestroyed()) passage = await wc.executeJavaScript('String(window.getSelection())').catch(() => '');
    }
    passage = passage.trim();
    if (!passage) return;
    const d = this.get(sid);
    d.clips.unshift({ id: randomUUID(), text: passage.slice(0, 5000), url: url ?? tab?.url ?? '', title: title ?? tab?.title ?? '', at: Date.now() });
    if (d.clips.length > MAX_CLIPS) d.clips.length = MAX_CLIPS;
    this.save(sid);
  }

  source(spaceId: SpaceId | undefined, url?: string, title?: string, zotero = false): void {
    const sid = spaceId ?? this.c.state.activeSpaceId;
    const tab = focusedTab(this.c.state);
    const u = url ?? tab?.url;
    if (!u) return;
    const d = this.get(sid);
    const existing = d.sources.find((x) => x.url === u);
    if (existing) {
      if (zotero) existing.zotero = true;
      existing.at = Date.now();
    } else d.sources.unshift({ id: randomUUID(), url: u, title: title ?? tab?.title ?? u, at: Date.now(), zotero: zotero || undefined });
    this.save(sid);
  }

  remove(spaceId: SpaceId, kind: 'clip' | 'source', id: string): void {
    const d = this.get(spaceId);
    if (kind === 'clip') d.clips = d.clips.filter((x) => x.id !== id);
    else d.sources = d.sources.filter((x) => x.id !== id);
    this.save(spaceId);
  }

  /** Save a page to Zotero as a web page item with a snapshot. */
  async zoteroSave(spaceId: SpaceId | undefined, tabId?: TabId): Promise<{ ok: boolean; error?: string }> {
    const sid = spaceId ?? this.c.state.activeSpaceId;
    const tab = tabId ? this.c.state.tabs[tabId] : focusedTab(this.c.state);
    if (!tab) return { ok: false, error: 'no page' };
    if (!(await this.checkZotero())) return { ok: false, error: 'Zotero is not running' };
    const wc = this.c.tabs.get(tab.id)?.webContents;
    const html = wc && !wc.isDestroyed() ? await wc.executeJavaScript('document.documentElement.outerHTML').catch(() => '') : '';
    try {
      const res = await net.fetch(`${ZOTERO}/connector/saveSnapshot`, {
        method: 'POST',
        headers: ZOTERO_HEADERS,
        body: JSON.stringify({ url: tab.url, title: tab.title, html: typeof html === 'string' ? html.slice(0, 5_000_000) : '' }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ok: false, error: `Zotero answered ${res.status}` };
      this.source(sid, tab.url, tab.title, true);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private save(spaceId: SpaceId): void {
    this.store.save(this.data);
    this.c.sendAll('research', { spaceId, data: this.get(spaceId), zotero: this.zotero } satisfies ResearchStatus);
  }

  flush(): void {
    this.store.flush();
  }

  /** Research-mode spaces that still exist; others are dropped from the file. */
  prune(): void {
    const ids = new Set(this.c.state.spaces.map((sp) => sp.id));
    for (const id of Object.keys(this.data)) if (!ids.has(id)) delete this.data[id];
    this.store.save(this.data);
  }

  activeId(): SpaceId {
    return activeSpace(this.c.state).id;
  }
}
