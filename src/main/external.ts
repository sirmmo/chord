import { BrowserWindow, dialog, shell, type WebContents } from 'electron';
import { externalScheme } from '../shared/url.ts';

const QUIET = new Set(['mailto:', 'tel:', 'sms:', 'facetime:']);
const allowed = new Map<string, boolean>();

/**
 * Hand a non-web link (magnet:, zoommtg:, …) to the application registered for
 * it, asking once per scheme and session except for the everyday ones.
 */
export async function openExternalLink(wc: WebContents | undefined, url: string): Promise<void> {
  const scheme = externalScheme(url);
  if (!scheme) return;
  let ok = QUIET.has(scheme) || allowed.get(scheme);
  if (ok === undefined) {
    const win = (wc && BrowserWindow.fromWebContents(wc)) ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const opts = {
      type: 'question' as const,
      buttons: ['Open', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Open this ${scheme.slice(0, -1)} link in another application?`,
      detail: url.length > 200 ? `${url.slice(0, 200)}…` : url,
      checkboxLabel: `Always open ${scheme} links until Chord quits`,
      checkboxChecked: false,
    };
    const { response, checkboxChecked } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    ok = response === 0;
    if (checkboxChecked) allowed.set(scheme, ok);
  }
  if (ok) await shell.openExternal(url).catch(() => {});
}
