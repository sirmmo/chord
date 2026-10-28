// Chrome extensions ("add-ins"): unpacked folders the user picked, or packages
// fetched from the Chrome Web Store and unpacked into the profile folder.
// Electron supports a subset of the extension API (content scripts, storage,
// some chrome.* calls); toolbar popups are not rendered.

import { app, dialog, type BrowserWindow } from 'electron';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { ExtensionsStatus, State } from '../shared/types.ts';
import { crxDownloadUrl, crxToZip, extensionIdFrom, localizedName } from '../shared/crx.ts';
import { readZip, safeZipName } from '../shared/zip.ts';
import { browsingSession } from './session.ts';

export interface ExtensionsHost {
  apply(action: { type: 'extension.info'; path: string; name: string; version: string } | { type: 'extension.add'; path: string; name?: string; version?: string; storeId?: string } | { type: 'extension.remove'; path: string }): void;
  onStatus(status: ExtensionsStatus): void;
  entries(): State['settings']['extensions'];
}

const MAX_PACKAGE = 200 * 1024 * 1024;

interface Manifest {
  name?: unknown;
  version?: unknown;
  manifest_version?: unknown;
  default_locale?: unknown;
}

export class ExtensionManager {
  private readonly loaded = new Map<string, string>(); // path -> extension id
  private readonly status: ExtensionsStatus = { paths: {}, install: { busy: false, message: '', error: false } };
  private syncing: Promise<void> = Promise.resolve();

  private readonly host: ExtensionsHost;

  constructor(host: ExtensionsHost) {
    this.host = host;
  }

  getStatus(): ExtensionsStatus {
    return { paths: { ...this.status.paths }, install: { ...this.status.install } };
  }

  /** Where store packages are unpacked: one folder per extension id. */
  static storeDir(): string {
    return join(app.getPath('userData'), 'extensions');
  }

  /** Make the session match the enabled extensions in the settings. Serialised. */
  sync(state: State): Promise<void> {
    this.syncing = this.syncing.then(() => this.doSync(state)).catch((err) => console.error('extension sync failed', err));
    return this.syncing;
  }

  private async doSync(state: State): Promise<void> {
    const ses = browsingSession();
    const wanted = new Map(state.settings.extensions.map((e) => [e.path, e.enabled]));
    let changed = false;
    const paths = this.status.paths;

    for (const [path, id] of [...this.loaded]) {
      if (wanted.get(path)) continue;
      try {
        ses.extensions.removeExtension(id);
      } catch (err) {
        console.error('could not unload extension', path, err);
      }
      this.loaded.delete(path);
      paths[path] = { loaded: false };
      changed = true;
    }
    for (const path of Object.keys(paths)) {
      if (!wanted.has(path)) {
        delete paths[path];
        changed = true;
        // a store package that was removed from the list is deleted from disk too
        const store = ExtensionManager.storeDir();
        if (resolve(path).startsWith(store + sep)) void rm(path, { recursive: true, force: true }).catch(() => {});
      }
    }

    for (const [path, enabled] of wanted) {
      if (!enabled) {
        if (!paths[path] || paths[path].loaded) {
          paths[path] = { loaded: false };
          changed = true;
        }
        continue;
      }
      if (this.loaded.has(path)) continue;
      try {
        const ext = await ses.extensions.loadExtension(path, { allowFileAccess: false });
        this.loaded.set(path, ext.id);
        paths[path] = { loaded: true };
        this.host.apply({ type: 'extension.info', path, name: ext.name, version: ext.version });
      } catch (err) {
        paths[path] = { loaded: false, error: err instanceof Error ? err.message : String(err) };
      }
      changed = true;
    }
    if (changed) this.host.onStatus(this.getStatus());
  }

