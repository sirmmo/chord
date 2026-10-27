// Space modes: composable capabilities a space can switch on. Each mode has a
// view in the side panel on the right of the content area.

import type { ModeId } from './types.ts';

export const MODES: { id: ModeId; name: string; description: string }[] = [
  { id: 'research', name: 'Research', description: 'Keep notes, clip passages and sources, save pages to Zotero.' },
  { id: 'ai', name: 'AI', description: 'Chat with a local or remote model that can read and act on the tabs of this space.' },
];

export const MODE_IDS = new Set<string>(MODES.map((m) => m.id));

export function isModeId(v: unknown): v is ModeId {
  return typeof v === 'string' && MODE_IDS.has(v);
}

export const PANEL_MIN = 280;
export const PANEL_MAX = 640;

export function clampPanel(w: number): number {
  return Math.round(Math.max(PANEL_MIN, Math.min(PANEL_MAX, w)));
}
