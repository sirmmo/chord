import { net, protocol, type Session } from 'electron';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RENDERER_DIR } from './paths.ts';

/** Internal pages served as chord://<page>/ from the renderer bundle. */
export const INTERNAL_PAGES = new Set(['downloads', 'settings', 'history', 'panel', 'guide']);

/** Must run before app.whenReady(). */
export function registerInternalScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'chord', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

export function serveInternalPages(ses: Session): void {
  ses.protocol.handle('chord', (request) => {
    const url = new URL(request.url);
    const page = url.hostname;
    if (!INTERNAL_PAGES.has(page)) return new Response('Not found', { status: 404 });
    const file = url.pathname === '' || url.pathname === '/' ? `${page}.html` : url.pathname.slice(1);
    const abs = resolve(RENDERER_DIR, file);
    if (!abs.startsWith(RENDERER_DIR + sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(abs).href);
  });
}
