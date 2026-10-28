// Smart pages for developers: GitHub and VS Code in the browser (vscode.dev,
// github.dev, Codespaces, code-server, openvscode-server). Runs in the page
// preload's isolated world, reads what the page shows (the PR state and its
// checks, a workflow run's jobs, the status bar of VS Code) and reports it to
// Chord, which shows it from every space. Best effort: selectors follow the
// current markup of both apps and fail quietly.

import { ipcRenderer } from 'electron';
import { parseChecksText, parseGitHubPath, parseProblems, parseVsCodeTitle, stateFromFavicon, stripCodicons } from '../shared/dev.ts';
import type { DevAction, DevChecks, DevInfo } from '../shared/types.ts';

type Report = Omit<DevInfo, 'updatedAt'>;

interface Adapter {
  snapshot(): Report | null;
  act(action: DevAction): void;
}

const POLL_MS = 2000;
const DETECT_MS = 3000;

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null => root.querySelector<T>(sel);
const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const aria = (el: Element | null | undefined): string => el?.getAttribute('aria-label') ?? el?.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '';
const findButton = (re: RegExp, root: ParentNode = document): HTMLElement | undefined =>
  Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"], [role="menuitem"], summary')).find((b) => re.test(text(b) || b.getAttribute('aria-label') || ''));

// ---- GitHub ----

function isGitHub(): boolean {
  const h = location.hostname;
  if (h === 'github.com' || h.endsWith('.github.com')) return true;
  return Boolean($('meta[name="github-keyboard-shortcuts"], meta[name="expected-hostname"], meta[name="octolytics-url"]'));
}

const ICON_OK = 'svg.octicon-check, svg.octicon-check-circle-fill, svg.octicon-check-circle';
const ICON_FAIL = 'svg.octicon-x, svg.octicon-x-circle-fill, svg.octicon-x-circle, svg.octicon-alert, svg.octicon-alert-fill';
const ICON_PENDING = 'svg.octicon-dot-fill, svg.anim-rotate, svg.octicon-clock, svg.octicon-clock-fill, svg.octicon-hourglass';
const ICON_SKIP = 'svg.octicon-skip, svg.octicon-stop, svg.octicon-skip-fill';

function countIcons(root: ParentNode): DevChecks | null {
  const ok = root.querySelectorAll(ICON_OK).length;
  const failed = root.querySelectorAll(ICON_FAIL).length;
  const pending = root.querySelectorAll(ICON_PENDING).length;
  const skipped = root.querySelectorAll(ICON_SKIP).length;
  const total = ok + failed + pending + skipped;
  return total ? { ok, failed, pending, total } : null;
}

function githubChecks(kind: string): DevChecks | null {
  if (kind === 'pr') {
    const items = document.querySelectorAll('.merge-status-item');
    if (items.length) {
      const c = { ok: 0, failed: 0, pending: 0, total: items.length };
      for (const it of items) {
        if (it.querySelector(ICON_FAIL)) c.failed++;
        else if (it.querySelector(ICON_PENDING)) c.pending++;
        else if (it.querySelector(ICON_OK)) c.ok++;
      }
      return c;
    }
    for (const el of document.querySelectorAll('.branch-action-item .status-heading, .merge-status-list h3, [data-testid*="checks"] h3, [data-testid*="checks-status"], .mergeability-details h3, [class*="MergeBox"] h3')) {
      const parsed = parseChecksText(text(el));
      if (parsed) return parsed;
    }
    return null;
  }
  if (kind === 'run') {
    const scope = $('[data-testid="jobs-sidebar"], nav[aria-label*="Jobs" i], nav[aria-label*="jobs" i], .js-workflow-run-jobs, aside') ?? document;
    return countIcons(scope);
  }
  return null;
}

