import { deflateSync } from 'node:zlib';
import { nativeImage } from 'electron';

// A tiny PNG encoder so the tray icon needs no asset files: three rising bars.

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const body = new Uint8Array(type.length + data.length);
  body.set(new TextEncoder().encode(type));
  body.set(data, type.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  return new Uint8Array([...len, ...body, ...crc]);
}

function png(size: number, rgba: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = new Uint8Array((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = rgba(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size);
  v.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]);
}

/** Three bars, like a chord on a staff. `color` is used on Windows and Linux; macOS gets a template image. */
export function trayIcon(template: boolean): Electron.NativeImage {
  const draw = (size: number) => {
    const s = size / 16;
    const bars: [number, number, number, number][] = [
      [2, 9, 5, 14],
      [6, 5, 9, 14],
      [10, 2, 13, 14],
    ];
    return png(size, (x, y) => {
      const px = x / s;
      const py = y / s;
      const inside = bars.some(([x0, y0, x1, y1]) => px >= x0 && px < x1 && py >= y0 && py < y1);
      if (!inside) return [0, 0, 0, 0];
      return template ? [0, 0, 0, 255] : [200, 204, 214, 255];
    });
  };
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, buffer: draw(16) });
  img.addRepresentation({ scaleFactor: 2, buffer: draw(32) });
  if (template) img.setTemplateImage(true);
  return img;
}
