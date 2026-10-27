import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, initialState, activeSpace, hydrate, isLocked, spaceById, visiblePanes, AUTO_LOCK_MS, MAX_PANES, type Ctx } from '../src/shared/model.ts';
import { exportConfig } from '../src/shared/config.ts';
import type { Action, State } from '../src/shared/types.ts';
import { toUrl, titleFor } from '../src/shared/url.ts';
import { computeLayout } from '../src/shared/layout.ts';

let n = 0;
const ctx = (now = 1_000): Ctx => ({ now, newId: () => `id${++n}` });
const run = (s: State, actions: Action[], c: Ctx = ctx()): State => actions.reduce((st, a) => reduce(st, a, c), s);
const fresh = () => {
  n = 0;
  return initialState(ctx());
};

test('new tab is shown and listed first in Today', () => {
  const s = run(fresh(), [
    { type: 'tab.new', url: 'https://a.test' },
    { type: 'tab.new', url: 'https://b.test' },
  ]);
  const sp = activeSpace(s);
  assert.deepEqual(sp.today, ['id3', 'id2']);
  assert.deepEqual(sp.panes, ['id3']);
  assert.equal(sp.focused, 'id3');
  assert.equal(s.tabs.id3.awake, true);
  assert.equal(s.tabs.id2.awake, true, 'previous tab stays awake in the background');
  assert.equal(s.tabs.id2.title, 'a.test');
});

test('background tab is not shown and stays asleep', () => {
  const s = run(fresh(), [
    { type: 'tab.new', url: 'https://a.test' },
    { type: 'tab.new', url: 'https://b.test', activate: false },
  ]);
  assert.equal(activeSpace(s).focused, 'id2');
  assert.equal(s.tabs.id3.awake, false);
});

test('closing the focused today tab shows its neighbour and records it', () => {
  let s = run(fresh(), [
    { type: 'tab.new', url: 'https://a.test' },
    { type: 'tab.new', url: 'https://b.test' },
    { type: 'tab.new', url: 'https://c.test' },
  ]);
  // today = [c, b, a]; focused c
  s = reduce(s, { type: 'tab.close', id: 'id3' }, ctx(2_000));
  const sp = activeSpace(s);
  assert.deepEqual(sp.today, ['id4', 'id2']);
  assert.equal(sp.focused, 'id4');
  assert.equal(s.tabs.id3, undefined);
  assert.equal(s.recentlyClosed[0].url, 'https://b.test');
  s = run(s, [{ type: 'tab.close', id: 'id4' }, { type: 'tab.close', id: 'id2' }]);
  assert.equal(activeSpace(s).focused, null);
  assert.deepEqual(activeSpace(s).panes, []);
});

test('closing a pinned tab puts it to sleep at its home url', () => {
  let s = run(fresh(), [{ type: 'tab.new', url: 'https://a.test' }, { type: 'tab.pin', id: 'id2' }]);
  s = reduce(s, { type: 'tab.patch', id: 'id2', patch: { url: 'https://a.test/deep' } }, ctx());
  s = reduce(s, { type: 'tab.close', id: 'id2' }, ctx());
  const t = s.tabs.id2;
  assert.ok(t, 'pinned tab survives close');
  assert.equal(t.awake, false);
  assert.equal(t.url, 'https://a.test');
  assert.deepEqual(activeSpace(s).pinned, ['id2']);
  assert.equal(activeSpace(s).focused, null);
});

test('pin / unpin moves between lists', () => {
  let s = run(fresh(), [{ type: 'tab.new', url: 'https://a.test' }, { type: 'tab.new', url: 'https://b.test' }]);
  s = reduce(s, { type: 'tab.togglePin' }, ctx()); // pins focused (b)
  let sp = activeSpace(s);
  assert.deepEqual(sp.pinned, ['id3']);
  assert.deepEqual(sp.today, ['id2']);
  assert.equal(s.tabs.id3.homeUrl, 'https://b.test');
  s = reduce(s, { type: 'tab.unpin', id: 'id3' }, ctx());
  sp = activeSpace(s);
  assert.deepEqual(sp.pinned, []);
  assert.deepEqual(sp.today, ['id3', 'id2']);
  assert.equal(s.tabs.id3.homeUrl, undefined);
});

