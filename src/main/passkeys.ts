import { app, dialog, ipcMain, safeStorage, systemPreferences, type WebContents } from 'electron';
import { join } from 'node:path';
import type { PasskeyEntry, PasskeysMode, PasskeysStatus } from '../shared/types.ts';
import { fromB64url, rpIdMatches } from '../shared/passkeys.ts';
import { Store } from './store.ts';
import type { Controller } from './controller.ts';

/**
 * Passkeys, stored in Chord. Chromium's WebAuthn stack in Electron reaches
 * security keys and, on Windows, Windows Hello, but no platform authenticator
 * on macOS or Linux (Apple's needs a signed app and a per-site association
 * file). So Chord is the authenticator: when a page calls
 * navigator.credentials.create()/get() (hooked in the page preload), the user
 * is asked — Touch ID where available, a dialog elsewhere — and for the
 * duration of that one call a virtual authenticator is attached through the
 * DevTools WebAuthn domain, loaded with the credentials for that site. Private
 * keys live in passkeys.json encrypted with safeStorage (the OS keychain).
 */

interface Stored {
  /** credential id, base64 */
  id: string;
  rpId: string;
  userHandle: string | null;
  userName: string;
  userDisplayName: string;
  /** base64 of safeStorage.encryptString(privateKey base64 PKCS#8) */
  secret: string;
  signCount: number;
  createdAt: number;
  lastUsedAt: number;
}
interface File {
  entries: Stored[];
}
interface Session {
  authenticatorId: string;
  timer: NodeJS.Timeout;
}
interface CdpCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
  backupEligibility?: boolean;
  backupState?: boolean;
  userName?: string;
  userDisplayName?: string;
}

const SESSION_MS = 3 * 60_000;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

export class PasskeyManager {
  private readonly c: Controller;
  private readonly store: Store<File>;
  private entries: Stored[] = [];
  private sessions = new Map<number, Session>();
  private busy = new Set<number>();

  constructor(c: Controller) {
    this.c = c;
    this.store = new Store(join(app.getPath('userData'), 'passkeys.json'));
  }

  init(): void {
    const raw = this.store.load() as Partial<File> | null;
    if (raw && Array.isArray(raw.entries)) this.entries = raw.entries.filter((e) => e && typeof e.id === 'string' && typeof e.rpId === 'string' && typeof e.secret === 'string');

    ipcMain.on('passkey:mode', (event) => {
      event.returnValue = this.c.tabs.tabIdOf(event.sender) && this.available() ? this.mode() : 'system';
    });
    ipcMain.handle('passkey', (event, raw: unknown) => this.handle(event.sender, raw));
    ipcMain.handle('passkeys', (event) => (this.c.trustedEvent(event) ? this.status() : { available: false, mode: 'system', entries: [] }));
  }

  available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  mode(): PasskeysMode {
    return this.c.state.settings.passkeys;
  }

