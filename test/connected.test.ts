import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brokerProblem, docFromSpace, emptyDoc, joinLink, mergeDocs, newConnected, parseJoinLink, sameDoc, sanitizeDoc, seal, spaceSignature, unseal, DEFAULT_BROKER } from '../src/shared/connected.ts';
import { reduce, initialState, activeSpace, type Ctx } from '../src/shared/model.ts';
import type { Action, State } from '../src/shared/types.ts';

let n = 0;
const ctx = (now = 1_000): Ctx => ({ now, newId: () => `id${++n}` });
const run = (s: State, actions: Action[], c: Ctx = ctx()): State => actions.reduce((st, a) => reduce(st, a, c), s);
const fresh = () => {
  n = 0;
  return initialState(ctx());
};

test('brokers must be encrypted on the wire', () => {
  assert.equal(brokerProblem(DEFAULT_BROKER), null);
  assert.equal(brokerProblem('wss://broker.example.org:8884/mqtt'), null);
  assert.match(brokerProblem('mqtt://broker.hivemq.com:1883')!, /mqtts/);
  assert.match(brokerProblem('ws://localhost:9001')!, /mqtts/);
  assert.match(brokerProblem('http://x')!, /mqtts/);
  assert.equal(brokerProblem('not a url'), 'not a URL');
});

test('join links carry id, key and broker and parse back', () => {
  const c = newConnected('mqtts://b.example:8883', 5);
  assert.match(c.id, /^[0-9a-f]{24}$/);
  assert.match(c.key, /^[\w-]{43}$/);
  const link = joinLink(c);
  assert.ok(link.startsWith('chord://join/?'));
  const back = parseJoinLink(link, 9);
  assert.deepEqual(back, { ...c, since: 9 });
  assert.equal(parseJoinLink('chord://join/?id=zzz&k=short'), null, 'malformed links are rejected');
  assert.equal(parseJoinLink(`chord://join/?id=${c.id}&k=${c.key}&b=mqtt://plain:1883`), null, 'plain brokers are rejected');
  assert.equal(parseJoinLink(`chord://join/?id=${c.id}&k=${c.key}`)?.broker, DEFAULT_BROKER, 'the default broker when none is given');
});

test('sealing round-trips and rejects the wrong key or tampering', async () => {
  const a = newConnected(DEFAULT_BROKER, 1);
  const b = newConnected(DEFAULT_BROKER, 1);
  const bytes = (await seal(a.key, { hello: 'world', n: 1 }))!;
  assert.ok(bytes.length > 12);
  assert.deepEqual(await unseal(a.key, bytes), { hello: 'world', n: 1 });
  assert.equal(await unseal(b.key, bytes), null);
  const broken = new Uint8Array(bytes);
  broken[broken.length - 1] ^= 1;
  assert.equal(await unseal(a.key, broken), null);
  assert.equal(await seal('bad-key', {}), null);
});

test('a document follows the space: adds keep their time, removals become tombstones, metadata is last-writer-wins', () => {
  let s = run(fresh(), [{ type: 'tab.new', url: 'https://a.test/' }, { type: 'tab.pin', id: 'id2' }, { type: 'tab.new', url: 'https://b.test/' }, { type: 'tab.pin', id: 'id3' }]);
  const sp = activeSpace(s);
  const d1 = docFromSpace(s, sp, undefined, 100, 'me');
  assert.deepEqual(d1.tabs.map((t) => [t.url, t.at]), [['https://a.test/', 100], ['https://b.test/', 100]]);
  assert.equal(d1.metaAt, 100);
  s = reduce(s, { type: 'space.update', id: sp.id, patch: { name: 'Team' } }, ctx(150));
  const d2 = docFromSpace(s, activeSpace(s), d1, 200, 'me');
  assert.equal(d2.name, 'Team');
  assert.equal(d2.metaAt, 200);
  assert.deepEqual(d2.tabs.map((t) => t.at), [100, 100], 'existing tabs keep their add time');
  // close pinned tab b twice (sleep, then remove) → tombstone
  s = run(s, [{ type: 'tab.close', id: 'id3' }, { type: 'tab.close', id: 'id3' }], ctx(250));
  const d3 = docFromSpace(s, activeSpace(s), d2, 300, 'me');
  assert.deepEqual(d3.tabs.map((t) => t.url), ['https://a.test/']);
  assert.equal(d3.removed['https://b.test/'], 300);
  assert.equal(d3.metaAt, 200, 'metadata unchanged keeps its time');
  assert.ok(sameDoc(d3, docFromSpace(s, activeSpace(s), d3, 400, 'me')), 'no change, same document');
});