test('favorites are global and can be split into the active space', () => {
  let s = run(fresh(), [
    { type: 'tab.new', url: 'https://mail.test' },
    { type: 'tab.favorite', id: 'id2' },
    { type: 'space.create', name: 'Work' },
    { type: 'tab.new', url: 'https://docs.test' },
    { type: 'tab.split', id: 'id2' },
  ]);
  assert.equal(s.tabs.id2.spaceId, null);
  assert.deepEqual(s.favorites, ['id2']);
  const work = activeSpace(s);
  assert.equal(work.name, 'Work');
  assert.deepEqual(work.panes, ['id4', 'id2']);
  assert.equal(work.focused, 'id2');
  s = reduce(s, { type: 'tab.unsplit', id: 'id2' }, ctx());
  assert.deepEqual(activeSpace(s).panes, ['id4']);
  assert.equal(activeSpace(s).focused, 'id4');
});

test('split view is capped and a tab from another space cannot be split', () => {
  const urls = ['a', 'b', 'c', 'd', 'e', 'f'].map((h) => `https://${h}.test`);
  let s = run(fresh(), urls.map((url) => ({ type: 'tab.new', url }) as Action));
  const ids = activeSpace(s).today; // 6 ids
  s = run(s, ids.slice(1).map((id) => ({ type: 'tab.split', id }) as Action));
  assert.equal(activeSpace(s).panes.length, MAX_PANES);
  s = run(s, [{ type: 'space.create' }]);
  assert.deepEqual(activeSpace(s).panes, []);
  s = reduce(s, { type: 'tab.split', id: ids[0] }, ctx());
  assert.deepEqual(activeSpace(s).panes, []);
});

test('activating a tab in a split replaces the focused pane', () => {
  let s = run(fresh(), [
    { type: 'tab.new', url: 'https://a.test' },
    { type: 'tab.new', url: 'https://b.test' },
    { type: 'tab.split', id: 'id2' },
    { type: 'tab.new', url: 'https://c.test' },
  ]);
  assert.deepEqual(activeSpace(s).panes, ['id3', 'id4']);
  s = reduce(s, { type: 'pane.focus', id: 'id3' }, ctx());
  s = reduce(s, { type: 'tab.activate', id: 'id2' }, ctx());
  assert.deepEqual(activeSpace(s).panes, ['id2', 'id4']);
});

test('tick archives stale today tabs but not visible or pinned ones', () => {
  let s = run(fresh(), [
    { type: 'tab.new', url: 'https://old.test' },
    { type: 'tab.new', url: 'https://pinned.test' },
    { type: 'tab.pin', id: 'id3' },
    { type: 'tab.new', url: 'https://visible.test' },
  ]);
  const later = 1_000 + 13 * 3600_000;
  const before = s;
  s = reduce(s, { type: 'tick' }, ctx(1_000 + 3600_000));
  assert.equal(s, before, 'nothing to archive after one hour');
  s = reduce(s, { type: 'tick' }, ctx(later));
  assert.equal(s.tabs.id2, undefined);
  assert.ok(s.tabs.id3);
  assert.ok(s.tabs.id4);
  assert.equal(s.archived[0].url, 'https://old.test');
  s = reduce(s, { type: 'archived.restore', id: 'id2' }, ctx(later));
  assert.equal(activeSpace(s).today.length, 2);
  assert.equal(s.archived.length, 0);
});

test('deleting a space archives its tabs; the last space cannot be deleted', () => {
  let s = run(fresh(), [{ type: 'tab.new', url: 'https://a.test' }, { type: 'space.create', name: 'Work' }, { type: 'tab.new', url: 'https://w.test' }]);
  const workId = s.activeSpaceId;
  s = reduce(s, { type: 'space.delete', id: workId }, ctx());
  assert.equal(s.spaces.length, 1);
  assert.equal(s.tabs.id4, undefined);
  assert.equal(s.archived[0].url, 'https://w.test');
  assert.equal(activeSpace(s).focused, 'id2');
  const same = reduce(s, { type: 'space.delete', id: s.spaces[0].id }, ctx());
  assert.equal(same, s);
});

