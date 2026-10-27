// Sourceror page script: reads the article, draws marks, reports clicks.
//
// Ported from the Sourceror Chrome extension's content script. Chord runs it
// in the page preload's isolated world on demand (SourcesManager), so it sees
// the DOM but not the page's JavaScript, and it never talks to the Sourceror
// server itself: the main process makes every API call. Clicks on marks reach
// the side panel through window.__chordSourceror, which the page preload
// defines in the same world.

import { Readability } from '@mozilla/readability';

interface Paragraph {
  i: number;
  text: string;
  marked: string;
}
interface Link {
  id: number;
  href: string;
  text: string;
  p: number | null;
}
interface SourceMark {
  n: number;
  href?: string;
  urls?: string[];
  doi?: string;
  display?: string;
  grade: string;
  score: number;
}
interface ClaimMark {
  id: string;
  text: string;
  status: string;
}

type Api = {
  extract(): unknown;
  mark(payload: { wikipedia?: boolean; sources: SourceMark[]; claims: ClaimMark[] }): { sources: number; claims: number };
  clear(): { ok: true };
  focus(kind: string, id: string): { ok: boolean };
};

declare global {
  interface Window {
    __sourceror?: Api;
    __chordSourceror?: { select(kind: string, id: string): void };
  }
  interface Highlight {
    _brand?: never;
  }
}

