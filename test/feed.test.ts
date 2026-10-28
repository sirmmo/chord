import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, discoverFeeds, feedGuesses, itemKind, parseFeed, parseGitHubStars, resolveCuratorInput } from '../src/shared/feed.ts';

test('parseFeed reads RSS 2.0', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Finds &amp; Links</title>
    <item><title><![CDATA[A <b>great</b> site]]></title><link>https://example.com/a</link><description>&lt;p&gt;Nice &amp; short&lt;/p&gt;</description><pubDate>Tue, 27 Oct 2026 10:00:00 GMT</pubDate><dc:creator>Ann</dc:creator><guid>g1</guid></item>
    <item><title>Second</title><guid isPermaLink="true">https://example.com/b</guid></item>
  </channel></rss>`;
  const f = parseFeed(rss, 'https://example.com/feed');
  assert.ok(f);
  assert.equal(f.title, 'Finds & Links');
  assert.equal(f.items.length, 2);
  assert.deepEqual({ ...f.items[0] }, { id: 'g1', title: 'A great site', url: 'https://example.com/a', summary: 'Nice & short', author: 'Ann', publishedAt: Date.UTC(2026, 9, 27, 10) });
  assert.equal(f.items[1].url, 'https://example.com/b');
});

test('parseFeed reads Atom and JSON Feed, rejects HTML', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Stars</title><entry><title>repo</title><link rel="self" href="https://x/self"/><link rel="alternate" href="/owner/repo"/><id>tag:1</id><updated>2026-10-01T00:00:00Z</updated><author><name>Bob</name></author><content type="html">&lt;p&gt;hi&lt;/p&gt;</content></entry></feed>`;
  const a = parseFeed(atom, 'https://github.com/x.atom');
  assert.ok(a);
  assert.equal(a.items[0].url, 'https://github.com/owner/repo');
  assert.equal(a.items[0].author, 'Bob');
  assert.equal(a.items[0].summary, 'hi');
  const json = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'J', items: [{ id: '1', url: 'https://j.test/1', title: 'One', content_text: 'x', date_published: '2026-10-02T00:00:00Z', authors: [{ name: 'Jo' }] }] });
  const j = parseFeed(json);
  assert.ok(j);
  assert.equal(j.items[0].author, 'Jo');
  assert.equal(parseFeed('<!doctype html><html><body>no</body></html>'), null);
});

test('parseGitHubStars, itemKind and cleanText', () => {
  const stars = JSON.stringify([{ starred_at: '2026-10-03T00:00:00Z', repo: { full_name: 'a/b', html_url: 'https://github.com/a/b', description: 'd', language: 'TS', stargazers_count: 5 } }]);
  const items = parseGitHubStars(stars);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'a/b');
  assert.equal(items[0].summary, 'd · TS · ★ 5');
  assert.equal(itemKind('https://github.com/a/b'), 'repo');
  assert.equal(itemKind('https://github.com/a/b/issues/1'), 'link');
  assert.equal(itemKind('https://www.youtube.com/watch?v=x'), 'video');
  assert.equal(itemKind('https://bsky.app/profile/x/post/1'), 'post');
  assert.equal(cleanText('<![CDATA[Tom &amp; Jerry <i>x</i>]]>'), 'Tom & Jerry x');
});

test('resolveCuratorInput understands handles, GitHub users and sites', () => {
  assert.deepEqual(resolveCuratorInput('@alice.bsky.social'), { kind: 'feed', url: 'https://bsky.app/profile/alice.bsky.social/rss', name: '@alice.bsky.social' });
  assert.deepEqual(resolveCuratorInput('@bob@mastodon.social'), { kind: 'feed', url: 'https://mastodon.social/@bob.rss', name: '@bob@mastodon.social' });
  assert.equal(resolveCuratorInput('github.com/sirmmo')?.kind, 'github');
  assert.equal(resolveCuratorInput('gh:sirmmo')?.url, 'https://api.github.com/users/sirmmo/starred?per_page=60');
  assert.equal(resolveCuratorInput('https://github.com/sirmmo/chord')?.url, 'https://github.com/sirmmo/chord/releases.atom');
  assert.equal(resolveCuratorInput('reddit.com/r/selfhosted')?.url, 'https://www.reddit.com/r/selfhosted/.rss');
  assert.equal(resolveCuratorInput('https://news.ycombinator.com/user?id=pg')?.url, 'https://hnrss.org/submitted?id=pg');
  assert.equal(resolveCuratorInput('example.com')?.kind, 'discover');
  assert.equal(resolveCuratorInput('https://blog.example.com/feed.xml')?.kind, 'feed');
  assert.equal(resolveCuratorInput(''), null);
});

test('discoverFeeds and feedGuesses', () => {
  const html = `<html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml"><link rel="stylesheet" href="/x.css"><link rel="alternate" type="application/atom+xml" href="https://other/atom"></head></html>`;
  assert.deepEqual(discoverFeeds(html, 'https://site.test/blog/'), ['https://site.test/rss.xml', 'https://other/atom']);
  assert.ok(feedGuesses('https://site.test/blog/').includes('https://site.test/blog/feed'));
  assert.ok(feedGuesses('https://site.test/blog/').includes('https://site.test/rss.xml'));
});