test('reopen closed restores the tab into its space', () => {
  let s = run(fresh(), [{ type: 'tab.new', url: 'https://a.test' }, { type: 'space.create' }]);
  const first = s.spaces[0].id;
  s = run(s, [{ type: 'tab.close', id: 'id2' }, { type: 'closed.reopen' }]);
  assert.equal(s.activeSpaceId, first);
  assert.equal(activeSpace(s).today.length, 1);
  assert.equal(s.recentlyClosed.length, 0);
});

test('tab.move reorders using the index after removal', () => {
  let s = run(fresh(), [{ type: 'tab.new', url: 'https://a.test' }, { type: 'tab.new', url: 'https://b.test' }, { type: 'tab.new', url: 'https://c.test' }]);
  // today = [c(id4), b(id3), a(id2)]
  s = reduce(s, { type: 'tab.move', id: 'id4', list: 'today', index: 2 }, ctx());
  assert.deepEqual(activeSpace(s).today, ['id3', 'id2', 'id4']);
  s = reduce(s, { type: 'tab.move', id: 'id2', list: 'pinned', index: 0 }, ctx());
  assert.deepEqual(activeSpace(s).pinned, ['id2']);
  assert.equal(s.tabs.id2.kind, 'pinned');
});

test('next/prev/jump cycle through pinned then today', () => {
  let s = run(fresh(), [{ type: 'tab.new', url: 'https://a.test' }, { type: 'tab.new', url: 'https://b.test' }, { type: 'tab.pin', id: 'id2' }]);
  // pinned [a], today [b]; focused b
  s = reduce(s, { type: 'tab.next' }, ctx());
  assert.equal(activeSpace(s).focused, 'id2');
  s = reduce(s, { type: 'tab.prev' }, ctx());
  assert.equal(activeSpace(s).focused, 'id3');
  s = reduce(s, { type: 'tab.jump', index: 0 }, ctx());
  assert.equal(activeSpace(s).focused, 'id2');
});

test('hydrate drops dangling ids and wakes only the active panes', () => {
  const s = run(fresh(), [{ type: 'tab.new', url: 'https://a.test' }, { type: 'tab.new', url: 'https://b.test', activate: false }]);
  const raw = JSON.parse(JSON.stringify(s));
  raw.spaces[0].today.push('ghost');
  raw.spaces[0].panes.push('ghost');
  raw.tabs.id3.awake = true;
  const h = hydrate(raw, ctx());
  assert.deepEqual(h.spaces[0].today, ['id3', 'id2']);
  assert.deepEqual(h.spaces[0].panes, ['id2']);
  assert.equal(h.tabs.id2.awake, true);
  assert.equal(h.tabs.id3.awake, false);
  assert.equal(hydrate(null, ctx()).spaces.length, 1);
  assert.equal(hydrate({ version: 99 }, ctx()).spaces.length, 1);
});

test('toUrl recognises hosts and schemes, otherwise search', () => {
  assert.equal(toUrl('example.com'), 'https://example.com');
  assert.equal(toUrl('localhost:3000/x'), 'https://localhost:3000/x');
  assert.equal(toUrl('http://a.b/c?d=e'), 'http://a.b/c?d=e');
  assert.equal(toUrl('what is a chord'), null);
  assert.equal(toUrl('javascript:alert(1)'), null);
  assert.equal(toUrl('chord'), null);
  assert.equal(titleFor('https://www.example.com/path'), 'example.com');
});

test('layout splits the content area evenly', () => {
  const { content, panes } = computeLayout({ width: 1000, height: 600, sidebarOpen: true, sidebarWidth: 260, panes: 2 });
  assert.equal(content.x, 260);
  assert.equal(panes.length, 2);
  assert.equal(panes[0].x, 260);
  assert.equal(panes[1].x + panes[1].width, 992);
  const closed = computeLayout({ width: 1000, height: 600, sidebarOpen: false, sidebarWidth: 260, panes: 1 });
  assert.equal(closed.panes[0].x, 8);
  assert.equal(closed.panes[0].width, 984);
});

