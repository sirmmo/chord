// Privacy defaults: DNS over HTTPS, Global Privacy Control, third-party cookie blocking,
// HTTPS first and e-mail aliases. Pure helpers; the Electron side lives in main/privacy.ts.

import type { PrivacySettings } from './types.ts';
import { siteOf } from './url.ts';

export type DnsProvider = 'quad9' | 'cloudflare' | 'mullvad' | 'system' | 'custom';
export type AliasProvider = 'none' | 'simplelogin' | 'relay';

export const DNS_PROVIDERS: Record<Exclude<DnsProvider, 'system' | 'custom'>, { label: string; url: string; site: string; note: string }> = {
  quad9: { label: 'Quad9', url: 'https://dns.quad9.net/dns-query', site: 'https://quad9.net/', note: 'Swiss non-profit, blocks known malware domains, keeps no logs of who asked' },
  cloudflare: { label: 'Cloudflare 1.1.1.1', url: 'https://cloudflare-dns.com/dns-query', site: 'https://1.1.1.1/', note: 'fast, audited no-logging policy' },
  mullvad: { label: 'Mullvad', url: 'https://dns.mullvad.net/dns-query', site: 'https://mullvad.net/en/help/dns-over-https-and-dns-over-tls', note: 'no logging, no account needed' },
};

export const ALIAS_PROVIDERS: Record<Exclude<AliasProvider, 'none'>, { label: string; site: string; keyUrl: string; keyHint: string }> = {
  simplelogin: { label: 'SimpleLogin (Proton)', site: 'https://simplelogin.io/', keyUrl: 'https://app.simplelogin.io/dashboard/api_key', keyHint: 'Create an API key under Settings → API Keys' },
  relay: { label: 'Firefox Relay', site: 'https://relay.firefox.com/', keyUrl: 'https://relay.firefox.com/accounts/settings/', keyHint: 'Copy the API token from Settings' },
};

export const COMPANIONS = [
  { name: 'Proton VPN', url: 'https://protonvpn.com/', what: 'A VPN hides where you browse from your network and your provider. Chord cannot route traffic itself; Proton VPN runs system-wide, with a free tier and no logs.' },
  { name: 'Privacy Badger', url: 'https://privacybadger.org/', what: 'EFF\'s tracker blocker learns who follows you across sites. Shields already block the known trackers; Privacy Badger adds the heuristics. Install from the Chrome Web Store page in Chord; parts that lean on Chrome-only APIs may not work.', store: 'https://chromewebstore.google.com/detail/privacy-badger/pkehgijcmpdhfbdbbnkijodmdjhbjlgp' },
  { name: 'Quad9', url: 'https://quad9.net/', what: 'The DNS resolver Chord uses by default: encrypted lookups, malware domains blocked, no logs.' },
] as const;

export const defaultPrivacy = (): PrivacySettings => ({ dns: 'quad9', gpc: true, thirdPartyCookies: true, httpsFirst: true, aliases: { provider: 'none' } });

export function cleanPrivacy(raw: unknown): PrivacySettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<PrivacySettings>;
  const d = defaultPrivacy();
  const out: PrivacySettings = {
    dns: r.dns === 'cloudflare' || r.dns === 'mullvad' || r.dns === 'system' || r.dns === 'custom' ? r.dns : 'quad9',
    gpc: r.gpc !== false,
    thirdPartyCookies: r.thirdPartyCookies !== false,
    httpsFirst: r.httpsFirst !== false,
    aliases: { provider: r.aliases?.provider === 'simplelogin' || r.aliases?.provider === 'relay' ? r.aliases.provider : 'none' },
  };
  if (typeof r.dnsCustom === 'string' && /^https:\/\/[^\s]+$/i.test(r.dnsCustom.trim())) out.dnsCustom = r.dnsCustom.trim();
  if (out.dns === 'custom' && !out.dnsCustom) out.dns = d.dns;
  if (typeof r.aliases?.key === 'string' && r.aliases.key.trim()) out.aliases.key = r.aliases.key.trim().slice(0, 300);
  return out;
}

/** The DNS-over-HTTPS server to use, or null for the system resolver. */
export function dohServer(p: PrivacySettings): string | null {
  if (p.dns === 'system') return null;
  if (p.dns === 'custom') return p.dnsCustom ?? null;
  return DNS_PROVIDERS[p.dns].url;
}

const hostOnly = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

/** A request is third party when its registrable domain differs from the page's. Unknown page → not third party. */
export function isThirdParty(requestUrl: string, pageUrl: string): boolean {
  const a = hostOnly(requestUrl);
  const b = hostOnly(pageUrl);
  if (!a || !b) return false;
  return siteOf(a) !== siteOf(b);
}

const PLAIN_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\d+\.\d+\.\d+\.\d+)$|\.(local|lan|home|internal|test|localhost)$/i;

/** The https:// twin of a plain http:// page address; null when the address should stay as it is. */
export function httpsUpgrade(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:') return null;
  if (PLAIN_HOST.test(u.hostname)) return null;
  if (u.port && u.port !== '80') return null;
  u.protocol = 'https:';
  u.port = '';
  return u.toString();
}

/** The request that asks the alias service for a new address for `hostname`. */
export function aliasRequest(provider: AliasProvider, key: string, hostname: string): { url: string; init: { method: string; headers: Record<string, string>; body?: string } } | null {
  if (!key) return null;
  if (provider === 'simplelogin') {
    return {
      url: `https://app.simplelogin.io/api/alias/random/new?hostname=${encodeURIComponent(hostname)}`,
      init: { method: 'POST', headers: { Authentication: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: `Chord · ${hostname}` }) },
    };
  }
  if (provider === 'relay') {
    return {
      url: 'https://relay.firefox.com/api/v1/relayaddresses/',
      init: { method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, description: hostname.slice(0, 64), generated_for: hostname.slice(0, 255), used_on: hostname }) },
    };
  }
  return null;
}

/** The address in the service's answer. */
export function aliasFromResponse(provider: AliasProvider, json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  const v = provider === 'simplelogin' ? o.alias : provider === 'relay' ? o.full_address : undefined;
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+$/.test(v) ? v : null;
}
