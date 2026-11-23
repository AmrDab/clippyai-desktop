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
 * macOS only (2026-11 scan):
 *   EnableEmbeddedAsarIntegrityValidation → on: app.asar must match the
 *     ElectronAsarIntegrity hash electron-builder writes into Info.plist
 *     (computed after the asar is built and before this hook, for the arm64
 *     and x64 builds alike), so the app's code can't be swapped on disk.
 *   OnlyLoadAppFromAsar → on: no fallback to a loose resources/app folder.
 *   Windows keeps both off: not supported on Windows in Electron 29.
 *
 * Left ON on purpose — RunAsNode. It lets any local process run
 * `ELECTRON_RUN_AS_NODE=1 ClippyAI -e …` as Node inside the signed app (on
 * macOS, with its Accessibility / Screen Recording / Microphone grants).
 * Two features need it, because the packaged app ships no separate node:
 *   1. "Connect an agent": Claude Desktop launches
 *      `ELECTRON_RUN_AS_NODE=1 <ClippyAI> resources/mcp/clippy-mcp-bridge.js`
 *      (agent-config.ts buildSetupSnippets, agent-connect.ts). The bridge is
 *      started by Claude Desktop, not by ClippyAI, so utilityProcess.fork
 *      can't replace it. Turning the fuse off needs a bridge that is its own
 *      program (a small signed native binary, or a `--mcp-bridge` mode of the
 *      app itself that runs before any window), or dropping the stdio
 *      snippet for clients that speak HTTP MCP.
 *   2. ClawHub skills with run.js / run.mjs (clawhub.ts runSkill) run under
 *      process.execPath with ELECTRON_RUN_AS_NODE=1. These could move to
 *      utilityProcess.fork (stdio 'pipe', env, cwd; timeout and output cap
 *      done by hand).
 * Turning RunAsNode off breaks both until each is migrated.
 *
 * History: until v0.24.2 this hook was a no-op. Before v0.11.10 it ran rcedit
 * on the UNSIGNED exe, and the changed hash with no signature tripped hardened
 * Windows configs ("This app can't run on your PC"). Builds are signed now
 * (Azure Trusted Signing, after this hook), so reputation follows the signer.
 */
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/** The fuses for one platform / arch (exported for tests/after-pack.test.ts). */
function fuseConfig(electronPlatformName, arch) {
  const mac = electronPlatformName === 'darwin';
  return {
    version: FuseVersion.V1,
    // electron-builder re-signs afterwards; this keeps an unsigned arm64 dev pack launchable.
    resetAdHocDarwinSignature: mac && arch === 3 /* Arch.arm64 */,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.RunAsNode]: true,
    ...(mac ? {
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    } : {}),
  };
}

exports.fuseConfig = fuseConfig;

exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager, arch } = context;
  const name = packager.appInfo.productFilename;
  const target = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${name}.app`)
    : electronPlatformName === 'win32'
      ? path.join(appOutDir, `${name}.exe`)
      : path.join(appOutDir, packager.executableName || name);
  await flipFuses(target, fuseConfig(electronPlatformName, arch));
  const asar = electronPlatformName === 'darwin' ? ', asar integrity + asar-only on' : '';
  console.log(`[afterPack] fuses flipped on ${path.basename(target)}: inspect args off, NODE_OPTIONS off${asar}, RunAsNode kept`);
};
