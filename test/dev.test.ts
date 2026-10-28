import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChecksText, parseGitHubPath, parseProblems, parseVsCodeTitle, stateFromFavicon, stripCodicons } from '../src/shared/dev.ts';

test('parseGitHubPath knows the kinds of repository pages', () => {
  assert.deepEqual(parseGitHubPath('/sirmmo/chord/pull/42'), { project: 'sirmmo/chord', kind: 'pr', number: 42, subject: 'PR #42' });
  assert.deepEqual(parseGitHubPath('/sirmmo/chord/issues/7/'), { project: 'sirmmo/chord', kind: 'issue', number: 7, subject: 'Issue #7' });
  assert.deepEqual(parseGitHubPath('/sirmmo/chord/actions/runs/123456/job/9'), { project: 'sirmmo/chord', kind: 'run', number: 123456, subject: 'Run #123456' });
  assert.equal(parseGitHubPath('/sirmmo/chord/commit/abcdef1234').subject, 'Commit abcdef1');
  assert.equal(parseGitHubPath('/sirmmo/chord/blob/main/src/main/index.ts').subject, 'index.ts');
  assert.equal(parseGitHubPath('/sirmmo/chord').kind, 'repo');
  assert.equal(parseGitHubPath('/sirmmo/chord/pulls').kind, 'repo');
  assert.equal(parseGitHubPath('/notifications').kind, 'notifications');
  assert.equal(parseGitHubPath('/settings/profile').project, '');
  assert.equal(parseGitHubPath('/').project, '');
  assert.equal(parseGitHubPath('/sirmmo').project, '');
});

test('parseChecksText reads the merge box summary', () => {
  assert.deepEqual(parseChecksText('1 failing, 2 successful, and 3 pending checks'), { ok: 2, failed: 1, pending: 3, total: 6 });
  assert.deepEqual(parseChecksText('All checks have passed'), { ok: 1, failed: 0, pending: 0, total: 1 });
  assert.deepEqual(parseChecksText("Some checks haven't completed yet"), { ok: 0, failed: 0, pending: 1, total: 1 });
  assert.equal(parseChecksText('Merge pull request'), null);
});

test('stateFromFavicon reads GitHub status favicons', () => {
  assert.equal(stateFromFavicon('https://github.githubassets.com/favicons/favicon-failure.svg'), 'failure');
  assert.equal(stateFromFavicon('https://github.githubassets.com/favicons/favicon-success.png'), 'success');
  assert.equal(stateFromFavicon('https://github.githubassets.com/favicons/favicon.svg'), '');
});

test('parseVsCodeTitle splits file, workspace and the unsaved mark', () => {
  assert.deepEqual(parseVsCodeTitle('● main.ts - chord - Visual Studio Code'), { file: 'main.ts', workspace: 'chord', unsaved: true });
  assert.deepEqual(parseVsCodeTitle('README.md - chord - code-server'), { file: 'README.md', workspace: 'chord', unsaved: false });
  assert.deepEqual(parseVsCodeTitle('chord - GitHub Codespaces'), { file: '', workspace: 'chord', unsaved: false });
  assert.deepEqual(parseVsCodeTitle('Visual Studio Code'), { file: '', workspace: '', unsaved: false });
});

test('VS Code status bar labels', () => {
  assert.deepEqual(parseProblems('3 Errors, 2 Warnings'), { errors: 3, warnings: 2 });
  assert.deepEqual(parseProblems('No Problems'), { errors: 0, warnings: 0 });
  assert.deepEqual(parseProblems('1 Error, 0 Warnings, 4 Infos'), { errors: 1, warnings: 0 });
  assert.equal(stripCodicons(' main*'), 'main*');
});
