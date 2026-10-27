import { ipcMain, net, type IpcMainEvent, type WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SourcesStatus, SpaceId, TabId } from '../shared/types.ts';
import { spaceById } from '../shared/model.ts';
import type { Controller } from './controller.ts';
import { DIST } from './paths.ts';

/**
 * Sources mode: the Sourceror extension, built in. A Sourceror server running
 * on this computer (sirmmo/sourceror) judges who published every link in an
 * article and which claims rest on nothing; Chord reads the page as the user
 * sees it, sends it over, shows the report in the side panel and marks the
 * page. One analysis per tab is kept until the tab navigates.
 */

const POLL_MS = 1000;
const POLL_LIMIT_MS = 6 * 60 * 1000;
/** The page preload's isolated world: the Sourceror script runs there, next to the click bridge. */
const ISOLATED_WORLD = 999;

export const SOURCEROR_CSS = `
.srcr-dot { display: inline-block; width: .62em; height: .62em; margin: 0 .18em 0 .22em; border-radius: 50%; vertical-align: .12em; cursor: pointer; box-shadow: 0 0 0 1.5px #fff, 0 0 0 2.5px rgba(0,0,0,.18); transition: transform .15s ease; }
.srcr-dot:hover, .srcr-dot:focus-visible { transform: scale(1.45); outline: none; }
.srcr-dot.srcr-solid { background: #1a7f4b; }
.srcr-dot.srcr-ok { background: #8aa324; }
.srcr-dot.srcr-weak { background: #d98a0b; }
.srcr-dot.srcr-unreliable { background: #c62f2f; }
.srcr-dot.srcr-none { background: #8a8f98; }
.srcr-dot.srcr-flash, sup.srcr-ref.srcr-flash { animation: srcr-pulse .55s ease 4; }
@keyframes srcr-pulse { 50% { transform: scale(1.9); } }
sup.srcr-ref a { border-radius: 3px; padding: 0 1px; }
sup.srcr-ref.srcr-weak a { background: #fde7c0; color: #7a4a00 !important; }
sup.srcr-ref.srcr-unreliable a { background: #f8d0d0; color: #8a1414 !important; }
::highlight(srcr-unsourced) { background-color: rgba(230, 70, 70, .22); text-decoration: underline wavy rgba(198, 47, 47, .75); }
::highlight(srcr-weak) { background-color: rgba(240, 160, 30, .25); text-decoration: underline wavy rgba(200, 120, 0, .8); }
::highlight(srcr-attributed) { text-decoration: underline dotted rgba(70, 90, 160, .7); }
::highlight(srcr-focus) { background-color: rgba(255, 214, 0, .7); color: #000; }
`;

interface Entry {
  url: string;
  kind: 'article' | 'wikipedia';
  result: Record<string, unknown>;
  marks?: { sources: number; claims: number };
}

interface Progress {
  phase: string;
  done: number;
  total: number;
}

export class SourcesManager {
  private readonly c: Controller;
  private readonly results = new Map<TabId, Entry>();
  private readonly injected = new Set<TabId>();
  private readonly busy = new Set<TabId>();
  private readonly progress = new Map<TabId, Progress>();
  private readonly messages = new Map<TabId, { text: string; error: boolean }>();
  private server = { up: null as boolean | null, checkedAt: 0, info: '' };
  private selectedSeq = 0;
  private selected: { tabId: TabId; kind: string; id: string; seq: number } | null = null;
  private script = '';

  constructor(c: Controller) {
    this.c = c;
  }

  init(): void {
    ipcMain.handle('sources', (event, spaceId: unknown) => (this.c.trustedEvent(event) && typeof spaceId === 'string' ? this.status(spaceId) : null));
    ipcMain.on('sourceror', (event: IpcMainEvent, raw: unknown) => {
      const tabId = this.c.tabs.tabIdOf(event.sender);
      if (!tabId || typeof raw !== 'object' || raw === null) return;
      const r = raw as { kind?: unknown; id?: unknown };
      if (typeof r.kind !== 'string' || (typeof r.id !== 'string' && typeof r.id !== 'number')) return;
      this.selected = { tabId, kind: r.kind, id: String(r.id), seq: ++this.selectedSeq };
      this.push(tabId);
    });
  }

  // ---- status ----

  private settings() {
    return this.c.state.settings.sourceror;
  }

  /** The tab the panel of a space shows: that space's focused tab. */
  private tabFor(spaceId: SpaceId): TabId | null {
    return spaceById(this.c.state, spaceId)?.focused ?? null;
  }

