// Split-view tilings: how the panes of a space share the content area.
//
// A tiling is rows of columns. The text form is what users type and what is
// stored: rows separated by "|", columns by "/", numbers are weights, and a row
// may carry its own weight before a colon:
//   "50/50"            two columns
//   "50/50 | 100"      two panes on top, one across the bottom
//   "2:50/50 | 1:100"  same, with the top row twice as tall
//   "70/30"            a wide pane and a narrow one

import type { Rect } from './layout.ts';

export interface TilingRow {
  height: number;
  cols: number[];
}
export interface Tiling {
  rows: TilingRow[];
}

const MAX_CELLS = 4;

function normalise(weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  return sum > 0 ? weights.map((w) => w / sum) : weights.map(() => 1 / weights.length);
}

export function parseTiling(spec: string): Tiling | null {
  const rows: TilingRow[] = [];
  for (const rawRow of spec.split('|')) {
    const text = rawRow.trim();
    if (!text) return null;
    let height = 1;
    let colsText = text;
    const colon = text.indexOf(':');
    if (colon >= 0) {
      height = Number(text.slice(0, colon).trim());
      colsText = text.slice(colon + 1);
      if (!Number.isFinite(height) || height <= 0) return null;
    }
    const cols = colsText.split('/').map((c) => Number(c.trim()));
    if (cols.length === 0 || cols.some((c) => !Number.isFinite(c) || c <= 0)) return null;
    rows.push({ height, cols: normalise(cols) });
  }
  if (rows.length === 0) return null;
  const heights = normalise(rows.map((r) => r.height));
  rows.forEach((r, i) => (r.height = heights[i]));
  const t = { rows };
  return cellCount(t) > MAX_CELLS ? null : t;
}

export function formatTiling(t: Tiling): string {
  const pct = (v: number) => String(Math.round(v * 100));
  const equalRows = t.rows.every((r) => Math.abs(r.height - 1 / t.rows.length) < 0.005);
  return t.rows.map((r) => `${equalRows ? '' : `${pct(r.height)}:`}${r.cols.map(pct).join('/')}`).join(' | ');
}

export function cellCount(t: Tiling): number {
  return t.rows.reduce((n, r) => n + r.cols.length, 0);
}

/** n equal columns: what split view does when no tiling is chosen. */
export function defaultTiling(n: number): Tiling {
  return { rows: [{ height: 1, cols: Array.from({ length: Math.max(1, n) }, () => 1 / Math.max(1, n)) }] };
}

/** Cells in reading order, laid out inside `content` with `gap` between them. */
export function tilingRects(t: Tiling, content: Rect, gap: number): Rect[] {
  const out: Rect[] = [];
  const rowsH = content.height - gap * (t.rows.length - 1);
  let y = content.y;
  for (const row of t.rows) {
    const h = rowsH * row.height;
    const colsW = content.width - gap * (row.cols.length - 1);
    let x = content.x;
    for (const c of row.cols) {
      const w = colsW * c;
      out.push({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
      x += w + gap;
    }
    y += h + gap;
  }
  return out;
}

export interface TilingPreset {
  name: string;
  spec: string;
}

/** Built-in layouts, by pane count. */
export const TILING_PRESETS: TilingPreset[] = [
  { name: 'Side by side', spec: '50/50' },
  { name: 'Wide and narrow', spec: '67/33' },
  { name: 'Narrow and wide', spec: '33/67' },
  { name: 'Stacked', spec: '100 | 100' },
  { name: 'Three columns', spec: '33/33/33' },
  { name: 'Two on top, one below', spec: '50/50 | 100' },
  { name: 'One on top, two below', spec: '100 | 50/50' },
  { name: 'Main and two stacked', spec: '67/33 | 67/33' },
  { name: 'Grid', spec: '50/50 | 50/50' },
  { name: 'Four columns', spec: '25/25/25/25' },
  { name: 'One on top, three below', spec: '100 | 33/33/33' },
  { name: 'Three on top, one below', spec: '33/33/33 | 100' },
];

export function presetsFor(panes: number, custom: TilingPreset[] = []): TilingPreset[] {
  return [...TILING_PRESETS, ...custom].filter((p) => {
    const t = parseTiling(p.spec);
    return t !== null && cellCount(t) === panes;
  });
}

/** Move the boundary after column `col` of row `row` so it sits at fraction `at` (0–1) of the row's width. */
export function resizeColumn(t: Tiling, row: number, col: number, at: number): Tiling {
  const r = t.rows[row];
  if (!r || col < 0 || col >= r.cols.length - 1) return t;
  const before = r.cols.slice(0, col).reduce((a, b) => a + b, 0);
  const pair = r.cols[col] + r.cols[col + 1];
  const left = Math.min(pair - 0.1, Math.max(0.1, at - before));
  const cols = [...r.cols];
  cols[col] = left;
  cols[col + 1] = pair - left;
  return { rows: t.rows.map((x, i) => (i === row ? { ...x, cols } : x)) };
}

/** Move the boundary after row `row` so it sits at fraction `at` (0–1) of the content height. */
export function resizeRow(t: Tiling, row: number, at: number): Tiling {
  if (row < 0 || row >= t.rows.length - 1) return t;
  const before = t.rows.slice(0, row).reduce((a, r) => a + r.height, 0);
  const pair = t.rows[row].height + t.rows[row + 1].height;
  const top = Math.min(pair - 0.1, Math.max(0.1, at - before));
  return {
    rows: t.rows.map((r, i) => (i === row ? { ...r, height: top } : i === row + 1 ? { ...r, height: pair - top } : r)),
  };
}
