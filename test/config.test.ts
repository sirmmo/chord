import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, initialState, activeSpace, type Ctx } from '../src/shared/model.ts';
import { exportConfig, parseConfig, exportFileName, CONFIG_FORMAT } from '../src/shared/config.ts';
import type { Action, State } from '../src/shared/types.ts';

let n = 0;
const ctx = (now = 1_000): Ctx => ({ now, newId: () => `id${++n}` });
const run = (s: State, actions: Action[], c: Ctx = ctx()): State => actions.reduce((st, a) => reduce(st, a, c), s);

function sample(): State {
  n = 0;
  return run(initialState(ctx()), [
    { type: 'tab.new', url: 'https://mail.test' },
    { type: 'tab.favorite', id: 'id2' },
    { type: 'tab.new', url: 'https://docs.test/home' },
    { type: 'tab.pin', id: 'id3' },
    { type: 'tab.patch', id: 'id3', patch: { url: 'https://docs.test/deep', title: 'Docs' } },
    { type: 'tab.new', url: 'https://news.test' },
    { type: 'space.create', name: 'Work', icon: '💼' },
    { type: 'tab.new', url: 'https://work.test' },
    { type: 'settings.update', patch: { searchEngine: 'kagi', archiveAfterHours: 24 } },
  ]);
}

test('export is portable: no ids, pinned tabs use their home url, settings included', () => {
  const s = sample();
  const cfg = exportConfig(s, 1_000);
  assert.equal(cfg.format, CONFIG_FORMAT);
  assert.deepEqual(cfg.favorites, [{ url: 'https://mail.test', title: 'mail.test' }]);
  assert.equal(cfg.spaces.length, 2);
  assert.deepEqual(cfg.spaces[0].pinned, [{ url: 'https://docs.test/home', title: 'Docs' }]);
  assert.deepEqual(cfg.spaces[0].today.map((t) => t.url), ['https://news.test']);
  assert.equal(cfg.spaces[1].icon, '💼');
  assert.equal(cfg.settings?.searchEngine, 'kagi');
  assert.ok(!JSON.stringify(cfg).includes('"id'), 'no internal ids leak');
});

test('export of a single space leaves favorites and settings out', () => {
  const s = sample();
  const cfg = exportConfig(s, 1_000, s.spaces[1].id);
  assert.equal(cfg.spaces.length, 1);
  assert.equal(cfg.spaces[0].name, 'Work');
  assert.deepEqual(cfg.favorites, []);
  assert.equal(cfg.settings, undefined);
});

test('export → parse → replace import round-trips the structure', () => {
  const s = sample();
  const text = JSON.stringify(exportConfig(s, 1_000));
  const parsed = parseConfig(text);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const fresh = initialState(ctx(5_000));
  const next = reduce(fresh, { type: 'config.import', config: parsed.config, mode: 'replace' }, ctx(5_000));
  assert.deepEqual(next.spaces.map((sp) => sp.name), ['Personal', 'Work']);
  assert.equal(next.favorites.length, 1);
  assert.equal(next.spaces[0].pinned.length, 1);
  assert.equal(next.spaces[0].today.length, 1);
  assert.equal(next.settings.searchEngine, 'kagi');
  assert.equal(next.settings.archiveAfterHours, 24);
  const pinned = next.tabs[next.spaces[0].pinned[0]];
  assert.equal(pinned.kind, 'pinned');
  assert.equal(pinned.homeUrl, 'https://docs.test/home');
  assert.equal(pinned.awake, false);
  assert.equal(activeSpace(next).id, next.spaces[0].id);
});

test('merge adds missing tabs to same-named spaces and leaves settings alone', () => {
  const s = sample();
  const cfg = parseConfig(JSON.stringify({
    format: 'chord-config', version: 1,
    favorites: ['https://mail.test', 'https://cal.test'],
    spaces: [
      { name: 'work', color: '#ff6b6b', pinned: [{ url: 'https://work.test' }, { url: 'https://jira.test', title: 'Jira' }], today: [] },
      { name: 'Reading', pinned: [], today: [{ url: 'https://blog.test' }] },
    ],
    settings: { searchEngine: 'google' },
  }));
  assert.ok(cfg.ok);
  if (!cfg.ok) return;
  const next = reduce(s, { type: 'config.import', config: cfg.config, mode: 'merge' }, ctx(9_000));
  assert.equal(next.favorites.length, 2, 'existing favorite is not duplicated');
  assert.deepEqual(next.spaces.map((sp) => sp.name), ['Personal', 'Work', 'Reading']);
  const work = next.spaces[1];
  assert.equal(work.color, '#ff6b6b');
  assert.equal(work.today.length, 1, 'work.test already present as today tab, not added again');
  assert.deepEqual(work.pinned.map((id) => next.tabs[id].title), ['Jira']);
  assert.equal(next.spaces[2].today.length, 1);
  assert.equal(next.settings.searchEngine, 'kagi');
  assert.equal(next.archived.length, 0);
});

