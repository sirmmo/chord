// Bookmarks: merging two devices' lists, and the public "linkroll" site that
// the public ones are published as (GitHub Pages). Pure, unit-tested.

import type { Bookmark } from './types.ts';
import { renderMarkdown } from './markdown.ts';

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
    ...(typeof b.spaceId === 'string' ? { spaceId: b.spaceId } : {}),
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
  /** look of the page: elegant cards (default), a pragmatic dense list, or an old-school digg.com homage */
  theme?: 'elegant' | 'pragmatic' | 'digg';
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

/** The linkroll page: a static site with search and tag filters, no build step, in one of three looks. */
export function renderLinkroll(list: Bookmark[], opts: SiteOptions): string {
  if (opts.theme === 'pragmatic') return renderPragmatic(list, opts);
  if (opts.theme === 'digg') return renderDigg(list, opts);
  return renderElegant(list, opts);
}

const SEARCH_SCRIPT = `(function(){var q=document.getElementById('q'),chips=document.getElementById('chips'),items=[].slice.call(document.querySelectorAll('.bm')),tag='';
function apply(){var t=q?q.value.trim().toLowerCase():'';items.forEach(function(li){var ok=(!t||li.dataset.text.indexOf(t)>=0)&&(!tag||(' '+li.dataset.tags+' ').indexOf(' '+tag+' ')>=0);li.classList.toggle('hide',!ok)});if(chips)[].slice.call(chips.children).forEach(function(c){c.classList.toggle('on',c.dataset.tag===tag)})}
if(chips)chips.addEventListener('click',function(e){var c=e.target.closest('.chip');if(!c)return;tag=tag===c.dataset.tag?'':c.dataset.tag;location.hash=tag?'tag='+encodeURIComponent(tag):'';apply()});
document.addEventListener('click',function(e){var a=e.target.closest('a.tag');if(!a)return;e.preventDefault();tag=decodeURIComponent(a.getAttribute('href').slice(5));location.hash=a.getAttribute('href');apply()});
if(q)q.addEventListener('input',apply);var m=/tag=([^&]+)/.exec(location.hash);if(m)tag=decodeURIComponent(m[1]);apply();})();`;

