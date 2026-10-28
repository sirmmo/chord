import { app, dialog, ipcMain, nativeImage, shell } from 'electron';
import { join } from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Easel, EaselItem, EaselStatus, SpaceId, TabId } from '../shared/types.ts';
import { focusedTab, spaceById } from '../shared/model.ts';
import { hostOf, isInternal } from '../shared/url.ts';
import { Store } from './store.ts';
import { EASEL_IMAGES_DIR } from './paths.ts';
import type { Controller } from './controller.ts';

/**
 * Easels: a freeform canvas per space (several, if wanted) holding notes,
 * links, clipped text and pictures, in easels.json. Pictures (page snapshots,
 * pasted or dropped images) live as files in the easels folder and are served
 * to the page as chord://easel/images/<file>.
 */

interface File {
  easels: Easel[];
}

const MAX_ITEMS = 500;
const MAX_TEXT = 20_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_WIDTH = 1200;

export class EaselManager {
  private readonly c: Controller;
  private readonly store: Store<File>;
  private easels: Easel[] = [];

  constructor(c: Controller) {
    this.c = c;
    this.store = new Store(join(app.getPath('userData'), 'easels.json'));
  }

  init(): void {
    const raw = this.store.load() as Partial<File> | null;
    if (raw && Array.isArray(raw.easels)) {
      this.easels = raw.easels
        .filter((e) => e && typeof e.id === 'string' && typeof e.spaceId === 'string')
        .map((e) => ({ ...e, name: typeof e.name === 'string' ? e.name : 'Easel', items: Array.isArray(e.items) ? e.items.filter(validItem) : [], createdAt: e.createdAt || Date.now(), updatedAt: e.updatedAt || Date.now() }));
    }
    ipcMain.handle('easels', (event) => (this.c.trustedEvent(event) ? this.status() : null));
  }

  status(): EaselStatus {
    return { easels: this.easels };
  }

  get(id: string): Easel | undefined {
    return this.easels.find((e) => e.id === id);
  }

  /** The easels of a space, oldest first. */
  forSpace(spaceId: SpaceId): Easel[] {
    return this.easels.filter((e) => e.spaceId === spaceId);
  }

  /** The easel an item lands on when none is named: the space's first, created if the space has none. */
  private target(id: string | undefined, spaceId: SpaceId | null): Easel | null {
    if (id) return this.get(id) ?? null;
    if (!spaceId) return null;
    const sp = spaceById(this.c.state, spaceId);
    if (!sp || sp.reader) return null;
    return this.forSpace(spaceId)[0] ?? this.create(spaceId);
  }

  create(spaceId: SpaceId, name?: string): Easel {
    const n = this.forSpace(spaceId).length;
    const easel: Easel = { id: randomUUID(), spaceId, name: (name ?? '').trim() || (n ? `Easel ${n + 1}` : 'Easel'), items: [], createdAt: Date.now(), updatedAt: Date.now() };
    this.easels.push(easel);
    this.changed();
    return easel;
  }

  rename(id: string, name: string): void {
    const e = this.get(id);
    if (!e || !name.trim()) return;
    e.name = name.trim().slice(0, 80);
    e.updatedAt = Date.now();
    this.changed();
  }

  async remove(id: string): Promise<void> {
    const e = this.get(id);
    if (!e) return;
    if (e.items.length) {
      const { response } = await dialog.showMessageBox({ type: 'question', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, message: `Delete the easel “${e.name}”?`, detail: `Its ${e.items.length} item${e.items.length === 1 ? '' : 's'} go with it.` });
      if (response !== 0) return;
    }
    for (const it of e.items) this.dropImage(it);
    this.easels = this.easels.filter((x) => x.id !== id);
    this.changed();
  }

  /** A space is gone: its easels and their pictures go with it. */
  keepOnly(spaceIds: Set<SpaceId>): void {
    const gone = this.easels.filter((e) => !spaceIds.has(e.spaceId));
    if (!gone.length) return;
    for (const e of gone) for (const it of e.items) this.dropImage(it);
    this.easels = this.easels.filter((e) => spaceIds.has(e.spaceId));
    this.changed();
  }

