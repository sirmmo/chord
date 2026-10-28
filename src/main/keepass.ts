import * as kdbxwebNs from 'kdbxweb';
import { argon2d, argon2id } from 'hash-wasm';

// kdbxweb ships one UMD bundle: Node's ESM loader may expose it only as `default`.
const kdbxweb = ((kdbxwebNs as unknown as { default?: typeof kdbxwebNs }).default?.Kdbx ? (kdbxwebNs as unknown as { default: typeof kdbxwebNs }).default : kdbxwebNs) as typeof kdbxwebNs;

/**
 * Passwords as a KeePass file (KDBX 4, Argon2 and ChaCha20/AES): what the
 * private sync repository holds, and what KeePassXC and friends can open.
 */

kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
  const fn = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
  const out = await fn({ password: new Uint8Array(password), salt: new Uint8Array(salt), memorySize: memory, iterations, parallelism, hashLength: length, outputType: 'binary' });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
});

export interface KeePassEntry {
  host: string;
  username: string;
  password: string;
  updatedAt: number;
}

const GROUP = 'Chord';

export async function exportKdbx(entries: KeePassEntry[], masterPassword: string): Promise<Buffer> {
  const credentials = new kdbxweb.KdbxCredentials(kdbxweb.ProtectedValue.fromString(masterPassword));
  const db = kdbxweb.Kdbx.create(credentials, 'Chord passwords');
  const group = db.createGroup(db.getDefaultGroup(), GROUP);
  for (const e of entries) {
    const entry = db.createEntry(group);
    entry.fields.set('Title', e.host);
    entry.fields.set('UserName', e.username);
    entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(e.password));
    entry.fields.set('URL', `https://${e.host}/`);
    entry.fields.set('Notes', 'Saved by Chord');
    entry.times.lastModTime = new Date(e.updatedAt);
    entry.times.creationTime = new Date(e.updatedAt);
  }
  const data = await db.save();
  return Buffer.from(data);
}

export async function importKdbx(file: Buffer, masterPassword: string): Promise<KeePassEntry[]> {
  const credentials = new kdbxweb.KdbxCredentials(kdbxweb.ProtectedValue.fromString(masterPassword));
  const ab = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  const db = await kdbxweb.Kdbx.load(ab, credentials);
  const out: KeePassEntry[] = [];
  const text = (v: kdbxweb.KdbxEntryField | undefined): string => (v === undefined ? '' : typeof v === 'string' ? v : v.getText());
  const walk = (g: kdbxweb.KdbxGroup) => {
    for (const e of g.entries) {
      const url = text(e.fields.get('URL'));
      let host = '';
      try {
        host = url ? new URL(url).host : '';
      } catch {
        host = '';
      }
      host = host || text(e.fields.get('Title'));
      const password = text(e.fields.get('Password'));
      if (!host || !password) continue;
      out.push({ host: host.toLowerCase(), username: text(e.fields.get('UserName')), password, updatedAt: e.times.lastModTime?.getTime() ?? 0 });
    }
    for (const sub of g.groups) walk(sub);
  };
  walk(db.getDefaultGroup());
  return out;
}
