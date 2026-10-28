import type { SearchEngine } from './types.ts';

export const SEARCH_ENGINES: Record<SearchEngine, { name: string; url: string }> = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
  kagi: { name: 'Kagi', url: 'https://kagi.com/search?q=' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=' },
};

/** Schemes the browser itself renders; anything else with a scheme belongs to another app. */
const WEB_SCHEMES = new Set(['http:', 'https:', 'file:', 'ftp:', 'chord:', 'about:', 'data:', 'blob:', 'javascript:', 'chrome:', 'devtools:', 'chrome-extension:']);

/** magnet:, mailto:, zoommtg: … — links another application should open. */
export function externalScheme(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (!m) return null;
  const scheme = `${m[1].toLowerCase()}:`;
  return WEB_SCHEMES.has(scheme) ? null : scheme;
}

/** Chord's own pages: chord://downloads and friends. */
export function isInternal(url: string): boolean {
  return /^chord:\/\//i.test(url);
}

const HOSTLIKE = /^(localhost|(\d{1,3}\.){3}\d{1,3}|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#].*)?$/i;

/** Turn what the user typed into a URL, or null when it should be a search. */
export function toUrl(input: string): string | null {
  const q = input.trim();
  if (!q || /\s/.test(q)) return null;
  if (/^(https?|file|ftp):\/\//i.test(q)) return q;
  if (/^(about|data|chrome|chord):/i.test(q)) return q;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q)) return null; // unknown scheme: search instead
  if (HOSTLIKE.test(q)) return 'https://' + q;
  return null;
}

export function searchUrl(engine: SearchEngine, query: string): string {
  return (SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.duckduckgo).url + encodeURIComponent(query.trim());
}

/** What to show for a page until it reports its title. */
export function titleFor(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'about:' || u.protocol === 'data:') return 'New tab';
    if (u.protocol === 'chord:') return u.hostname.charAt(0).toUpperCase() + u.hostname.slice(1);
    return u.hostname.replace(/^www\./, '') || url;
  } catch {
    return url || 'New tab';
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function isSecure(url: string): boolean {
  return url.startsWith('https://');
}

/** Registrable domain of a host, roughly: the last two labels, three for the usual second-level suffixes. */
export function siteOf(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const second = parts[parts.length - 2];
  const sld = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);
  return (sld.has(second) && parts[parts.length - 1].length === 2 ? parts.slice(-3) : parts.slice(-2)).join('.');
}
