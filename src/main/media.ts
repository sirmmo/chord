import { ipcMain, type IpcMainEvent } from 'electron';
import type { MediaAction, MediaInfo, MediaStatus, TabId } from '../shared/types.ts';
import { hostOf } from '../shared/url.ts';
import type { Controller } from './controller.ts';

const BROADCAST_MS = 100;

/**
 * "Smart pages": what each page reports through its Media Session (see
 * src/preload/page.ts), keyed by tab. The sidebar shows the current player
 * across spaces and sends play/pause/next/previous back to the page.
 */
export class MediaManager {
  private readonly c: Controller;
  private status: MediaStatus = {};
  private timer: NodeJS.Timeout | null = null;

  constructor(c: Controller) {
    this.c = c;
  }

  init(): void {
    ipcMain.on('media', (event: IpcMainEvent, raw: unknown) => {
      const id = this.c.tabs.tabIdOf(event.sender);
      if (!id || !this.c.state.settings.smartPages) return;
      const info = sanitize(raw, this.c.state.tabs[id]?.url ?? '');
      if (!info) return;
      if (!info.title && !info.playing) {
        this.clear(id);
        return;
      }
      this.status = { ...this.status, [id]: info };
      this.broadcast();
    });
    ipcMain.handle('media', () => this.status);
  }

  getStatus(): MediaStatus {
    return this.status;
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

  act(id: TabId, action: MediaAction): void {
    const wc = this.c.tabs.get(id)?.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send('media:action', action);
  }

  private broadcast(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.c.sendAll('media', this.status);
    }, BROADCAST_MS);
  }
}

const ACTIONS = new Set(['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'stop']);

function sanitize(raw: unknown, url: string): MediaInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
  const artwork = str(r.artwork, 2000);
  return {
    title: str(r.title),
    artist: str(r.artist),
    album: str(r.album),
    artwork: /^(https?:|data:image\/)/i.test(artwork) ? artwork : '',
    playing: r.playing === true,
    actions: Array.isArray(r.actions) ? r.actions.filter((a): a is MediaAction => typeof a === 'string' && ACTIONS.has(a)) : [],
    host: hostOf(url),
    updatedAt: Date.now(),
  };
}
