import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInternal, titleFor, toUrl } from '../src/shared/url.ts';

test("Chord's own pages are URLs, not searches", () => {
  assert.equal(toUrl('chord://downloads'), 'chord://downloads');
  assert.equal(toUrl('chord://downloads/'), 'chord://downloads/');
  assert.equal(isInternal('chord://downloads/'), true);
  assert.equal(isInternal('https://chord.test/'), false);
  assert.equal(titleFor('chord://downloads/'), 'Downloads');
  assert.equal(toUrl('weird://thing'), null, 'unknown schemes still search');
});
