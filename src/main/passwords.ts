import { app, dialog, ipcMain, safeStorage, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PasswordEntry, PasswordsStatus } from '../shared/types.ts';
import { Store } from './store.ts';
import type { Controller } from './controller.ts';

interface Stored {
  id: string;
  host: string;
  username: string;
  /** base64 of safeStorage.encryptString(password) */
  secret: string;
  createdAt: number;
  updatedAt: number;
}
interface File {
  entries: Stored[];
  never: string[];
}

const PROMPT_DELAY_MS = 2500;

/**
 * A small password manager. Secrets are encrypted with Electron's safeStorage,
 * which uses the OS keychain (macOS Keychain, Windows DPAPI, a Linux keyring),
 * so passwords.json is useless without the user's OS account.
 */
export class PasswordManager {
  private readonly c: Controller;
  private readonly store: Store<File>;
  private entries: Stored[] = [];
  private never = new Set<string>();
  private pending = new Map<string, { host: string; username: string; password: string; timer: NodeJS.Timeout }>();

  constructor(c: Controller) {
    this.c = c;
    this.store = new Store(join(app.getPath('userData'), 'passwords.json'));
  }

  init(): void {
    const raw = this.store.load() as Partial<File> | null;
    if (raw && Array.isArray(raw.entries)) this.entries = raw.entries.filter((e) => e && typeof e.id === 'string' && typeof e.host === 'string' && typeof e.secret === 'string');
    if (raw && Array.isArray(raw.never)) this.never = new Set(raw.never.filter((h) => typeof h === 'string'));

    ipcMain.on('passwords:captured', (event: IpcMainEvent, raw: unknown) => {
      const id = this.c.tabs.tabIdOf(event.sender);
      if (!id || !this.available()) return;
      const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      const host = str(r.host, 253);
      const username = str(r.username, 200);
      const password = str(r.password, 500);
      if (!host || !password || this.never.has(host)) return;
      const existing = this.entries.find((e) => e.host === host && e.username === username);
      if (existing && this.decrypt(existing) === password) return;
      this.queuePrompt(id, host, username, password);
    });
    ipcMain.handle('passwords:lookup', (event, rawHost: unknown) => {
      if (!this.c.tabs.tabIdOf(event.sender) || !this.available()) return { auto: false, entries: [] };
      const host = str(rawHost, 253);
      return { auto: this.c.state.settings.autofill, entries: this.forHost(host).map((e) => ({ username: e.username, password: this.decrypt(e) })) };
    });
    ipcMain.handle('passwords', (event) => (this.c.trustedEvent(event) ? this.status() : { entries: [], never: [], available: false }));
    ipcMain.handle('passwords:reveal', (event, id: unknown) => {
      if (!this.c.trustedEvent(event) || typeof id !== 'string') return null;
      const e = this.entries.find((x) => x.id === id);
      return e ? this.decrypt(e) : null;
    });
  }

  available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  status(): PasswordsStatus {
    return {
      available: this.available(),
      entries: this.entries.map(({ id, host, username, updatedAt }) => ({ id, host, username, updatedAt })),
      never: [...this.never].sort(),
    };
  }

  /** The page navigated: a pending login looks successful, ask now. */
  navigated(tabId: string): void {
    const p = this.pending.get(tabId);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(tabId);
      void this.prompt(p.host, p.username, p.password);
    }
  }

  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.save();
  }

  allowAgain(host: string): void {
    this.never.delete(host);
    this.save();
  }

  flush(): void {
    this.store.flush();
  }

  private forHost(host: string): Stored[] {
    const base = registrable(host);
    return this.entries.filter((e) => e.host === host || registrable(e.host) === base).sort((a, b) => (a.host === host ? -1 : b.host === host ? 1 : b.updatedAt - a.updatedAt));
  }

  private queuePrompt(tabId: string, host: string, username: string, password: string): void {
    const old = this.pending.get(tabId);
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => {
      this.pending.delete(tabId);
      void this.prompt(host, username, password);
    }, PROMPT_DELAY_MS);
    this.pending.set(tabId, { host, username, password, timer });
  }

  private async prompt(host: string, username: string, password: string): Promise<void> {
    const win = this.c.win;
    if (!win) return;
    const existing = this.entries.find((e) => e.host === host && e.username === username);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: existing ? ['Update', 'Not Now'] : ['Save', 'Never for This Site', 'Not Now'],
      defaultId: 0,
      cancelId: existing ? 1 : 2,
      message: existing ? `Update the saved password for ${username || host}?` : `Save the password for ${host}?`,
      detail: `${username ? `Username: ${username}\n` : ''}Stored encrypted with your operating system's keychain. Manage saved passwords in Settings → Passwords.`,
    });
    if (response !== 0) {
      if (!existing && response === 1) {
        this.never.add(host);
        this.save();
      }
      return;
    }
    const secret = safeStorage.encryptString(password).toString('base64');
    const now = Date.now();
    if (existing) {
      existing.secret = secret;
      existing.updatedAt = now;
    } else this.entries.push({ id: randomUUID(), host, username, secret, createdAt: now, updatedAt: now });
    this.save();
  }

  private decrypt(e: Stored): string {
    try {
      return safeStorage.decryptString(Buffer.from(e.secret, 'base64'));
    } catch {
      return '';
    }
  }

  private save(): void {
    this.store.save({ entries: this.entries, never: [...this.never] });
    this.c.sendAll('passwords', this.status());
  }
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Good-enough registrable domain: the last two labels, three for common second-level suffixes. */
function registrable(host: string): string {
  const parts = host.toLowerCase().split('.');
  if (parts.length <= 2) return host.toLowerCase();
  const sld = parts[parts.length - 2];
  const take = ['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'].includes(sld) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-take).join('.');
}