  /** Insert or replace one item. */
  put(id: string, item: EaselItem): void {
    const e = this.get(id);
    if (!e || !validItem(item)) return;
    const clean = cleanItem(item);
    if (clean.kind === 'link' && clean.url && (!clean.title || clean.title === clean.url)) void this.fetchTitle(id, clean.id, clean.url);
    const i = e.items.findIndex((x) => x.id === clean.id);
    if (i >= 0) {
      const prev = e.items[i];
      if (prev.image && prev.image !== clean.image) this.dropImage(prev);
      e.items[i] = { ...clean, image: clean.image ?? prev.image, createdAt: prev.createdAt };
    } else {
      if (e.items.length >= MAX_ITEMS) return;
      e.items.push(clean);
    }
    e.updatedAt = Date.now();
    this.changed();
  }

  removeItem(id: string, itemId: string): void {
    const e = this.get(id);
    if (!e) return;
    const it = e.items.find((x) => x.id === itemId);
    if (!it) return;
    this.dropImage(it);
    e.items = e.items.filter((x) => x.id !== itemId);
    e.updatedAt = Date.now();
    this.changed();
  }

  private add(e: Easel, partial: Partial<EaselItem> & { kind: EaselItem['kind'] }): EaselItem {
    const spot = this.freeSpot(e, partial.w ?? 240, partial.h ?? 160);
    const item: EaselItem = {
      id: randomUUID(),
      x: spot.x,
      y: spot.y,
      w: 240,
      h: 160,
      z: e.items.reduce((m, it) => Math.max(m, it.z), 0) + 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...partial,
    };
    this.put(e.id, item);
    return item;
  }

  /** A spot below the lowest item, so new things never land on top of each other. */
  private freeSpot(e: Easel, w: number, h: number): { x: number; y: number } {
    if (!e.items.length) return { x: 80, y: 80 };
    const bottom = Math.max(...e.items.map((it) => it.y + it.h));
    const right = Math.max(...e.items.map((it) => it.x + it.w));
    const last = e.items.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
    const beside = { x: last.x + last.w + 24, y: last.y };
    const overlaps = e.items.some((it) => beside.x < it.x + it.w && beside.x + w > it.x && beside.y < it.y + it.h && beside.y + h > it.y);
    if (!overlaps && beside.x + w < Math.max(right, 1400)) return beside;
    return { x: 80, y: bottom + 24 };
  }

  /** A link card for a page (the focused one by default). */
  addPage(id: string | undefined, tabId?: TabId): void {
    const tab = tabId ? this.c.state.tabs[tabId] : focusedTab(this.c.state);
    if (!tab || isInternal(tab.url)) return;
    const e = this.target(id, tab.spaceId);
    if (!e) return;
    this.add(e, { kind: 'link', url: tab.url, title: tab.title || tab.url, w: 260, h: 110 });
    this.c.sendSidebar({ kind: 'toast', text: `Added to ${e.name}`, detail: tab.title || tab.url });
  }

  /** A picture of a page as it looks now, with a link back to it. */
  async snapshot(id: string | undefined, tabId?: TabId): Promise<void> {
    const tab = tabId ? this.c.state.tabs[tabId] : focusedTab(this.c.state);
    if (!tab || isInternal(tab.url)) return;
    const wc = this.c.tabs.get(tab.id)?.webContents;
    if (!wc || wc.isDestroyed()) return;
    const e = this.target(id, tab.spaceId);
    if (!e) return;
    try {
      let img = await wc.capturePage();
      const size = img.getSize();
      if (size.width > SNAPSHOT_WIDTH) img = img.resize({ width: SNAPSHOT_WIDTH });
      const file = await this.saveImage(img.toPNG(), 'png');
      const dims = img.getSize();
      const w = Math.min(420, dims.width);
      const h = Math.round((w * dims.height) / dims.width) + 28;
      this.add(e, { kind: 'image', image: file, url: tab.url, title: tab.title || tab.url, w, h });
      this.c.sendSidebar({ kind: 'toast', text: `Snapshot added to ${e.name}`, detail: tab.title || tab.url });
    } catch (err) {
      console.error('easel snapshot:', err);
    }
  }

