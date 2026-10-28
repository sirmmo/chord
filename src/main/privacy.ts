import { app, ipcMain, net, type WebContents } from 'electron';
import type { PrivacySettings } from '../shared/types.ts';
import { aliasFromResponse, aliasRequest, dohServer, httpsUpgrade, isThirdParty } from '../shared/privacy.ts';
import { headerKey, onBeforeRequest, onBeforeSendHeaders, onHeadersReceived } from './webrequest.ts';
import type { Controller } from './controller.ts';

/**
 * Privacy defaults, applied to every browsing session through the webRequest hub:
 * encrypted DNS (Quad9 by default), Global Privacy Control and Do Not Track headers,
 * no cookies to or from third parties, plain http:// page loads upgraded to https://
 * with a fallback when the secure twin does not answer, and e-mail aliases on demand.
 */

const UPGRADE_MEMORY = 90_000;

export class PrivacyManager {
  private readonly c: Controller;
  /** hosts whose http → https upgrade is pending confirmation: host → when */
  private upgraded = new Map<string, number>();
  /** hosts that answered only on http this session */
  private httpOnly = new Set<string>();

  constructor(c: Controller) {
    this.c = c;
  }

  private get p(): PrivacySettings {
    return this.c.state.settings.privacy;
  }

  init(): void {
    this.applyDns();
    ipcMain.on('privacy', (event) => {
      event.returnValue = { gpc: this.p.gpc };
    });
    onBeforeRequest((d) => {
      if (!this.p.httpsFirst || d.resourceType !== 'mainFrame') return undefined;
      const https = httpsUpgrade(d.url);
      if (!https) return undefined;
      const host = new URL(d.url).hostname;
      if (this.httpOnly.has(host)) return undefined;
      this.upgraded.set(host, Date.now());
      return { redirectURL: https };
    });
    onBeforeSendHeaders((d, headers) => {
      if (this.p.gpc) {
        headers['Sec-GPC'] = '1';
        headers['DNT'] = '1';
      }
      if (this.p.thirdPartyCookies && d.resourceType !== 'mainFrame' && isThirdParty(d.url, pageUrlOf(d))) {
        const k = headerKey(headers, 'cookie');
        if (k) delete headers[k];
      }
    });
    onHeadersReceived((d, headers) => {
      if (!this.p.thirdPartyCookies || d.resourceType === 'mainFrame' || !isThirdParty(d.url, pageUrlOf(d))) return undefined;
      const k = headerKey(headers, 'set-cookie');
      if (k) delete headers[k];
      return undefined;
    });
  }

  /** Settings changed. */
  apply(): void {
    this.applyDns();
  }

  private applyDns(): void {
    const server = dohServer(this.p);
    try {
      app.configureHostResolver(server ? { secureDnsMode: 'secure', secureDnsServers: [server] } : { secureDnsMode: 'automatic', secureDnsServers: [] });
    } catch (err) {
      console.warn('DNS over HTTPS not configured', err);
    }
  }

  /**
   * A main-frame load failed. When Chord upgraded that address to https:// moments ago and the
   * failure looks like "no https here", go back to plain http for this host and say so.
   */
  failed(wc: WebContents, url: string, code: number): boolean {
    if (!this.p.httpsFirst) return false;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    const at = this.upgraded.get(u.hostname);
    if (!at || Date.now() - at > UPGRADE_MEMORY) return false;
    // connection and certificate errors (-100…-299), plus failed/timed out
    const connectionish = code === -2 || code === -7 || (code <= -100 && code > -300);
    if (!connectionish) return false;
    this.upgraded.delete(u.hostname);
    this.httpOnly.add(u.hostname);
    u.protocol = 'http:';
    this.c.sendSidebar({ kind: 'toast', text: `${u.hostname} has no HTTPS`, detail: 'Opened over plain HTTP for this session' });
    void wc.loadURL(u.toString());
    return true;
  }

  /** Ask the configured alias service for a fresh address for `hostname`. */
  async createAlias(hostname: string): Promise<string> {
    const { provider, key } = this.p.aliases;
    const req = aliasRequest(provider, key ?? '', hostname);
    if (!req) throw new Error('no alias service configured');
    const res = await net.fetch(req.url, { ...req.init, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${provider === 'relay' ? 'Firefox Relay' : 'SimpleLogin'} answered ${res.status}`);
    const alias = aliasFromResponse(provider, await res.json().catch(() => null));
    if (!alias) throw new Error('unexpected answer from the alias service');
    return alias;
  }
}

/** The address of the page a request belongs to, best effort. */
function pageUrlOf(d: { frame?: { top?: { url: string } | null } | null; webContents?: WebContents; referrer?: string; url: string }): string {
  try {
    const top = d.frame?.top?.url;
    if (top) return top;
  } catch {
    /* frame gone */
  }
  try {
    const wc = d.webContents?.getURL();
    if (wc) return wc;
  } catch {
    /* destroyed */
  }
  return d.referrer ?? '';
}
