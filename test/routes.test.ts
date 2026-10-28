import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRoute, routeFor, routeMatches } from '../src/shared/routes.ts';

test('routeMatches: hosts, subdomains, wildcards and path prefixes', () => {
  assert.equal(routeMatches('github.com', 'https://github.com/a/b'), true);
  assert.equal(routeMatches('github.com', 'https://gist.github.com/x'), true);
  assert.equal(routeMatches('*.github.com', 'https://github.com/x'), false);
  assert.equal(routeMatches('github.com/myorg', 'https://github.com/myorg/repo'), true);
  assert.equal(routeMatches('github.com/myorg', 'https://github.com/MyOrg'), true);
  assert.equal(routeMatches('github.com/myorg', 'https://github.com/myorganisation'), false);
  assert.equal(routeMatches('github.com/myorg/', 'https://github.com/myorg/repo'), true);
  assert.equal(routeMatches('https://docs.google.com/, notion.so', 'https://www.notion.so/page'), true);
  assert.equal(routeMatches('*', 'https://anything.example/'), true);
  assert.equal(routeMatches('*', 'mailto:x@y'), false);
  assert.equal(routeMatches('', 'https://x.y/'), false);
});

test('routeFor skips disabled rules and rules whose space is gone', () => {
  const spaces = [{ id: 'work' }];
  const routes = [
    { id: '1', pattern: 'github.com', spaceId: 'gone', enabled: true },
    { id: '2', pattern: 'github.com', spaceId: 'work', enabled: false },
    { id: '3', pattern: 'github.com/acme', spaceId: 'work', enabled: true },
  ];
  assert.equal(routeFor(routes, spaces, 'https://github.com/acme/x')?.id, '3');
  assert.equal(routeFor(routes, spaces, 'https://github.com/other'), undefined);
});

test('isRoute validates shape', () => {
  assert.equal(isRoute({ id: 'a', pattern: 'x', spaceId: 's', enabled: true }), true);
  assert.equal(isRoute({ id: 'a', pattern: 'x' }), false);
});