  /** Selected text from a page, with where it came from. */
  clip(id: string | undefined, text: string, url: string, title: string): void {
    const tab = focusedTab(this.c.state);
    const e = this.target(id, tab?.spaceId ?? this.c.state.activeSpaceId);
    if (!e || !text.trim()) return;
    const t = text.trim().slice(0, MAX_TEXT);
    this.add(e, { kind: 'clip', text: t, url, title, w: 300, h: Math.min(360, 80 + Math.ceil(t.length / 40) * 20) });
    this.c.sendSidebar({ kind: 'toast', text: `Clipped to ${e.name}`, detail: t.slice(0, 80) });
  }

  /** A pasted or dropped picture, as a data URL from the easel page. */
  async image(id: string, dataUrl: string, url?: string, title?: string, x?: number, y?: number): Promise<void> {
    const e = this.get(id);
    if (!e) return;
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i.exec(dataUrl);
    if (!m) return;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE_BYTES) return;
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const file = await this.saveImage(buf, ext);
    const dims = safeSize(buf, ext);
    const w = Math.min(360, dims.width || 360);
    const h = dims.width ? Math.round((w * dims.height) / dims.width) + (url ? 28 : 0) : 240;
    const at = x !== undefined && y !== undefined ? { x, y } : {};
    this.add(e, { kind: 'image', image: file, url, title, w, h, ...at });
  }

  /** An image from a page, by its address (context menu on a picture). */
  async imageUrl(id: string | undefined, src: string, url: string, title: string): Promise<void> {
    const tab = focusedTab(this.c.state);
    const e = this.target(id, tab?.spaceId ?? this.c.state.activeSpaceId);
    if (!e) return;
    try {
      const res = await fetch(src);
      const type = res.headers.get('content-type') ?? '';
      const ext = /png/.test(type) ? 'png' : /gif/.test(type) ? 'gif' : /webp/.test(type) ? 'webp' : /jpe?g/.test(type) ? 'jpg' : '';
      if (!ext) return;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) return;
      const file = await this.saveImage(buf, ext);
      const dims = safeSize(buf, ext);
      const w = Math.min(360, dims.width || 360);
      const h = dims.width ? Math.round((w * dims.height) / dims.width) + 28 : 240;
      this.add(e, { kind: 'image', image: file, url, title, w, h });
      this.c.sendSidebar({ kind: 'toast', text: `Picture added to ${e.name}`, detail: title || hostOf(url) });
    } catch (err) {
      console.error('easel image:', err);
    }
  }

  /** The easel as a Markdown file: notes, links, clips with their sources, pictures copied next to it. */
  async export(id: string): Promise<void> {
    const e = this.get(id);
    if (!e) return;
    const sp = spaceById(this.c.state, e.spaceId);
    const { filePath } = await dialog.showSaveDialog({ defaultPath: `${e.name}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!filePath) return;
    const dir = filePath.replace(/[^/\\]+$/, '');
    const lines = [`# ${e.name}`, '', `Easel of the space “${sp?.name ?? e.spaceId}” in Chord, exported ${new Date().toISOString().slice(0, 10)}.`, ''];
    const sorted = [...e.items].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const it of sorted) {
      if (it.kind === 'note') lines.push(it.text ?? '', '');
      else if (it.kind === 'link') lines.push(`- [${it.title || it.url}](${it.url})`, '');
      else if (it.kind === 'clip') lines.push(...(it.text ?? '').split('\n').map((l) => `> ${l}`), it.url ? `> — [${it.title || hostOf(it.url)}](${it.url})` : '', '');
      else if (it.kind === 'image' && it.image) {
        try {
          const data = await readFile(join(EASEL_IMAGES_DIR, it.image));
          await writeFile(join(dir, it.image), data);
          lines.push(`![${it.title ?? ''}](${it.image})`, it.url ? `[${it.title || hostOf(it.url)}](${it.url})` : '', '');
        } catch {
          /* picture gone */
        }
      }
    }
    await writeFile(filePath, lines.join('\n'));
    shell.showItemInFolder(filePath);
  }

  /** A pasted link gets the page's title once it is known. */
  private async fetchTitle(easelId: string, itemId: string, url: string): Promise<void> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'text/html' } });
      clearTimeout(t);
      if (!/text\/html/i.test(res.headers.get('content-type') ?? '')) return;
      const html = (await res.text()).slice(0, 200_000);
      const m = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html) ?? /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,300})["']/i.exec(html);
      const title = m ? m[1].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim() : '';
      const e = this.get(easelId);
      const it = e?.items.find((x) => x.id === itemId);
      if (!e || !it || !title || (it.title && it.title !== it.url)) return;
      it.title = title;
      this.changed();
    } catch {
      /* the link keeps its address as title */
    }
  }

  private async saveImage(buf: Buffer, ext: string): Promise<string> {
    await mkdir(EASEL_IMAGES_DIR, { recursive: true });
    const file = `${randomUUID()}.${ext}`;
    await writeFile(join(EASEL_IMAGES_DIR, file), buf);
    return file;
  }

  private dropImage(it: EaselItem): void {
    if (!it.image || !/^[\w-]+\.(png|jpg|gif|webp)$/.test(it.image)) return;
    const file = it.image;
    if (this.easels.some((e) => e.items.some((x) => x !== it && x.image === file))) return;
    void unlink(join(EASEL_IMAGES_DIR, file)).catch(() => {});
  }

  private changed(): void {
    this.store.save({ easels: this.easels });
    this.c.sendAll('easels', this.status());
  }
}

