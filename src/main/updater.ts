import { autoUpdater, UpdateInfo } from 'electron-updater';
import { app, BrowserWindow } from 'electron';
import { createLogger } from './logger';

const log = createLogger('Updater');

let mainWindow: BrowserWindow | null = null;

export function initUpdater(win: BrowserWindow): void {
  mainWindow = win;

  // Silent downloads — don't show native OS dialogs
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for updates...');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info('Update available', { version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    log.debug('No update available');
  });

  autoUpdater.on('download-progress', (progress) => {
    log.debug('Download progress', { percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info('Update downloaded', { version: info.version });
    // Notify the renderer so Clippy can tell the user
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-ready', info.version);
    }
  });

  autoUpdater.on('error', (err) => {
    // Silently log — never bother the user about update failures
    log.warn('Auto-update error (non-fatal)', String(err).substring(0, 200));
  });
}

export function checkForUpdates(): void {
  // Only check in packaged builds, not during development
  if (!app.isPackaged) {
    log.debug('Skipping update check in dev mode');
    return;
  }

  autoUpdater.checkForUpdates().catch((err) => {
    log.warn('Update check failed (non-fatal)', String(err).substring(0, 200));
  });
}

export function installUpdate(): void {
  log.info('User requested update install — quitting and installing');
  autoUpdater.quitAndInstall(false, true);
}