test('theme settings merge over defaults and clamp the tint', () => {
  let s = run(fresh(), [{ type: 'theme.update', patch: { mode: 'dark', tint: 250 } }]);
  assert.equal(s.settings.theme.mode, 'dark');
  assert.equal(s.settings.theme.tint, 100);
  assert.equal(s.settings.theme.iconStyle, 'color');
  const raw = JSON.parse(JSON.stringify(s));
  raw.settings = { sidebarWidth: 300, theme: { accent: '#ff0000' } };
  const h = hydrate(raw, ctx());
  assert.equal(h.settings.theme.accent, '#ff0000');
  assert.equal(h.settings.theme.mode, 'system', 'missing theme fields fall back to defaults');
  assert.equal(h.settings.sidebarWidth, 300);
  assert.equal(h.settings.shields, true);
  assert.equal(h.settings.smartPages, true);
});

test('layout honours a top inset for platforms with a native window-controls strip', () => {
  const { content } = computeLayout({ width: 800, height: 600, sidebarOpen: true, sidebarWidth: 240, panes: 1, topInset: 36 });
  assert.equal(content.y, 36);
  assert.equal(content.height, 600 - 36 - 8);
});

test('extensions are added once, toggled, annotated and removed', () => {
  let s = run(fresh(), [
    { type: 'extension.add', path: '/ext/a' },
    { type: 'extension.add', path: '/ext/a' },
    { type: 'extension.add', path: '/ext/b', name: 'B', version: '1.0' },
    { type: 'extension.toggle', path: '/ext/a', enabled: false },
    { type: 'extension.info', path: '/ext/a', name: 'A', version: '2.0' },
  ]);
  assert.deepEqual(s.settings.extensions, [
    { path: '/ext/a', enabled: false, name: 'A', version: '2.0' },
    { path: '/ext/b', enabled: true, name: 'B', version: '1.0' },
  ]);
  const same = reduce(s, { type: 'extension.remove', path: '/nope' }, ctx());
  assert.equal(same, s);
  s = reduce(s, { type: 'extension.remove', path: '/ext/a' }, ctx());
  assert.equal(s.settings.extensions.length, 1);
  const raw = JSON.parse(JSON.stringify(s));
  raw.settings.extensions = [{ path: '/ext/b', enabled: true }, 'junk', { enabled: true }];
  assert.equal(hydrate(raw, ctx()).settings.extensions.length, 1);
  assert.equal(hydrate(raw, ctx()).settings.addressBar, false);
});

