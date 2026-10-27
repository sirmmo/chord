import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteMatches } from '../src/shared/boosts.ts';
import { installUrlFrom, parseSpaceManifest } from '../src/shared/installer.ts';

test('boost site patterns', () => {
  assert.equal(siteMatches('example.com', 'example.com'), true);
  assert.equal(siteMatches('example.com', 'www.example.com'), true);
  assert.equal(siteMatches('example.com', 'app.example.com'), true);
  assert.equal(siteMatches('example.com', 'notexample.com'), false);
  assert.equal(siteMatches('*.example.com', 'example.com'), false);
  assert.equal(siteMatches('*.example.com', 'app.example.com'), true);
  assert.equal(siteMatches('youtube.com, *.google.com', 'mail.google.com'), true);
  assert.equal(siteMatches('*', 'anything.test'), true);
  assert.equal(siteMatches('https://example.com/path', 'example.com'), true, 'URLs are tolerated');
});

test('space manifests: chord-space and chord-config, boosts limited to the source domain', () => {
  const manifest = JSON.stringify({
    format: 'chord-space',
    version: 1,
    name: 'OFM',
    icon: '🗺️',
    color: '#2a9d8f',
    pinned: [{ url: 'https://ofm.test/', title: 'Home' }, 'https://ofm.test/docs'],
    boosts: [
      { name: 'Wide', sites: 'ofm.test', css: '.x{display:none}' },
      { name: 'Evil', sites: 'bank.test', js: 'alert(1)' },
      { name: 'All', sites: '*', css: 'body{}' },
    ],
  });
  const r = parseSpaceManifest(manifest, 'ofm.test');
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (!r.ok) return;
  assert.equal(r.name, 'OFM');
  assert.equal(r.config.spaces[0].icon, '🗺️');
  assert.deepEqual(r.config.spaces[0].pinned.map((t) => t.url), ['https://ofm.test/', 'https://ofm.test/docs']);
  assert.deepEqual(r.boosts.map((b) => b.name), ['Wide'], 'only boosts for the publishing domain survive');
  assert.equal(r.config.settings, undefined);

  const whole = parseSpaceManifest('{"format":"chord-config","version":1,"spaces":[{"name":"A","today":["https://a.test"]}],"settings":{"shields":false}}', 'a.test');
  assert.ok(whole.ok && whole.config.settings === undefined, 'a manifest never carries settings');
  assert.ok(!parseSpaceManifest('{"format":"chord-space","version":2,"name":"x"}', 'x.test').ok);
  assert.ok(!parseSpaceManifest('{"hello":1}', 'x.test').ok);
});

test('install links', () => {
  assert.equal(installUrlFrom('chord://install/?url=https%3A%2F%2Fofm.test%2Fchord-space.json'), 'https://ofm.test/chord-space.json');
  assert.equal(installUrlFrom('chord://install/?url=http://ofm.test/x.json'), null, 'https only');
  assert.equal(installUrlFrom('chord://settings/'), null);
  assert.equal(installUrlFrom('https://ofm.test/'), null);
});
