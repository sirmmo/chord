import { app, ipcMain, net, safeStorage } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Bookmark, SyncStatus } from '../shared/types.ts';
import { exportConfig, parseConfig } from '../shared/config.ts';
import { renderBookmarksJson, renderFeed, renderLinkroll } from '../shared/bookmarks.ts';
import type { Controller } from './controller.ts';

/**
 * Sync through GitHub. Chord creates two repositories for the user: a private
 * one (spaces, settings worth sharing, every bookmark) and a public one (the
 * public bookmarks as JSON, an RSS feed and a linkroll site served by GitHub
 * Pages). Writes go through the contents API — no git needed — a debounced
 * push after changes and a pull at launch and every 15 minutes. Pulls only
 * ever merge: bookmarks by id with the newer version winning, spaces with the
 * importer's merge mode, which adds and never removes.
 */

const API = 'https://api.github.com';
const PUSH_DELAY = 30_000;
const PULL_EVERY = 15 * 60_000;

interface Shas {
  [key: string]: string | undefined;
}

export class SyncManager {
  private readonly c: Controller;
  private token = '';
  private busy = false;
  private error = '';
  private lastPush = 0;
  private lastPull = 0;
  private pushTimer: NodeJS.Timeout | null = null;
  private pullTimer: NodeJS.Timeout | null = null;
  /** blob shas of what we last wrote or read, per "repo/path" */
  private shas: Shas = {};
  /** content hashes of what we last pushed, per "repo/path" */
  private pushed: Record<string, string> = {};
  private pendingPush = false;

  constructor(c: Controller) {
    this.c = c;
  }

  init(): void {
    this.token = this.readToken();
    ipcMain.handle('sync', (event) => (this.c.trustedEvent(event) ? this.status() : null));
    if (this.connected()) {
      setTimeout(() => void this.pull(), 15_000).unref();
      this.pullTimer = setInterval(() => void this.pull(), PULL_EVERY);
      this.pullTimer.unref();
    }
  }

  private get settings() {
    return this.c.state.settings.sync;
  }

  connected(): boolean {
    return Boolean(this.token && this.settings.enabled && this.settings.user);
  }

  status(): SyncStatus {
    const s = this.settings;
    return {
      connected: this.connected(),
      user: s.user,
      privateRepo: s.privateRepo,
      publicRepo: s.publicRepo,
      pagesUrl: s.user ? `https://${s.user.toLowerCase()}.github.io/${s.publicRepo}/` : '',
      lastPush: this.lastPush,
      lastPull: this.lastPull,
      busy: this.busy,
      error: this.error,
    };
  }

  /** A token with the `repo` scope: find out who it is, make the two repositories, pull, push. */
  async connect(rawToken: string): Promise<void> {
    const token = rawToken.trim();
    if (!token) return;
    this.busy = true;
    this.error = '';
    this.send();
    try {
      this.token = token;
      const user = (await this.api('GET', '/user')) as { login?: string };
      if (!user.login) throw new Error('GitHub did not return a login for this token.');
      const s = this.settings;
      await this.ensureRepo(s.privateRepo, true, 'Chord browser sync: spaces and bookmarks (private)');
      await this.ensureRepo(s.publicRepo, false, `${user.login}'s public bookmarks, published with Chord`);
      this.writeToken(token);
      this.c.apply({ type: 'settings.update', patch: { sync: { ...s, enabled: true, user: user.login } } });
      this.shas = {};
      this.pushed = {};
      await this.pull();
      await this.push(true);
      await this.ensurePages(user.login, s.publicRepo);
      if (!this.pullTimer) {
        this.pullTimer = setInterval(() => void this.pull(), PULL_EVERY);
        this.pullTimer.unref();
      }
    } catch (err) {
      this.token = this.settings.enabled ? this.readToken() : '';
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
      this.send();
    }
  }

