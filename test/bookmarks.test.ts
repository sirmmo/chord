import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBookmarks, normalizeTags, pruneTombstones, renderFeed, renderLinkroll, renderBookmarksJson } from '../src/shared/bookmarks.ts';
import type { Bookmark } from '../src/shared/types.ts';

const bm = (id: string, url: string, extra: Partial<Bookmark> = {}): Bookmark => ({ id, url, title: id, note: '', tags: [], public: false, addedAt: 1000, updatedAt: 1000, ...extra });

test('mergeBookmarks keeps the newer version and respects deletions', () => {
  const local = [bm('a', 'https://a.test', { title: 'old', updatedAt: 1 }), bm('b', 'https://b.test')];
  const remote = [bm('a', 'https://a.test', { title: 'new', updatedAt: 2 }), bm('c', 'https://c.test'), bm('b', 'https://b.test', { deletedAt: 5000, updatedAt: 5000 })];
  const { merged, changed } = mergeBookmarks(local, remote);
  assert.ok(changed);
  assert.equal(merged.find((b) => b.id === 'a')?.title, 'new');
  assert.equal(merged.find((b) => b.id === 'b')?.deletedAt, 5000);
  assert.ok(merged.some((b) => b.id === 'c'));
  assert.equal(mergeBookmarks(merged, merged).changed, false);
});

test('mergeBookmarks folds the same URL added on two devices', () => {
  const { merged } = mergeBookmarks([bm('x', 'https://same.test/#frag', { addedAt: 1 })], [bm('y', 'https://same.test/', { addedAt: 2, tags: ['t'], updatedAt: 3000 })]);
  const live = merged.filter((b) => !b.deletedAt);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, 'x');
  assert.deepEqual(live[0].tags, ['t'], 'the newer edit wins on the survivor');
});

test('tags, tombstones and the public site', () => {
  assert.deepEqual(normalizeTags('#Dev, tools dev'), ['dev', 'tools']);
  const now = 100 * 86_400_000;
  assert.equal(pruneTombstones([bm('d', 'https://d', { deletedAt: 1 }), bm('e', 'https://e', { deletedAt: now - 1000 })], now).length, 1);
  const list = [bm('p', 'https://p.test/x', { public: true, title: 'A <b> & "q"', tags: ['one'], note: 'n' }), bm('s', 'https://s.test', { public: false })];
  const opts = { user: 'sirmmo', siteUrl: 'https://sirmmo.github.io/chord-bookmarks/' };
  const feed = renderFeed(list, opts);
  assert.ok(feed.includes('<title>A &lt;b&gt; &amp; &quot;q&quot;</title>'));
  assert.ok(!feed.includes('s.test'), 'private bookmarks stay out of the feed');
  const html = renderLinkroll(list, opts);
  assert.ok(html.includes('href="feed.xml"'));
  assert.ok(html.includes('data-tag="one"'));
  assert.ok(!html.includes('https://s.test'));
  assert.equal(JSON.parse(renderBookmarksJson(list, opts)).bookmarks.length, 1);
});
