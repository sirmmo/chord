// Pure layout math for the content area: where the web views go.

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
}

export const PAD = 8;
export const GAP = 6;

export function computeLayout(i: LayoutInput): { content: Rect; panes: Rect[] } {
  if (i.fullscreen) {
    const full = { x: 0, y: 0, width: i.width, height: i.height };
    return { content: full, panes: [full] };
  }
  const left = i.sidebarOpen ? i.sidebarWidth : PAD;
  const content: Rect = {
    x: left,
    y: PAD,
    width: Math.max(0, i.width - left - PAD),
    height: Math.max(0, i.height - PAD * 2),
  };
  const n = Math.max(0, i.panes);
  const panes: Rect[] = [];
  if (n > 0) {
    const w = (content.width - GAP * (n - 1)) / n;
    for (let k = 0; k < n; k++) {
      const x = content.x + k * (w + GAP);
      panes.push({ x: Math.round(x), y: content.y, width: Math.round(w), height: content.height });
    }
  }
  return { content, panes };
}
