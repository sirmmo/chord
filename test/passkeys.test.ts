import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64url, fromB64url, rpIdMatches } from '../src/shared/passkeys.ts';

test('rpIdMatches follows the WebAuthn relying party rule', () => {
  assert.ok(rpIdMatches('login.example.com', 'example.com'));
  assert.ok(rpIdMatches('example.com', 'example.com'));
  assert.ok(rpIdMatches('a.b.example.co.uk', 'example.co.uk'));
  assert.ok(!rpIdMatches('example.com', 'evil.com'));
  assert.ok(!rpIdMatches('a.example.co.uk', 'co.uk'), 'a public suffix is not a relying party');
  assert.ok(!rpIdMatches('example.com', 'com'));
  assert.ok(!rpIdMatches('notexample.com', 'example.com'));
});

test('base64url round-trips', () => {
  assert.equal(b64url('ab+/cd=='), 'ab-_cd');
  assert.equal(fromB64url('ab-_cd'), 'ab+/cd==');
});