test('private spaces: lock, unlock, no traces, never exported', () => {
  let s = initialState(ctx());
  const first = s.spaces[0];
  s = reduce(s, { type: 'space.create' }, ctx());
  const priv = s.spaces[1];
  s = reduce(s, { type: 'space.activate', id: priv.id }, ctx());
  s = reduce(s, { type: 'tab.new', url: 'https://secret.test/' }, ctx());
  const secretId = activeSpace(s).today[0];
  s = reduce(s, { type: 'space.setLock', id: priv.id, lock: { salt: 'x', hash: 'y' } }, ctx());
  assert.equal(isLocked(spaceById(s, priv.id)!), false, 'setting a password leaves the space open');

  s = reduce(s, { type: 'space.lock', id: priv.id }, ctx());
  assert.equal(isLocked(spaceById(s, priv.id)!), true);
  assert.equal(s.tabs[secretId].awake, false, 'locking puts its tabs to sleep');
  assert.deepEqual(visiblePanes(spaceById(s, priv.id)!), []);
  assert.equal(reduce(s, { type: 'tab.activate', id: secretId }, ctx()), s, 'tabs of a locked space cannot be activated');
  assert.equal(reduce(s, { type: 'tab.new', url: 'https://x.test/' }, ctx()), s, 'no new tabs in a locked space');
  assert.equal(reduce(s, { type: 'space.delete', id: priv.id }, ctx()), s, 'a locked space cannot be deleted');

  const exported = exportConfig(s, Date.now());
  assert.deepEqual(exported.spaces.map((sp) => sp.name), [first.name], 'private spaces are not exported');

  s = reduce(s, { type: 'space.unlocked', id: priv.id }, ctx());
  assert.equal(isLocked(spaceById(s, priv.id)!), false);
  assert.equal(s.tabs[secretId].awake, true, 'unlocking the active space wakes its panes');

  s = reduce(s, { type: 'tab.close', id: secretId }, ctx());
  assert.equal(s.recentlyClosed.length, 0, 'closed private tabs are not kept for reopening');

  // auto-lock after being left alone
  s = reduce(s, { type: 'space.activate', id: first.id }, ctx());
  const later = { now: Date.now() + AUTO_LOCK_MS + 1000, newId: ctx().newId };
  s = reduce(s, { type: 'tick' }, later);
  assert.equal(isLocked(spaceById(s, priv.id)!), true, 'locks again after 15 minutes away');

  const persisted = reduce(s, { type: 'space.unlocked', id: priv.id }, ctx());
  const reloaded = hydrate(structuredClone(persisted), ctx());
  assert.equal(isLocked(spaceById(reloaded, priv.id)!), true, 'private spaces start locked on launch');
});

test('tab volume is clamped and 100% means unset', () => {
  let s = initialState(ctx());
  s = reduce(s, { type: 'tab.new', url: 'https://a.test/' }, ctx());
  const id = activeSpace(s).today[0];
  s = reduce(s, { type: 'tab.volume', id, volume: 0.333 }, ctx());
  assert.equal(s.tabs[id].volume, 0.33);
  s = reduce(s, { type: 'tab.volume', id, volume: 5 }, ctx());
  assert.equal(s.tabs[id].volume, undefined);
  s = reduce(s, { type: 'tab.volume', id, volume: -1 }, ctx());
  assert.equal(s.tabs[id].volume, 0);
});

test('troubleshooting flags survive a reload and ignore junk', () => {
  const ctx: Ctx = { now: 1, newId: () => 'x' };
  const s = initialState(ctx);
  const next = reduce(s, { type: 'settings.update', patch: { flags: { noHwVideoDecode: true } } }, ctx);
  assert.equal(next.settings.flags.noHwVideoDecode, true);
  const raw = JSON.parse(JSON.stringify(next)) as { settings: { flags: Record<string, unknown> } };
  raw.settings.flags.noGpu = 'yes';
  raw.settings.flags.bogus = true;
  const back = hydrate(raw, ctx);
  assert.deepEqual(back.settings.flags, { noHwVideoDecode: true });
});

test('skin setting defaults to chord and only accepts known skins', () => {
  const ctx: Ctx = { now: 1, newId: () => 'x' };
  const s = initialState(ctx);
  assert.equal(s.settings.theme.skin, 'chord');
  const next = reduce(s, { type: 'theme.update', patch: { skin: 'lcars' } }, ctx);
  assert.equal(next.settings.theme.skin, 'lcars');
  const raw = JSON.parse(JSON.stringify(next)) as { settings: { theme: Record<string, unknown> } };
  raw.settings.theme.skin = 'holodeck';
  assert.equal(hydrate(raw, ctx).settings.theme.skin, 'chord');
});

