// Installable spaces: a site publishes a manifest, Chord turns it into a space.
//
// <link rel="chord-space" href="/chord-space.json"> on any page, or a link to
// chord://install/?url=https://example.org/chord-space.json. The manifest is a
// "chord-space" document (one space, optional boosts) or a whole chord-config.

import { CONFIG_FORMAT, CONFIG_VERSION, parseConfig, type ChordConfig } from './config.ts';
import { siteMatches } from './boosts.ts';
import type { Boost } from './types.ts';

export const SPACE_FORMAT = 'chord-space';

export interface SpaceManifestResult {
  ok: true;
  config: ChordConfig;
  /** boosts the manifest ships; they run code on pages, so the user confirms them separately */
  boosts: Boost[];
  name: string;
  /** the manifest asks to manage tabs through navigator.chord; granted for the source origin on install */
  dynamic: boolean;
}
export type ParsedManifest = SpaceManifestResult | { ok: false; error: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Turn a manifest fetched from `sourceHost` into a config plus boosts. Boost site lists may only name the source's own domain. */
export function parseSpaceManifest(text: string, sourceHost: string): ParsedManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the manifest is not JSON' };
  }
  if (!isObj(raw)) return { ok: false, error: 'the manifest is not a JSON object' };

  let configText: string;
  let boostsRaw: unknown = [];
  if (raw.format === CONFIG_FORMAT) {
    configText = text;
    boostsRaw = isObj(raw.settings) ? (raw.settings as Obj).boosts : [];
  } else if (raw.format === SPACE_FORMAT) {
    if (raw.version !== 1) return { ok: false, error: `unsupported chord-space version ${String(raw.version)}` };
    const { boosts, format: _f, version: _v, ...space } = raw;
    boostsRaw = boosts;
    configText = JSON.stringify({ format: CONFIG_FORMAT, version: CONFIG_VERSION, spaces: [{ pinned: [], today: [], ...space }] });
  } else {
    return { ok: false, error: 'not a chord-space manifest' };
  }
  const parsed = parseConfig(configText);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.config.spaces.length === 0) return { ok: false, error: 'the manifest describes no space' };
  delete parsed.config.settings; // a site never changes the user's settings

  const boosts: Boost[] = [];
  if (Array.isArray(boostsRaw)) {
    for (const b of boostsRaw) {
      if (!isObj(b)) continue;
      const sites = typeof b.sites === 'string' ? b.sites : '';
      const css = typeof b.css === 'string' ? b.css : '';
      const js = typeof b.js === 'string' ? b.js : '';
      if (!sites || (!css && !js)) continue;
      // Only the publishing site may be boosted by its own manifest.
      const patterns = sites.split(/[\s,]+/).filter(Boolean);
      if (!patterns.every((p) => p !== '*' && siteMatches(p, sourceHost))) continue;
      boosts.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, name: typeof b.name === 'string' && b.name ? b.name : `${parsed.config.spaces[0].name} boost`, sites, css, js, enabled: true });
    }
  }
  return { ok: true, config: parsed.config, boosts, name: parsed.config.spaces[0].name, dynamic: raw.dynamic === true };
}

/** The manifest URL carried by a chord://install link, if valid. */
export function installUrlFrom(link: string): string | null {
  try {
    const u = new URL(link);
    if (u.protocol !== 'chord:' || u.hostname !== 'install') return null;
    const target = u.searchParams.get('url') ?? '';
    return /^https:\/\//i.test(target) ? target : null;
  } catch {
    return null;
  }
}
