import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportKdbx, importKdbx } from '../src/main/keepass.ts';

test('a KeePass file round-trips and refuses the wrong master password', async () => {
  const entries = [
    { host: 'example.com', username: 'ann', password: 'p@ss "quoted" <xml>', updatedAt: Date.UTC(2026, 9, 1) },
    { host: 'mail.test', username: '', password: 'nouser', updatedAt: Date.UTC(2026, 9, 2) },
  ];
  const file = await exportKdbx(entries, 'master-password');
  assert.ok(file.length > 500);
  assert.equal(file.readUInt32LE(0), 0x9aa2d903, 'KDBX signature');
  const back = await importKdbx(file, 'master-password');
  assert.deepEqual(back.map((e) => [e.host, e.username, e.password]), entries.map((e) => [e.host, e.username, e.password]));
  assert.equal(back[0].updatedAt, entries[0].updatedAt);
  await assert.rejects(importKdbx(file, 'wrong'));
});
