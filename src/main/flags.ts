import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TroubleFlags } from '../shared/types.ts';

/**
 * Troubleshooting switches from Settings → Troubleshooting. Chromium reads most of its
 * command-line switches before the app is ready, long before the state store is
 * loaded, so the flags are read straight from state.json at process start.
 */
export const FLAG_INFO: { key: keyof TroubleFlags; label: string; help: string }[] = [
  { key: 'noHwVideoDecode', label: 'Disable hardware video decoding', help: 'Videos decode on the CPU. Try first when a video stays black or never starts.' },
  { key: 'noMacOverlays', label: 'Disable video overlays (macOS)', help: 'Draws video through the normal compositor instead of a native overlay layer.' },
  { key: 'noGraphite', label: 'Disable Skia Graphite', help: 'Falls back to the older Ganesh renderer for all page drawing.' },
  { key: 'noGpuCompositing', label: 'Disable GPU compositing', help: 'Composites pages on the CPU. Slower, but isolates driver problems.' },
  { key: 'noGpu', label: 'Disable the GPU entirely', help: 'Last resort: software rendering for everything.' },
  { key: 'noPageHooks', label: 'Do not patch pages', help: 'Chord adds small hooks to pages for players, calls, passkeys and Google sign-in. Turn them off (new page loads) to find out whether a site that keeps asking you to prove you are human objects to them.' },
];

let active: string[] = [];

export function activeFlags(): string[] {
  return active;
}

export function readFlags(): TroubleFlags {
  try {
    const raw = JSON.parse(readFileSync(join(app.getPath('userData'), 'state.json'), 'utf8')) as { settings?: { flags?: unknown } };
    const f = (raw.settings?.flags ?? {}) as Record<string, unknown>;
    const out: TroubleFlags = {};
    for (const { key } of FLAG_INFO) if (f[key] === true) out[key] = true;
    return out;
  } catch {
    return {};
  }
}

export function applyStartupFlags(): void {
  const f = readFlags();
  const switches: string[] = [];
  const disabledFeatures: string[] = [];
  if (f.noHwVideoDecode) switches.push('disable-accelerated-video-decode');
  if (f.noMacOverlays && process.platform === 'darwin') switches.push('disable-mac-overlays');
  if (f.noGraphite) disabledFeatures.push('SkiaGraphite');
  if (f.noGpuCompositing) switches.push('disable-gpu-compositing');
  if (f.noGpu) switches.push('disable-gpu');
  for (const s of switches) app.commandLine.appendSwitch(s);
  if (disabledFeatures.length) app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));
  active = [...switches.map((s) => `--${s}`), ...(disabledFeatures.length ? [`--disable-features=${disabledFeatures.join(',')}`] : [])];
}
