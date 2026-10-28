import { net } from 'electron';
import type { LiveItem, LiveSource, TabGroup } from '../shared/types.ts';
import { LIVE_KINDS } from '../shared/types.ts';
import { fetchFeed } from './feeds.ts';
import type { Controller } from './controller.ts';

/**
 * Live folders: subspaces Chord fills from a source and keeps current. GitHub
 * folders use the token from Settings → Sync (any token with repo and
 * notifications scope); feeds and bookmark tags need nothing.
 */

const REFRESH_MS = 10 * 60_000;
const DEFAULT_LIMIT = 20;

export class LiveManager {
  private readonly c: Controller;
  private timer: NodeJS.Timeout | null = null;
  private busy = new Set<string>();

  constructor(c: Controller) {
    this.c = c;
  }

  init(): void {
    this.timer = setInterval(() => void this.refreshAll(), REFRESH_MS);
    this.timer.unref();
    setTimeout(() => void this.refreshAll(), 20_000).unref();
  }

  private groups(): { group: TabGroup; spaceId: string }[] {
    const out: { group: TabGroup; spaceId: string }[] = [];
    for (const sp of this.c.state.spaces) for (const g of sp.groups ?? []) if (g.live && !(sp.lock && sp.locked)) out.push({ group: g, spaceId: sp.id });
    return out;
  }

  async refreshAll(): Promise<void> {
    for (const { group } of this.groups()) await this.refresh(group.id);
  }

  async refresh(groupId: string): Promise<void> {
    const entry = this.groups().find((g) => g.group.id === groupId);
    const live = entry?.group.live;
    if (!live || this.busy.has(groupId)) return;
    this.busy.add(groupId);
    try {
      const items = await this.fetch(live);
      this.c.apply({ type: 'group.liveSync', id: groupId, items: items.slice(0, live.limit ?? DEFAULT_LIMIT), at: Date.now() });
    } catch (err) {
      this.c.apply({ type: 'group.liveSync', id: groupId, items: [], at: Date.now(), error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.busy.delete(groupId);
    }
  }

  private async fetch(live: LiveSource): Promise<LiveItem[]> {
    switch (live.kind) {
      case 'github-review':
        return this.githubSearch('is:pr is:open review-requested:@me archived:false');
      case 'github-prs':
        return this.githubSearch('is:pr is:open author:@me archived:false');
      case 'github-issues':
        return this.githubSearch('is:issue is:open assignee:@me archived:false');
      case 'github-search':
        return this.githubSearch(live.query);
      case 'github-notifications':
        return this.githubNotifications();
      case 'feed': {
        const { items } = await fetchFeed(live.query);
        return items.map((it) => ({ url: it.url, title: it.title }));
      }
      case 'bookmarks': {
        const tag = live.query.trim().toLowerCase().replace(/^#/, '');
        return this.c.state.bookmarks
          .filter((b) => !b.deletedAt && b.tags.some((t) => t.toLowerCase() === tag))
          .sort((a, b) => b.addedAt - a.addedAt)
          .map((b) => ({ url: b.url, title: b.title }));
      }
    }
  }

  private headers(): Record<string, string> {
    const token = this.c.sync.githubToken();
    const h: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'Chord', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  private async githubSearch(q: string): Promise<LiveItem[]> {
    if (/@me\b/.test(q) && !this.c.sync.githubToken()) throw new Error('Sign in to GitHub in Settings → Sync first.');
    const res = await net.fetch(`https://api.github.com/search/issues?per_page=50&sort=updated&q=${encodeURIComponent(q)}`, { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) throw new Error('GitHub rejected the token. Sign in again in Settings → Sync.');
    if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached; it will try again later.');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    const data = (await res.json()) as { items?: { html_url?: string; title?: string; number?: number; repository_url?: string }[] };
    return (data.items ?? []).filter((it) => typeof it.html_url === 'string').map((it) => ({ url: it.html_url as string, title: `${it.title ?? ''}${it.repository_url ? ` · ${it.repository_url.replace(/^.*\/repos\//, '')}#${it.number ?? ''}` : ''}` }));
  }

  private async githubNotifications(): Promise<LiveItem[]> {
    if (!this.c.sync.githubToken()) throw new Error('Sign in to GitHub in Settings → Sync first.');
    const res = await net.fetch('https://api.github.com/notifications?per_page=50', { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) throw new Error('GitHub rejected the token. Sign in again in Settings → Sync.');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    const data = (await res.json()) as { subject?: { title?: string; url?: string | null; type?: string }; repository?: { full_name?: string; html_url?: string } }[];
    const out: LiveItem[] = [];
    for (const n of data) {
      const repo = n.repository?.full_name ?? '';
      const api = n.subject?.url ?? '';
      // api.github.com/repos/o/r/pulls/12 → github.com/o/r/pull/12
      const m = /\/repos\/([^/]+\/[^/]+)\/(pulls|issues|commits|releases)\/([^/]+)$/.exec(api);
      const url = m ? `https://github.com/${m[1]}/${m[2] === 'pulls' ? 'pull' : m[2] === 'commits' ? 'commit' : m[2] === 'releases' ? 'releases/tag' : 'issues'}/${m[3]}` : n.repository?.html_url ?? '';
      if (!url) continue;
      out.push({ url, title: `${n.subject?.title ?? n.subject?.type ?? 'Notification'}${repo ? ` · ${repo}` : ''}` });
    }
    return out;
  }
}

export function liveLabel(live: LiveSource): string {
  const k = LIVE_KINDS[live.kind];
  return k.needsQuery ? `${k.label.replace(/…$/, '')}: ${live.query}` : k.label;
}
