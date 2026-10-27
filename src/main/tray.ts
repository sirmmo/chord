import { app, Menu, Tray, type MenuItemConstructorOptions } from 'electron';
import type { Controller } from './controller.ts';
import { isMac } from './platform.ts';
import { trayIcon } from './trayicon.ts';

/**
 * Menu bar / tray presence while "keep running when the window is closed" is on:
 * reopen the window, control the current player or call, see downloads, quit.
 */
export class TrayManager {
  private readonly c: Controller;
  private tray: Tray | null = null;

  constructor(c: Controller) {
    this.c = c;
  }

  sync(enabled: boolean): void {
    if (enabled && !this.tray) {
      this.tray = new Tray(trayIcon(isMac));
      this.tray.setToolTip('Chord');
      if (!isMac) this.tray.on('click', () => this.c.focusWindow());
      this.refresh();
    } else if (!enabled && this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  refresh(): void {
    if (!this.tray) return;
    const items: MenuItemConstructorOptions[] = [{ label: 'Show Chord', click: () => this.c.focusWindow() }, { type: 'separator' }];
    const smart = this.c.smart.getStatus();
    const tabs = this.c.state.tabs;

    const player = Object.entries(smart)
      .filter(([id, s]) => s.media && tabs[id])
      .sort((a, b) => Number(b[1].media!.playing) - Number(a[1].media!.playing) || b[1].media!.updatedAt - a[1].media!.updatedAt)[0];
    if (player) {
      const [id, s] = player;
      const m = s.media!;
      const label = [m.title || tabs[id].title, m.artist].filter(Boolean).join(' — ');
      items.push(
        { label: label.slice(0, 60), enabled: false },
        { label: m.playing ? 'Pause' : 'Play', click: () => this.c.smart.mediaAction(id, m.playing ? 'pause' : 'play') },
        { label: 'Next Track', enabled: m.actions.includes('nexttrack'), click: () => this.c.smart.mediaAction(id, 'nexttrack') },
        { label: 'Previous Track', enabled: m.actions.includes('previoustrack'), click: () => this.c.smart.mediaAction(id, 'previoustrack') },
        { type: 'separator' },
      );
    }

    const call = Object.entries(smart).find(([id, s]) => s.call && tabs[id]);
    if (call) {
      const [id, s] = call;
      const info = s.call!;
      items.push(
        { label: `In a call on ${info.site || tabs[id].title}`, enabled: false },
        { label: info.muted ? 'Unmute' : 'Mute', click: () => this.c.smart.callAction(id, 'mute') },
        { label: info.cameraOff ? 'Turn Camera On' : 'Turn Camera Off', click: () => this.c.smart.callAction(id, 'camera') },
        { label: 'Leave Call', click: () => this.c.smart.callAction(id, 'leave') },
        { type: 'separator' },
      );
    }

    const active = this.c.downloads.status().active;
    items.push({ label: active ? `Downloads (${active} in progress)` : 'Downloads', click: () => this.c.openInternalFromTray('chord://downloads/') });
    items.push({ type: 'separator' }, { label: 'Quit Chord', click: () => app.quit() });
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }
}
