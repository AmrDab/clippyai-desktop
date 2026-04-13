const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  const exePath = path.join(context.appOutDir, 'ClippyAI.exe');
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  const rceditPath = path.join(__dirname, '..', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');

  console.log('[afterPack] Applying rcedit to', exePath);

  try {
    execFileSync(rceditPath, [
      exePath,
      '--set-icon', iconPath,
      '--set-version-string', 'ProductName', 'ClippyAI',
      '--set-version-string', 'FileDescription', 'ClippyAI — Your AI Desktop Buddy',
      '--set-version-string', 'CompanyName', 'Cloudana',
      '--set-version-string', 'LegalCopyright', 'Copyright © 2026 Cloudana',
      '--set-product-version', context.packager.appInfo.version,
      '--set-file-version', context.packager.appInfo.version,
    ]);
    console.log('[afterPack] rcedit applied successfully');
  } catch (err) {
    console.error('[afterPack] rcedit failed:', err.message);
  }
};
