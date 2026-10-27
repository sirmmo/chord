import { app, net, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateChannel, UpdateStatus } from '../shared/types.ts';
import { assetFor, compareVersions } from '../shared/version.ts';
import type { Controller } from './controller.ts';

const REPO = 'sirmmo/chord';
const RELEASES = `https://github.com/${REPO}/releases`;
const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 3600_000;

/**
 * Update checks for every build, self-update where the packaging allows it.
 * The Windows installer and the Linux AppImage replace themselves through
 * electron-updater (fed by the latest*.yml files electron-builder publishes
 * with each release). The unsigned macOS build, the Windows portable zip and
 * the .deb cannot swap themselves out, so for those Chord looks at the GitHub
 * releases API and offers the matching download.
 */
export class UpdateManager {
  private readonly c: Controller;
  status: UpdateStatus;
  private timer: NodeJS.Timeout | null = null;
  private wired = false;
  private checking = false;

  constructor(c: Controller) {
    this.c = c;
    const channel = detectChannel();
    this.status = { state: 'idle', channel, canInstall: channel === 'nsis' || channel === 'appimage', current: app.getVersion() };
  }

  init(): void {
    this.schedule();
  }

  /** Called when the updates settings change. */
  schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!app.isPackaged || !this.c.state.settings.updates.check) return;
    setTimeout(() => void this.check(false), FIRST_CHECK_MS).unref();
    this.timer = setInterval(() => void this.check(false), CHECK_EVERY_MS);
    this.timer.unref();
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.c.sendAll('updates', this.status);
  }

  async check(manual: boolean): Promise<void> {
    if (this.checking) return;
    if (this.status.state === 'downloading' || this.status.state === 'ready') return;
    this.checking = true;
    this.set({ state: 'checking', error: undefined });
    try {
      if (this.status.canInstall) await this.checkWithUpdater();
      else await this.checkWithApi();
      this.set({ checkedAt: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.set({ state: manual ? 'error' : 'idle', error: manual ? message : undefined, checkedAt: Date.now() });
    } finally {
      this.checking = false;
    }
  }

  private wireUpdater(): void {
    if (this.wired) return;
    this.wired = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', progress: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version, progress: 100 }));
    autoUpdater.on('error', (err) => {
      if (this.status.state === 'downloading') this.set({ state: 'error', error: err.message });
    });
  }

  private async checkWithUpdater(): Promise<void> {
    this.wireUpdater();
    const result = await autoUpdater.checkForUpdates();
    const version = result?.updateInfo?.version;
    if (!version || compareVersions(version, app.getVersion()) <= 0) {
      this.set({ state: 'none', version: undefined, url: undefined });
      return;
    }
    this.set({ state: 'available', version, url: `${RELEASES}/tag/v${version}` });
    if (this.c.state.settings.updates.auto) await this.download();
  }

  private async checkWithApi(): Promise<void> {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Chord/${app.getVersion()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rel = (await res.json()) as { tag_name?: string; html_url?: string; assets?: { name: string; browser_download_url: string }[] };
    const version = (rel.tag_name ?? '').replace(/^v/, '');
    if (!version || compareVersions(version, app.getVersion()) <= 0) {
      this.set({ state: 'none', version: undefined, url: undefined });
      return;
    }
    const names = (rel.assets ?? []).map((a) => a.name);
    const asset = assetFor(names, this.status.channel);
    const url = asset ? rel.assets!.find((a) => a.name === asset)!.browser_download_url : (rel.html_url ?? `${RELEASES}/tag/v${version}`);
    this.set({ state: 'available', version, url });
  }

  async download(): Promise<void> {
    if (!this.status.canInstall) {
      this.openPage();
      return;
    }
    if (this.status.state !== 'available') return;
    this.wireUpdater();
    this.set({ state: 'downloading', progress: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      this.set({ state: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  install(): void {
    if (this.status.state !== 'ready') return;
    this.c.quitting = true;
    this.c.store.flush();
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  }

  openPage(): void {
    void shell.openExternal(this.status.url ?? `${RELEASES}/latest`);
  }
}

function detectChannel(): UpdateChannel {
  if (!app.isPackaged) return 'dev';
  // Builds on Electron 43 exist for macOS 12, which Electron 44+ no longer runs on.
  if (process.platform === 'darwin') return Number(process.versions.electron.split('.')[0]) < 44 ? 'mac-legacy' : 'mac';
  if (process.platform === 'win32') return app.getPath('userData').endsWith('ChordData') || process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'nsis';
  return process.env.APPIMAGE ? 'appimage' : 'deb';
}
