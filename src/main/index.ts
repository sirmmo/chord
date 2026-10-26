import { app } from 'electron';
import { Controller } from './controller.ts';
import { configureSession } from './session.ts';

app.setName('Chord');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let controller: Controller | null = null;
  let pendingUrl: string | null = null;
  const urlFromArgv = (argv: string[]) => argv.find((a) => /^https?:\/\//i.test(a)) ?? null;

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
    configureSession();
    controller = new Controller();
    controller.init();
    controller.createWindow();
    const url = pendingUrl ?? urlFromArgv(process.argv.slice(1));
    if (url) controller.openUrl(url);
  });

  app.on('activate', () => controller?.focusWindow());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => controller?.flush());
}
