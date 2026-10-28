// A small ZIP reader: enough for extension packages (stored and deflated
// entries, no ZIP64, no encryption). Pure, so it can be tested without Electron.

import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  /** true for directory entries */
  dir: boolean;
  data: Uint8Array;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Every file in the archive, in central-directory order. Throws on a malformed archive. */
export function readZip(buf: Uint8Array): ZipEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (o: number) => view.getUint32(o, true);
  const u16 = (o: number) => view.getUint16(o, true);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (u32(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = u16(eocd + 10);
  let offset = u32(eocd + 16);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (u32(offset) !== CENTRAL) throw new Error('zip central directory is damaged');
    const method = u16(offset + 10);
    const compressed = u32(offset + 20);
    const uncompressed = u32(offset + 24);
    const nameLen = u16(offset + 28);
    const extraLen = u16(offset + 30);
    const commentLen = u16(offset + 32);
    const local = u32(offset + 42);
    const name = dec.decode(buf.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
    if (u32(local) !== LOCAL) throw new Error(`zip entry ${name} is damaged`);
    const dataStart = local + 30 + u16(local + 26) + u16(local + 28);
    const raw = buf.subarray(dataStart, dataStart + compressed);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw));
    else throw new Error(`zip entry ${name} uses unsupported compression ${method}`);
    if (data.length !== uncompressed) throw new Error(`zip entry ${name} has the wrong size`);
    out.push({ name, dir: name.endsWith('/'), data });
  }
  return out;
}

/** Reject names that would escape the extraction folder. */
export function safeZipName(name: string): boolean {
  if (!name || name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) return false;
  return !name.split(/[\\/]/).some((part) => part === '..');
}
