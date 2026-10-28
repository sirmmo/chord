import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readZip, safeZipName } from '../src/shared/zip.ts';
import { crxToZip, extensionIdFrom, localizedName, isWebStorePage } from '../src/shared/crx.ts';

/** A minimal zip writer for the tests: stored or deflated entries, no extras. */
function makeZip(files: Record<string, string>, deflate = false): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const stored = deflate ? deflateRawSync(data) : data;
    const nameB = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    parts.push(local, nameB, stored);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(stored.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameB.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameB);
    offset += local.length + nameB.length + stored.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, eocd]));
}

test('readZip reads stored and deflated entries', () => {
  const files = { 'manifest.json': '{"name":"x"}', 'dir/': '', 'dir/a.js': 'console.log(1)'.repeat(20) };
  for (const deflate of [false, true]) {
    const entries = readZip(makeZip(files, deflate));
    assert.deepEqual(entries.map((e) => e.name), Object.keys(files));
    assert.equal(new TextDecoder().decode(entries[2].data), files['dir/a.js']);
    assert.equal(entries[1].dir, true);
  }
});

test('readZip rejects junk', () => {
  assert.throws(() => readZip(new Uint8Array(100)), /not a zip/);
});

test('safeZipName keeps names inside the folder', () => {
  assert.equal(safeZipName('a/b.js'), true);
  assert.equal(safeZipName('../x'), false);
  assert.equal(safeZipName('/etc/passwd'), false);
  assert.equal(safeZipName('C:\\x'), false);
});

test('crxToZip strips a CRX3 header', () => {
  const zip = makeZip({ 'manifest.json': '{}' });
  const header = Buffer.from([1, 2, 3, 4, 5]);
  const crx = Buffer.alloc(12);
  crx.write('Cr24', 0);
  crx.writeUInt32LE(3, 4);
  crx.writeUInt32LE(header.length, 8);
  const out = crxToZip(new Uint8Array(Buffer.concat([crx, header, Buffer.from(zip)])));
  assert.equal(readZip(out)[0].name, 'manifest.json');
  assert.throws(() => crxToZip(new Uint8Array(Buffer.from('hello world, not a crx'))), /not a Chrome extension/);
});

test('extensionIdFrom reads store addresses and ids', () => {
  const id = 'cjpalhdlnbpafiamejdnhcphjbkeiagm';
  assert.equal(extensionIdFrom(id), id);
  assert.equal(extensionIdFrom(`https://chromewebstore.google.com/detail/ublock-origin/${id}?hl=en`), id);
  assert.equal(extensionIdFrom(`https://chrome.google.com/webstore/detail/ublock-origin/${id}`), id);
  assert.equal(extensionIdFrom(`https://chromewebstore.google.com/detail/${id}`), id);
  assert.equal(extensionIdFrom('https://example.com/'), null);
  assert.equal(isWebStorePage(`https://chromewebstore.google.com/detail/x/${id}`), true);
  assert.equal(isWebStorePage('https://chromewebstore.google.com/'), false);
});

test('localizedName resolves __MSG__ placeholders', () => {
  assert.equal(localizedName('__MSG_appName__', { appName: { message: 'uBlock' } }), 'uBlock');
  assert.equal(localizedName('__MSG_extName__', { extname: { message: 'Lower' } }), 'Lower');
  assert.equal(localizedName('Plain', null), 'Plain');
  assert.equal(localizedName('__MSG_missing__', {}), undefined);
});
