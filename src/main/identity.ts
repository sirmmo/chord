import { ipcMain } from 'electron';
import { onBeforeSendHeaders } from './webrequest.ts';
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

const GOOGLE_HOST_RE = /^https:\/\/accounts\.(google|youtube)\.com\//i;

let mode: GoogleSignIn = 'firefox';
let electronUserAgent = '';

export function setGoogleSignIn(m: GoogleSignIn): void {
  mode = m;
}

/** Remember Electron's untouched User-Agent (with the app token removed) before the session gets the plain Chromium one. */
export function rememberElectronUserAgent(ua: string): void {
  electronUserAgent = ua.replace(/ ?chord(-browser)?\/\S+/i, '');
}

/**
 * Electron's User-Agent as plain Chromium: no Electron or app token, and the build
 * number reduced to major.0.0.0 like Chrome itself reports. Applied through
 * app.userAgentFallback rather than a session override, because an override makes
 * Chromium drop the client hints (sec-ch-ua, navigator.userAgentData) that bot checks
 * such as Cloudflare's expect next to a Chrome-like User-Agent.
 */
export function plainChromiumUserAgent(raw: string): string {
  return raw
    .replace(/ ?Electron\/\S+/i, '')
    .replace(/ ?chord(-browser)?\/\S+/i, '')
    .replace(/Chrome\/(\d+)\.[\d.]+/, 'Chrome/$1.0.0.0');
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

let installed = false;
/** Rewrite request headers for the sign-in hosts (every session, through the webRequest hub). */
export function installIdentity(): void {
  if (installed) return;
  installed = true;
  onBeforeSendHeaders((details, headers) => {
    if (!GOOGLE_HOST_RE.test(details.url)) return;
    const ident = identityFor();
    if (ident.mode === 'off' || !ident.userAgent) return;
    if (ident.mode === 'firefox') for (const k of Object.keys(headers)) if (/^sec-ch-ua/i.test(k)) delete headers[k]; // Firefox sends no Client Hints
    headers['User-Agent'] = ident.userAgent;
  });
}

/** The page preload asks synchronously, before any page script runs. */
export function initIdentityIpc(): void {
  ipcMain.on('identity', (event) => {
    event.returnValue = identityFor();
  });
}
