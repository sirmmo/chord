import { net, protocol, type Session } from 'electron';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EASEL_IMAGES_DIR, RENDERER_DIR } from './paths.ts';

/** Internal pages served as chord://<page>/ from the renderer bundle. */
export const INTERNAL_PAGES = new Set(['downloads', 'settings', 'history', 'panel', 'guide', 'bookmarks', 'reader', 'little', 'notes', 'easel', 'peek']);

/** Must run before app.whenReady(). */
export function registerInternalScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'chord', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

export function serveInternalPages(ses: Session): void {
  ses.protocol.handle('chord', (request) => {
    const url = new URL(request.url);
    const page = url.hostname;
    if (!INTERNAL_PAGES.has(page)) return new Response('Not found', { status: 404 });
    if (page === 'easel' && url.pathname.startsWith('/images/')) {
      const img = resolve(EASEL_IMAGES_DIR, url.pathname.slice(8));
      if (!img.startsWith(EASEL_IMAGES_DIR + sep)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(img).href);
    }
    const file = url.pathname === '' || url.pathname === '/' ? `${page}.html` : url.pathname.slice(1);
    const abs = resolve(RENDERER_DIR, file);
    if (!abs.startsWith(RENDERER_DIR + sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(abs).href);
  });
}
