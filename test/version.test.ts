import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetFor, compareVersions } from '../src/shared/version.ts';

test('compareVersions orders dotted versions and pre-releases', () => {
  assert.ok(compareVersions('0.16.0', '0.15.9') > 0);
  assert.ok(compareVersions('v0.16.0', '0.16.0') === 0);
  assert.ok(compareVersions('0.16.0', '0.16.1') < 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.ok(compareVersions('1.0.0-beta.1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc') > 0);
  assert.ok(compareVersions('0.16', '0.16.0') === 0);
});

test('assetFor picks the installer that matches the build', () => {
  const names = ['Chord-0.17.0-linux-amd64.deb', 'Chord-0.17.0-linux-x86_64.AppImage', 'Chord-0.17.0-mac-universal.dmg', 'Chord-0.17.0-mac-universal-legacy.dmg', 'Chord-0.17.0-win-x64-portable.zip', 'Chord-0.17.0-win-x64-setup.exe', 'latest.yml'];
  assert.equal(assetFor(names, 'mac'), 'Chord-0.17.0-mac-universal.dmg');
  assert.equal(assetFor(names, 'mac-legacy'), 'Chord-0.17.0-mac-universal-legacy.dmg');
  assert.equal(assetFor(names, 'portable'), 'Chord-0.17.0-win-x64-portable.zip');
  assert.equal(assetFor(names, 'deb'), 'Chord-0.17.0-linux-amd64.deb');
  assert.equal(assetFor(names, 'dev'), undefined);
});