  /** Let the user pick a folder containing manifest.json, validate it and add it. */
  async pickFolder(win: BrowserWindow): Promise<void> {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Add an unpacked extension',
      message: 'Choose the folder that contains the extension’s manifest.json',
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths[0]) return;
    const path = filePaths[0];
    const info = await readManifest(path);
    if (!info) {
      dialog.showErrorBox('Not an extension', 'That folder has no readable manifest.json. Unpack the extension first, then choose the folder that contains manifest.json.');
      return;
    }
    this.host.apply({ type: 'extension.add', path, name: info.name, version: info.version });
  }

  /** Fetch an extension from the Chrome Web Store by address or id, unpack it and add it. */
  async installFromStore(input: string): Promise<void> {
    const id = extensionIdFrom(input);
    if (!id) return this.report('That is not a Chrome Web Store address or extension id.', true);
    const existing = this.host.entries().find((e) => e.storeId === id);
    if (existing) return this.report(`${existing.name ?? id} is already installed.`, true);
    if (this.status.install.busy) return;
    this.report('Downloading…');
    try {
      const { dir, info } = await this.fetchAndUnpack(id);
      this.host.apply({ type: 'extension.add', path: dir, name: info.name, version: info.version, storeId: id });
      this.report(`Installed ${info.name ?? id} ${info.version ?? ''}`.trim());
    } catch (err) {
      this.report(err instanceof Error ? err.message : String(err), true);
    }
  }

  /** Re-fetch store extensions (one, or every one) and swap in newer versions. */
  async updateFromStore(path?: string): Promise<void> {
    const targets = this.host.entries().filter((e) => e.storeId && (!path || e.path === path));
    if (!targets.length) return this.report('No store extension to update.', true);
    if (this.status.install.busy) return;
    let updated = 0;
    for (const entry of targets) {
      const id = entry.storeId as string;
      this.report(`Checking ${entry.name ?? id}…`);
      try {
        const { dir, info } = await this.fetchAndUnpack(id, entry.path);
        if (info.version && entry.version && info.version === entry.version && dir === entry.path) continue;
        updated++;
        this.host.apply({ type: 'extension.info', path: entry.path, name: info.name ?? entry.name ?? id, version: info.version ?? '' });
        // reload: unload the old copy so the next sync loads the fresh files
        const ses = browsingSession();
        const loadedId = this.loaded.get(entry.path);
        if (loadedId) {
          try {
            ses.extensions.removeExtension(loadedId);
          } catch {
            /* already gone */
          }
          this.loaded.delete(entry.path);
        }
      } catch (err) {
        this.report(`${entry.name ?? id}: ${err instanceof Error ? err.message : String(err)}`, true);
        return;
      }
    }
    this.report(updated ? `Updated ${updated} extension${updated === 1 ? '' : 's'}` : 'Everything is up to date.');
    if (updated) this.host.onStatus(this.getStatus());
  }

  /** Download the package, unpack it into the store folder (replacing what is there) and read its manifest. */
  private async fetchAndUnpack(id: string, into?: string): Promise<{ dir: string; info: { name?: string; version?: string } }> {
    const res = await fetch(crxDownloadUrl(id, process.versions.chrome), { redirect: 'follow' });
    if (!res.ok) throw new Error(res.status === 404 || res.status === 204 ? 'The store has no extension with that id, or it is not available for this platform.' : `The store answered ${res.status}.`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_PACKAGE) throw new Error('That package is too large.');
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_PACKAGE) throw new Error('That package is too large.');
    if (buf.length < 100) throw new Error('The store has no extension with that id.');
    const entries = readZip(crxToZip(buf));
    const dir = into ?? join(ExtensionManager.storeDir(), id);
    const tmp = `${dir}.new`;
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    for (const e of entries) {
      if (!safeZipName(e.name)) continue;
      const target = resolve(tmp, e.name);
      if (!target.startsWith(tmp + sep)) continue;
      if (e.dir) await mkdir(target, { recursive: true });
      else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, e.data);
      }
    }
    const info = await readManifest(tmp);
    if (!info) {
      await rm(tmp, { recursive: true, force: true });
      throw new Error('The package has no manifest.json.');
    }
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
    return { dir, info };
  }

  private report(message: string, error = false): void {
    this.status.install = { busy: !error && message.endsWith('…'), message, error };
    this.host.onStatus(this.getStatus());
  }
}

/** Name and version from a folder's manifest, with "__MSG_…__" names resolved from the default locale. */
async function readManifest(path: string): Promise<{ name?: string; version?: string } | null> {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
  let messages: Record<string, { message?: string }> | null = null;
  if (typeof manifest.name === 'string' && manifest.name.startsWith('__MSG_')) {
    const locales = [typeof manifest.default_locale === 'string' ? manifest.default_locale : 'en', 'en', 'en_US'];
    for (const loc of locales) {
      try {
        messages = JSON.parse(await readFile(join(path, '_locales', loc, 'messages.json'), 'utf8'));
        break;
      } catch {
        /* try the next */
      }
    }
  }
  return { name: localizedName(manifest.name, messages), version: typeof manifest.version === 'string' ? manifest.version : undefined };
}
