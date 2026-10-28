// Sharing: a space published as an installable chord-space manifest with a
// landing page, and a tab published as a small page of its own, both in the
// public sync repository (GitHub Pages). Pure, so it can be tested.

import type { ChordConfig, ConfigSpace } from './config.ts';
import type { SharedTab } from './types.ts';
import { SPACE_FORMAT } from './installer.ts';

export interface ShareSite {
  user: string;
  /** the Pages root, with a trailing slash */
  siteUrl: string;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** A URL-safe folder name from a space name; unique within the given set. */
export function slugify(name: string, taken: Set<string> = new Set()): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'space';
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

/** A short random id for shared tabs. */
export function shareId(random: () => number = Math.random): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(random() * alphabet.length)];
  return out;
}

/** The chord-space manifest for one exported space. */
export function renderSpaceManifest(space: ConfigSpace): string {
  const { name, color, icon, pinned, today, notes, liveFolders } = space;
  return JSON.stringify({ format: SPACE_FORMAT, version: 1, name, color, icon, notes, liveFolders, pinned, today }, null, 2);
}

const STYLE = `
:root{--bg:#fafafd;--fg:#1c1c24;--muted:#6b6b76;--line:#e6e6ee;--card:#fff;--accent:#5b6cff}
@media(prefers-color-scheme:dark){:root{--bg:#16161c;--fg:#f0f0f4;--muted:#9a9aa6;--line:#2a2a34;--card:#1e1e26}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:48px 20px 80px}h1{font-size:28px;margin:0 0 6px;display:flex;align-items:center;gap:10px}
.sub{color:var(--muted);margin:0 0 24px}.btns{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 28px}
.btn{display:inline-block;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600;border:1px solid var(--line);background:var(--card);color:var(--fg)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.list{list-style:none;padding:0;margin:0;border:1px solid var(--line);border-radius:12px;background:var(--card);overflow:hidden}
.list li{display:flex;align-items:center;gap:12px;padding:10px 14px;border-top:1px solid var(--line)}.list li:first-child{border-top:0}
.list img{width:18px;height:18px;border-radius:4px}.list a{color:var(--fg);text-decoration:none;font-weight:500}.list a:hover{text-decoration:underline}
.list .h{color:var(--muted);font-size:13px;margin-left:auto;white-space:nowrap}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:26px 0 8px}
.note{white-space:pre-wrap;border-left:3px solid var(--accent);padding:4px 14px;margin:0 0 20px;color:var(--fg)}
.card{border:1px solid var(--line);border-radius:14px;background:var(--card);padding:22px}
.card .t{font-size:22px;font-weight:700;margin:0 0 4px}.card .u{color:var(--muted);word-break:break-all;margin:0 0 14px}
footer{margin-top:40px;color:var(--muted);font-size:13px}footer a{color:var(--muted)}
.dot{width:14px;height:14px;border-radius:50%;display:inline-block}
`;

const CHORD = 'https://ingmmo.com/chord/';

function favicon(url: string): string {
  return `https://icons.duckduckgo.com/ip3/${esc(host(url))}.ico`;
}

function foot(site: ShareSite): string {
  return `<footer>Shared by <a href="https://github.com/${esc(site.user)}">${esc(site.user)}</a> with <a href="${CHORD}">Chord</a>, an open-source browser with Spaces. The “Open in Chord” button works once Chord is installed.</footer>`;
}

/** The landing page of a shared space: its tabs, and a button that installs it in Chord. */
export function renderSpacePage(space: ConfigSpace, manifestUrl: string, site: ShareSite): string {
  const tabs = [...space.pinned, ...space.today];
  const li = (t: { url: string; title?: string }) => `<li><img src="${favicon(t.url)}" alt=""><a href="${esc(t.url)}">${esc(t.title || t.url)}</a><span class="h">${esc(host(t.url))}</span></li>`;
  const install = `chord://install/?url=${encodeURIComponent(manifestUrl)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(space.name)} · a Chord space</title><style>${STYLE}</style></head>
<body><main>
<h1>${space.color ? `<span class="dot" style="background:${esc(space.color)}"></span>` : ''}${space.icon ? esc(space.icon) + ' ' : ''}${esc(space.name)}</h1>
<p class="sub">A space shared from Chord: ${tabs.length} tab${tabs.length === 1 ? '' : 's'}${space.liveFolders?.length ? `, ${space.liveFolders.length} live folder${space.liveFolders.length === 1 ? '' : 's'}` : ''}.</p>
<div class="btns"><a class="btn primary" href="${esc(install)}">Open in Chord</a><a class="btn" href="${esc(manifestUrl)}">Manifest (JSON)</a><a class="btn" href="${CHORD}">Get Chord</a></div>
${space.notes ? `<h2>Notes</h2><div class="note">${esc(space.notes)}</div>` : ''}
${space.pinned.length ? `<h2>Pinned</h2><ul class="list">${space.pinned.map(li).join('')}</ul>` : ''}
${space.today.length ? `<h2>Today</h2><ul class="list">${space.today.map(li).join('')}</ul>` : ''}
${foot(site)}
</main></body></html>
`;
}

