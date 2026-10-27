// Applies the appearance settings to a chrome page (sidebar or overlay).

import type { Space, Theme } from '../shared/types.ts';

export const FONTS: Record<Theme['font'], string> = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  serif: 'ui-serif, "New York", Georgia, "Times New Roman", serif',
};

export function applyTheme(theme: Theme, space: Space | undefined): void {
  const root = document.documentElement;
  const style = root.style;
  style.setProperty('--space', space?.color ?? '#5b6cff');
  style.setProperty('--tint-strong', `${theme.tint}%`);
  style.setProperty('--tint-weak', `${Math.round(theme.tint * 0.4)}%`);
  style.setProperty('--accent', theme.accent ?? 'var(--space)');
  style.setProperty('--icon-color', theme.iconColor ?? 'var(--fg)');
  style.setProperty('--font', FONTS[theme.font] ?? FONTS.system);
  if (theme.mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme.mode);
  document.body.classList.toggle('icons-mono', theme.iconStyle === 'mono');
  if (theme.skin === 'lcars') root.setAttribute('data-skin', 'lcars');
  else root.removeAttribute('data-skin');
}
