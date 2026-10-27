import type { SearchEngine } from './types.ts';

export const SEARCH_ENGINES: Record<SearchEngine, { name: string; url: string }> = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
  kagi: { name: 'Kagi', url: 'https://kagi.com/search?q=' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=' },
};

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
