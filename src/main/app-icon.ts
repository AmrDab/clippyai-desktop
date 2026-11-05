import path from 'path';
import { app } from 'electron';

/**
 * The app icon for the tray and windows. `build/` is not inside app.asar, so
 * the packaged path `__dirname/../../build/icon.ico` resolved to nothing and
 * the tray icon came out blank; the file now ships as an extraResource.
 */
export function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '../../build/icon.ico');
}