  status(spaceId: SpaceId): SourcesStatus {
    const tabId = this.tabFor(spaceId);
    const tab = tabId ? this.c.state.tabs[tabId] : undefined;
    const entry = tabId ? this.results.get(tabId) : undefined;
    const sel = this.selected && this.selected.tabId === tabId ? this.selected : undefined;
    return {
      spaceId,
      tabId: tabId ?? undefined,
      url: tab?.url ?? '',
      title: tab?.title ?? '',
      web: /^https?:/i.test(tab?.url ?? ''),
      server: this.settings().server,
      serverUp: this.server.up,
      serverInfo: this.server.info,
      busy: tabId ? this.busy.has(tabId) : false,
      progress: tabId ? this.progress.get(tabId) : undefined,
      message: tabId ? this.messages.get(tabId) : undefined,
      kind: entry?.kind,
      result: entry && entry.url === tab?.url ? entry.result : undefined,
      marks: entry?.marks,
      selected: sel ? { kind: sel.kind, id: sel.id, seq: sel.seq } : undefined,
    };
  }

  private push(tabId: TabId | null): void {
    // Every space whose focused tab this is (normally one) gets the news.
    for (const sp of this.c.state.spaces) if (!tabId || sp.focused === tabId) this.c.sendAll('sources', this.status(sp.id));
  }

  /** The focused tab changed, a tab navigated, or settings changed: refresh the panel. */
  refresh(): void {
    this.push(null);
  }

  // ---- server ----