function githubState(kind: string): string {
  const fav = stateFromFavicon($<HTMLLinkElement>('link[rel~="icon"]')?.href ?? '');
  if (kind === 'pr' || kind === 'issue' || kind === 'discussion') {
    const el = $('.State, [data-testid="header-state"], [data-testid="issue-state"], [class*="StateLabel"]');
    const t = text(el).toLowerCase();
    const cls = el?.className ?? '';
    const state = /merged/.test(t) || /merged/i.test(cls) ? 'merged' : /draft/.test(t) || /draft/i.test(cls) ? 'draft' : /closed/.test(t) || /closed/i.test(cls) ? 'closed' : /open/.test(t) || /open/i.test(cls) ? 'open' : '';
    return state || fav;
  }
  if (kind === 'run' || kind === 'commit') {
    if (fav) return fav;
    const head = text($('h1, [data-testid="run-header"]')).toLowerCase();
    if (/in progress|running|queued|waiting/.test(head)) return 'pending';
    const c = githubChecks(kind);
    if (!c) return '';
    return c.pending ? 'pending' : c.failed ? 'failure' : 'success';
  }
  return fav;
}

function githubBranch(kind: string): string {
  if (kind === 'pr') return text($('.head-ref, [data-testid="head-ref"], .commit-ref.head-ref')).slice(0, 80);
  if (kind === 'code' || kind === 'repo') return text($('[data-hotkey="w"] .css-truncate-target, #branch-select-menu .css-truncate-target, button[id^="branch-picker"] span, [data-testid="anchor-button"] [class*="Text"]')).slice(0, 80);
  if (kind === 'run') return text($('.branch-name, [data-testid="run-branch"], a[href*="/tree/"] .css-truncate-target')).slice(0, 80);
  return '';
}

function githubUnread(): number {
  if (location.pathname.startsWith('/notifications')) return document.querySelectorAll('.notifications-list-item:not(.notification-read), [data-testid="notification-item"][data-read="false"]').length;
  return $('.AppHeader-button--hasIndicator, notification-indicator[data-indicator-mode]:not([data-indicator-mode="none"]), .mail-status.unread, [data-testid="notification-indicator"][data-unread="true"]') ? 1 : 0;
}

