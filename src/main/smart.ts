import { ipcMain, type IpcMainEvent } from 'electron';
import type { CallAction, CallInfo, MediaAction, MediaInfo, SmartInfo, SmartStatus, TabId } from '../shared/types.ts';
import { parseTitleSignals } from '../shared/signals.ts';
import { hostOf } from '../shared/url.ts';
import type { Controller } from './controller.ts';

const BROADCAST_MS = 100;

/**
 * "Smart pages": everything a page gives away that is worth showing across
 * spaces. Players and calls are reported by the page bridge (src/preload/page.ts),
 * notifications are counted as the page creates them, unread counts and timers
 * come from the title.
 */
export class SmartManager {
  private readonly c: Controller;
  private status: SmartStatus = {};
  private timer: NodeJS.Timeout | null = null;

  constructor(c: Controller) {
    this.c = c;
  }

  init(): void {
    ipcMain.on('smart', (event: IpcMainEvent, raw: unknown) => {
      const id = this.c.tabs.tabIdOf(event.sender);
      if (!id) return;
      if (typeof raw !== 'object' || raw === null) return;
      const r = raw as Record<string, unknown>;
      const url = this.c.state.tabs[id]?.url ?? '';
      if (r.kind === 'open') {
        const target = str(r.url, 4000);
        if (!/^(https?|ftp):\/\//i.test(target)) return;
        const opener = this.c.state.tabs[id];
        this.c.apply({ type: 'tab.new', url: target, spaceId: opener?.spaceId ?? this.c.state.activeSpaceId, activate: r.background !== true });
        return;
      }
      if (!this.c.state.settings.smartPages) return;
      if (r.kind === 'notification') {
        const prev = this.status[id] ?? empty();
        this.set(id, {
          ...prev,
          notifications: prev.notifications + 1,
          lastNotification: { title: str(r.title, 120), body: str(r.body, 200), at: Date.now() },
        });
      } else if (r.kind === 'state') {
        const prev = this.status[id] ?? empty();
        const media = sanitizeMedia(r.media, url);
        const call = sanitizeCall(r.call, url, prev.call);
        this.set(id, { ...prev, media: media && (media.title || media.playing) ? media : undefined, call: call ?? undefined });
      }
    });
    ipcMain.handle('smart', () => this.status);
  }

  getStatus(): SmartStatus {
    return this.status;
  }

  /** Page title changed: refresh what we read from it. */
  title(id: TabId, title: string): void {
    if (!this.c.state.settings.smartPages) return;
    const { unread, timer } = parseTitleSignals(title);
    const prev = this.status[id] ?? empty();
    if (prev.unread === unread && prev.timer?.text === timer?.text && prev.timer?.progress === timer?.progress) return;
    this.set(id, { ...prev, unread, timer });
  }

  /** The user looked at the tab: its notifications are no longer news. */
  seen(id: TabId): void {
    const prev = this.status[id];
    if (!prev || prev.notifications === 0) return;
    this.set(id, { ...prev, notifications: 0 });
  }

  clear(id: TabId): void {
    if (!(id in this.status)) return;
    const next = { ...this.status };
    delete next[id];
    this.status = next;
    this.broadcast();
  }

  clearAll(): void {
    if (Object.keys(this.status).length === 0) return;
    this.status = {};
    this.broadcast();
  }

  mediaAction(id: TabId, action: MediaAction): void {
    this.send(id, `media:${action}`);
  }

  callAction(id: TabId, action: CallAction): void {
    this.send(id, `call:${action}`);
  }

  private send(id: TabId, action: string): void {
    const wc = this.c.tabs.get(id)?.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send('smart:action', action);
  }

  private set(id: TabId, info: SmartInfo): void {
    const next = { ...info, updatedAt: Date.now() };
    const isEmpty = !next.media && !next.call && !next.timer && next.unread === undefined && next.notifications === 0;
    if (isEmpty) {
      this.clear(id);
      return;
    }
    this.status = { ...this.status, [id]: next };
    this.broadcast();
  }

  private broadcast(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.c.sendAll('smart', this.status);
      this.c.tray.refresh();
    }, BROADCAST_MS);
  }
}

function empty(): SmartInfo {
  return { notifications: 0, updatedAt: 0 };
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const MEDIA_ACTIONS = new Set(['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'stop']);

function sanitizeMedia(raw: unknown, url: string): MediaInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const artwork = str(r.artwork, 2000);
  return {
    title: str(r.title),
    artist: str(r.artist),
    album: str(r.album),
    artwork: /^(https?:|data:image\/)/i.test(artwork) ? artwork : '',
    playing: r.playing === true,
    actions: Array.isArray(r.actions) ? r.actions.filter((a): a is MediaAction => typeof a === 'string' && MEDIA_ACTIONS.has(a)) : [],
    host: hostOf(url),
    updatedAt: Date.now(),
  };
}

function sanitizeCall(raw: unknown, url: string, prev: CallInfo | undefined): CallInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const tri = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  return {
    since: prev?.since ?? (typeof r.since === 'number' && r.since > 0 ? r.since : Date.now()),
    muted: tri(r.muted),
    cameraOff: tri(r.cameraOff),
    sharing: r.sharing === true,
    canLeave: r.canLeave === true,
    site: hostOf(url),
  };
}
