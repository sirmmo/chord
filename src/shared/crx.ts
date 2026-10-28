// Chrome Web Store packages: the extension id in a store address, the CRX3
// container (a signed header in front of a zip), and manifest names.

const ID = /^[a-p]{32}$/;

/** The 32-letter id from a Web Store address, a "chrome-extension://" address or the id itself. */
export function extensionIdFrom(input: string): string | null {
  const s = input.trim();
  if (ID.test(s)) return s;
  const m = /(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)\/(?:detail\/)?(?:[^/]+\/)?([a-p]{32})\b/i.exec(s) ?? /chrome-extension:\/\/([a-p]{32})/i.exec(s);
  return m ? m[1].toLowerCase() : null;
}

/** Is this a page of the Web Store that describes one extension? */
export function isWebStorePage(url: string): boolean {
  return /^https:\/\/(chromewebstore\.google\.com\/detail\/|chrome\.google\.com\/webstore\/detail\/)/i.test(url);
}

/** Where Chrome itself fetches an extension's current package. */
export function crxDownloadUrl(id: string, chromeVersion: string): string {
  return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${encodeURIComponent(chromeVersion)}&acceptformat=crx2,crx3&x=${encodeURIComponent(`id=${id}&uc`)}`;
}

/** The zip inside a CRX2 or CRX3 package. Throws when the magic number is missing. */
export function crxToZip(buf: Uint8Array): Uint8Array {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 16 || buf[0] !== 0x43 || buf[1] !== 0x72 || buf[2] !== 0x32 || buf[3] !== 0x34) {
    // not "Cr24": maybe already a zip
    if (buf.length > 4 && view.getUint32(0, true) === 0x04034b50) return buf;
    throw new Error('not a Chrome extension package');
  }
  const version = view.getUint32(4, true);
  if (version === 2) {
    const keyLen = view.getUint32(8, true);
    const sigLen = view.getUint32(12, true);
    return buf.subarray(16 + keyLen + sigLen);
  }
  if (version === 3) {
    const headerLen = view.getUint32(8, true);
    return buf.subarray(12 + headerLen);
  }
  throw new Error(`unknown CRX version ${version}`);
}

/** Resolve a manifest string that may be "__MSG_key__" using the extension's messages. */
export function localizedName(value: unknown, messages: Record<string, { message?: string }> | null): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const m = /^__MSG_(.+)__$/.exec(value);
  if (!m) return value;
  const key = m[1];
  const hit = messages?.[key] ?? messages?.[key.toLowerCase()] ?? Object.entries(messages ?? {}).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];
  return hit?.message || undefined;
}
