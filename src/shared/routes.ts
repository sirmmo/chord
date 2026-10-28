// Air Traffic Control: rules that send links from chosen sites into a chosen
// space. A rule applies to links that arrive from other apps and to pages a
// site opens in a new tab; a link you click or type stays where you are.

import type { Route, Space, SpaceId } from './types.ts';
import { siteMatches } from './boosts.ts';

/**
 * Patterns are comma or whitespace separated, each a site pattern as for boosts
 * ("example.com", "*.example.com", "*") with an optional path prefix:
 * "github.com/myorg" matches pages under that path only.
 */
export function routeMatches(pattern: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  for (const raw of pattern.split(/[\s,]+/)) {
    const p = raw.trim().replace(/^https?:\/\//i, '');
    if (!p) continue;
    const slash = p.indexOf('/');
    const host = slash < 0 ? p : p.slice(0, slash);
    const path = slash < 0 ? '' : p.slice(slash).replace(/\/+$/, '');
    if (!siteMatches(host, u.hostname)) continue;
    if (!path) return true;
    const want = path.toLowerCase();
    const have = u.pathname.toLowerCase();
    if (have === want || have.startsWith(`${want}/`)) return true;
  }
  return false;
}

/** The first enabled rule whose pattern matches and whose space still exists. */
export function routeFor(routes: Route[], spaces: Pick<Space, 'id'>[], url: string): Route | undefined {
  const known = new Set(spaces.map((sp) => sp.id));
  return routes.find((r) => r.enabled && known.has(r.spaceId) && routeMatches(r.pattern, url));
}

export function isRoute(v: unknown): v is Route {
  const r = v as Route;
  return typeof v === 'object' && v !== null && typeof r.id === 'string' && typeof r.pattern === 'string' && typeof r.spaceId === 'string' && typeof r.enabled === 'boolean';
}

/** The space a link should land in, if a rule says so. */
export function spaceForUrl(routes: Route[], spaces: Pick<Space, 'id'>[], url: string): SpaceId | undefined {
  return routeFor(routes, spaces, url)?.spaceId;
}
