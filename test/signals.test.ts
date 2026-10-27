import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTitleSignals } from '../src/shared/signals.ts';

test('unread counts in titles', () => {
  assert.equal(parseTitleSignals('(3) Inbox - Gmail').unread, 3);
  assert.equal(parseTitleSignals('Inbox (12) - me@example.com - Gmail').unread, 12);
  assert.equal(parseTitleSignals('[2] general | Slack').unread, 2);
  assert.equal(parseTitleSignals('5 • Discord').unread, 5);
  assert.equal(parseTitleSignals('Blade Runner (1982)').unread, undefined, 'years are not counts');
  assert.equal(parseTitleSignals('Plain title').unread, undefined);
});

test('timers and progress in titles', () => {
  assert.deepEqual(parseTitleSignals('24:59 - Pomofocus').timer, { text: '24:59', progress: null });
  assert.deepEqual(parseTitleSignals('(12:03) Timer').timer, { text: '12:03', progress: null });
  assert.deepEqual(parseTitleSignals('Uploading 45% · Drive').timer, { text: '45%', progress: 0.45 });
  assert.deepEqual(parseTitleSignals('1:02:03 left').timer, { text: '1:02:03', progress: null });
  assert.equal(parseTitleSignals('Episode 12:34:56:78').timer, undefined);
  assert.equal(parseTitleSignals('Nothing here').timer, undefined);
});
