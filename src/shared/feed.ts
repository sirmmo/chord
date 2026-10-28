// Feeds for curated mode: RSS 2.0, Atom and JSON Feed parsed without a DOM,
// GitHub starred lists, and the guesswork that turns what a user types
// (a site, an @handle, a GitHub user) into a feed URL. Pure, unit-tested.

export interface FeedItem {
  id: string;
  title: string;
  url: string;
  summary: string;
  author: string;
  publishedAt: number;
}
export interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Text of an element: CDATA unwrapped, tags stripped, entities decoded, whitespace folded. */
export function cleanText(raw: string): string {
  let t = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  t = decodeEntities(t);
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}

function tag(block: string, names: string[]): string {
  for (const n of names) {
    const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}\\s*>`, 'i').exec(block);
    if (m) return m[1];
  }
  return '';
}
function attr(el: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(el);
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : '';
}
function atomLink(block: string): string {
  const links = block.match(/<link\b[^>]*\/?>/gi) ?? [];
  let fallback = '';
  for (const l of links) {
    const rel = attr(l, 'rel') || 'alternate';
    const href = attr(l, 'href');
    if (!href) continue;
    if (rel === 'alternate') return href;
    if (!fallback && rel !== 'self' && rel !== 'enclosure' && rel !== 'replies') fallback = href;
  }
  return fallback;
}
function date(s: string): number {
  const t = Date.parse(cleanText(s));
  return Number.isFinite(t) ? t : 0;
}
function absolute(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** Parse an RSS, Atom or JSON Feed document. Returns null when it is none of them. */
export function parseFeed(text: string, baseUrl = ''): ParsedFeed | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return parseJsonFeed(trimmed, baseUrl);
  if (!/<(rss|feed|rdf:RDF|channel)\b/i.test(trimmed.slice(0, 4000))) return null;
  const isAtom = /<feed\b[^>]*>/i.test(trimmed) && /<entry\b/i.test(trimmed);
  const items: FeedItem[] = [];
  if (isAtom) {
    const head = trimmed.split(/<entry\b/i)[0];
    const title = cleanText(tag(head, ['title']));
    for (const m of trimmed.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
      const b = m[1];
      const url = absolute(atomLink(b), baseUrl);
      const author = cleanText(tag(tag(b, ['author']), ['name']));
      items.push({
        id: cleanText(tag(b, ['id'])) || url,
        title: cleanText(tag(b, ['title'])),
        url,
        summary: cleanText(tag(b, ['summary', 'content'])).slice(0, 400),
        author,
        publishedAt: date(tag(b, ['published', 'updated', 'issued'])),
      });
    }
    return { title, items };
  }
  const head = trimmed.split(/<item\b/i)[0];
  const title = cleanText(tag(head, ['title']));
  for (const m of trimmed.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const b = m[1];
    let url = cleanText(tag(b, ['link']));
    if (!url) url = attr(/<link\b[^>]*\/?>/i.exec(b)?.[0] ?? '', 'href');
    if (!url) {
      const guid = /<guid\b[^>]*>([\s\S]*?)<\/guid>/i.exec(b);
      if (guid && /^https?:/i.test(cleanText(guid[1]))) url = cleanText(guid[1]);
    }
    url = absolute(url, baseUrl);
    items.push({
      id: cleanText(tag(b, ['guid'])) || url,
      title: cleanText(tag(b, ['title'])),
      url,
      summary: cleanText(tag(b, ['description', 'content:encoded', 'summary'])).slice(0, 400),
      author: cleanText(tag(b, ['dc:creator', 'author'])),
      publishedAt: date(tag(b, ['pubDate', 'dc:date', 'published', 'updated'])),
    });
  }
  return { title, items };
}

function parseJsonFeed(text: string, baseUrl: string): ParsedFeed | null {
  try {
    const j = JSON.parse(text) as { version?: string; title?: string; items?: Record<string, unknown>[] };
    if (!j || !Array.isArray(j.items) || !(typeof j.version === 'string' && j.version.includes('jsonfeed'))) return null;
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    return {
      title: s(j.title),
      items: j.items.map((it) => {
        const url = absolute(s(it.url) || s(it.external_url), baseUrl);
        const authors = Array.isArray(it.authors) ? (it.authors as { name?: string }[]) : [];
        return {
          id: s(it.id) || url,
          title: s(it.title),
          url,
          summary: cleanText(s(it.summary) || s(it.content_text) || s(it.content_html)).slice(0, 400),
          author: s((it.author as { name?: string } | undefined)?.name) || s(authors[0]?.name),
          publishedAt: date(s(it.date_published) || s(it.date_modified)),
        };
      }),
    };
  } catch {
    return null;
  }
}

/** GitHub's starred list with `Accept: application/vnd.github.star+json`. */
export function parseGitHubStars(text: string): FeedItem[] {
  try {
    const arr = JSON.parse(text) as { starred_at?: string; repo?: Record<string, unknown> }[];
    if (!Array.isArray(arr)) return [];
    return arr
      .map((e) => {
        const r = (e.repo ?? e) as Record<string, unknown>;
        const full = typeof r.full_name === 'string' ? r.full_name : '';
        if (!full) return null;
        const bits = [typeof r.description === 'string' ? r.description : '', typeof r.language === 'string' ? r.language : '', typeof r.stargazers_count === 'number' ? `★ ${r.stargazers_count}` : ''].filter(Boolean);
        return { id: `gh:${full}`, title: full, url: typeof r.html_url === 'string' ? r.html_url : `https://github.com/${full}`, summary: bits.join(' · ').slice(0, 400), author: full.split('/')[0], publishedAt: date(typeof e.starred_at === 'string' ? e.starred_at : typeof r.pushed_at === 'string' ? r.pushed_at : '') };
      })
      .filter((x): x is FeedItem => x !== null);
  } catch {
    return [];
  }
}

