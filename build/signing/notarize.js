/**
 * afterSign hook — drives Apple notarization + stapling for the DMG.
 *
 * Called by electron-builder once it has finished signing the .app bundle
 * with the Developer ID Application certificate. We submit the signed app
 * to Apple's notary service via notarytool, wait for the result, then
 * staple the notarization ticket onto the .app so Gatekeeper trusts it
 * offline (no network call required when the user launches it).
 *
 * Required env vars (set in CI, optional locally):
 *   APPLE_ID                — Apple ID email (Developer account)
 *   APPLE_APP_SPECIFIC_PWD  — app-specific password from appleid.apple.com
 *   APPLE_TEAM_ID           — 10-char team ID from developer.apple.com/account
 *   (or alternatively, the App Store Connect API key trio:)
 *   APPLE_API_KEY           — path to the .p8 private key file
 *   APPLE_API_KEY_ID        — key ID (e.g. "ABC1234567")
 *   APPLE_API_ISSUER        — issuer UUID
 *
 * If none of these are set we skip notarization (useful for local-only
 * unsigned dev builds). The DMG will work but Gatekeeper will require the
 * user to right-click → Open the first time.
 */

const path = require('path');
const fs = require('fs');

exports.default = async function notarizeMac(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) {
    console.warn(`[notarize] app not found at ${appPath} — skipping`);
    return;
  }

  const hasAppleIdAuth = !!(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PWD && process.env.APPLE_TEAM_ID);
  const hasApiKeyAuth = !!(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER);

  if (!hasAppleIdAuth && !hasApiKeyAuth) {
    console.warn('[notarize] no Apple credentials in env — skipping notarization');
    console.warn('[notarize] users will need to right-click → Open the first time');
    return;
  }

  // Lazy require so a fresh checkout without devDeps installed doesn't fail
  // at config-load time. @electron/notarize is a devDep added in M1.
  const { notarize } = require('@electron/notarize');

  const opts = hasAppleIdAuth
    ? {
        tool: 'notarytool',
        appPath,
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PWD,
        teamId: process.env.APPLE_TEAM_ID,
      }
    : {
        tool: 'notarytool',
        appPath,
        appleApiKey: process.env.APPLE_API_KEY,
        appleApiKeyId: process.env.APPLE_API_KEY_ID,
        appleApiIssuer: process.env.APPLE_API_ISSUER,
      };

  console.log(`[notarize] submitting ${appPath} to Apple…`);
  const t0 = Date.now();
  await notarize(opts);
  console.log(`[notarize] success in ${Math.round((Date.now() - t0) / 1000)}s`);

  // notarize() already calls `xcrun stapler staple` internally for the .app
  // bundle. We do NOT need to staple the DMG separately — electron-builder
  // mounts the .app inside the DMG after this hook, and Gatekeeper accepts
  // the embedded ticket. (Stapling the DMG itself is optional belt-and-
  // suspenders; revisit in M7 if any users hit "cannot verify" prompts.)
};
