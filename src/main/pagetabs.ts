import { dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import type { State, TabGroup, TabId } from '../shared/types.ts';
import { membersOf, spaceById } from '../shared/model.ts';
import type { Controller } from './controller.ts';
import { boostsFor } from '../shared/boosts.ts';

/**
 * The page API: `navigator.chord` lets a page open and close tabs of its own in
 * the space it lives in. Those tabs form a subspace owned by the page, so a
 * dashboard such as Stairway can keep one tab per experiment and tidy up after
 * itself. Each origin asks once; the answer is kept in Settings → General.
 */

const MAX_MEMBERS = 24;

interface Request {
  method: string;
  args?: Record<string, unknown>;
}

type Reply = { ok: true; result?: unknown } | { ok: false; error: string };

export class PageTabsManager {
  private readonly c: Controller;
  private readonly asking = new Map<string, Promise<boolean>>();

  constructor(c: Controller) {
    this.c = c;
  }

  init(): void {
    ipcMain.handle('pagetabs', (event, raw: unknown) => this.handle(event, raw));
  }

  private async handle(event: IpcMainInvokeEvent, raw: unknown): Promise<Reply> {
    const tabId = this.c.tabs.tabIdOf(event.sender);
    if (!tabId || typeof raw !== 'object' || raw === null) return { ok: false, error: 'not a Chord tab' };
    if (event.senderFrame !== event.sender.mainFrame) return { ok: false, error: 'only the top frame may manage tabs' };
    const origin = originOf(event.senderFrame?.url ?? '');
    if (!origin) return { ok: false, error: 'only https pages (or localhost) may manage tabs' };
    const req = raw as Request;
    const method = typeof req.method === 'string' ? req.method : '';
    const args = (typeof req.args === 'object' && req.args !== null ? req.args : {}) as Record<string, unknown>;

    if (method === 'status') return { ok: true, result: { granted: this.allowed(origin) } };
    if (method === 'theme') return { ok: true, result: this.c.themeFor(tabId) };
    if (!(await this.permission(origin, tabId))) return { ok: false, error: `${origin} may not manage tabs in Chord` };
    const tab = this.c.state.tabs[tabId];
    if (!tab || !tab.spaceId) return { ok: false, error: 'tab gone' };
    if (method === 'request') return { ok: true, result: { granted: true } };

    try {
      switch (method) {
        case 'card':
          this.c.smart.setCard(tabId, args.card ?? null);
          return { ok: true };
        case 'unread':
          this.c.smart.setUnread(tabId, typeof args.count === 'number' ? args.count : null);
          return { ok: true };
        case 'notify':
          this.c.smart.notify(tabId, String(args.title ?? ''), String(args.body ?? ''));
          return { ok: true };
        case 'bookmark': {
          const url = String(args.url ?? tab.url);
          if (!/^https?:\/\//i.test(url)) throw new Error('url must be http(s)');
          this.c.apply({ type: 'bookmark.add', url, title: String(args.title ?? tab.title ?? url).slice(0, 300), public: args.public === true, note: typeof args.note === 'string' ? args.note : undefined, tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined, spaceId: tab.spaceId });
          return { ok: true };
        }
        case 'note': {
          const text = String(args.text ?? '').trim();
          if (!text) throw new Error('text is empty');
          const space = spaceById(this.c.state, tab.spaceId);
          if (!space) throw new Error('space gone');
          this.c.apply({ type: 'space.notes', id: space.id, text: `${space.notes ? `${space.notes.replace(/\s+$/, '')}\n\n` : ''}${text.slice(0, 20_000)}` });
          return { ok: true };
        }
        case 'subscribe': {
          const feed = await this.c.reader.subscribe(String(args.url ?? tab.url), null, undefined, tab.spaceId);
          if (!feed) throw new Error(this.c.reader.status().error || 'no feed found');
          return { ok: true, result: { title: feed.title, url: feed.url } };
        }
        case 'openUrl': {
          const url = String(args.url ?? '');
          if (!/^https?:\/\//i.test(url) || url.length > 4000) throw new Error('url must be http(s)');
          this.c.apply({ type: 'tab.new', url, spaceId: tab.spaceId, activate: args.background !== true });
          return { ok: true };
        }
        case 'little': {
          const url = String(args.url ?? '');
          if (!/^https?:\/\//i.test(url) || url.length > 4000) throw new Error('url must be http(s)');
          this.c.little.open(url);
          return { ok: true };
        }
        case 'open': {
          const url = String(args.url ?? '');
          if (!/^https?:\/\//i.test(url) || url.length > 4000) throw new Error('url must be http(s)');
          const group = this.group(tabId, true)!;
          const space = spaceById(this.c.state, tab.spaceId)!;
          if (membersOf(this.c.state, space, group.id).length >= MAX_MEMBERS) throw new Error(`a page may keep at most ${MAX_MEMBERS} tabs open`);
          const id = randomUUID();
          this.c.apply({ type: 'tab.new', url, spaceId: tab.spaceId, activate: args.activate === true, id });
          this.c.apply({ type: 'tab.setGroup', id, groupId: group.id });
          return { ok: true, result: this.info(id) };
        }
        case 'close': {
          const id = this.member(tabId, args.id);
          this.c.apply({ type: 'tab.close', id });
          return { ok: true };
        }
        case 'focus': {
          const id = this.member(tabId, args.id);
          this.c.apply({ type: 'tab.activate', id });
          return { ok: true };
        }
        case 'navigate': {
          const id = this.member(tabId, args.id);
          const url = String(args.url ?? '');
          if (!/^https?:\/\//i.test(url) || url.length > 4000) throw new Error('url must be http(s)');
          const view = this.c.tabs.get(id);
          if (view && !view.webContents.isDestroyed()) void view.webContents.loadURL(url);
          else this.c.apply({ type: 'tab.patch', id, patch: { url } });
          return { ok: true };
        }
        case 'list': {
          const group = this.group(tabId, false);
          if (!group) return { ok: true, result: [] };
          const space = spaceById(this.c.state, tab.spaceId)!;
          return { ok: true, result: membersOf(this.c.state, space, group.id).filter((id) => id !== tabId).map((id) => this.info(id)) };
        }
        case 'name': {
          const name = String(args.name ?? '').trim().slice(0, 60);
          if (!name) throw new Error('name required');
          const group = this.group(tabId, true)!;
          this.c.apply({ type: 'group.rename', id: group.id, name });
          return { ok: true };
        }
        default:
          throw new Error(`unknown method ${method}`);
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Granted by the user, or a site the user wrote a boost for: boosts are theirs, so their sites are trusted. */
  private allowed(origin: string): boolean {
    if (this.c.state.settings.pageTabs.includes(origin)) return true;
    const host = hostOf(origin);
    return host !== '' && boostsFor(this.c.state.settings.boosts, host).length > 0;
  }

  private permission(origin: string, tabId: TabId): Promise<boolean> {
    if (this.allowed(origin)) return Promise.resolve(true);
    const pending = this.asking.get(origin);
    if (pending) return pending;
    const p = (async () => {
      const win = this.c.win;
      if (!win) return false;
      const space = spaceById(this.c.state, this.c.state.tabs[tabId]?.spaceId ?? '');
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Allow', 'Block'],
        defaultId: 0,
        cancelId: 1,
        message: `${origin} wants to manage tabs in “${space?.name ?? 'this space'}”`,
        detail: 'The page could open tabs of its own in this space, grouped under it as a subspace, and close them again. It cannot touch your other tabs. Allowed sites are listed in Settings → General.',
      });
      const allowed = response === 0;
      if (allowed) this.c.apply({ type: 'settings.update', patch: { pageTabs: [...this.c.state.settings.pageTabs, origin] } });
      return allowed;
    })().finally(() => this.asking.delete(origin));
    this.asking.set(origin, p);
    return p;
  }

  /** The subspace owned by `tabId`, created on demand. */
  private group(tabId: TabId, create: boolean): TabGroup | undefined {
    const tab = this.c.state.tabs[tabId];
    const space = tab?.spaceId ? spaceById(this.c.state, tab.spaceId) : undefined;
    if (!tab || !space) return undefined;
    const existing = space.groups?.find((g) => g.owner === tabId);
    if (existing || !create) return existing;
    const id = randomUUID();
    this.c.apply({ type: 'group.create', spaceId: space.id, name: tab.title || hostOf(tab.url), owner: tabId, id, tabIds: [tabId] });
    return spaceById(this.c.state, space.id)?.groups?.find((g) => g.id === id);
  }

  private member(ownerId: TabId, id: unknown): TabId {
    const group = this.group(ownerId, false);
    const tab = typeof id === 'string' ? this.c.state.tabs[id] : undefined;
    if (!group || !tab || tab.groupId !== group.id || tab.id === ownerId) throw new Error('not a tab this page opened');
    return tab.id;
  }

  private info(id: TabId): { id: TabId; url: string; title: string } {
    const t = this.c.state.tabs[id];
    return { id, url: t?.url ?? '', title: t?.title ?? '' };
  }

  /** Tell owning pages when their tabs close or move to a new page. */
  diff(prev: State, next: State): void {
    for (const space of next.spaces) {
      for (const g of space.groups ?? []) {
        if (!g.owner) continue;
        const view = this.c.tabs.get(g.owner);
        if (!view || view.webContents.isDestroyed()) continue;
        const prevSpace = spaceById(prev, space.id);
        const before = prevSpace ? membersOf(prev, prevSpace, g.id).filter((id) => id !== g.owner) : [];
        const after = new Set(membersOf(next, space, g.id).filter((id) => id !== g.owner));
        for (const id of before) {
          if (!after.has(id)) view.webContents.send('pagetabs:event', { type: 'tabclosed', id });
          else if (prev.tabs[id]?.url !== next.tabs[id]?.url || prev.tabs[id]?.title !== next.tabs[id]?.title) view.webContents.send('pagetabs:event', { type: 'tabchanged', ...this.info(id) });
        }
      }
    }
  }
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) return u.origin;
  } catch {
    /* not a url */
  }
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
