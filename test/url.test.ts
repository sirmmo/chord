import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalScheme, isInternal, titleFor, toUrl } from '../src/shared/url.ts';

test("Chord's own pages are URLs, not searches", () => {
  assert.equal(toUrl('chord://downloads'), 'chord://downloads');
  assert.equal(toUrl('chord://downloads/'), 'chord://downloads/');
  assert.equal(isInternal('chord://downloads/'), true);
  assert.equal(isInternal('https://chord.test/'), false);
  assert.equal(titleFor('chord://downloads/'), 'Downloads');
  assert.equal(toUrl('weird://thing'), null, 'unknown schemes still search');
});

test('external schemes are recognised, web schemes are not', () => {
  assert.equal(externalScheme('magnet:?xt=urn:btih:abc'), 'magnet:');
  assert.equal(externalScheme('mailto:a@b.c'), 'mailto:');
  assert.equal(externalScheme('ZoomMtg://join'), 'zoommtg:');
  assert.equal(externalScheme('https://example.com/'), null);
  assert.equal(externalScheme('chord://settings/'), null);
  assert.equal(externalScheme('javascript:void(0)'), null);
  assert.equal(externalScheme('no scheme here'), null);
});

test('siteOf reduces hosts to their registrable domain', async () => {
  const { siteOf } = await import('../src/shared/url.ts');
  assert.equal(siteOf('www.github.com'), 'github.com');
  assert.equal(siteOf('gist.github.com'), 'github.com');
  assert.equal(siteOf('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(siteOf('localhost'), 'localhost');
  assert.notEqual(siteOf('github.com'), siteOf('example.org'));
});
