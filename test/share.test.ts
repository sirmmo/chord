import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSpacePage, renderTabPage, sharedFiles, shareId, slugify } from '../src/shared/share.ts';
import { parseSpaceManifest } from '../src/shared/installer.ts';
import { CONFIG_FORMAT, CONFIG_VERSION, type ChordConfig } from '../src/shared/config.ts';

const site = { user: 'sirmmo', siteUrl: 'https://sirmmo.github.io/chord-bookmarks/' };

test('slugify makes safe unique folder names', () => {
  assert.equal(slugify('Board Games & Stuff!'), 'board-games-stuff');
  assert.equal(slugify('Caffè'), 'caffe');
  assert.equal(slugify('***'), 'space');
  assert.equal(slugify('Work', new Set(['work', 'work-2'])), 'work-3');
});

test('shareId is eight unambiguous characters', () => {
  const id = shareId();
  assert.match(id, /^[abcdefghijkmnpqrstuvwxyz23456789]{8}$/);
  assert.equal(shareId(() => 0), 'aaaaaaaa');
});

test('sharedFiles writes a manifest Chord can install, a page per space and tab, and an index', () => {
  const config: ChordConfig = {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt: '2026-10-28T00:00:00.000Z',
    favorites: [],
    spaces: [
      { name: 'Games', color: '#ff0000', icon: '🎲', pinned: [{ url: 'https://boardgamegeek.com/', title: 'BGG' }], today: [{ url: 'https://example.org/x' }], notes: 'Hi <there>' },
      { name: 'Secret', pinned: [], today: [] },
    ],
  };
  const tabs = [{ id: 'abcd2345', url: 'https://example.com/page?a=1&b=2', title: 'A "page"', note: 'look', at: 1 }];
  const files = sharedFiles(config, new Map([['Games', 'games']]), tabs, site);
  assert.deepEqual([...files.keys()].sort(), ['shared.html', 'spaces/games/index.html', 'spaces/games/space.json', 't/abcd2345/index.html']);
  const parsed = parseSpaceManifest(files.get('spaces/games/space.json') as string, 'sirmmo.github.io');
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.equal(parsed.name, 'Games');
    assert.equal(parsed.config.spaces[0].pinned[0].url, 'https://boardgamegeek.com/');
    assert.equal(parsed.config.spaces[0].notes, 'Hi <there>');
  }
  const page = files.get('spaces/games/index.html') as string;
  assert.ok(page.includes('chord://install/?url=https%3A%2F%2Fsirmmo.github.io%2Fchord-bookmarks%2Fspaces%2Fgames%2Fspace.json'));
  assert.ok(page.includes('Hi &lt;there&gt;'));
  assert.ok(!page.includes('Secret'));
  const tab = files.get('t/abcd2345/index.html') as string;
  assert.ok(tab.includes('A &quot;page&quot;'));
  assert.ok(tab.includes('href="https://example.com/page?a=1&amp;b=2"'));
  assert.ok((files.get('shared.html') as string).includes('spaces/games/'));
  assert.equal(sharedFiles(config, new Map(), [], site).size, 0);
});

test('renderers escape what they print', () => {
  const html = renderTabPage({ id: 'x', url: 'https://e.com/<script>', title: '<b>', note: '', at: 0 }, site);
  assert.ok(!html.includes('<script>'));
  const sp = renderSpacePage({ name: '<img>', pinned: [], today: [] }, 'https://x/y.json', site);
  assert.ok(!sp.includes('<img>'));
});
