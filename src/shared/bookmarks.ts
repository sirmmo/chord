// Bookmarks: merging two devices' lists, and the public "linkroll" site that
// the public ones are published as (GitHub Pages). Pure, unit-tested.

import type { Bookmark } from './types.ts';

export const TOMBSTONE_DAYS = 90;

export function normalizeTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,\s]+/) : [];
  const out: string[] = [];
  for (const t of list) {
    const v = String(t).trim().replace(/^#/, '').toLowerCase().slice(0, 40);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 20);
}

export function normalizeBookmarkUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    return u.href;
  } catch {
    return url.trim();
  }
}

/** Union of two lists: the newer version of each bookmark wins, deletions included. */
export function mergeBookmarks(local: Bookmark[], remote: Bookmark[]): { merged: Bookmark[]; changed: boolean } {
  const byId = new Map<string, Bookmark>();
  for (const b of local) byId.set(b.id, b);
  let changed = false;
  for (const r of remote) {
    if (!r || typeof r.id !== 'string' || typeof r.url !== 'string') continue;
    const l = byId.get(r.id);
    if (!l) {
      byId.set(r.id, sanitize(r));
      changed = true;
    } else if ((r.updatedAt ?? 0) > (l.updatedAt ?? 0)) {
      byId.set(r.id, sanitize(r));
      changed = true;
    }
  }
  // the same URL added on two devices: keep the older id, mark the other deleted
  const byUrl = new Map<string, Bookmark>();
  for (const b of [...byId.values()].sort((a, b) => a.addedAt - b.addedAt)) {
    if (b.deletedAt) continue;
    const key = normalizeBookmarkUrl(b.url);
    const first = byUrl.get(key);
    if (!first) byUrl.set(key, b);
    else {
      byId.set(b.id, { ...b, deletedAt: Date.now(), updatedAt: Date.now() });
      if (b.updatedAt > first.updatedAt) byId.set(first.id, { ...first, title: b.title, note: b.note, tags: b.tags, public: b.public, updatedAt: b.updatedAt });
      changed = true;
    }
  }
  return { merged: [...byId.values()].sort((a, b) => b.addedAt - a.addedAt), changed };
}

export function sanitize(b: Bookmark): Bookmark {
  return {
    id: String(b.id).slice(0, 64),
    url: String(b.url).slice(0, 2000),
    title: typeof b.title === 'string' ? b.title.slice(0, 300) : '',
    note: typeof b.note === 'string' ? b.note.slice(0, 2000) : '',
    tags: normalizeTags(b.tags),
    public: b.public === true,
    addedAt: typeof b.addedAt === 'number' ? b.addedAt : Date.now(),
    updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : Date.now(),
    ...(typeof b.deletedAt === 'number' ? { deletedAt: b.deletedAt } : {}),
  };
}

/** Deletions older than TOMBSTONE_DAYS have reached every device: forget them. */
export function pruneTombstones(list: Bookmark[], now: number): Bookmark[] {
  const limit = now - TOMBSTONE_DAYS * 86_400_000;
  return list.filter((b) => !b.deletedAt || b.deletedAt > limit);
}

export const liveBookmarks = (list: Bookmark[]): Bookmark[] => list.filter((b) => !b.deletedAt);
export const publicBookmarks = (list: Bookmark[]): Bookmark[] => liveBookmarks(list).filter((b) => b.public);

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export interface SiteOptions {
  user: string;
  siteUrl: string;
  title?: string;
}

/** The public bookmarks as a JSON document others (and Chord's curated mode) can read. */
export function renderBookmarksJson(list: Bookmark[], opts: SiteOptions): string {
  return JSON.stringify(
    {
      format: 'chord-bookmarks',
      version: 1,
      user: opts.user,
      site: opts.siteUrl,
      exportedAt: new Date().toISOString(),
      bookmarks: publicBookmarks(list).map((b) => ({ url: b.url, title: b.title, note: b.note, tags: b.tags, addedAt: new Date(b.addedAt).toISOString() })),
    },
    null,
    2,
  );
}