function tagCounts(pub: Bookmark[]): [string, number][] {
  const tags = new Map<string, number>();
  for (const b of pub) for (const t of b.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  return [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function chipsOf(pub: Bookmark[]): string {
  return tagCounts(pub)
    .map(([t, n]) => `<button class="chip" data-tag="${esc(t)}">${esc(t)} <span>${n}</span></button>`)
    .join('');
}

function dataAttrs(b: Bookmark, host: string): string {
  return `data-tags="${esc(b.tags.join(' '))}" data-text="${esc(`${b.title} ${host} ${b.note} ${b.tags.join(' ')}`.toLowerCase())}"`;
}

function ago(ts: number): string {
  const d = Date.now() - ts;
  const days = Math.floor(d / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function headMeta(opts: SiteOptions, title: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="Links ${esc(opts.user)} bookmarked publicly with Chord.">
<link rel="alternate" type="application/rss+xml" title="${title}" href="feed.xml">
<link rel="alternate" type="application/json" title="${title} (JSON)" href="bookmarks.json">`;
}

/** Dense and plain: one line per link, dates, tags, nothing else. */
function renderPragmatic(list: Bookmark[], opts: SiteOptions): string {
  const pub = publicBookmarks(list).slice().sort((a, b) => b.addedAt - a.addedAt);
  const title = esc(opts.title ?? `${opts.user}'s bookmarks`);
  const rows = pub
    .map((b) => {
      const host = hostOf(b.url);
      const d = new Date(b.addedAt).toISOString().slice(0, 10);
      return `<li class="bm" ${dataAttrs(b, host)}><span class="d">${d}</span> <a href="${esc(b.url)}" rel="noopener">${esc(b.title || b.url)}</a> <span class="h">${esc(host)}</span>${b.tags.map((t) => ` <a class="tag" href="#tag=${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')}${b.note ? `<div class="n">${renderMarkdown(b.note)}</div>` : ''}</li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
${headMeta(opts, title)}
<style>
:root{--bg:#fff;--fg:#111;--muted:#666;--line:#ddd;--accent:#0645ad}
@media(prefers-color-scheme:dark){:root{--bg:#101010;--fg:#e8e8e8;--muted:#999;--line:#2c2c2c;--accent:#7fb2ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
main{max-width:900px;margin:0 auto;padding:28px 16px 60px}h1{font-size:18px;margin:0 0 2px}.sub{color:var(--muted);margin:0 0 14px;font-size:13px}.sub a{color:var(--muted)}
.search{width:100%;font:inherit;padding:6px 8px;border:1px solid var(--line);background:transparent;color:var(--fg);outline:none;margin-bottom:8px}
.chips{display:flex;flex-wrap:wrap;gap:4px 10px;margin:0 0 16px}.chip{font:inherit;font-size:12px;border:0;background:none;color:var(--accent);padding:0;cursor:pointer}.chip span{color:var(--muted)}.chip.on{text-decoration:underline;font-weight:700}
ul{list-style:none;margin:0;padding:0}.bm{padding:4px 0;border-bottom:1px dotted var(--line)}.bm.hide{display:none}.bm a{color:var(--accent);text-decoration:none}.bm a:hover{text-decoration:underline}
.d{color:var(--muted);margin-right:6px}.h{color:var(--muted);font-size:12px}.tag{font-size:12px}.n{color:var(--muted);font-size:13px;padding:2px 0 2px 96px}.n p{margin:0}
footer{margin-top:28px;color:var(--muted);font-size:12px}footer a{color:inherit}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p class="sub">${pub.length} links · <a href="feed.xml">rss</a> · <a href="bookmarks.json">json</a></p>
<input class="search" id="q" type="search" placeholder="filter" autocomplete="off">
<div class="chips" id="chips">${chipsOf(pub)}</div>
<ul id="list">
${rows || '<li>nothing public yet</li>'}
</ul>
<footer>published with <a href="https://ingmmo.com/chord/">chord</a> · follow this page as a curator in chord</footer>
</main>
<script>${SEARCH_SCRIPT}</script>
</body>
</html>
`;
}

/** An homage to digg.com circa 2007: the blue header, the yellow box on every story, topics down the side. */
function renderDigg(list: Bookmark[], opts: SiteOptions): string {
  const pub = publicBookmarks(list).slice().sort((a, b) => b.addedAt - a.addedAt);
  const title = esc(opts.title ?? `${opts.user}'s bookmarks`);
  const total = pub.length;
  const rows = pub
    .map((b, i) => {
      const host = hostOf(b.url);
      return `<div class="bm story" ${dataAttrs(b, host)}>
  <div class="diggbox"><strong>${total - i}</strong><span>bookmark</span></div>
  <div class="body">
    <h3><a href="${esc(b.url)}" rel="noopener">${esc(b.title || b.url)}</a> <span class="src">(${esc(host)})</span></h3>
    <p class="meta">bookmarked by <a href="https://github.com/${esc(opts.user)}">${esc(opts.user)}</a> ${ago(b.addedAt)}${b.tags.length ? ` in ${b.tags.map((t) => `<a class="tag" href="#tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join(', ')}` : ''}</p>${b.note ? `\n    <div class="desc">${renderMarkdown(b.note)}</div>` : ''}
  </div>
</div>`;
    })
    .join('\n');
  const topics = tagCounts(pub)
    .map(([t, n]) => `<li><button class="chip" data-tag="${esc(t)}">${esc(t)} <span>(${n})</span></button></li>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
${headMeta(opts, title)}
<style>
body{margin:0;background:#fff;color:#333;font:13px/1.4 Verdana,Arial,Helvetica,sans-serif}
a{color:#1b5790}a:hover{color:#f00}
#hdr{background:#1b5790 linear-gradient(#2a6fb1,#1b5790);border-bottom:4px solid #f5a623;padding:0}
#hdr .in{max-width:960px;margin:0 auto;display:flex;align-items:flex-end;gap:24px;padding:14px 12px 10px}
#hdr .logo{font:bold 30px/1 "Trebuchet MS",Arial,sans-serif;color:#fff;letter-spacing:-1px;text-decoration:none}#hdr .logo em{font-style:normal;color:#f5a623}
#hdr nav a{color:#fff;font-weight:bold;text-decoration:none;margin-right:16px;font-size:13px}
#sub{background:#e8eef5;border-bottom:1px solid #c9d6e4}#sub .in{max-width:960px;margin:0 auto;padding:6px 12px;display:flex;align-items:center;gap:10px;font-size:12px;color:#555}
#sub input{font:inherit;padding:3px 6px;border:1px solid #9db3cc;width:260px}
.wrap{max-width:960px;margin:0 auto;display:grid;grid-template-columns:1fr 220px;gap:24px;padding:14px 12px 40px}
.story{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #e5e5e5}.story.hide{display:none}
.diggbox{flex:none;width:52px;height:48px;border:1px solid #c8c8a8;background:#fffbcc;text-align:center;font-size:10px;color:#777;padding-top:4px;box-sizing:border-box}.diggbox strong{display:block;font-size:17px;color:#1b5790;line-height:1.1}
.story h3{margin:0;font-size:16px;font-weight:bold}.story h3 a{text-decoration:none}.story h3 a:hover{text-decoration:underline}.story .src{font-size:12px;font-weight:normal;color:#777}
.story .meta{margin:3px 0 0;font-size:11px;color:#777}.story .meta a{color:#1b5790}.story .desc{margin:6px 0 0;font-size:12px;color:#444;line-height:1.5}.story .desc p{margin:0 0 4px}
aside h4{margin:0 0 6px;font-size:12px;text-transform:uppercase;color:#1b5790;border-bottom:2px solid #1b5790;padding-bottom:3px}
aside ul{list-style:none;margin:0 0 20px;padding:0}aside li{padding:2px 0;font-size:12px}aside .chip{font:inherit;border:0;background:none;color:#1b5790;padding:0;cursor:pointer;text-align:left}aside .chip.on{font-weight:bold;color:#f00}aside .chip span{color:#999}
.box{border:1px solid #d7e0ea;background:#f5f8fb;padding:8px 10px;font-size:11px;color:#555;margin-bottom:16px}.box a{color:#1b5790}
footer{max-width:960px;margin:0 auto;padding:10px 12px 30px;font-size:11px;color:#999;border-top:1px solid #e5e5e5}footer a{color:#1b5790}
@media(max-width:700px){.wrap{grid-template-columns:1fr}}
</style>
</head>
<body>
<div id="hdr"><div class="in"><a class="logo" href="./">${esc(opts.user)}<em>.</em>links</a><nav><a href="./">All</a><a href="feed.xml">RSS</a><a href="bookmarks.json">JSON</a></nav></div></div>
<div id="sub"><div class="in"><span>${total} stories</span><input id="q" type="search" placeholder="Search this page" autocomplete="off"></div></div>
<div class="wrap">
<div id="list">
${rows || '<p>Nothing public yet.</p>'}
</div>
<aside>
<div class="box">Links ${esc(opts.user)} bookmarked publicly with <a href="https://ingmmo.com/chord/">Chord</a>. Follow them: paste this page's address into a curated space, or subscribe to the <a href="feed.xml">RSS feed</a>.</div>
<h4>Topics</h4>
<ul id="chips">${topics || '<li>none yet</li>'}</ul>
</aside>
</div>
<footer>${title} · made with Chord, in the spirit of digg.com, 2007.</footer>
<script>${SEARCH_SCRIPT}</script>
</body>
</html>
`;
}

function renderElegant(list: Bookmark[], opts: SiteOptions): string {
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
  <span class="h">${esc(host)}</span>${b.note ? `\n  <div class="n">${renderMarkdown(b.note)}</div>` : ''}
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
.bm .t{font-weight:600;color:var(--fg);text-decoration:none}.bm .t:hover{color:var(--accent)}.bm .h{color:var(--muted);font-size:13px;margin-left:8px}.bm .n{margin:6px 0 0;color:var(--fg)}.bm .n p{margin:0 0 4px}.bm .m{display:block;margin-top:6px;font-size:12.5px;color:var(--muted)}.tag{color:var(--accent);text-decoration:none;margin-right:2px}
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
