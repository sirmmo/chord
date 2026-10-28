import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpml, renderOpml } from '../src/shared/opml.ts';
import { parseFeed } from '../src/shared/feed.ts';

test('parseOpml reads folders and feeds, dedupes, skips junk', () => {
  const xml = `<?xml version="1.0"?><opml version="2.0"><head><title>My feeds &amp; more</title></head><body>
    <outline text="Tech">
      <outline type="rss" text="Blog A" xmlUrl="https://a.test/feed" htmlUrl="https://a.test"/>
      <outline type="rss" text="Blog B" xmlUrl="https://b.test/rss.xml"></outline>
    </outline>
    <outline type="rss" text="Loose" xmlUrl="https://c.test/atom"/>
    <outline type="rss" text="Dup" xmlUrl="https://c.test/atom"/>
    <outline text="Empty folder"></outline>
  </body></opml>`;
  const doc = parseOpml(xml);
  assert.ok(doc);
  assert.equal(doc.title, 'My feeds & more');
  assert.deepEqual(doc.feeds.map((f) => [f.title, f.folder]), [['Blog A', 'Tech'], ['Blog B', 'Tech'], ['Loose', '']]);
  assert.equal(doc.feeds[0].htmlUrl, 'https://a.test');
  assert.equal(parseOpml('<html></html>'), null);
});

test('renderOpml round-trips through parseOpml', () => {
  const out = renderOpml('Chord subscriptions', [
    { name: '', feeds: [{ title: 'Loose "one"', xmlUrl: 'https://l.test/feed', htmlUrl: '' }] },
    { name: 'News & views', feeds: [{ title: 'N', xmlUrl: 'https://n.test/feed', htmlUrl: 'https://n.test' }] },
  ]);
  const back = parseOpml(out);
  assert.ok(back);
  assert.equal(back.title, 'Chord subscriptions');
  assert.deepEqual(back.feeds.map((f) => [f.title, f.folder]), [['Loose "one"', ''], ['N', 'News & views']]);
});

test('parseFeed keeps the entry body for the reader', () => {
  const rss = `<rss version="2.0"><channel><title>T</title><item><title>X</title><link>https://x.test/1</link><content:encoded><![CDATA[<p>Hello <b>world</b></p><script>alert(1)</script>]]></content:encoded></item></channel></rss>`;
  const f = parseFeed(rss);
  assert.ok(f);
  assert.equal(f.items[0].summary, 'Hello world alert(1)'.replace(' alert(1)', ''));
  assert.ok(f.items[0].content?.includes('<b>world</b>'));
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><title>E</title><link href="https://a.test/e"/><content type="html">&lt;p&gt;escaped&lt;/p&gt;</content></entry></feed>`;
  assert.equal(parseFeed(atom)?.items[0].content, '<p>escaped</p>');
});