/** The page of a shared tab: title, address, an optional note, and buttons. */
export function renderTabPage(share: SharedTab, site: ShareSite): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(share.title || share.url)}</title>
<meta property="og:title" content="${esc(share.title || share.url)}"><meta property="og:description" content="${esc(share.note || `Shared from Chord by ${site.user}`)}"><meta property="og:url" content="${esc(share.url)}">
<style>${STYLE}</style></head>
<body><main>
<div class="card"><p class="t"><img src="${favicon(share.url)}" alt="" style="width:20px;height:20px;vertical-align:-3px;margin-right:8px">${esc(share.title || share.url)}</p><p class="u">${esc(share.url)}</p>
${share.note ? `<div class="note">${esc(share.note)}</div>` : ''}
<div class="btns" style="margin:0"><a class="btn primary" href="${esc(share.url)}">Open page</a><a class="btn" href="chord://open/?url=${encodeURIComponent(share.url)}">Open in Chord</a></div></div>
${foot(site)}
</main></body></html>
`;
}

/** An index of everything shared, linked from the public repository. */
export function renderSharesIndex(spaces: { name: string; slug: string; icon?: string; color?: string; tabs: number }[], tabs: SharedTab[], site: ShareSite): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shared by ${esc(site.user)}</title><style>${STYLE}</style></head>
<body><main>
<h1>Shared by ${esc(site.user)}</h1><p class="sub">Spaces and pages shared from Chord.</p>
${spaces.length ? `<h2>Spaces</h2><ul class="list">${spaces.map((s) => `<li>${s.color ? `<span class="dot" style="background:${esc(s.color)}"></span>` : ''}<a href="spaces/${esc(s.slug)}/">${s.icon ? esc(s.icon) + ' ' : ''}${esc(s.name)}</a><span class="h">${s.tabs} tab${s.tabs === 1 ? '' : 's'}</span></li>`).join('')}</ul>` : ''}
${tabs.length ? `<h2>Pages</h2><ul class="list">${tabs.map((t) => `<li><img src="${favicon(t.url)}" alt=""><a href="t/${esc(t.id)}/">${esc(t.title || t.url)}</a><span class="h">${esc(host(t.url))}</span></li>`).join('')}</ul>` : ''}
${!spaces.length && !tabs.length ? '<p class="sub">Nothing shared yet.</p>' : ''}
${foot(site)}
</main></body></html>
`;
}

/** The files a push writes for everything shared: path → content. */
export function sharedFiles(config: ChordConfig, sharedSlugs: Map<string, string>, tabs: SharedTab[], site: ShareSite): Map<string, string> {
  const out = new Map<string, string>();
  const index: { name: string; slug: string; icon?: string; color?: string; tabs: number }[] = [];
  for (const sp of config.spaces) {
    const slug = sharedSlugs.get(sp.name);
    if (!slug) continue;
    const manifestUrl = `${site.siteUrl}spaces/${slug}/space.json`;
    out.set(`spaces/${slug}/space.json`, renderSpaceManifest(sp));
    out.set(`spaces/${slug}/index.html`, renderSpacePage(sp, manifestUrl, site));
    index.push({ name: sp.name, slug, icon: sp.icon, color: sp.color, tabs: sp.pinned.length + sp.today.length });
  }
  for (const t of tabs) out.set(`t/${t.id}/index.html`, renderTabPage(t, site));
  if (out.size || tabs.length) out.set('shared.html', renderSharesIndex(index, tabs, site));
  return out;
}
