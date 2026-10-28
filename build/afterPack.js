// electron-builder afterPack hook: Widevine's Verified Media Path.
//
// Chord ships castLabs' Electron (electron-releases, "+wvcus"), whose Widevine
// CDM only decrypts for a VMP-signed binary. The development signature that
// comes with it works against test servers only, and @electron/universal
// refuses to merge the two architectures while the signature files are there.
// So: drop the development signature from the per-arch builds of a universal
// macOS package, then sign the merged app (and the Windows build) with
// castLabs' EVS service when its credentials are present (EVS_ACCOUNT_NAME and
// EVS_PASSWD). Without credentials the build is packaged unsigned: Linux needs
// no VMP signature; macOS and Windows then play unprotected media only.
const { execFileSync } = require('node:child_process');
const { existsSync, readdirSync, rmSync, statSync } = require('node:fs');
const { join } = require('node:path');

const ARCH_UNIVERSAL = 4; // builder-util Arch.universal

function removeSignatures(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name.endsWith('.sig')) {
      rmSync(p);
      console.log(`afterPack: removed development VMP signature ${p}`);
    } else if (statSync(p).isDirectory()) removeSignatures(p);
  }
}

function evsSign(dir) {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const env = { ...process.env, EVS_NO_ASK: '1' };
  console.log(`afterPack: VMP-signing ${dir} with castLabs EVS as ${process.env.EVS_ACCOUNT_NAME}`);
  execFileSync(python, ['-m', 'castlabs_evs.vmp', '--no-ask', 'sign-pkg', dir], { stdio: 'inherit', env });
  execFileSync(python, ['-m', 'castlabs_evs.vmp', '--no-ask', 'verify-pkg', dir], { stdio: 'inherit', env });
}

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const haveEvs = Boolean(process.env.EVS_ACCOUNT_NAME && process.env.EVS_PASSWD);
  if (platform === 'darwin') {
    if (context.arch !== ARCH_UNIVERSAL && /-temp$/.test(context.appOutDir)) {
      // one half of a universal build: the merge step chokes on the development signature
      removeSignatures(context.appOutDir);
      return;
    }
    if (haveEvs) evsSign(context.appOutDir);
    else console.log('afterPack: no EVS credentials, the macOS build is not VMP-signed (Widevine will not play protected media)');
  } else if (platform === 'win32') {
    if (haveEvs) evsSign(context.appOutDir);
    else console.log('afterPack: no EVS credentials, the Windows build is not VMP-signed (Widevine will not play protected media)');
  }
  if (!existsSync(context.appOutDir)) throw new Error(`afterPack: ${context.appOutDir} is missing`);
};