(() => {
  if (window.__sourceror) return;

  const BLOCKS = 'p, li, blockquote, dd, figcaption';
  const MAX_PARAGRAPHS = 120;
  const TRACKING = /^(utm_|fbclid$|gclid$|mc_[ce]id$|ref$|ref_src$|cmpid$|ocid$|smid$|xtor$)/i;
  const win = window as Window & { CSS: typeof CSS & { highlights?: Map<string, unknown> }; Highlight?: new (...ranges: Range[]) => unknown };

  // Must match sourceror.page.normalise_url, so marks find their sources.
  function normaliseUrl(raw: string, base?: string): string {
    try {
      const u = new URL(raw, base || location.href);
      if (!/^https?:$/.test(u.protocol)) return '';
      const keep = [...u.searchParams].filter(([k]) => !TRACKING.test(k));
      const q = new URLSearchParams(keep).toString();
      return `${u.protocol}//${u.host.toLowerCase()}${u.pathname || '/'}${q ? '?' + q : ''}`;
    } catch {
      return '';
    }
  }

  // ------------------------------------------------------------ extract

  function wikipediaTarget(): { kind: 'wikipedia'; lang: string; title: string; url: string } | null {
    const m = location.hostname.match(/^([a-z-]+)\.(?:m\.)?wikipedia\.org$/);
    if (!m || !location.pathname.startsWith('/wiki/')) return null;
    const title = decodeURIComponent(location.pathname.slice(6)).replace(/_/g, ' ');
    if (/^[^:]+:/.test(title) && !/^[^:]+: /.test(title)) return null; // Special:, Talk:…
    return { kind: 'wikipedia', lang: m[1], title, url: location.href };
  }

  function meta(...names: string[]): string | null {
    for (const n of names) {
      const el = document.querySelector<HTMLMetaElement>(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
      if (el && el.content) return el.content.trim();
    }
    return null;
  }

  function leafBlocks(root: ParentNode): Element[] {
    // A <li> that wraps a <p> would be read twice; keep the innermost block.
    return [...root.querySelectorAll(BLOCKS)].filter((el) => !el.querySelector(BLOCKS));
  }

  function extractArticle() {
    let article: ReturnType<Readability['parse']> = null;
    try {
      article = new Readability(document.cloneNode(true) as Document, { charThreshold: 300 }).parse();
    } catch {
      article = null;
    }
    const root: ParentNode = article?.content ? new DOMParser().parseFromString(article.content, 'text/html').body : (document.querySelector('article, main, [role=main]') ?? document.body);

    const paragraphs: Paragraph[] = [];
    const links: Link[] = [];
    for (const block of leafBlocks(root)) {
      if (paragraphs.length >= MAX_PARAGRAPHS) break;
      let text = '';
      let marked = '';
      const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.nodeValue ?? '';
          marked += node.nodeValue ?? '';
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (/^(SCRIPT|STYLE|NOSCRIPT|BUTTON|svg)$/i.test(node.nodeName)) return;
        node.childNodes.forEach(walk);
        const el = node as Element;
        if (el.nodeName === 'A' && el.getAttribute('href')) {
          const href = normaliseUrl(el.getAttribute('href')!, location.href);
          if (href) {
            const id = links.length;
            links.push({ id, href, text: (el.textContent ?? '').trim().slice(0, 200), p: paragraphs.length });
            marked += ` [L${id}]`;
          }
        }
      };
      walk(block);
      text = text.replace(/\s+/g, ' ').trim();
      if (text.length < 25) {
        // Too short to be prose, but its links (a "Source:" line) still count.
        for (const l of links) if (l.p === paragraphs.length) l.p = null;
        continue;
      }
      paragraphs.push({ i: paragraphs.length, text, marked: marked.replace(/\s+/g, ' ').trim() });
    }

    return {
      kind: 'article' as const,
      url: location.href,
      title: article?.title || meta('og:title') || document.title,
      byline: article?.byline || meta('author', 'article:author'),
      site_name: article?.siteName || meta('og:site_name'),
      published: article?.publishedTime || meta('article:published_time', 'datePublished', 'date', 'DC.date.issued'),
      lang: article?.lang || document.documentElement.lang || navigator.language,
      paragraphs,
      links,
    };
  }

  // -------------------------------------------------------------- marks

  const state = { claims: new Map<string, Range>(), dots: [] as HTMLElement[], refMarks: [] as HTMLElement[] };

  function clearMarks(): void {
    state.dots.forEach((d) => d.remove());
    state.refMarks.forEach((el) => el.classList.remove('srcr-ref', 'srcr-solid', 'srcr-ok', 'srcr-weak', 'srcr-unreliable', 'srcr-flash'));
    state.dots = [];
    state.refMarks = [];
    state.claims.clear();
    if (win.CSS && win.CSS.highlights) {
      for (const n of ['srcr-unsourced', 'srcr-weak', 'srcr-attributed', 'srcr-focus']) win.CSS.highlights.delete(n);
    }
  }

  function dot(grade: string, kind: string, id: string | number, title: string): HTMLElement {
    const d = document.createElement('span');
    d.className = `srcr-dot srcr-${grade || 'none'}`;
    d.dataset.srcrKind = kind;
    d.dataset.srcrId = String(id);
    d.title = title;
    d.setAttribute('role', 'button');
    d.tabIndex = 0;
    state.dots.push(d);
    return d;
  }

  function inProse(el: Element): boolean {
    return !!el.closest('p, li, blockquote, dd, td, figcaption') && !el.closest('nav, header, footer, aside, [role=navigation]');
  }

  function markSources(sources: SourceMark[]): number {
    const byHref = new Map(sources.filter((s) => s.href).map((s) => [s.href!, s]));
    let marked = 0;
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (!inProse(a)) continue;
      const s = byHref.get(normaliseUrl(a.getAttribute('href')!));
      if (!s) continue;
      a.after(dot(s.grade, 'source', s.n, `Sourceror: ${s.grade} (${s.score}/100)`));
      marked++;
    }
    return marked;
  }

  // Wikipedia: tie each audited citation to its <li> in the reference list.
  function markWikipediaRefs(citations: SourceMark[]): number {
    const keyed = new Map<string, SourceMark>();
    for (const c of citations) {
      for (const u of c.urls ?? []) {
        const k = normaliseUrl(u);
        if (k) keyed.set(k, c);
      }
      if (c.doi) keyed.set('doi:' + c.doi.toLowerCase(), c);
    }
    const byText = citations.filter((c) => c.display && c.display.length > 12);
    let marked = 0;
    for (const li of document.querySelectorAll<HTMLElement>('ol.references > li[id]')) {
      let c: SourceMark | undefined;
      for (const a of li.querySelectorAll<HTMLAnchorElement>('a.external[href]')) {
        c = keyed.get(normaliseUrl(a.getAttribute('href')!));
        if (c) break;
      }
      if (!c) {
        const doi = (li.textContent?.match(/\b10\.\d{4,9}\/[^\s"<>]+/) || [])[0];
        if (doi) c = keyed.get('doi:' + doi.replace(/[.,;)]+$/, '').toLowerCase());
      }
      if (!c) {
        const t = (li.textContent ?? '').replace(/\s+/g, ' ');
        c = byText.find((x) => t.includes(x.display!.slice(0, 40)));
      }
      if (!c) continue;
      const target = li.querySelector('.reference-text') || li;
      target.prepend(dot(c.grade, 'citation', c.n, `Sourceror: ${c.grade} (${c.score}/100)`));
      for (const sup of document.querySelectorAll(`sup.reference a[href="#${CSS.escape(li.id)}"]`)) {
        const s = sup.closest('sup') as HTMLElement | null;
        if (!s) continue;
        s.classList.add('srcr-ref', `srcr-${c.grade}`);
        s.dataset.srcrKind = 'citation';
        s.dataset.srcrId = String(c.n);
        state.refMarks.push(s);
      }
      marked++;
    }
    return marked;
  }

  // Text search over the live page, collapsing whitespace, so a claim string
  // from the server can be turned back into a Range.
  function textIndex(): { str: string; map: [Text, number][] } {
    const scope = document.querySelector('#mw-content-text, article, main, [role=main]') || document.body;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => ((n.parentElement?.closest('script, style, noscript, .srcr-dot, sup.reference, .mw-editsection') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) as number),
    });
    let str = '';
    const map: [Text, number][] = [];
    let lastSpace = true;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const v = n.nodeValue ?? '';
      for (let i = 0; i < v.length; i++) {
        const ch = v[i];
        if (/\s/.test(ch)) {
          if (lastSpace) continue;
          str += ' ';
          lastSpace = true;
        } else {
          str += ch;
          lastSpace = false;
        }
        map.push([n as Text, i]);
      }
    }
    return { str, map };
  }

  function findRange(idx: ReturnType<typeof textIndex>, text: string): Range | null {
    const needle = text.replace(/\s+/g, ' ').trim();
    const tries = [needle, needle.slice(0, 90), needle.slice(0, 50)].filter((t, i, a) => t.length >= 20 && a.indexOf(t) === i);
    for (const t of tries) {
      const at = idx.str.indexOf(t);
      if (at < 0) continue;
      const [sn, so] = idx.map[at];
      const [en, eo] = idx.map[at + t.length - 1];
      const r = document.createRange();
      r.setStart(sn, so);
      r.setEnd(en, eo + 1);
      return r;
    }
    return null;
  }

  function markClaims(claims: ClaimMark[]): number {
    if (!(win.CSS && win.CSS.highlights && win.Highlight)) return 0;
    const idx = textIndex();
    const groups: Record<string, Range[]> = { 'srcr-unsourced': [], 'srcr-weak': [], 'srcr-attributed': [] };
    const group: Record<string, string> = { unsourced: 'srcr-unsourced', weakly_linked: 'srcr-weak', attributed: 'srcr-attributed', tagged: 'srcr-unsourced', unsourced_paragraph: 'srcr-unsourced' };
    let found = 0;
    for (const c of claims) {
      const g = group[c.status];
      if (!g) continue;
      const r = findRange(idx, c.text);
      if (!r) continue;
      state.claims.set(String(c.id), r);
      groups[g].push(r);
      found++;
    }
    for (const [name, ranges] of Object.entries(groups)) {
      if (ranges.length) win.CSS.highlights.set(name, new win.Highlight(...ranges));
    }
    return found;
  }

  function focus(kind: string, id: string): boolean {
    if (kind === 'claim') {
      const r = state.claims.get(String(id));
      if (!r) return false;
      const box = r.getBoundingClientRect();
      window.scrollBy({ top: box.top - innerHeight / 3, behavior: 'smooth' });
      if (win.Highlight && win.CSS.highlights) {
        win.CSS.highlights.set('srcr-focus', new win.Highlight(r));
        setTimeout(() => win.CSS.highlights!.delete('srcr-focus'), 2200);
      }
      return true;
    }
    const el = state.dots.find((d) => d.dataset.srcrKind === kind && d.dataset.srcrId === String(id));
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('srcr-flash');
    setTimeout(() => el.classList.remove('srcr-flash'), 2200);
    return true;
  }

  const select = (kind: string, id: string) => {
    try {
      window.__chordSourceror?.select(kind, id);
    } catch {
      /* bridge missing */
    }
  };

  // Clicking a mark in the page jumps to its entry in the side panel.
  document.addEventListener(
    'click',
    (ev) => {
      const target = ev.target instanceof Element ? ev.target : null;
      const el = target?.closest<HTMLElement>('[data-srcr-kind]');
      if (el && el.classList.contains('srcr-dot')) {
        ev.preventDefault();
        ev.stopPropagation();
        select(el.dataset.srcrKind!, el.dataset.srcrId!);
        return;
      }
      if (!state.claims.size || !document.caretRangeFromPoint) return;
      const p = document.caretRangeFromPoint(ev.clientX, ev.clientY);
      if (!p) return;
      for (const [id, r] of state.claims) {
        try {
          if (r.isPointInRange(p.startContainer, p.startOffset)) {
            select('claim', id);
            return;
          }
        } catch {
          /* range from a node that has since left the page */
        }
      }
    },
    true,
  );

  window.__sourceror = {
    extract: () => wikipediaTarget() || extractArticle(),
    mark: (msg) => {
      clearMarks();
      const sources = msg.wikipedia ? markWikipediaRefs(msg.sources || []) : markSources(msg.sources || []);
      return { sources, claims: markClaims(msg.claims || []) };
    },
    clear: () => {
      clearMarks();
      return { ok: true };
    },
    focus: (kind, id) => ({ ok: focus(kind, id) }),
  };
})();
