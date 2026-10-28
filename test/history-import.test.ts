import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeTimeToMs, cleanVisits, firefoxBookmarksToConfig, firefoxTimeToMs } from '../src/shared/importers.ts';

test('time conversions', () => {
  // 2024-01-01T00:00:00Z
  assert.equal(chromeTimeToMs(13_348_540_800_000_000), Date.UTC(2024, 0, 1));
  assert.equal(firefoxTimeToMs(1_704_067_200_000_000), Date.UTC(2024, 0, 1));
});

test('cleanVisits keeps web pages, drops junk and repeats, sorts newest first', () => {
  const now = Date.UTC(2024, 5, 1);
  const out = cleanVisits(
    [
      { url: 'https://a.example/', title: 'A', at: now - 1000 },
      { url: 'https://a.example/', title: 'A again', at: now - 1000 },
      { url: 'https://b.example/', title: '', at: now - 5000 },
      { url: 'chrome://settings', title: 'x', at: now },
      { url: 'https://future.example/', title: 'x', at: now + 10 * 86_400_000 },
      { url: 'https://c.example/', title: 'C', at: 'yesterday' },
    ],
    now,
  );
  assert.deepEqual(out, [
    { url: 'https://a.example/', title: 'A', at: now - 1000 },
    { url: 'https://b.example/', title: 'https://b.example/', at: now - 5000 },
  ]);
});

test('firefoxBookmarksToConfig maps toolbar folders to spaces', () => {
  const rows = [
    { id: 1, parent: 0, type: 2, title: '', url: null, guid: 'root________' },
    { id: 2, parent: 1, type: 2, title: 'toolbar', url: null, guid: 'toolbar_____' },
    { id: 3, parent: 1, type: 2, title: 'menu', url: null, guid: 'menu________' },
    { id: 4, parent: 1, type: 2, title: 'unfiled', url: null, guid: 'unfiled_____' },
    { id: 10, parent: 2, type: 2, title: 'Work', url: null, guid: 'g10' },
    { id: 11, parent: 10, type: 1, title: 'Jira', url: 'https://jira.example/', guid: 'g11' },
    { id: 12, parent: 10, type: 2, title: 'Sub', url: null, guid: 'g12' },
    { id: 13, parent: 12, type: 1, title: 'Wiki', url: 'https://wiki.example/', guid: 'g13' },
    { id: 14, parent: 2, type: 1, title: 'Loose', url: 'https://loose.example/', guid: 'g14' },
    { id: 15, parent: 2, type: 3, title: null, url: null, guid: 'g15' },
    { id: 16, parent: 4, type: 1, title: 'Unfiled one', url: 'https://unfiled.example/', guid: 'g16' },
    { id: 17, parent: 3, type: 1, title: 'Bad', url: 'place:sort=8', guid: 'g17' },
  ];
  const r = firefoxBookmarksToConfig(rows, new Date(0));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.config.spaces.map((sp) => [sp.name, sp.pinned.map((t) => t.url)]), [
    ['Firefox Bookmarks', ['https://loose.example/']],
    ['Work', ['https://jira.example/', 'https://wiki.example/']],
    ['Other Bookmarks', ['https://unfiled.example/']],
  ]);
  assert.equal(firefoxBookmarksToConfig([], new Date(0)).ok, false);
});
