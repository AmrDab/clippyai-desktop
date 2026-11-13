import path from 'path';
import { app } from 'electron';

/**
 * The app icon for the tray and windows. `build/` is not inside app.asar, so
 * the packaged path `__dirname/../../build/icon.ico` resolved to nothing and
 * the tray icon came out blank; the file now ships as an extraResource.
 *
 * macOS: nativeImage cannot be relied on to decode a .ico there, so the tray
 * uses a PNG (build/icon-256.png, shipped as `icon.png` by the mac section of
 * electron-builder.yml). Windows is unchanged.
 */
export function appIconPath(): string {
  if (process.platform === 'darwin') {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '../../build/icon-256.png');
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '../../build/icon.ico');
}
