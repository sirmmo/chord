// chord://guide — the Getting Started page. Renders shortcuts for the platform Chord runs on.

import type { State } from '../shared/types.ts';
import { activeSpace } from '../shared/model.ts';
import { applyTheme } from './theme.ts';

const api = window.chord;
const NAMES: Record<string, string> = { mac: 'macOS', win: 'Windows', linux: 'Linux' };

/** Keys are written as Cmd+Shift+T in the markup; the Mac gets symbols, others get Ctrl/Alt words. */
function renderKeys(isMac: boolean): void {
  const map: Record<string, string> = isMac
    ? { Cmd: '⌘', Alt: '⌥', Shift: '⇧', Ctrl: '⌃', Left: '←', Right: '→', Enter: '↩' }
    : { Cmd: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Ctrl: 'Ctrl', Left: '←', Right: '→', Enter: 'Enter' };
  for (const k of Array.from(document.querySelectorAll('kbd'))) {
    const original = k.dataset.keys ?? k.textContent ?? '';
    k.dataset.keys = original;
    const parts = original.split('+');
    if (parts.length === 1 && parts[0] !== 'Enter') continue;
    if (!isMac && k.classList.contains('space-jump')) parts[0] = 'Alt';
    const out = parts.map((p) => map[p] ?? p);
    k.textContent = isMac ? out.join('') : out.join('+');
  }
}

function show(os: string): void {
  document.body.className = os;
  for (const e of Array.from(document.querySelectorAll('.os-name'))) e.textContent = NAMES[os] ?? os;
  renderKeys(os === 'mac');
}

for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('.other-os button'))) b.onclick = () => show(b.dataset.os ?? 'linux');
show(api.platform === 'darwin' ? 'mac' : api.platform === 'win32' ? 'win' : 'linux');

api.onState((s: State) => applyTheme(s.settings.theme, activeSpace(s)));
api.getState().then((s) => s && applyTheme(s.settings.theme, activeSpace(s)));
