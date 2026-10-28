import { dialog, systemPreferences, type BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';

/**
 * "Is it really you?" — the operating system's own check, the one a passkey
 * would use: Touch ID on Macs that have it, Windows Hello on Windows. Where
 * neither exists (Linux, an Intel Mac without Touch ID) a confirmation dialog
 * stands in, which only guards against a slip, not an intruder.
 */

export type VerifyMethod = 'touchid' | 'hello' | 'dialog';

let helloChecked: Promise<boolean> | null = null;

export function verifyMethod(): VerifyMethod {
  if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) return 'touchid';
  if (process.platform === 'win32') return 'hello';
  return 'dialog';
}

/** Windows Hello through WinRT's UserConsentVerifier, driven from PowerShell. */
function windowsHello(reason: string): Promise<boolean | null> {
  const script = `
[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $t) { $m = $asTask.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$avail = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
if ($avail -ne 'Available') { Write-Output 'UNAVAILABLE'; exit 0 }
$r = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync(${JSON.stringify(reason)})) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
Write-Output $r
`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 120_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const out = stdout.trim();
      if (out === 'UNAVAILABLE') return resolve(null);
      resolve(out === 'Verified');
    });
  });
}

/** Whether Windows Hello is set up on this machine (cached). */
export function helloAvailable(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return (helloChecked ??= new Promise((resolve) => {
    const script = `[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
$m = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]); $task = $m.Invoke($null, @([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync())); $task.Wait(-1) | Out-Null; Write-Output $task.Result`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 20_000, windowsHide: true }, (err, stdout) => resolve(!err && stdout.trim() === 'Available'));
  }));
}

/** Ask the OS to verify the user; falls back to a dialog that says what it is worth. */
export async function verifyUser(win: BrowserWindow | undefined, reason: string, button = 'Continue'): Promise<boolean> {
  const method = verifyMethod();
  if (method === 'touchid') {
    try {
      await systemPreferences.promptTouchID(reason);
      return true;
    } catch {
      return false; // cancelled, or Touch ID failed: no silent fallback
    }
  }
  if (method === 'hello') {
    const r = await windowsHello(reason);
    if (r !== null) return r;
  }
  if (!win) return false;
  const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: [button, 'Cancel'], defaultId: 0, cancelId: 1, message: reason, detail: 'This computer offers no Touch ID or Windows Hello, so this is only a confirmation.' });
  return response === 0;
}
