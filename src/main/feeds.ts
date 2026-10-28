import { net } from 'electron';
import { discoverFeeds, feedGuesses, parseFeed, parseGitHubStars, type FeedItem } from '../shared/feed.ts';

/** Fetching feeds, shared by curated mode and the reader. */

export const FETCH_TIMEOUT = 15_000;
export const FEED_HEADERS = { Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, text/xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5', 'User-Agent': 'Chord (feed reader)' };

export async function fetchFeed(feed: string, kind: 'feed' | 'github' = 'feed'): Promise<{ title: string; items: FeedItem[] }> {
  const headers: Record<string, string> = kind === 'github' ? { Accept: 'application/vnd.github.star+json', 'User-Agent': 'Chord' } : FEED_HEADERS;
  const res = await net.fetch(feed, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`${new URL(feed).hostname} answered ${res.status}`);
  const text = await res.text();
  if (kind === 'github') {
    const user = /users\/([^/]+)\//.exec(feed)?.[1] ?? 'GitHub';
    return { title: `${user} on GitHub`, items: parseGitHubStars(text) };
  }
  const parsed = parseFeed(text, feed);
  if (!parsed) throw new Error('Not a feed (RSS, Atom or JSON Feed).');
  return parsed;
}

export async function isFeed(url: string): Promise<boolean> {
  try {
    const res = await net.fetch(url, { headers: FEED_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    const text = (await res.text()).slice(0, 200_000);
    return parseFeed(text, url) !== null;
  } catch {
    return false;
  }
}

/** Fetch a page and find its feed: advertised links first, then the usual places. */
export async function discoverFeed(pageUrl: string): Promise<string | null> {
  try {
    const res = await net.fetch(pageUrl, { headers: FEED_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    const text = await res.text();
    if (parseFeed(text.slice(0, 200_000), pageUrl)) return pageUrl; // it was a feed after all
    for (const url of discoverFeeds(text, pageUrl)) if (await isFeed(url)) return url;
  } catch {
    /* page unreachable: still try the guesses */
  }
  for (const url of feedGuesses(pageUrl)) if (await isFeed(url)) return url;
  return null;
}