test('merging keeps concurrent adds and honours the newest remove', () => {
  const base = { ...emptyDoc('S'), metaAt: 1, at: 1 };
  const a = { ...base, tabs: [{ url: 'https://x.test/', title: 'x', at: 10 }], removed: { 'https://old.test/': 12 }, at: 10, by: 'a' };
  const b = { ...base, name: 'S renamed', metaAt: 11, tabs: [{ url: 'https://y.test/', title: 'y', at: 11 }, { url: 'https://old.test/', title: 'old', at: 5 }], at: 11, by: 'b' };
  const m = mergeDocs(a, b, 20);
  assert.deepEqual(m.tabs.map((t) => t.url), ['https://y.test/', 'https://x.test/'], 'both adds survive, newer document first');
  assert.equal(m.removed['https://old.test/'], 12, 'removed after it was added → stays removed');
  assert.equal(m.name, 'S renamed');
  assert.ok(sameDoc(mergeDocs(b, a, 20), m), 'merge is commutative');
  assert.ok(sameDoc(mergeDocs(m, a, 21), m), 'merge is idempotent');
  // re-adding after a removal wins when it is newer
  const c = { ...base, tabs: [{ url: 'https://old.test/', title: 'old again', at: 30 }], at: 30, by: 'c' };
  const m2 = mergeDocs(m, c, 31);
  assert.ok(m2.tabs.some((t) => t.url === 'https://old.test/'));
  assert.equal(m2.removed['https://old.test/'], undefined);
});

test('sanitizeDoc drops junk from the wire', () => {
  const d = sanitizeDoc({ v: 1, name: 'N', metaAt: 1, color: 'red', tabs: [{ url: 'javascript:alert(1)', title: 't', at: 1 }, { url: 'https://ok.test/', title: 'ok', at: 2, group: 'G' }, { url: 'https://ok.test/', title: 'dup', at: 3 }], removed: { 'https://z.test/': 4, bad: 'x' as unknown as number }, at: 5, by: 'someone' });
  assert.deepEqual(d.tabs.map((t) => t.url), ['https://ok.test/']);
  assert.equal(d.tabs[0].group, 'G');
  assert.equal(d.color, undefined);
  assert.deepEqual(d.removed, { 'https://z.test/': 4 });
});

test('connect, join and sync: the space takes the shape of the document', () => {
  let s = run(fresh(), [{ type: 'tab.new', url: 'https://a.test/' }, { type: 'tab.pin', id: 'id2' }]);
  const sp = activeSpace(s);
  const connected = newConnected(DEFAULT_BROKER, 1);
  s = reduce(s, { type: 'space.connect', id: sp.id, connected }, ctx());
  assert.deepEqual(activeSpace(s).connected, connected);
  const sig1 = spaceSignature(s, activeSpace(s));
  const doc = { ...emptyDoc('From afar'), icon: '🛰️', metaAt: 50, tabs: [{ url: 'https://b.test/', title: 'B', at: 20, group: 'Docs' }, { url: 'https://a.test/', title: 'A', at: 10, name: 'Alpha' }], at: 50, by: 'peer' };
  s = reduce(s, { type: 'space.connectedSync', id: sp.id, doc }, ctx(60));
  const after = activeSpace(s);
  assert.equal(after.name, 'From afar');
  assert.equal(after.icon, '🛰️');
  assert.deepEqual(after.pinned.map((id) => s.tabs[id].url), ['https://b.test/', 'https://a.test/'], 'order of the document, existing tab reused');
  assert.equal(after.pinned[1], 'id2');
  assert.equal(s.tabs.id2.name, 'Alpha');
  assert.equal(after.groups?.length, 1);
  assert.equal(s.tabs[after.pinned[0]].groupId, after.groups![0].id);
  assert.notEqual(spaceSignature(s, after), sig1);
  // a removal: the tab open on screen survives as a today tab, the other goes away
  s = reduce(s, { type: 'tab.activate', id: 'id2' }, ctx(70));
  const doc2 = { ...doc, tabs: [], removed: { 'https://a.test/': 80, 'https://b.test/': 80 }, at: 80 };
  s = reduce(s, { type: 'space.connectedSync', id: sp.id, doc: doc2 }, ctx(90));
  assert.deepEqual(activeSpace(s).pinned, []);
  assert.equal(s.tabs.id2.kind, 'today');
  assert.ok(activeSpace(s).today.includes('id2'));
  assert.equal(activeSpace(s).groups, undefined, 'empty groups are dropped');
  // joining creates a space; joining the same id again only activates it
  s = reduce(s, { type: 'space.join', connected: newConnected(DEFAULT_BROKER, 2) }, ctx());
  assert.equal(s.spaces.length, 2);
  assert.equal(activeSpace(s).name, 'Connected space');
  const joined = activeSpace(s).connected!;
  s = run(s, [{ type: 'space.activate', id: sp.id }, { type: 'space.join', connected: joined }]);
  assert.equal(s.spaces.length, 2);
  assert.equal(s.activeSpaceId, s.spaces[1].id);
  s = reduce(s, { type: 'space.disconnect', id: sp.id }, ctx());
  assert.equal(s.spaces[0].connected, undefined);
});

test('mqtt settings only accept encrypted brokers', () => {
  let s = fresh();
  assert.equal(s.settings.mqtt.broker, DEFAULT_BROKER);
  s = reduce(s, { type: 'settings.update', patch: { mqtt: { broker: 'mqtt://plain.example:1883', username: 'u' } } }, ctx());
  assert.equal(s.settings.mqtt.broker, DEFAULT_BROKER, 'a plain broker falls back to the default');
  assert.equal(s.settings.mqtt.username, 'u');
  s = reduce(s, { type: 'settings.update', patch: { mqtt: { broker: 'wss://my.example/mqtt' } } }, ctx());
  assert.equal(s.settings.mqtt.broker, 'wss://my.example/mqtt');
});
