const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Applies the Clippy icon to the packed ClippyAI.exe.
 *
 * IMPORTANT: we deliberately do NOT change VERSIONINFO strings (ProductName,
 * CompanyName, FileDescription, etc.). Reason:
 *
 * Windows SmartScreen & Defender compute per-binary reputation using the
 * combination of (hash, signer, ProductName/CompanyName). Because we don't
 * code-sign yet, our binaries inherit the "Electron" identity Windows already
 * trusts (because every Electron app uses it). The moment we change those
 * strings to "ClippyAI / Cloudana", Windows sees a completely unrecognized
 * app with zero reputation — and on some user configurations, SmartScreen
 * silently blocks it with no UI. That was v0.9.3's post-update bug.
 *
 * Icon replacement is SAFE: it doesn't affect reputation. So we only change
 * the icon here. The taskbar, Alt-Tab, desktop shortcut all show Clippy.
 * Properties dialog still says "Electron" until we ship an EV-signed build —
 * that's a cosmetic-only trade for not silently breaking users.
 *
 * Once we have code signing, add the VERSIONINFO flags back (in the block
 * below that's kept as a comment for reference).
 */
exports.default = async function afterPack(context) {
  const exePath = path.join(context.appOutDir, 'ClippyAI.exe');
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  const rceditPath = path.join(__dirname, '..', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');

  console.log('[afterPack] Setting Clippy icon on', exePath);

  try {
    execFileSync(rceditPath, [
      exePath,
      '--set-icon', iconPath,
      // VERSIONINFO intentionally left alone — see comment above.
      // When code signing is in place, uncomment the block below:
      //   '--set-version-string', 'ProductName', 'ClippyAI',
      //   '--set-version-string', 'FileDescription', 'ClippyAI Desktop Buddy',
      //   '--set-version-string', 'CompanyName', 'Cloudana',
      //   '--set-version-string', 'LegalCopyright', '(c) 2026 Cloudana',
      //   '--set-product-version', context.packager.appInfo.version,
      //   '--set-file-version', context.packager.appInfo.version,
    ]);
    console.log('[afterPack] icon applied successfully');
  } catch (err) {
    console.error('[afterPack] rcedit failed:', err.message);
    // Don't throw — icon is a nice-to-have, shouldn't block a release.
  }
};