  disconnect(): void {
    this.token = '';
    try {
      unlinkSync(this.tokenPath());
    } catch {
      /* none */
    }
    if (this.pullTimer) clearInterval(this.pullTimer);
    this.pullTimer = null;
    this.c.apply({ type: 'settings.update', patch: { sync: { ...this.settings, enabled: false } } });
    this.error = '';
    this.send();
  }

  /** Something changed: push soon, unless more changes follow. */
  schedulePush(): void {
    if (!this.connected()) return;
    this.pendingPush = true;
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      if (this.pendingPush) void this.push();
    }, PUSH_DELAY);
    this.pushTimer.unref();
  }

  async syncNow(): Promise<void> {
    if (!this.connected()) return;
    await this.pull();
    await this.push(true);
  }

  async push(force = false): Promise<void> {
    if (!this.connected() || this.busy) {
      if (this.busy) this.pendingPush = true;
      return;
    }
    this.pendingPush = false;
    this.busy = true;
    this.send();
    try {
      const s = this.settings;
      const state = this.c.state;
      const now = Date.now();
      const config = exportConfig(state, now);
      const site = { user: s.user, siteUrl: this.status().pagesUrl };
      const files: [string, string, string][] = [
        [s.privateRepo, 'config.json', JSON.stringify(config, null, 2)],
        [s.privateRepo, 'bookmarks.json', JSON.stringify({ format: 'chord-bookmarks-sync', version: 1, bookmarks: state.bookmarks }, null, 2)],
        [s.privateRepo, 'README.md', '# Chord sync\n\nSpaces and bookmarks of the Chord browser, kept here by the app itself. Private.\n'],
        [s.publicRepo, 'bookmarks.json', renderBookmarksJson(state.bookmarks, site)],
        [s.publicRepo, 'feed.xml', renderFeed(state.bookmarks, site)],
        [s.publicRepo, 'index.html', renderLinkroll(state.bookmarks, site)],
        [s.publicRepo, '.nojekyll', ''],
        [s.publicRepo, 'README.md', `# Bookmarks\n\nLinks bookmarked publicly with [Chord](https://ingmmo.com/chord/). Browse them at ${site.siteUrl} or follow feed.xml.\n`],
      ];
      for (const [repo, path, content] of files) {
        const key = `${repo}/${path}`;
        const hash = createHash('sha1').update(content).digest('hex');
        if (!force && this.pushed[key] === hash) continue;
        // exportedAt changes every time: skip the config when nothing but the stamp moved
        if (path === 'config.json' && this.pushed[key] && this.pushed[`${key}#body`] === hashWithout(config)) continue;
        await this.put(repo, path, content, `Chord: update ${path}`);
        this.pushed[key] = hash;
        if (path === 'config.json') this.pushed[`${key}#body`] = hashWithout(config);
      }
      this.lastPush = Date.now();
      this.error = '';
    } catch (err) {
      this.error = `Push failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.busy = false;
      this.send();
      if (this.pendingPush) this.schedulePush();
    }
  }

  async pull(): Promise<void> {
    if (!this.connected() || this.busy) return;
    this.busy = true;
    this.send();
    try {
      const s = this.settings;
      const bm = await this.get(s.privateRepo, 'bookmarks.json');
      if (bm && bm.sha !== this.shas[`${s.privateRepo}/bookmarks.json#pulled`]) {
        try {
          const parsed = JSON.parse(bm.content) as { bookmarks?: Bookmark[] };
          if (Array.isArray(parsed.bookmarks)) this.c.apply({ type: 'bookmarks.merge', remote: parsed.bookmarks });
        } catch {
          /* unreadable: ours will overwrite it on the next push */
        }
        this.shas[`${s.privateRepo}/bookmarks.json#pulled`] = bm.sha;
      }
      const cfg = await this.get(s.privateRepo, 'config.json');
      if (cfg && cfg.sha !== this.shas[`${s.privateRepo}/config.json#pulled`]) {
        const parsed = parseConfig(cfg.content);
        if (parsed.ok) this.c.apply({ type: 'config.import', config: parsed.config, mode: 'merge' });
        else console.warn('sync: remote config not applied:', parsed.error);
        this.shas[`${s.privateRepo}/config.json#pulled`] = cfg.sha;
      }
      this.lastPull = Date.now();
      this.error = '';
    } catch (err) {
      this.error = `Pull failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.busy = false;
      this.send();
    }
  }

  // ---- GitHub ----

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await net.fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Chord', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return null;
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = (json as { message?: string } | null)?.message ?? text.slice(0, 200);
      throw new Error(`GitHub ${res.status}${msg ? `: ${msg}` : ''}`);
    }
    return json;
  }

  private async ensureRepo(name: string, isPrivate: boolean, description: string): Promise<void> {
    const user = this.settings.user || ((await this.api('GET', '/user')) as { login: string }).login;
    const existing = await this.api('GET', `/repos/${user}/${name}`);
    if (existing) return;
    await this.api('POST', '/user/repos', { name, private: isPrivate, description, auto_init: true, has_issues: false, has_projects: false, has_wiki: false });
  }

  private async ensurePages(user: string, repo: string): Promise<void> {
    try {
      const pages = await this.api('GET', `/repos/${user}/${repo}/pages`);
      if (pages) return;
      await this.api('POST', `/repos/${user}/${repo}/pages`, { source: { branch: 'main', path: '/' } });
    } catch (err) {
      console.warn('sync: GitHub Pages not enabled', err);
    }
  }

  private async get(repo: string, path: string): Promise<{ content: string; sha: string } | null> {
    const r = (await this.api('GET', `/repos/${this.settings.user}/${repo}/contents/${path}`)) as { content?: string; sha?: string; encoding?: string } | null;
    if (!r || typeof r.sha !== 'string') return null;
    this.shas[`${repo}/${path}`] = r.sha;
    const content = typeof r.content === 'string' ? Buffer.from(r.content.replace(/\n/g, ''), 'base64').toString('utf8') : '';
    return { content, sha: r.sha };
  }

  private async put(repo: string, path: string, content: string, message: string): Promise<void> {
    const key = `${repo}/${path}`;
    let sha = this.shas[key];
    if (sha === undefined) {
      const existing = (await this.api('GET', `/repos/${this.settings.user}/${repo}/contents/${path}`)) as { sha?: string } | null;
      sha = existing?.sha;
    }
    const attempt = async (withSha: string | undefined) =>
      (await this.api('PUT', `/repos/${this.settings.user}/${repo}/contents/${path}`, { message, content: Buffer.from(content, 'utf8').toString('base64'), ...(withSha ? { sha: withSha } : {}) })) as { content?: { sha?: string } };
    let r: { content?: { sha?: string } };
    try {
      r = await attempt(sha);
    } catch (err) {
      if (!/GitHub 409|GitHub 422/.test(String(err))) throw err;
      // someone else wrote in between: take the current sha and retry once
      const existing = (await this.api('GET', `/repos/${this.settings.user}/${repo}/contents/${path}`)) as { sha?: string } | null;
      r = await attempt(existing?.sha);
    }
    this.shas[key] = r.content?.sha;
  }

  // ---- token ----

  private tokenPath(): string {
    return join(app.getPath('userData'), 'github-token');
  }

  private readToken(): string {
    try {
      const raw = readFileSync(this.tokenPath());
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
    } catch {
      return '';
    }
  }

  private writeToken(token: string): void {
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, 'utf8');
    writeFileSync(this.tokenPath(), data, { mode: 0o600 });
  }

  private send(): void {
    this.c.sendAll('sync', this.status());
  }
}

/** Hash of a config without its timestamp. */
function hashWithout(config: ReturnType<typeof exportConfig>): string {
  const { exportedAt: _ignored, ...rest } = config;
  return createHash('sha1').update(JSON.stringify(rest)).digest('hex');
}