  private async api(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await net.fetch(
      this.settings().server.replace(/\/+$/, '') + path,
      body === undefined ? { signal: AbortSignal.timeout(20_000) } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) },
    );
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
    return data;
  }

  async ping(): Promise<boolean> {
    try {
      const kb = await this.api('/api/kb');
      this.server = { up: true, checkedAt: Date.now(), info: `${kb.rsp_entries ?? '?'} RSP · ${kb.headbomb_rules ?? '?'} CITEWATCH` };
    } catch {
      this.server = { up: false, checkedAt: Date.now(), info: '' };
    }
    return this.server.up === true;
  }

  // ---- page script ----

  private async inject(tabId: TabId, wc: WebContents): Promise<void> {
    if (this.injected.has(tabId)) return;
    if (!this.script) this.script = readFileSync(join(DIST, 'sourceror.js'), 'utf8');
    await wc.insertCSS(SOURCEROR_CSS);
    await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: this.script }]);
    this.injected.add(tabId);
  }

  private call<T>(wc: WebContents, expr: string): Promise<T> {
    return wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: `(() => { const s = window.__sourceror; return s ? ${expr} : { error: 'not injected' }; })()` }]) as Promise<T>;
  }

  /** A tab navigated: its analysis and marks are gone with the old document. */
  navigated(tabId: TabId): void {
    this.injected.delete(tabId);
    if (this.results.delete(tabId) || this.messages.delete(tabId)) this.push(tabId);
  }

  forget(tabId: TabId): void {
    this.injected.delete(tabId);
    this.results.delete(tabId);
    this.messages.delete(tabId);
    this.progress.delete(tabId);
    this.busy.delete(tabId);
  }

  // ---- analysis ----

  private message(tabId: TabId, text: string, error = true): void {
    this.messages.set(tabId, { text, error });
    this.progress.delete(tabId);
    this.push(tabId);
  }

  async analyze(spaceId: SpaceId): Promise<void> {
    const tabId = this.tabFor(spaceId);
    const tab = tabId ? this.c.state.tabs[tabId] : undefined;
    if (!tabId || !tab) return;
    if (!/^https?:/i.test(tab.url)) return this.message(tabId, 'not_web');
    if (this.busy.has(tabId)) return;
    const wc = this.c.tabs.get(tabId)?.webContents;
    if (!wc || wc.isDestroyed()) return this.message(tabId, 'inject_failed');
    this.busy.add(tabId);
    this.messages.delete(tabId);
    this.progress.set(tabId, { phase: 'starting', done: 0, total: 0 });
    this.push(tabId);
    try {
      if (!(await this.ping())) return this.message(tabId, 'no_server');
      try {
        await this.inject(tabId, wc);
      } catch {
        return this.message(tabId, 'inject_failed');
      }
      const page = await this.call<Record<string, unknown> & { error?: string }>(wc, 's.extract()');
      if (!page || page.error) return this.message(tabId, `failed:${page?.error ?? ''}`);
      const s = this.settings();
      const settings = { check_links: s.checkLinks, use_llm: s.useLlm, discover_sources: s.discover };
      let start: Record<string, unknown>;
      if (page.kind === 'wikipedia') {
        start = await this.api('/api/analyze', { title: page.title, lang: page.lang, ...settings });
      } else {
        const paragraphs = page.paragraphs as unknown[];
        const links = page.links as unknown[];
        if (!paragraphs?.length && !links?.length) return this.message(tabId, 'no_text');
        start = await this.api('/api/page', { ...page, ...settings });
      }
      if (start.error) return this.message(tabId, `failed:${String(start.error)}`);
      const result = await this.poll(tabId, String(start.job ?? ''));
      if (!result) return;
      if (result.error === 'not_found') return this.message(tabId, 'not_found');
      const entry: Entry = { url: tab.url, kind: page.kind === 'wikipedia' ? 'wikipedia' : 'article', result };
      index(entry);
      this.results.set(tabId, entry);
      this.progress.delete(tabId);
      this.push(tabId);
      await this.mark(tabId, entry);
    } catch (err) {
      this.message(tabId, `failed:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy.delete(tabId);
      this.progress.delete(tabId);
      this.push(tabId);
    }
  }

  private async poll(tabId: TabId, job: string): Promise<Record<string, unknown> | null> {
    const began = Date.now();
    while (Date.now() - began < POLL_LIMIT_MS) {
      const j = await this.api(`/api/job/${encodeURIComponent(job)}`);
      if (j.state === 'done') return (j.result ?? {}) as Record<string, unknown>;
      if (j.state === 'error' || j.error) {
        this.message(tabId, `failed:${String(j.error ?? '')}`);
        return null;
      }
      this.progress.set(tabId, { phase: String(j.phase ?? 'starting'), done: Number(j.done ?? 0), total: Number(j.total ?? 0) });
      this.push(tabId);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    this.message(tabId, 'timeout');
    return null;
  }

  private async mark(tabId: TabId, entry: Entry): Promise<void> {
    const wc = this.c.tabs.get(tabId)?.webContents;
    if (!wc || wc.isDestroyed()) return;
    const r = entry.result as { citations?: Record<string, unknown>[]; gaps?: Record<string, unknown>[]; sources?: Record<string, unknown>[]; claims?: Record<string, unknown>[] };
    const payload =
      entry.kind === 'wikipedia'
        ? {
            wikipedia: true,
            sources: (r.citations ?? []).map((c) => ({ n: c.n, urls: c.urls, doi: c.doi, display: c.display, grade: c.grade, score: c.score })),
            claims: (r.gaps ?? []).map((g) => ({ id: g.id, text: g.claim, status: g.status })),
          }
        : {
            sources: (r.sources ?? []).map((s) => ({ n: s.n, href: s.href, grade: s.grade, score: s.score })),
            claims: (r.claims ?? []).map((c) => ({ id: c.id, text: c.text, status: c.status })),
          };
    try {
      const got = await this.call<{ sources: number; claims: number; error?: string }>(wc, `s.mark(${JSON.stringify(payload)})`);
      if (got && !got.error) entry.marks = { sources: got.sources, claims: got.claims };
    } catch {
      /* the tab navigated away; the report is still useful */
    }
    this.push(tabId);
  }

  async clear(spaceId: SpaceId): Promise<void> {
    const tabId = this.tabFor(spaceId);
    if (!tabId) return;
    const wc = this.c.tabs.get(tabId)?.webContents;
    if (wc && !wc.isDestroyed() && this.injected.has(tabId)) await this.call(wc, 's.clear()').catch(() => {});
    this.results.delete(tabId);
    this.messages.delete(tabId);
    this.push(tabId);
  }

  async focus(spaceId: SpaceId, kind: string, id: string): Promise<void> {
    const tabId = this.tabFor(spaceId);
    if (!tabId) return;
    const wc = this.c.tabs.get(tabId)?.webContents;
    if (wc && !wc.isDestroyed() && this.injected.has(tabId)) await this.call(wc, `s.focus(${JSON.stringify(kind)}, ${JSON.stringify(id)})`).catch(() => {});
  }
}

// Give every entry a stable index (n) that the page marks refer back to.
function index(entry: Entry): void {
  const r = entry.result as { citations?: Record<string, unknown>[]; gaps?: Record<string, unknown>[]; sources?: Record<string, unknown>[] };
  if (entry.kind === 'wikipedia') {
    (r.citations ?? []).forEach((c, n) => {
      c.n = n;
    });
    (r.gaps ?? []).forEach((g, n) => {
      g.id = `g${n}`;
      g.status = g.type === 'tagged' ? 'tagged' : 'unsourced_paragraph';
      g.text = g.claim;
    });
  } else {
    (r.sources ?? []).forEach((s, n) => {
      s.n = n;
    });
  }
}
