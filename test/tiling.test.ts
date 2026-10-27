import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellCount, defaultTiling, formatTiling, parseTiling, presetsFor, resizeColumn, resizeRow, tilingRects } from '../src/shared/tiling.ts';
import { computeLayout } from '../src/shared/layout.ts';

test('tiling specs parse, normalise and round-trip', () => {
  const t = parseTiling('50/50 | 100')!;
  assert.equal(cellCount(t), 3);
  assert.deepEqual(t.rows.map((r) => r.height), [0.5, 0.5]);
  assert.deepEqual(t.rows[0].cols, [0.5, 0.5]);
  assert.equal(formatTiling(t), '50/50 | 100');
  const weighted = parseTiling('2:1/1 | 1:1')!;
  assert.deepEqual(weighted.rows.map((r) => Math.round(r.height * 100)), [67, 33]);
  assert.equal(formatTiling(weighted), '67:50/50 | 33:100');
  assert.equal(parseTiling(''), null);
  assert.equal(parseTiling('50/x'), null);
  assert.equal(parseTiling('0:50/50'), null);
  assert.equal(parseTiling('25/25/25/25 | 100'), null, 'more than four panes');
});

test('tiling rects fill the content area with gaps', () => {
  const rects = tilingRects(parseTiling('50/50 | 100')!, { x: 0, y: 0, width: 206, height: 106 }, 6);
  assert.deepEqual(rects, [
    { x: 0, y: 0, width: 100, height: 50 },
    { x: 106, y: 0, width: 100, height: 50 },
    { x: 0, y: 56, width: 206, height: 50 },
  ]);
});

test('computeLayout uses the tiling only when the pane count matches', () => {
  const base = { width: 1000, height: 600, sidebarOpen: false, sidebarWidth: 0, topInset: 8 };
  const tiled = computeLayout({ ...base, panes: 3, tiling: parseTiling('50/50 | 100') });
  assert.equal(tiled.panes.length, 3);
  assert.equal(tiled.panes[2].width, tiled.content.width, 'bottom pane spans the row');
  const mismatch = computeLayout({ ...base, panes: 2, tiling: parseTiling('50/50 | 100') });
  assert.equal(mismatch.panes[0].height, mismatch.content.height, 'falls back to equal columns');
  assert.equal(mismatch.panes.length, 2);
});

test('presets and resizing', () => {
  assert.ok(presetsFor(3).every((p) => cellCount(parseTiling(p.spec)!) === 3));
  assert.ok(presetsFor(2, [{ name: 'mine', spec: '80/20' }]).some((p) => p.name === 'mine'));
  const t = defaultTiling(2);
  const resized = resizeColumn(t, 0, 0, 0.7);
  assert.deepEqual(resized.rows[0].cols.map((c) => Math.round(c * 100)), [70, 30]);
  assert.deepEqual(resizeColumn(t, 0, 0, 0.01).rows[0].cols.map((c) => Math.round(c * 100)), [10, 90], 'clamped');
  const rows = resizeRow(parseTiling('100 | 100')!, 0, 0.25);
  assert.deepEqual(rows.rows.map((r) => r.height), [0.25, 0.75]);
});

test('a side panel takes its width from the content area', () => {
  const base = { width: 1000, height: 600, sidebarOpen: false, sidebarWidth: 0, topInset: 8, panes: 1 };
  const without = computeLayout(base);
  const withPanel = computeLayout({ ...base, panelWidth: 300 });
  assert.equal(without.panel, null);
  assert.ok(withPanel.panel);
  assert.equal(withPanel.panel!.width, 300);
  assert.equal(withPanel.content.width, without.content.width - 300 - 6);
  assert.equal(withPanel.panel!.x + withPanel.panel!.width, 1000 - 8, 'panel ends at the right padding');
});
