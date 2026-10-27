import { app } from 'electron';
import { dirname, join } from 'node:path';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { Controller } from './controller.ts';
import { configureSession } from './session.ts';
import { mark, warnIfTranslated } from './diagnostics.ts';
import { registerInternalScheme } from './internal.ts';
import { applyStartupFlags } from './flags.ts';

app.setName('Chord');
app.setAboutPanelOptions({ applicationName: 'Chord', applicationVersion: app.getVersion(), website: 'https://ingmmo.com/chord/', copyright: 'MIT licensed · github.com/sirmmo/chord' });
registerInternalScheme();

// The Windows portable build (electron-builder "portable" target) sets this to the
// folder holding the .exe. Keep profile, cookies and settings next to it so the
// whole browser can live on a USB stick and leaves nothing behind in %APPDATA%.
// The zip build is portable when a portable.txt sits next to Chord.exe.
const exeDir = dirname(app.getPath('exe'));
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR ?? (existsSync(join(exeDir, 'portable.txt')) ? exeDir : null);
if (portableDir) {
  app.setPath('userData', join(portableDir, 'ChordData'));
}
applyStartupFlags();

/**
 * Make sure the process really ends once quitting starts. A page that stalls in
 * beforeunload, or a view that is slow to tear down, must never leave an
 * invisible Chord.exe behind: on Windows that is what makes the installer and
 * the uninstaller report "Chord cannot be closed".
 */
function armExitWatchdog(): void {
  setTimeout(() => app.exit(0), 3000).unref();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let controller: Controller | null = null;
  let pendingUrl: string | null = null;
  const urlFromArgv = (argv: string[]) => argv.find((a) => /^(https?|chord):\/\//i.test(a)) ?? null;

  app.on('second-instance', (_event, argv) => {
    const url = urlFromArgv(argv);
    if (controller) url ? controller.openUrl(url) : controller.focusWindow();
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (controller) controller.openUrl(url);
    else pendingUrl = url;
  });

  app.whenReady().then(() => {
    mark('app-ready');
    configureSession();
    controller = new Controller();
    controller.init();
    controller.createWindow();
    warnIfTranslated(controller);
    const url = pendingUrl ?? urlFromArgv(process.argv.slice(1));
    if (url) controller.openUrl(url);
    // Registering the chord: protocol touches the registry on Windows: do it once per version.
    if (!process.defaultApp) {
      const stamp = join(app.getPath('userData'), 'protocol-registered');
      let done = '';
      try {
        done = readFileSync(stamp, 'utf8');
      } catch {
        /* first run */
      }
      if (done !== app.getVersion()) {
        app.setAsDefaultProtocolClient('chord');
        try {
          writeFileSync(stamp, app.getVersion());
        } catch {
          /* read-only profile */
        }
      }
    }
  });

  app.on('activate', () => controller?.focusWindow());
  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return;
    armExitWatchdog();
    app.quit();
  });
  app.on('before-quit', () => {
    if (controller) controller.quitting = true;
    armExitWatchdog();
    controller?.flush();
  });
}
