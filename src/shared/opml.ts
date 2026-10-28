// OPML: the subscription lists feed readers exchange. Pure, unit-tested.

import { decodeEntities } from './feed.ts';

export interface OpmlFeed {
  title: string;
  xmlUrl: string;
  htmlUrl: string;
  /** the folder the outline sits in, "" at the top level */
  folder: string;
}
export interface OpmlDoc {
  title: string;
  feeds: OpmlFeed[];
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? '');
  return out;
}

/** Feeds of an OPML document, with the folder (outline without a URL) each sits in. Returns null when it is not OPML. */
export function parseOpml(xml: string): OpmlDoc | null {
  if (!/<opml\b/i.test(xml)) return null;
  const titleMatch = /<head>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/head>/i.exec(xml);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : '';
  const feeds: OpmlFeed[] = [];
  const stack: string[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<outline\b([^>]*?)(\/?)>|<\/outline\s*>/gi)) {
    if (m[0].startsWith('</')) {
      stack.pop();
      continue;
    }
    const a = attrs(m[1]);
    const xmlUrl = a.xmlurl ?? '';
    const text = a.text ?? a.title ?? '';
    const selfClosing = m[2] === '/';
    if (xmlUrl && /^https?:\/\//i.test(xmlUrl)) {
      if (!seen.has(xmlUrl)) {
        seen.add(xmlUrl);
        feeds.push({ title: text || xmlUrl, xmlUrl, htmlUrl: a.htmlurl ?? '', folder: stack[stack.length - 1] ?? '' });
      }
      if (!selfClosing) stack.push(stack[stack.length - 1] ?? '');
    } else if (!selfClosing) stack.push(text || stack[stack.length - 1] || '');
  }
  return { title, feeds };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** An OPML document, one folder outline per group. */
export function renderOpml(title: string, groups: { name: string; feeds: { title: string; xmlUrl: string; htmlUrl: string }[] }[]): string {
  const line = (f: { title: string; xmlUrl: string; htmlUrl: string }, indent: string) => `${indent}<outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.xmlUrl)}"${f.htmlUrl ? ` htmlUrl="${esc(f.htmlUrl)}"` : ''}/>`;
  const body = groups
    .map((g) => (g.name ? `    <outline text="${esc(g.name)}" title="${esc(g.name)}">\n${g.feeds.map((f) => line(f, '      ')).join('\n')}\n    </outline>` : g.feeds.map((f) => line(f, '    ')).join('\n')))
    .filter(Boolean)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${esc(title)}</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${body}
  </body>
</opml>
`;
}
