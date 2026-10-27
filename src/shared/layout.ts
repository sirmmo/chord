// Pure layout math for the content area: where the web views go.

import { tilingRects, cellCount, type Tiling } from './tiling.ts';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutInput {
  width: number;
  height: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
  panes: number;
  fullscreen?: boolean;
  /** distance from the top of the window to the content; defaults to PAD */
  topInset?: number;
  /** how the panes share the content area; equal columns when absent or not matching */
  tiling?: Tiling | null;
  /** width of the side panel on the right, 0 when hidden */
  panelWidth?: number;
}

export const PAD = 8;
export const GAP = 6;
/** Windows and Linux draw the window controls in a strip this tall. */
export const TITLEBAR_STRIP = 36;
export const ADDRESS_BAR_HEIGHT = 44;

/** Distance from the top of the window to the page: window controls plus the address bar. */
export function topInsetFor(platform: string, addressBar: boolean): number {
  return (platform === 'darwin' ? PAD : TITLEBAR_STRIP) + (addressBar ? ADDRESS_BAR_HEIGHT : 0);
}

export function computeLayout(i: LayoutInput): { content: Rect; panes: Rect[]; panel: Rect | null } {
  if (i.fullscreen) {
    const full = { x: 0, y: 0, width: i.width, height: i.height };
    return { content: full, panes: [full], panel: null };
  }
  const panelW = Math.max(0, i.panelWidth ?? 0);
  const left = i.sidebarOpen ? i.sidebarWidth : PAD;
  const top = i.topInset ?? PAD;
  const content: Rect = {
    x: left,
    y: top,
    width: Math.max(0, i.width - left - PAD - (panelW ? panelW + GAP : 0)),
    height: Math.max(0, i.height - top - PAD),
  };
  const panel: Rect | null = panelW ? { x: content.x + content.width + GAP, y: top, width: panelW, height: content.height } : null;
  const n = Math.max(0, i.panes);
  if (n > 0 && i.tiling && cellCount(i.tiling) === n) return { content, panes: tilingRects(i.tiling, content, GAP), panel };
  const panes: Rect[] = [];
  if (n > 0) {
    const w = (content.width - GAP * (n - 1)) / n;
    for (let k = 0; k < n; k++) {
      const x = content.x + k * (w + GAP);
      panes.push({ x: Math.round(x), y: content.y, width: Math.round(w), height: content.height });
    }
  }
  return { content, panes, panel };
}
