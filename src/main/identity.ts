import { ipcMain, type Session } from 'electron';
import type { GoogleSignIn } from '../shared/types.ts';

/**
 * Google refuses to sign users in from what it detects as an embedded
 * browser ("This browser or app may not be secure"). The usual Chromium
 * identity Chord presents triggers Google's full desktop-Chrome checks, which
 * an Electron runtime fails. On accounts.google.com only, Chord can present
 * itself differently: as Firefox (no Client Hints, the approach Min browser
 * has used for years) or with Electron's own identity (which gets Google's
 * lighter embedded-browser flow). The page's navigator.userAgent is aligned
 * with the header through the page preload so the two never disagree.
 */

const GOOGLE_HOSTS = ['https://accounts.google.com/*', 'https://accounts.youtube.com/*'];

let mode: GoogleSignIn = 'firefox';
let electronUserAgent = '';

export function setGoogleSignIn(m: GoogleSignIn): void {
  mode = m;
}

/** Remember Electron's untouched User-Agent (with the app token removed) before the session gets the plain Chromium one. */
export function rememberElectronUserAgent(ua: string): void {
  electronUserAgent = ua.replace(/ ?chord(-browser)?\/\S+/i, '');
}

/** A believable current Firefox User-Agent for this OS. Firefox ships every four weeks since 91 (2021-08-10). */
export function firefoxUserAgent(now = Date.now()): string {
  const weeks = (now - Date.UTC(2021, 7, 10)) / (7 * 86_400_000);
  const version = Math.max(115, 91 + Math.floor(weeks / 4) - 1);
  const os = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10.15' : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`;
}

export function identityFor(m: GoogleSignIn = mode): { mode: GoogleSignIn; userAgent: string } {
  if (m === 'firefox') return { mode: m, userAgent: firefoxUserAgent() };
  if (m === 'electron') return { mode: m, userAgent: electronUserAgent };
  return { mode: 'off', userAgent: '' };
}

export function isGoogleSignInHost(host: string): boolean {
  return host === 'accounts.google.com' || host === 'accounts.youtube.com';
}

/** Rewrite request headers for the sign-in hosts of one session. */
export function installIdentity(ses: Session): void {
  ses.webRequest.onBeforeSendHeaders({ urls: GOOGLE_HOSTS }, (details, callback) => {
    const ident = identityFor();
    if (ident.mode === 'off' || !ident.userAgent) return callback({});
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(details.requestHeaders)) {
      if (ident.mode === 'firefox' && /^sec-ch-ua/i.test(k)) continue; // Firefox sends no Client Hints
      headers[k] = v;
    }
    headers['User-Agent'] = ident.userAgent;
    callback({ requestHeaders: headers });
  });
}

/** The page preload asks synchronously, before any page script runs. */
export function initIdentityIpc(): void {
  ipcMain.on('identity', (event) => {
    event.returnValue = identityFor();
  });
}