function validItem(it: unknown): it is EaselItem {
  const o = it as Partial<EaselItem> | null;
  return !!o && typeof o.id === 'string' && (o.kind === 'note' || o.kind === 'link' || o.kind === 'image' || o.kind === 'clip') && typeof o.x === 'number' && typeof o.y === 'number';
}

function cleanItem(it: EaselItem): EaselItem {
  const num = (v: unknown, d: number, lo = -1e6, hi = 1e6) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  return {
    id: it.id.slice(0, 64),
    kind: it.kind,
    x: num(it.x, 0),
    y: num(it.y, 0),
    w: num(it.w, 240, 60, 4000),
    h: num(it.h, 160, 40, 4000),
    z: num(it.z, 1, 0, 1e9),
    text: typeof it.text === 'string' ? it.text.slice(0, MAX_TEXT) : undefined,
    url: typeof it.url === 'string' && /^https?:/i.test(it.url) ? it.url.slice(0, 2000) : undefined,
    title: typeof it.title === 'string' ? it.title.slice(0, 300) : undefined,
    image: typeof it.image === 'string' && /^[\w-]+\.(png|jpg|gif|webp)$/.test(it.image) ? it.image : undefined,
    color: typeof it.color === 'string' && /^[a-z]{1,12}$/.test(it.color) ? it.color : undefined,
    createdAt: num(it.createdAt, Date.now(), 0, 1e14),
    updatedAt: Date.now(),
  };
}

/** Pixel size of a PNG, JPEG, GIF or WebP from its header; zeros when unreadable. */
function safeSize(buf: Buffer, ext: string): { width: number; height: number } {
  try {
    if (ext === 'png' && buf.length > 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (ext === 'gif' && buf.length > 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    const img = nativeImage.createFromBuffer(buf);
    const s = img.getSize();
    return { width: s.width, height: s.height };
  } catch {
    return { width: 0, height: 0 };
  }
}
