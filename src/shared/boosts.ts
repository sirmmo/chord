// Boosts: per-site CSS and JavaScript the user writes, applied when a page's
// host matches the boost's site list.

import type { Boost } from './types.ts';

/**
 * Site lists are comma or whitespace separated patterns:
 *   "example.com"    the host and its subdomains
 *   "*.example.com"  subdomains only
 *   "*"              every site
 */
export function siteMatches(sites: string, host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  if (!h) return false;
  for (const raw of sites.split(/[\s,]+/)) {
    const p = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!p) continue;
    if (p === '*') return true;
    if (p.startsWith('*.')) {
      if (h.endsWith(p.slice(1))) return true;
    } else if (h === p || h.endsWith(`.${p}`)) return true;
  }
  return false;
}

export function boostsFor(boosts: Boost[], host: string): Boost[] {
  return boosts.filter((b) => b.enabled && siteMatches(b.sites, host));
}

export function isBoost(v: unknown): v is Boost {
  const b = v as Boost;
  return typeof v === 'object' && v !== null && typeof b.id === 'string' && typeof b.name === 'string' && typeof b.sites === 'string' && typeof b.css === 'string' && typeof b.js === 'string' && typeof b.enabled === 'boolean';
}