const github: Adapter = {
  snapshot() {
    const place = parseGitHubPath(location.pathname);
    const unread = githubUnread();
    const actions: DevAction[] = ['notifications'];
    if (!place.project) {
      if (!unread) return null;
      return { kind: 'github', project: location.hostname, subject: place.subject, state: '', branch: '', remote: '', unsaved: false, debugging: false, tasks: 0, unread, actions };
    }
    const kind = place.kind ?? 'repo';
    const checks = githubChecks(kind) ?? undefined;
    const state = githubState(kind) || (checks ? (checks.pending ? 'pending' : checks.failed ? 'failure' : 'success') : '');
    if (kind === 'run' && findButton(/re-?run/i)) actions.push('rerun');
    if (kind === 'pr' && checks) actions.push('checks');
    let subject = place.subject;
    if (kind === 'pr' || kind === 'issue' || kind === 'discussion') {
      const title = text($('.js-issue-title, [data-testid="issue-title"], h1 bdi, .gh-header-title .markdown-title, h1[class*="Title"]'));
      if (title) subject = `${subject} · ${title}`;
    } else if (kind === 'run') {
      const name = text($('h1 .f3, [data-testid="run-title"], h1')).replace(/\s*#\d+$/, '');
      if (name) subject = `${name.slice(0, 60)} · ${subject}`;
    }
    return { kind: 'github', project: place.project, subject, state, branch: githubBranch(kind), remote: '', checks, unsaved: false, debugging: false, tasks: 0, unread, actions };
  },
  act(action) {
    if (action === 'notifications') {
      ipcRenderer.send('smart', { kind: 'open', url: `${location.origin}/notifications`, background: false });
      return;
    }
    if (action === 'checks') {
      const el = $('.merge-status-list, .branch-action-item, [data-testid*="checks"]');
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (action === 'rerun') {
      const all = findButton(/^re-?run all jobs$/i);
      if (all) {
        all.click();
      } else {
        findButton(/re-?run jobs/i)?.click();
        setTimeout(() => findButton(/^re-?run all jobs$/i)?.click(), 300);
      }
      // the confirm dialog
      setTimeout(() => {
        const dialog = $('dialog[open], [role="dialog"]');
        if (dialog) findButton(/^re-?run (all )?jobs$/i, dialog)?.click();
      }, 800);
    }
  },
};

// ---- VS Code in the browser ----

const isVsCode = (): boolean => Boolean($('.monaco-workbench'));
const statusItem = (id: string): HTMLElement | null => $(`.statusbar-item[id^="${id}"]`);
const statusLabel = (id: string): string => stripCodicons(text(statusItem(id)));

const vscode: Adapter = {
  snapshot() {
    if (!isVsCode()) return null;
    const t = parseVsCodeTitle(document.title);
    const problemsItem = statusItem('status.problems');
    let problems = parseProblems(aria(problemsItem));
    if (!problems.errors && !problems.warnings && problemsItem) {
      const m = /(\d+)\D+(\d+)/.exec(stripCodicons(text(problemsItem)));
      if (m) problems = { errors: Number(m[1]), warnings: Number(m[2]) };
    }
    const unreadMatch = /(\d+) new notification/i.exec(aria(statusItem('status.notifications')));
    const unread = unreadMatch ? Number(unreadMatch[1]) : 0;
    const debugging = Boolean($('.debug-toolbar'));
    const tasksMatch = /(\d+)/.exec(statusLabel('status.runningTasks'));
    const tasks = tasksMatch ? Number(tasksMatch[1]) : 0;
    const actions: DevAction[] = [];
    if (problems.errors || problems.warnings) actions.push('problems');
    if (unread) actions.push('notifications');
    if (debugging) actions.push('stopDebug');
    return {
      kind: 'vscode',
      project: t.workspace || location.hostname,
      subject: t.file,
      state: '',
      branch: statusLabel('status.scm').slice(0, 80),
      remote: statusLabel('status.host').slice(0, 60),
      problems,
      unsaved: t.unsaved,
      debugging,
      tasks,
      unread,
      actions,
    };
  },
  act(action) {
    const click = (el: Element | null) => {
      const target = (el?.querySelector<HTMLElement>('a, [role="button"]') ?? el) as HTMLElement | null;
      target?.click();
    };
    if (action === 'problems') click(statusItem('status.problems'));
    else if (action === 'notifications') click(statusItem('status.notifications'));
    else if (action === 'stopDebug') click($('.debug-toolbar .codicon-debug-stop, .debug-toolbar .codicon-debug-disconnect')?.closest('a, [role="button"], li') ?? null);
  },
};

// ---- wiring ----

export interface DevBridge {
  act(action: string): void;
}

/** Start watching this page; returns the handler for actions Chord sends back. */
export function installDevAdapter(): DevBridge {
  let adapter: Adapter | null = null;
  let lastKey = '';
  let lastState = '';
  let lastUrl = '';
  let detectTimer = 0;
  let pollTimer = 0;
  const send = (dev: Report | null) => ipcRenderer.send('smart', { kind: 'dev', dev });

  const report = () => {
    if (!adapter) return;
    let snap: Report | null = null;
    try {
      snap = adapter.snapshot();
    } catch {
      snap = null;
    }
    const key = JSON.stringify(snap);
    if (key === lastKey) return;
    lastKey = key;
    send(snap);
    // a run or the checks of a PR finished while the user was elsewhere: tell them once
    const state = snap?.kind === 'github' ? snap.state : '';
    const url = location.href.split('#')[0];
    if (url === lastUrl && lastState === 'pending' && (state === 'success' || state === 'failure' || state === 'cancelled') && document.hidden) {
      ipcRenderer.send('smart', { kind: 'notification', title: `${snap?.project}: ${state === 'success' ? 'passed' : state}`, body: snap?.subject ?? '' });
    }
    lastUrl = url;
    lastState = state;
  };

  const start = (a: Adapter) => {
    adapter = a;
    window.clearInterval(detectTimer);
    report();
    pollTimer = window.setInterval(report, POLL_MS);
    document.addEventListener('visibilitychange', report);
  };

  const detect = () => {
    if (adapter) return;
    if (isGitHub()) start(github);
    else if (isVsCode()) start(vscode);
  };
  const begin = () => {
    detect();
    if (!adapter) detectTimer = window.setInterval(detect, DETECT_MS);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin);
  else begin();
  window.addEventListener('pagehide', () => {
    window.clearInterval(pollTimer);
    window.clearInterval(detectTimer);
  });

  return {
    act(action: string) {
      try {
        adapter?.act(action as DevAction);
      } catch {
        /* the page changed under us */
      }
      setTimeout(report, 500);
    },
  };
}
