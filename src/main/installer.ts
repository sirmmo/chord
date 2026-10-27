import { dialog, net } from 'electron';
import { parseSpaceManifest } from '../shared/installer.ts';
import { hostOf } from '../shared/url.ts';
import type { Controller } from './controller.ts';

const MAX_BYTES = 1_000_000;

/** Fetch a space manifest, show what it contains, install on confirmation. */
export async function installSpace(c: Controller, manifestUrl: string): Promise<void> {
  const win = c.win;
  if (!win || !/^https:\/\//i.test(manifestUrl)) return;
  const sourceHost = hostOf(manifestUrl);
  let text: string;
  try {
    const res = await net.fetch(manifestUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error('manifest larger than 1 MB');
    text = new TextDecoder().decode(buf);
  } catch (err) {
    dialog.showErrorBox('Could not install space', `${manifestUrl}\n${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const parsed = parseSpaceManifest(text, sourceHost);
  if (!parsed.ok) {
    dialog.showErrorBox('Could not install space', `${manifestUrl}: ${parsed.error}.`);
    return;
  }
  const { config, boosts, name } = parsed;
  const tabs = config.spaces.reduce((n, sp) => n + sp.pinned.length + sp.today.length, 0);
  const existing = c.state.spaces.find((sp) => sp.name.toLowerCase() === name.toLowerCase());
  const lines = [
    `${config.spaces.length === 1 ? `Space “${name}”` : `${config.spaces.length} spaces`} with ${tabs} tab${tabs === 1 ? '' : 's'}${config.favorites.length ? ` and ${config.favorites.length} favorites` : ''}.`,
    existing ? `You already have a space named “${existing.name}”: missing tabs will be added to it.` : '',
    boosts.length ? `Includes ${boosts.length} boost${boosts.length === 1 ? '' : 's'} (CSS/JavaScript that runs on ${sourceHost} pages): ${boosts.map((b) => b.name).join(', ')}.` : '',
    'Only sites you trust should install spaces.',
  ].filter(Boolean);
  const buttons = boosts.length ? ['Install', 'Install without Boosts', 'Cancel'] : ['Install', 'Cancel'];
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    message: `Install from ${sourceHost}?`,
    detail: lines.join('\n\n'),
  });
  if (response === buttons.length - 1) return;
  c.apply({ type: 'config.import', config, mode: 'merge' });
  if (boosts.length && response === 0) {
    const current = c.state.settings.boosts;
    const fresh = boosts.filter((b) => !current.some((x) => x.sites === b.sites && x.css === b.css && x.js === b.js));
    if (fresh.length) c.apply({ type: 'settings.update', patch: { boosts: [...current, ...fresh] } });
  }
  const installed = c.state.spaces.find((sp) => sp.name.toLowerCase() === name.toLowerCase());
  if (installed) c.apply({ type: 'space.activate', id: installed.id });
}
