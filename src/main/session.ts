import { app, BrowserWindow, dialog, session, type Session, type WebContents } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import { serveInternalPages } from './internal.ts';

export const PARTITION = 'persist:chord';

export function browsingSession(): Session {
  return session.fromPartition(PARTITION);
}

const ASK: Record<string, string> = {
  media: 'use your camera or microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  midi: 'use MIDI devices',
  midiSysex: 'use MIDI devices',
  'clipboard-read': 'read your clipboard',
};
const ALWAYS = new Set(['fullscreen', 'pointerLock', 'keyboardLock', 'clipboard-sanitized-write', 'window-management', 'display-capture']);
const decisions = new Map<string, boolean>();

async function askPermission(wc: WebContents, permission: string, origin: string): Promise<boolean> {
  const key = `${origin}|${permission}`;
  const remembered = decisions.get(key);
  if (remembered !== undefined) return remembered;
  const win = BrowserWindow.fromWebContents(wc) ?? BrowserWindow.getFocusedWindow() ?? undefined;
  const opts = {
    type: 'question' as const,
    buttons: ['Allow', 'Block'],
    defaultId: 1,
    cancelId: 1,
    message: `${origin} wants to ${ASK[permission] ?? permission}`,
    detail: 'Chord will remember this choice until you quit.',
  };
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  const allowed = response === 0;
  decisions.set(key, allowed);
  return allowed;
}

export function configureSession(): Session {
  const ses = browsingSession();

  // Present as a plain Chromium build: some sites serve degraded pages to unknown UA tokens.
  const ua = ses
    .getUserAgent()
    .replace(/ ?Electron\/\S+/i, '')
    .replace(/ ?chord(-browser)?\/\S+/i, '');
  ses.setUserAgent(ua);

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (ALWAYS.has(permission)) return callback(true);
    const origin = (() => {
      try {
        return new URL(details.requestingUrl).origin;
      } catch {
        return details.requestingUrl;
      }
    })();
    if (permission in ASK) {
      askPermission(wc, permission, origin).then(callback, () => callback(false));
      return;
    }
    callback(false);
  });

  serveInternalPages(ses);
  return ses;
}

// ---- Shields: ad and tracker blocking (Ghostery engine with EasyList and EasyPrivacy) ----

let blocker: ElectronBlocker | null = null;
let shieldsOn = false;
let loading: Promise<ElectronBlocker | null> | null = null;

async function loadBlocker(): Promise<ElectronBlocker | null> {
  if (blocker) return blocker;
  loading ??= ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
    path: join(app.getPath('userData'), 'adblock-engine.bin'),
    read: (p) => readFile(p),
    write: (p, data) => writeFile(p, data),
  })
    .then((b) => (blocker = b))
    .catch((err) => {
      console.error('Shields could not load filter lists:', err);
      loading = null;
      return null;
    });
  return loading;
}

export function shieldsStatus(): { enabled: boolean; loaded: boolean } {
  return { enabled: shieldsOn, loaded: blocker !== null };
}

export async function setShields(enabled: boolean): Promise<void> {
  const ses = browsingSession();
  if (enabled) {
    const b = await loadBlocker();
    if (b && !shieldsOn) {
      b.enableBlockingInSession(ses);
      shieldsOn = true;
    }
  } else if (blocker && shieldsOn) {
    blocker.disableBlockingInSession(ses);
    shieldsOn = false;
  }
}
