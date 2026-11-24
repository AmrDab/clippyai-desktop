/**
 * afterPack: flip Electron fuses (v0.24.3). Runs before code signing, so the
 * signature covers the flipped binary on both platforms.
 *
 * Why: the Mac hardware run (docs/mac-test-report.md) showed a local process
 * could open a Node inspector inside the signed app (SIGUSR1, --inspect,
 * NODE_OPTIONS=--inspect) and so borrow Clippy's Accessibility / Screen
 * Recording grants. These two fuses close that:
 *   EnableNodeCliInspectArguments       → off (--inspect*, SIGUSR1)
 *   EnableNodeOptionsEnvironmentVariable → off (NODE_OPTIONS)
 *
 * Left ON on purpose:
 *   RunAsNode — ClawHub skills run under process.execPath (clawhub.ts), because the
 *     packaged app ships no separate node. Turning it off breaks them.
 *   Asar integrity / OnlyLoadAppFromAsar — not supported on Windows in Electron 29; revisit on upgrade.
 *
 * History: until v0.24.2 this hook was a no-op. Before v0.11.10 it ran rcedit
 * on the UNSIGNED exe, and the changed hash with no signature tripped hardened
 * Windows configs ("This app can't run on your PC"). Builds are signed now
 * (Azure Trusted Signing, after this hook), so reputation follows the signer.
 */
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager, arch } = context;
  const name = packager.appInfo.productFilename;
  const target = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${name}.app`)
    : electronPlatformName === 'win32'
      ? path.join(appOutDir, `${name}.exe`)
      : path.join(appOutDir, packager.executableName || name);
  await flipFuses(target, {
    version: FuseVersion.V1,
    // electron-builder re-signs afterwards; this keeps an unsigned arm64 dev pack launchable.
    resetAdHocDarwinSignature: electronPlatformName === 'darwin' && arch === 3 /* Arch.arm64 */,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.RunAsNode]: true,
  });
  console.log(`[afterPack] fuses flipped on ${path.basename(target)}: inspect args off, NODE_OPTIONS off, RunAsNode kept`);
};