/** RSS 2.0 of the newest public bookmarks: this is what a curated space follows. */
export function renderFeed(list: Bookmark[], opts: SiteOptions, max = 50): string {
  const items = publicBookmarks(list)
    .slice()
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, max)
    .map(
      (b) => `    <item>
      <title>${esc(b.title || b.url)}</title>
      <link>${esc(b.url)}</link>
      <guid isPermaLink="false">chord-bookmark-${esc(b.id)}</guid>
      <pubDate>${new Date(b.addedAt).toUTCString()}</pubDate>${b.note ? `\n      <description>${esc(b.note)}</description>` : ''}${b.tags.map((t) => `\n      <category>${esc(t)}</category>`).join('')}
    </item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(opts.title ?? `${opts.user}'s bookmarks`)}</title>
    <link>${esc(opts.siteUrl)}</link>
    <atom:link href="${esc(opts.siteUrl.replace(/\/?$/, '/'))}feed.xml" rel="self" type="application/rss+xml"/>
    <description>Links ${esc(opts.user)} bookmarked publicly with Chord.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

/** The linkroll page: a static site with search and tag filters, no build step. */
export function renderLinkroll(list: Bookmark[], opts: SiteOptions): string {
  const pub = publicBookmarks(list).slice().sort((a, b) => b.addedAt - a.addedAt);
  const tags = new Map<string, number>();
  for (const b of pub) for (const t of b.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  const tagChips = [...tags.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t, n]) => `<button class="chip" data-tag="${esc(t)}">${esc(t)} <span>${n}</span></button>`)
    .join('');
  const rows = pub
    .map((b) => {
      const host = hostOf(b.url);
      const d = new Date(b.addedAt);
      return `<li class="bm" data-tags="${esc(b.tags.join(' '))}" data-text="${esc(`${b.title} ${host} ${b.note} ${b.tags.join(' ')}`.toLowerCase())}">
  <a class="t" href="${esc(b.url)}" rel="noopener">${esc(b.title || b.url)}</a>
  <span class="h">${esc(host)}</span>${b.note ? `\n  <p class="n">${esc(b.note)}</p>` : ''}
  <span class="m"><time datetime="${d.toISOString()}">${d.toISOString().slice(0, 10)}</time>${b.tags.map((t) => ` <a class="tag" href="#tag=${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')}</span>
</li>`;
    })
    .join('\n');
  const title = esc(opts.title ?? `${opts.user}'s bookmarks`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="Links ${esc(opts.user)} bookmarked publicly with Chord.">
<link rel="alternate" type="application/rss+xml" title="${title}" href="feed.xml">
<link rel="alternate" type="application/json" title="${title} (JSON)" href="bookmarks.json">
<style>
:root{--bg:#fbfbfd;--fg:#1b1b22;--muted:#6b6b76;--line:#e6e6ec;--card:#fff;--accent:#5b6cff}
@media(prefers-color-scheme:dark){:root{--bg:#121218;--fg:#ececf1;--muted:#9a9aa6;--line:#2a2a33;--card:#1a1a22;--accent:#8c97ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 20px 80px}h1{font-size:26px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.search{width:100%;font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);outline:none}.search:focus{border-color:var(--accent)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 22px}.chip{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:3px 10px;cursor:pointer}.chip span{color:var(--muted)}.chip.on{background:var(--accent);border-color:var(--accent);color:#fff}.chip.on span{color:#fff}
ul{list-style:none;margin:0;padding:0}.bm{padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--card);margin-bottom:10px}.bm.hide{display:none}
.bm .t{font-weight:600;color:var(--fg);text-decoration:none}.bm .t:hover{color:var(--accent)}.bm .h{color:var(--muted);font-size:13px;margin-left:8px}.bm .n{margin:6px 0 0;color:var(--fg)}.bm .m{display:block;margin-top:6px;font-size:12.5px;color:var(--muted)}.tag{color:var(--accent);text-decoration:none;margin-right:2px}
footer{margin-top:40px;color:var(--muted);font-size:13px}footer a{color:inherit}.empty{color:var(--muted)}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p class="sub">${pub.length} link${pub.length === 1 ? '' : 's'} · <a href="feed.xml">RSS</a> · <a href="bookmarks.json">JSON</a></p>
<input class="search" id="q" type="search" placeholder="Search" autocomplete="off">
<div class="chips" id="chips">${tagChips}</div>
<ul id="list">
${rows || '<li class="empty">Nothing public yet.</li>'}
</ul>
<footer>Published with <a href="https://ingmmo.com/chord/">Chord</a>. Follow this page as a curator in Chord: paste its address into a curated space.</footer>
</main>
<script>
(function(){var q=document.getElementById('q'),chips=document.getElementById('chips'),items=[].slice.call(document.querySelectorAll('.bm')),tag='';
function apply(){var t=q.value.trim().toLowerCase();items.forEach(function(li){var ok=(!t||li.dataset.text.indexOf(t)>=0)&&(!tag||(' '+li.dataset.tags+' ').indexOf(' '+tag+' ')>=0);li.classList.toggle('hide',!ok)});[].slice.call(chips.children).forEach(function(c){c.classList.toggle('on',c.dataset.tag===tag)})}
chips.addEventListener('click',function(e){var c=e.target.closest('.chip');if(!c)return;tag=tag===c.dataset.tag?'':c.dataset.tag;location.hash=tag?'tag='+encodeURIComponent(tag):'';apply()});
document.addEventListener('click',function(e){var a=e.target.closest('a.tag');if(!a)return;e.preventDefault();tag=decodeURIComponent(a.getAttribute('href').slice(5));location.hash=a.getAttribute('href');apply()});
q.addEventListener('input',apply);var m=/tag=([^&]+)/.exec(location.hash);if(m)tag=decodeURIComponent(m[1]);apply();})();
</script>
</body>
</html>
`;
}
