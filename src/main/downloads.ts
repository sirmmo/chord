import { app, ipcMain, shell, type DownloadItem, type Session } from 'electron';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import type { DownloadEntry, DownloadsStatus } from '../shared/types.ts';
import { Store } from './store.ts';
import { isMac } from './platform.ts';
import type { Controller } from './controller.ts';

const MAX_HISTORY = 200;
const BROADCAST_MS = 200;

/** Tracks every download of the browsing session and remembers finished ones. */
export class DownloadManager {
  private readonly c: Controller;
  private items: DownloadEntry[] = []; // newest first
  private readonly live = new Map<string, DownloadItem>();
  private readonly speed = new Map<string, { at: number; bytes: number }>();
  private readonly store: Store<DownloadEntry[]>;
  private timer: NodeJS.Timeout | null = null;
  private ses: Session | null = null;

  constructor(c: Controller) {
    this.c = c;
    this.store = new Store(join(app.getPath('userData'), 'downloads.json'));
  }

  init(ses: Session): void {
    this.ses = ses;
    const raw = this.store.load();
    if (Array.isArray(raw)) {
      this.items = raw
        .filter(isEntry)
        .map((e) => (e.state === 'progressing' ? { ...e, state: 'interrupted' as const, paused: false, canResume: false, bytesPerSecond: 0 } : e))
        .slice(0, MAX_HISTORY);
    }
    ses.on('will-download', (_event, item) => this.track(item));
    ipcMain.handle('downloads', () => this.status());
  }

  status(): DownloadsStatus {
    return {
      items: this.items.map((e) => (e.state === 'completed' ? { ...e, exists: existsSync(e.path) } : e)),
      active: this.live.size,
    };
  }

  private track(item: DownloadItem): void {
    const id = randomUUID();
    const dir = app.getPath('downloads');
    if (this.c.state.settings.askDownloadPath) item.setSaveDialogOptions({ defaultPath: join(dir, item.getFilename()) });
    else item.setSavePath(uniquePath(join(dir, item.getFilename())));

    const entry: DownloadEntry = {
      id,
      url: item.getURL(),
      filename: item.getFilename(),
      path: item.getSavePath(),
      total: item.getTotalBytes(),
      received: 0,
      state: 'progressing',
      paused: false,
      canResume: false,
      startedAt: Date.now(),
      bytesPerSecond: 0,
    };
    this.live.set(id, item);
    this.items = [entry, ...this.items].slice(0, MAX_HISTORY);
    this.broadcast();

    const snapshot = (): Partial<DownloadEntry> => {
      const path = item.getSavePath() || entry.path;
      return {
        received: item.getReceivedBytes(),
        total: item.getTotalBytes(),
        path,
        filename: path ? basename(path) : item.getFilename(),
        paused: item.isPaused(),
        canResume: item.canResume(),
      };
    };
    item.on('updated', (_event, state) => {
      const now = Date.now();
      const received = item.getReceivedBytes();
      const last = this.speed.get(id);
      let bytesPerSecond: number | undefined;
      if (!last) this.speed.set(id, { at: now, bytes: received });
      else if (now - last.at >= 500) {
        bytesPerSecond = Math.max(0, ((received - last.bytes) * 1000) / (now - last.at));
        this.speed.set(id, { at: now, bytes: received });
      }
      this.patch(id, { ...snapshot(), state: state === 'interrupted' ? 'interrupted' : 'progressing', ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }) });
    });
    item.once('done', (_event, state) => {
      this.live.delete(id);
      this.speed.delete(id);
      this.patch(id, { ...snapshot(), state, paused: false, canResume: state === 'interrupted' && item.canResume(), bytesPerSecond: 0, finishedAt: Date.now() });
      this.store.save(this.items);
      if (state === 'completed' && isMac) app.dock?.downloadFinished(item.getSavePath());
    });
  }

  private patch(id: string, p: Partial<DownloadEntry>): void {
    this.items = this.items.map((e) => (e.id === id ? { ...e, ...p } : e));
    this.broadcast();
  }

  private broadcast(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.c.sendAll('downloads', this.status());
    }, BROADCAST_MS);
  }

  // ---- commands ----

  pause(id: string): void {
    this.live.get(id)?.pause();
  }

  resume(id: string): void {
    const item = this.live.get(id);
    if (item?.canResume()) item.resume();
  }

  cancel(id: string): void {
    this.live.get(id)?.cancel();
  }

  open(id: string): void {
    const e = this.items.find((x) => x.id === id);
    if (e?.path) void shell.openPath(e.path);
  }

  show(id: string): void {
    const e = this.items.find((x) => x.id === id);
    if (e?.path) shell.showItemInFolder(e.path);
  }

  retry(id: string): void {
    const e = this.items.find((x) => x.id === id);
    if (e && /^https?:/i.test(e.url)) this.ses?.downloadURL(e.url);
  }

  remove(id: string): void {
    this.live.get(id)?.cancel();
    this.items = this.items.filter((e) => e.id !== id);
    this.store.save(this.items);
    this.broadcast();
  }

  clearFinished(): void {
    this.items = this.items.filter((e) => e.state === 'progressing');
    this.store.save(this.items);
    this.broadcast();
  }

  flush(): void {
    this.store.flush();
  }
}

/** "report.pdf" → "report (2).pdf" when the name is taken. */
export function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

function isEntry(v: unknown): v is DownloadEntry {
  return typeof v === 'object' && v !== null && typeof (v as DownloadEntry).id === 'string' && typeof (v as DownloadEntry).url === 'string';
}
