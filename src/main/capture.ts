import { desktopCapturer, shell, systemPreferences, webContents, type Session, type Streams, type WebFrameMain } from 'electron';
import { randomUUID } from 'node:crypto';
import type { CaptureSource } from '../shared/types.ts';
import type { Controller } from './controller.ts';
import { isMac } from './platform.ts';
import { onSession } from './session.ts';
import { spaceOfTab } from '../shared/model.ts';

type Reply = (streams: Streams | null) => void;

interface Pending {
  reply: Reply;
  frame: WebFrameMain | null;
  audio: boolean;
}

/**
 * Screen sharing. Chromium only hands `getDisplayMedia` a stream when the app
 * supplies one, so every browsing session gets a display-media handler. On
 * macOS 15+ the system picker does the choosing; elsewhere Chord lists screens,
 * windows and its own tabs in the overlay and lets the user pick.
 */
export class CaptureManager {
  private readonly c: Controller;
  private pending = new Map<string, Pending>();

  constructor(c: Controller) {
    this.c = c;
  }

  init(): void {
    onSession((ses: Session) => {
      ses.setDisplayMediaRequestHandler((request, callback) => void this.handle(request.securityOrigin, request.frame, request.audioRequested, callback), {
        useSystemPicker: true,
      });
    });
  }

  private async handle(origin: string, frame: WebFrameMain | null, audio: boolean, reply: Reply): Promise<void> {
    // Only one picker at a time: a second request while one is open is refused.
    if (this.pending.size) return reply(null);
    const token = randomUUID();
    this.pending.set(token, { reply, frame, audio });
    const sources = await this.listSources(frame);
    if (!this.pending.has(token)) return;
    const needsPermission = isMac && systemPreferences.getMediaAccessStatus('screen') !== 'granted';
    this.c.overlay.show({ kind: 'show', mode: 'sources', token, origin: prettyOrigin(origin), audio, sources, needsPermission });
  }

  private async listSources(requester: WebFrameMain | null): Promise<CaptureSource[]> {
    const out: CaptureSource[] = [];
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: true });
      for (const s of sources) {
        if (s.name === 'Chord' || s.name.startsWith('Chord —')) continue;
        out.push({
          id: s.id,
          name: s.name || (s.id.startsWith('screen') ? 'Screen' : 'Window'),
          kind: s.id.startsWith('screen') ? 'screen' : 'window',
          thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
          icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.resize({ width: 32 }).toDataURL() : undefined,
        });
      }
    } catch (err) {
      console.error('desktopCapturer failed:', err);
    }
    // Chord's own tabs, so a page can share another tab (the requesting one is left out).
    const requesterWc = requester ? webContents.fromFrame(requester) : undefined;
    const requesterId = requesterWc ? this.c.tabs.tabIdOf(requesterWc) : undefined;
    for (const tab of Object.values(this.c.state.tabs)) {
      if (!tab.awake || tab.id === requesterId) continue;
      if (spaceOfTab(this.c.state, tab).locked) continue;
      const view = this.c.tabs.get(tab.id);
      if (!view || view.webContents.isDestroyed()) continue;
      out.push({ id: `tab:${tab.id}`, name: tab.title || tab.url, kind: 'tab', thumbnail: '', icon: tab.favicon });
    }
    return out;
  }

  /** The user picked a source (or dismissed the picker with `null`). */
  pick(token: string, id: string | null): void {
    const p = this.pending.get(token);
    if (!p) return;
    this.pending.delete(token);
    this.c.overlay.hide();
    if (!id) return p.reply(null);
    try {
      if (id.startsWith('tab:')) {
        const view = this.c.tabs.get(id.slice(4));
        if (!view || view.webContents.isDestroyed()) return p.reply(null);
        const frame = view.webContents.mainFrame;
        p.reply({ video: frame, audio: p.audio ? frame : undefined, enableLocalEcho: true });
        return;
      }
      p.reply({ video: { id, name: id }, audio: p.audio && process.platform === 'win32' ? 'loopback' : undefined });
    } catch (err) {
      console.error('Could not start capture:', err);
      try {
        p.reply(null);
      } catch {
        /* already answered */
      }
    }
  }

  /** The overlay was closed some other way: refuse the outstanding request. */
  cancel(): void {
    for (const p of this.pending.values()) {
      try {
        p.reply(null);
      } catch {
        /* frame gone */
      }
    }
    this.pending.clear();
  }

  openPermissionSettings(): void {
    if (isMac) void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
}

function prettyOrigin(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}