  status(): PasskeysStatus {
    return {
      available: this.available(),
      mode: this.mode(),
      touchId: process.platform === 'darwin' && systemPreferences.canPromptTouchID(),
      entries: this.entries.map(({ id, rpId, userName, userDisplayName, createdAt, lastUsedAt }): PasskeyEntry => ({ id, rpId, userName, userDisplayName, createdAt, lastUsedAt })),
    };
  }

  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.save();
  }

  flush(): void {
    this.store.flush();
  }

  private async handle(wc: WebContents, raw: unknown): Promise<{ ok: boolean; passthrough?: boolean; error?: string }> {
    const tabId = this.c.tabs.tabIdOf(wc);
    if (!tabId || typeof raw !== 'object' || raw === null) return { ok: false, passthrough: true };
    const r = raw as Record<string, unknown>;
    if (r.method === 'done') {
      await this.finish(wc);
      return { ok: true };
    }
    if (this.mode() !== 'chord' || !this.available()) return { ok: false, passthrough: true };
    let host = '';
    try {
      host = new URL(wc.getURL()).hostname;
    } catch {
      return { ok: false, passthrough: true };
    }
    const rpId = (str(r.rpId, 253) || host).toLowerCase();
    if (!rpIdMatches(host, rpId)) return { ok: false, error: 'The relying party ID is not valid for this site.' };
    if (this.busy.has(wc.id)) return { ok: false, error: 'A passkey request is already in progress.' };
    this.busy.add(wc.id);
    try {
      if (r.method === 'get') return await this.get(wc, rpId, host, r);
      if (r.method === 'create') return await this.create(wc, rpId, host, r);
      return { ok: false, passthrough: true };
    } finally {
      this.busy.delete(wc.id);
    }
  }

  private async get(wc: WebContents, rpId: string, host: string, r: Record<string, unknown>): Promise<{ ok: boolean; passthrough?: boolean; error?: string }> {
    if (r.conditional === true) return { ok: false, passthrough: true };
    const allow = Array.isArray(r.allow) ? new Set(r.allow.filter((a): a is string => typeof a === 'string').map((a) => fromB64url(a))) : new Set<string>();
    const candidates = this.forRp(rpId).filter((e) => allow.size === 0 || allow.has(e.id));
    if (candidates.length === 0) return { ok: false, passthrough: true }; // let a security key answer
    const win = this.c.windowOf(wc)?.win ?? this.c.win;
    if (!win) return { ok: false, error: 'No window.' };
    let chosen = candidates[0];
    if (candidates.length > 1) {
      const names = candidates.slice(0, 6).map((e) => e.userName || e.userDisplayName || e.id.slice(0, 8));
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: [...names, 'Cancel'],
        cancelId: names.length,
        message: `Which passkey for ${host}?`,
        detail: 'Chord has more than one passkey for this site.',
      });
      if (response >= names.length) return { ok: false, error: 'The user cancelled.' };
      chosen = candidates[response];
    }
    const verified = await this.verify(win, `Sign in to ${host}${chosen.userName ? ` as ${chosen.userName}` : ''}`, 'Use passkey');
    if (!verified) return { ok: false, error: 'The user cancelled.' };
    const armed = await this.arm(wc, [chosen]);
    if (!armed) return { ok: false, passthrough: true };
    chosen.lastUsedAt = Date.now();
    this.save();
    return { ok: true };
  }

  private async create(wc: WebContents, rpId: string, host: string, r: Record<string, unknown>): Promise<{ ok: boolean; passthrough?: boolean; error?: string }> {
    const win = this.c.windowOf(wc)?.win ?? this.c.win;
    if (!win) return { ok: false, error: 'No window.' };
    const userName = str(r.userName, 200);
    const rpName = str(r.rpName, 100);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Create Passkey', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Create a passkey for ${rpName && rpName !== rpId ? `${rpName} (${host})` : host}?`,
      detail: `${userName ? `Account: ${userName}\n` : ''}It is stored in Chord, encrypted with your operating system's keychain, and never leaves this computer. Manage passkeys in Settings → Passwords.`,
    });
    if (response !== 0) return { ok: false, error: 'The user cancelled.' };
    const verified = await this.verify(win, `Create a passkey for ${host}`, 'Create');
    if (!verified) return { ok: false, error: 'The user cancelled.' };
    const armed = await this.arm(wc, this.forRp(rpId)); // existing ones, so excludeCredentials is honoured
    if (!armed) return { ok: false, error: 'Chord could not start its authenticator.' };
    return { ok: true };
  }

  /** Touch ID when the Mac has it; otherwise the dialog already shown is the confirmation. */
  private async verify(win: Electron.BrowserWindow, reason: string, button: string): Promise<boolean> {
    if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
      try {
        await systemPreferences.promptTouchID(reason);
        return true;
      } catch {
        const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: [button, 'Cancel'], defaultId: 0, cancelId: 1, message: reason, detail: 'Touch ID was not confirmed. Continue anyway?' });
        return response === 0;
      }
    }
    if (button === 'Create') return true; // the create dialog was the confirmation
    const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: [button, 'Cancel'], defaultId: 0, cancelId: 1, message: reason, detail: 'Chord will answer this site with the passkey it stores for you.' });
    return response === 0;
  }

  /** Attach a virtual authenticator holding these credentials to the page for one request. */
  private async arm(wc: WebContents, creds: Stored[]): Promise<boolean> {
    await this.finish(wc);
    const dbg = wc.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
      await dbg.sendCommand('WebAuthn.enable', { enableUI: false });
      const { authenticatorId } = (await dbg.sendCommand('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          ctap2Version: 'ctap2_1',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
          hasPrf: true,
          hasLargeBlob: true,
          defaultBackupEligibility: true,
          defaultBackupState: true,
        },
      })) as { authenticatorId: string };
      for (const e of creds) {
        const privateKey = this.decrypt(e);
        if (!privateKey) continue;
        await dbg.sendCommand('WebAuthn.addCredential', {
          authenticatorId,
          credential: {
            credentialId: e.id,
            isResidentCredential: e.userHandle !== null,
            rpId: e.rpId,
            privateKey,
            userHandle: e.userHandle ?? undefined,
            signCount: e.signCount,
            backupEligibility: true,
            backupState: true,
            userName: e.userName || undefined,
            userDisplayName: e.userDisplayName || undefined,
          },
        });
      }
      const timer = setTimeout(() => void this.finish(wc), SESSION_MS);
      this.sessions.set(wc.id, { authenticatorId, timer });
      return true;
    } catch (err) {
      console.warn('passkeys: could not attach the authenticator', err);
      try {
        if (dbg.isAttached()) dbg.detach();
      } catch {
        /* already gone */
      }
      return false;
    }
  }

  /** The page's call returned: keep what the authenticator now holds and take it away again. */
  private async finish(wc: WebContents): Promise<void> {
    const session = this.sessions.get(wc.id);
    if (!session) return;
    this.sessions.delete(wc.id);
    clearTimeout(session.timer);
    if (wc.isDestroyed()) return;
    const dbg = wc.debugger;
    try {
      const { credentials } = (await dbg.sendCommand('WebAuthn.getCredentials', { authenticatorId: session.authenticatorId })) as { credentials: CdpCredential[] };
      let changed = false;
      const now = Date.now();
      for (const cred of credentials) {
        const existing = this.entries.find((e) => e.id === cred.credentialId);
        if (existing) {
          if (cred.signCount !== existing.signCount) {
            existing.signCount = cred.signCount;
            changed = true;
          }
          continue;
        }
        if (!cred.rpId || !cred.privateKey) continue;
        this.entries.push({
          id: cred.credentialId,
          rpId: cred.rpId,
          userHandle: cred.isResidentCredential && cred.userHandle ? cred.userHandle : null,
          userName: str(cred.userName, 200),
          userDisplayName: str(cred.userDisplayName, 200),
          secret: safeStorage.encryptString(cred.privateKey).toString('base64'),
          signCount: cred.signCount,
          createdAt: now,
          lastUsedAt: now,
        });
        changed = true;
      }
      if (changed) this.save();
    } catch (err) {
      console.warn('passkeys: could not read the authenticator back', err);
    }
    try {
      await dbg.sendCommand('WebAuthn.removeVirtualAuthenticator', { authenticatorId: session.authenticatorId });
      await dbg.sendCommand('WebAuthn.disable');
    } catch {
      /* page went away */
    }
    try {
      if (dbg.isAttached()) dbg.detach();
    } catch {
      /* already detached */
    }
  }

  private forRp(rpId: string): Stored[] {
    return this.entries.filter((e) => e.rpId === rpId).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  private decrypt(e: Stored): string {
    try {
      return safeStorage.decryptString(Buffer.from(e.secret, 'base64'));
    } catch {
      return '';
    }
  }

  private save(): void {
    this.store.save({ entries: this.entries });
    this.c.sendAll('passkeys', this.status());
  }
}
