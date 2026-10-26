// Unpacked Chrome extensions ("add-ins"): loaded into the browsing session
// from folders the user picked. Electron supports a subset of the extension
// API (content scripts, storage, some chrome.* calls); toolbar popups are not
// rendered.

import { dialog, type BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionsStatus, State } from '../shared/types.ts';
import { browsingSession } from './session.ts';

export interface ExtensionsHost {
  apply(action: { type: 'extension.info'; path: string; name: string; version: string } | { type: 'extension.add'; path: string; name?: string; version?: string }): void;
  onStatus(status: ExtensionsStatus): void;
}

export class ExtensionManager {
  private readonly loaded = new Map<string, string>(); // path -> extension id
  private readonly status: ExtensionsStatus = {};
  private syncing: Promise<void> = Promise.resolve();

  private readonly host: ExtensionsHost;

  constructor(host: ExtensionsHost) {
    this.host = host;
  }

  getStatus(): ExtensionsStatus {
    return { ...this.status };
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

    for (const [path, id] of [...this.loaded]) {
      if (wanted.get(path)) continue;
      try {
        ses.extensions.removeExtension(id);
      } catch (err) {
        console.error('could not unload extension', path, err);
      }
      this.loaded.delete(path);
      this.status[path] = { loaded: false };
      changed = true;
    }
    for (const path of Object.keys(this.status)) {
      if (!wanted.has(path)) {
        delete this.status[path];
        changed = true;
      }
    }

    for (const [path, enabled] of wanted) {
      if (!enabled) {
        if (!this.status[path] || this.status[path].loaded) {
          this.status[path] = { loaded: false };
          changed = true;
        }
        continue;
      }
      if (this.loaded.has(path)) continue;
      try {
        const ext = await ses.extensions.loadExtension(path, { allowFileAccess: false });
        this.loaded.set(path, ext.id);
        this.status[path] = { loaded: true };
        this.host.apply({ type: 'extension.info', path, name: ext.name, version: ext.version });
      } catch (err) {
        this.status[path] = { loaded: false, error: err instanceof Error ? err.message : String(err) };
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
    let manifest: { name?: unknown; version?: unknown; manifest_version?: unknown };
    try {
      manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
    } catch {
      dialog.showErrorBox('Not an extension', 'That folder has no readable manifest.json. Unpack the extension first, then choose the folder that contains manifest.json.');
      return;
    }
    const name = typeof manifest.name === 'string' && !manifest.name.startsWith('__MSG_') ? manifest.name : undefined;
    const version = typeof manifest.version === 'string' ? manifest.version : undefined;
    this.host.apply({ type: 'extension.add', path, name, version });
  }
}
