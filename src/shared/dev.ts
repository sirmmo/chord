// Pure helpers for the GitHub and VS Code smart pages: what can be read from a
// URL, a title or a status-bar label without touching the DOM, so the sidebar
// and the page adapters agree and it can be unit-tested.

import type { DevChecks } from './types.ts';

const GITHUB_RESERVED = new Set([
  'settings', 'notifications', 'marketplace', 'explore', 'orgs', 'login', 'logout', 'pulls', 'issues', 'search', 'codespaces', 'features',
  'sponsors', 'new', 'topics', 'trending', 'about', 'pricing', 'apps', 'users', 'organizations', 'dashboard', 'account', 'sessions',
  'enterprise', 'enterprises', 'security', 'site', 'contact', 'collections', 'events', 'join', 'signup', 'team', 'customer-stories',
  'readme', 'premium-support', 'resources', 'solutions', 'copilot', 'advisories', 'stars', 'watching', 'discussions', 'projects',
]);

export type GitHubKind = 'pr' | 'issue' | 'run' | 'commit' | 'code' | 'repo' | 'discussion' | 'notifications' | null;

export interface GitHubPlace {
  /** "owner/repo", or "" outside a repository */
  project: string;
  kind: GitHubKind;
  number: number | null;
  /** "PR #42", "Issue #7", "Run #123", "Commit abc1234", "" */
  subject: string;
}

/** Where a GitHub URL points: the repository and the kind of page. */
export function parseGitHubPath(pathname: string): GitHubPlace {
  const parts = pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const none: GitHubPlace = { project: '', kind: null, number: null, subject: '' };
  if (parts[0] === 'notifications') return { ...none, kind: 'notifications', subject: 'Notifications' };
  if (parts.length < 2 || GITHUB_RESERVED.has(parts[0].toLowerCase())) return none;
  const project = `${parts[0]}/${parts[1]}`;
  const section = parts[2] ?? '';
  const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : null);
  if (section === 'pull' && num(parts[3]) !== null) return { project, kind: 'pr', number: num(parts[3]), subject: `PR #${parts[3]}` };
  if (section === 'issues' && num(parts[3]) !== null) return { project, kind: 'issue', number: num(parts[3]), subject: `Issue #${parts[3]}` };
  if (section === 'discussions' && num(parts[3]) !== null) return { project, kind: 'discussion', number: num(parts[3]), subject: `Discussion #${parts[3]}` };
  if (section === 'actions' && parts[3] === 'runs' && num(parts[4]) !== null) return { project, kind: 'run', number: num(parts[4]), subject: `Run #${parts[4]}` };
  if (section === 'commit' && parts[3]) return { project, kind: 'commit', number: null, subject: `Commit ${parts[3].slice(0, 7)}` };
  if (section === 'blob' || section === 'tree') return { project, kind: 'code', number: null, subject: parts.length > 4 ? parts[parts.length - 1] : parts[3] ?? '' };
  return { project, kind: 'repo', number: null, subject: '' };
}

/** "1 failing, 2 successful, and 3 pending checks" / "All checks have passed" → counts. */
export function parseChecksText(text: string): DevChecks | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const n = (re: RegExp) => {
    const m = re.exec(t);
    return m ? Number(m[1]) : 0;
  };
  const ok = n(/(\d+) successful/i);
  const failed = n(/(\d+) (?:failing|failed|failure)/i) + n(/(\d+) errored/i);
  const pending = n(/(\d+) (?:pending|in progress|queued|expected|running)/i);
  const skipped = n(/(\d+) (?:skipped|neutral|cancel+ed)/i);
  const total = ok + failed + pending + skipped;
  if (total > 0) return { ok, failed, pending, total };
  if (/all checks (have )?passed/i.test(t)) return { ok: 1, failed: 0, pending: 0, total: 1 };
  if (/some checks (were not successful|failed)/i.test(t)) return { ok: 0, failed: 1, pending: 0, total: 1 };
  if (/checks? (haven't|have not|hasn't) completed|checks? (are|is) (still )?(running|pending|in progress)/i.test(t)) return { ok: 0, failed: 0, pending: 1, total: 1 };
  return null;
}

/** "favicon-failure.svg" and friends on GitHub pages that show a result. */
export function stateFromFavicon(href: string): string {
  const m = /favicon-(success|failure|pending|canceled|cancelled|skipped|neutral)\b/i.exec(href);
  if (!m) return '';
  const s = m[1].toLowerCase();
  return s === 'canceled' ? 'cancelled' : s;
}

export interface VsCodeTitle {
  /** the editor in front, "" when none */
  file: string;
  /** workspace or folder name, "" when none */
  workspace: string;
  unsaved: boolean;
}

/** "● main.ts - chord - Visual Studio Code" / "code-server" / "GitHub Codespaces". */
export function parseVsCodeTitle(title: string): VsCodeTitle {
  let t = title.trim();
  const unsaved = /^[●*] ?/.test(t);
  t = t.replace(/^[●*] ?/, '');
  const parts = t.split(/ [-–—] /).map((p) => p.trim()).filter(Boolean);
  if (parts.length && /^(visual studio code|vs ?code|code[- ]server|openvscode[- ]server|github codespaces|codespaces|theia|gitpod)/i.test(parts[parts.length - 1])) parts.pop();
  if (parts.length === 0) return { file: '', workspace: '', unsaved };
  if (parts.length === 1) return { file: '', workspace: parts[0], unsaved };
  return { file: parts[0], workspace: parts[parts.length - 1], unsaved };
}

/** "3 Errors, 2 Warnings" / "No Problems" from VS Code's status bar. */
export function parseProblems(label: string): { errors: number; warnings: number } {
  const n = (re: RegExp) => {
    const m = re.exec(label);
    return m ? Number(m[1]) : 0;
  };
  return { errors: n(/(\d+) errors?/i), warnings: n(/(\d+) warnings?/i) };
}

/** Strip the private-use codicon glyphs VS Code puts in status bar text. */
export function stripCodicons(text: string): string {
  return text.replace(/[-]/g, '').replace(/\s+/g, ' ').trim();
}