export type ItemKind = 'link' | 'repo' | 'post' | 'video';
export function itemKind(url: string): ItemKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'link';
  }
  const h = u.hostname.replace(/^www\./, '');
  if ((h === 'github.com' || h === 'gitlab.com' || h === 'codeberg.org') && /^\/[^/]+\/[^/]+\/?$/.test(u.pathname)) return 'repo';
  if (h === 'youtube.com' || h === 'youtu.be' || h === 'vimeo.com') return 'video';
  if (/^(bsky\.app|mastodon\.[a-z]+|twitter\.com|x\.com|threads\.net|reddit\.com|news\.ycombinator\.com|lobste\.rs)$/.test(h) || /^\/@[^/]+\/\d+/.test(u.pathname)) return 'post';
  return 'link';
}

export interface Resolved {
  kind: 'feed' | 'github' | 'discover';
  /** the feed (or API) URL, or the page to look for a feed on */
  url: string;
  name: string;
}

/** What a user typed → where the feed is, or which page to discover it on. */
export function resolveCuratorInput(raw: string): Resolved | null {
  let input = raw.trim();
  if (!input) return null;
  // @user@instance → Mastodon; @handle or handle.bsky.social → Bluesky
  let m = /^@?([\w.-]+)@([\w.-]+\.\w+)$/.exec(input);
  if (m) return { kind: 'feed', url: `https://${m[2]}/@${m[1]}.rss`, name: `@${m[1]}@${m[2]}` };
  m = /^@([\w.-]+)$/.exec(input);
  if (m) {
    const handle = m[1].includes('.') ? m[1] : `${m[1]}.bsky.social`;
    return { kind: 'feed', url: `https://bsky.app/profile/${handle}/rss`, name: `@${handle}` };
  }
  m = /^(?:github|gh):\s*([\w.-]+)$/i.exec(input);
  if (m) return { kind: 'github', url: `https://api.github.com/users/${m[1]}/starred?per_page=60`, name: `${m[1]} on GitHub` };
  if (!/^[a-z]+:\/\//i.test(input)) input = `https://${input}`;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  if (host === 'github.com') {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 1) return { kind: 'github', url: `https://api.github.com/users/${parts[0]}/starred?per_page=60`, name: `${parts[0]} on GitHub` };
    if (parts.length >= 2) return { kind: 'feed', url: `https://github.com/${parts[0]}/${parts[1]}/releases.atom`, name: `${parts[0]}/${parts[1]} releases` };
  }
  if (host === 'bsky.app') {
    const p = /^\/profile\/([^/]+)/.exec(path);
    if (p) return { kind: 'feed', url: `https://bsky.app/profile/${p[1]}/rss`, name: `@${p[1]}` };
  }
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const ch = /^\/channel\/([^/]+)/.exec(path);
    if (ch) return { kind: 'feed', url: `https://www.youtube.com/feeds/videos.xml?channel_id=${ch[1]}`, name: 'YouTube channel' };
    return { kind: 'discover', url: u.href, name: host };
  }
  if (host === 'reddit.com' || host === 'old.reddit.com') {
    const r = /^\/(r|user|u)\/([^/]+)/.exec(path);
    if (r) return { kind: 'feed', url: `https://www.reddit.com/${r[1] === 'u' ? 'user' : r[1]}/${r[2]}/.rss`, name: `${r[1] === 'r' ? 'r/' : 'u/'}${r[2]}` };
  }
  if (host === 'news.ycombinator.com') {
    const id = u.searchParams.get('id');
    if (id) return { kind: 'feed', url: `https://hnrss.org/submitted?id=${id}`, name: `${id} on Hacker News` };
  }
  const mast = /^\/@([\w.-]+)$/.exec(path);
  if (mast) return { kind: 'feed', url: `https://${u.hostname}/@${mast[1]}.rss`, name: `@${mast[1]}@${host}` };
  if (/\.(rss|xml|atom|json)$/i.test(path) || /\/(feed|rss|atom)\/?$/i.test(path) || u.searchParams.get('format') === 'rss') return { kind: 'feed', url: u.href, name: host };
  return { kind: 'discover', url: u.href, name: host };
}

/** Feed links advertised by an HTML page, absolute, in document order. */
export function discoverFeeds(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const l of html.match(/<link\b[^>]*>/gi) ?? []) {
    const type = attr(l, 'type').toLowerCase();
    const rel = attr(l, 'rel').toLowerCase();
    if (!/alternate/.test(rel) || !/(rss|atom|feed\+json|json)/.test(type)) continue;
    const href = attr(l, 'href');
    if (href) out.push(absolute(href, baseUrl));
  }
  return [...new Set(out)];
}

/** Where to look when a page advertises nothing. */
export function feedGuesses(pageUrl: string): string[] {
  try {
    const u = new URL(pageUrl);
    const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    return [`${base}/feed`, `${base}/rss`, `${base}/feed.xml`, `${base}/rss.xml`, `${base}/atom.xml`, `${base}/index.xml`, `${base}/feed.json`, `${u.origin}/feed`, `${u.origin}/rss.xml`, `${u.origin}/atom.xml`, `${u.origin}/index.xml`].filter((v, i, a) => a.indexOf(v) === i);
  } catch {
    return [];
  }
}