test('replace archives the current tabs instead of losing them', () => {
  const s = sample();
  const cfg = parseConfig(JSON.stringify({ format: 'chord-config', version: 1, spaces: [{ name: 'Only', today: ['https://only.test'] }] }));
  assert.ok(cfg.ok);
  if (!cfg.ok) return;
  const next = reduce(s, { type: 'config.import', config: cfg.config, mode: 'replace' }, ctx(9_000));
  assert.deepEqual(next.spaces.map((sp) => sp.name), ['Only']);
  assert.equal(Object.keys(next.tabs).length, 1);
  assert.equal(next.archived.length, 4);
  assert.equal(next.activeSpaceId, next.spaces[0].id);
  assert.equal(next.favorites.length, 0);
});

test('parseConfig rejects bad input with a readable message', () => {
  const bad = (text: string) => {
    const r = parseConfig(text);
    assert.equal(r.ok, false);
    return r.ok ? '' : r.error;
  };
  assert.match(bad('nope'), /JSON/);
  assert.match(bad('[]'), /not a JSON object/);
  assert.match(bad('{"format":"x"}'), /"format"/);
  assert.match(bad('{"format":"chord-config","version":2,"spaces":[]}'), /version/);
  assert.match(bad('{"format":"chord-config","version":1,"spaces":[{}]}'), /needs a "name"/);
  assert.match(bad('{"format":"chord-config","version":1,"spaces":[{"name":"A","today":[{"url":"javascript:alert(1)"}]}]}'), /unsupported url/);
  const ok = parseConfig('{"format":"chord-config","version":1,"spaces":[{"name":"A","today":["https://a.test"]}],"settings":{"searchEngine":"nope","shields":false}}');
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.config.settings, { shields: false });
    assert.equal(ok.config.spaces[0].today[0].url, 'https://a.test');
  }
});

test('export file names are safe and dated', () => {
  assert.equal(exportFileName(Date.UTC(2026, 9, 26), 'Side projects / 2026'), 'Chord-space-Side_projects_2026-2026-10-26.json');
  assert.equal(exportFileName(Date.UTC(2026, 9, 26)), 'Chord-config-2026-10-26.json');
});

test('theme travels through export and import, invalid fields are dropped', () => {
  let s = sample();
  s = reduce(s, { type: 'theme.update', patch: { mode: 'light', accent: '#123456', iconStyle: 'mono' } }, ctx());
  const parsed = parseConfig(JSON.stringify(exportConfig(s, 1_000)));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.config.settings?.theme?.accent, '#123456');
  const next = reduce(initialState(ctx()), { type: 'config.import', config: parsed.config, mode: 'replace' }, ctx());
  assert.equal(next.settings.theme.mode, 'light');
  assert.equal(next.settings.theme.iconStyle, 'mono');
  assert.equal(next.settings.theme.font, 'system');
  const sloppy = parseConfig('{"format":"chord-config","version":1,"spaces":[],"settings":{"theme":{"mode":"neon","tint":"lots","accent":"red","font":"mono"}}}');
  assert.ok(sloppy.ok);
  if (sloppy.ok) assert.deepEqual(sloppy.config.settings?.theme, { font: 'mono' });
});

test('export carries the address bar setting but never extension paths', () => {
  let s = sample();
  s = run(s, [{ type: 'settings.update', patch: { addressBar: true } }, { type: 'extension.add', path: '/Users/me/ext' }]);
  const cfg = exportConfig(s, 1_000);
  assert.equal(cfg.settings?.addressBar, true);
  assert.equal('extensions' in (cfg.settings ?? {}), false);
  const parsed = parseConfig(JSON.stringify(cfg));
  assert.ok(parsed.ok);
  if (parsed.ok) {
    const next = reduce(initialState(ctx()), { type: 'config.import', config: parsed.config, mode: 'replace' }, ctx());
    assert.equal(next.settings.addressBar, true);
    assert.deepEqual(next.settings.extensions, []);
  }
});
