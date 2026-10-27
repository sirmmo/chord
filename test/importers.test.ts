import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importAny } from '../src/shared/importers.ts';

const arcFile = JSON.stringify({
  version: 1,
  sidebar: {
    containers: [
      { global: {} },
      {
        items: [
          'top', { id: 'top', childrenIds: ['f1'], data: { itemContainer: { containerType: { topApps: {} } } } },
          'f1', { id: 'f1', parentID: 'top', title: 'Mail', childrenIds: [], data: { tab: { savedURL: 'https://mail.google.com/', savedTitle: 'Gmail' } } },
          'pinA', { id: 'pinA', childrenIds: ['t1', 'folder'], data: { itemContainer: { containerType: { spaceItems: {} } } } },
          't1', { id: 't1', parentID: 'pinA', title: '', childrenIds: [], data: { tab: { savedURL: 'https://github.com/', savedTitle: 'GitHub' } } },
          'folder', { id: 'folder', parentID: 'pinA', title: 'Docs', childrenIds: ['t2'], data: { list: {} } },
          't2', { id: 't2', parentID: 'folder', childrenIds: [], data: { tab: { savedURL: 'https://docs.example.com/', savedTitle: 'Docs' } } },
          'unpA', { id: 'unpA', childrenIds: ['t3', 't4'], data: { itemContainer: { containerType: { spaceItems: {} } } } },
          't3', { id: 't3', parentID: 'unpA', childrenIds: [], data: { tab: { savedURL: 'https://news.ycombinator.com/', savedTitle: 'HN' } } },
          't4', { id: 't4', parentID: 'unpA', childrenIds: [], data: { tab: { savedURL: 'arc://settings', savedTitle: 'Settings' } } },
        ],
        spaces: [
          's1', {
            id: 's1',
            title: 'Work',
            newContainerIDs: [{ pinned: {} }, 'pinA', { unpinned: {} }, 'unpA'],
            customInfo: {
              iconType: { emoji_v2: '💼' },
              windowTheme: { background: { single: { _0: { style: { color: { _0: { blendedSingleColor: { _0: { color: { _0: { red: 0.2, green: 0.4, blue: 1, alpha: 1 } } } } } } } } } } },
            },
          },
          's2', { id: 's2', title: 'Play', containerIDs: ['pinned', 'nope', 'unpinned', 'nope2'], customInfo: { iconType: { emoji: 127918 } } },
        ],
        topAppsContainerIDs: ['top'],
      },
    ],
  },
});

test('Arc sidebar: spaces, pinned and today tabs, favorites, icons and colours', () => {
  const r = importAny(arcFile);
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (!r.ok) return;
  assert.equal(r.source, 'Arc');
  assert.deepEqual(r.config.favorites, [{ url: 'https://mail.google.com/', title: 'Mail' }]);
  assert.equal(r.config.spaces.length, 2);
  const [work, play] = r.config.spaces;
  assert.equal(work.name, 'Work');
  assert.equal(work.icon, '💼');
  assert.equal(work.color, '#3366ff');
  assert.deepEqual(work.pinned.map((t) => t.url), ['https://github.com/', 'https://docs.example.com/'], 'folders are flattened in order');
  assert.deepEqual(work.today.map((t) => t.url), ['https://news.ycombinator.com/'], 'arc:// pages are skipped');
  assert.equal(play.name, 'Play');
  assert.equal(play.icon, '🎮');
  assert.deepEqual(play.pinned, []);
  assert.ok(r.notes.some((n) => /1 internal page/.test(n)));
});

test('Chromium bookmarks: bar folders become spaces, loose bookmarks a browser space', () => {
  const file = JSON.stringify({
    version: 1,
    roots: {
      bookmark_bar: {
        type: 'folder',
        name: 'Bookmarks bar',
        children: [
          { type: 'url', name: 'A', url: 'https://a.test/' },
          { type: 'folder', name: 'Dev', children: [{ type: 'url', name: 'B', url: 'https://b.test/' }, { type: 'folder', name: 'Nested', children: [{ type: 'url', name: 'C', url: 'https://c.test/' }] }] },
          { type: 'folder', name: 'Empty', children: [] },
        ],
      },
      other: { type: 'folder', name: 'Other bookmarks', children: [{ type: 'url', name: 'D', url: 'https://d.test/' }, { type: 'url', name: 'Bad', url: 'chrome://flags' }] },
      synced: { type: 'folder', name: 'Mobile bookmarks', children: [] },
    },
  });
  const r = importAny(file, new Date(), 'Brave');
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (!r.ok) return;
  assert.equal(r.source, 'Brave');
  assert.deepEqual(
    r.config.spaces.map((sp) => [sp.name, sp.pinned.map((t) => t.url)]),
    [
      ['Brave Bookmarks', ['https://a.test/']],
      ['Dev', ['https://b.test/', 'https://c.test/']],
      ['Other Bookmarks', ['https://d.test/']],
    ],
  );
  assert.deepEqual(r.config.favorites, []);
});

test('importAny recognises Chord files and rejects the rest', () => {
  const chord = importAny('{"format":"chord-config","version":1,"spaces":[{"name":"A","today":["https://a.test"]}]}');
  assert.ok(chord.ok && chord.source === 'Chord');
  assert.deepEqual(importAny('not json'), { ok: false, error: 'the file is not JSON' });
  const unknown = importAny('{"hello":1}');
  assert.ok(!unknown.ok && /not a Chord configuration/.test(unknown.error));
});