test('subspaces: members are grouped, owners take their subspace along, leaving the space drops it', () => {
  const ctx: Ctx = { now: 1, newId: (() => { let n = 0; return () => `t${++n}`; })() };
  let s = initialState(ctx);
  const space = activeSpace(s);
  s = reduce(s, { type: 'tab.new', url: 'https://stairway.example/', id: 'owner', spaceId: space.id }, ctx);
  s = reduce(s, { type: 'tab.new', url: 'https://a.example/', id: 'a', spaceId: space.id, activate: false }, ctx);
  s = reduce(s, { type: 'tab.new', url: 'https://b.example/', id: 'b', spaceId: space.id, activate: false }, ctx);
  s = reduce(s, { type: 'group.create', spaceId: space.id, name: 'Experiments', owner: 'owner', id: 'g1', tabIds: ['owner', 'a'] }, ctx);
  assert.equal(activeSpace(s).groups?.length, 1);
  assert.equal(s.tabs.a.groupId, 'g1');
  s = reduce(s, { type: 'tab.setGroup', id: 'b', groupId: 'g1' }, ctx);
  // b is placed right after the last member in the today list
  const today = activeSpace(s).today;
  assert.equal(today.indexOf('b'), today.indexOf('a') + 1);
  // a second space: moving a member there removes it from the group
  s = reduce(s, { type: 'space.create' }, ctx);
  const other = activeSpace(s);
  s = reduce(s, { type: 'tab.move', id: 'b', list: 'today', spaceId: other.id, index: 0 }, ctx);
  assert.equal(s.tabs.b.groupId, undefined);
  // closing the owner closes the remaining member and the group
  s = reduce(s, { type: 'tab.close', id: 'owner' }, ctx);
  assert.equal(s.tabs.a, undefined);
  assert.equal(s.spaces[0].groups, undefined);
});

test('subspaces: dissolve keeps tabs, close removes them, hydrate drops dangling groups', () => {
  const ctx: Ctx = { now: 1, newId: (() => { let n = 0; return () => `u${++n}`; })() };
  let s = initialState(ctx);
  const space = activeSpace(s);
  s = reduce(s, { type: 'tab.new', url: 'https://a.example/', id: 'a', spaceId: space.id, activate: false }, ctx);
  s = reduce(s, { type: 'tab.new', url: 'https://b.example/', id: 'b', spaceId: space.id, activate: false }, ctx);
  s = reduce(s, { type: 'group.create', spaceId: space.id, name: 'Docs', id: 'g', tabIds: ['a', 'b'] }, ctx);
  const dissolved = reduce(s, { type: 'group.dissolve', id: 'g' }, ctx);
  assert.equal(dissolved.tabs.a.groupId, undefined);
  assert.ok(dissolved.tabs.b);
  const closed = reduce(s, { type: 'group.close', id: 'g' }, ctx);
  assert.equal(closed.tabs.a, undefined);
  assert.equal(closed.tabs.b, undefined);
  const raw = JSON.parse(JSON.stringify(s)) as State;
  (raw.tabs.a as { groupId?: string }).groupId = 'missing';
  raw.spaces[0].groups!.push({ id: 'empty', name: 'Empty' });
  const back = hydrate(raw, ctx);
  assert.equal(back.tabs.a.groupId, undefined);
  assert.deepEqual(back.spaces[0].groups?.map((g) => g.id), ['g']);
  // export carries the group by name and import recreates it
  const exported = exportConfig(back, 1);
  assert.equal(exported.spaces[0].today.find((t) => t.url === 'https://b.example/')?.group, 'Docs');
});

test('windows: remembered per space, deduplicated and pruned on hydrate', () => {
  const ctx: Ctx = { now: 1, newId: (() => { let n = 0; return () => `w${++n}`; })() };
  let s = initialState(ctx);
  const first = s.activeSpaceId;
  s = reduce(s, { type: 'space.create' }, ctx);
  const second = s.activeSpaceId;
  s = reduce(s, { type: 'windows.set', windows: [{ spaceId: first, bounds: { x: 0, y: 0, width: 800, height: 600 } }, { spaceId: second }, { spaceId: 'missing' }] }, ctx);
  assert.deepEqual(s.windows?.map((w) => w.spaceId), [first, second]);
  const same = reduce(s, { type: 'windows.set', windows: s.windows! }, ctx);
  assert.equal(same, s);
  const raw = JSON.parse(JSON.stringify(s)) as State;
  raw.windows!.push({ spaceId: first });
  const back = hydrate(raw, ctx);
  assert.deepEqual(back.windows?.map((w) => w.spaceId), [first, second]);
});
