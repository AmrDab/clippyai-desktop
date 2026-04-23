/**
 * afterPack: DISABLED since v0.11.10.
 *
 * History:
 * - v0.9.3: used rcedit to rewrite icon + VERSIONINFO (ProductName=ClippyAI,
 *   CompanyName=Cloudana). Windows SmartScreen saw a zero-reputation binary
 *   and silently blocked it on some configs. "Clippy refuses to open after
 *   update."
 * - v0.9.4: narrowed rcedit to icon-only on the theory that icon replacement
 *   doesn't affect reputation. Worked on most configs.
 * - v0.11.9: on Windows 11 25H2 machines with hardened security (Smart App
 *   Control, AppLocker, Defender ASR, or WDAC), users hit "This app can't
 *   run on your PC — contact the software publisher." Icon replacement
 *   DOES change the exe's hash, and fresh-hash unsigned binaries start with
 *   zero SmartScreen reputation. Aggressive security policies block them.
 * - v0.11.10 (this file): drop the post-build PE modification entirely.
 *   The stock Electron binary has established reputation across millions of
 *   Electron apps. Not touching it keeps that trust.
 *
 * What the user sees without rcedit:
 * - Clippy's animated sprite in the window: UNCHANGED (renderer-drawn)
 * - Installer's icon (NSIS header + uninstall dialog): UNCHANGED (set via
 *   electron-builder.yml `nsis.installerIcon`, separate from the exe)
 * - Start menu + desktop shortcuts: UNCHANGED (NSIS sets them with Clippy
 *   icon via `shortcutName` and default shortcut behaviour)
 * - Taskbar + Alt-Tab: the default Electron icon, not Clippy. Cosmetic
 *   downgrade — trade for reliable launches on hardened Windows configs.
 *
 * When code signing with an EV certificate is in place, reputation applies
 * to (hash, signer) instead of hash alone, and we can re-enable rcedit
 * safely — see the git history of this file for the old implementation.
 */
exports.default = async function afterPack(_context) {
  console.log('[afterPack] no-op (rcedit disabled — see comment for rationale)');
};
