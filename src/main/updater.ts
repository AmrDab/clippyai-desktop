import { autoUpdater, UpdateInfo } from 'electron-updater';
import { app, BrowserWindow } from 'electron';
import { createLogger } from './logger';

const log = createLogger('Updater');

let mainWindow: BrowserWindow | null = null;
let updateDownloaded = false;

export function initUpdater(win: BrowserWindow): void {
  mainWindow = win;

  // Don't auto-download — just notify the user, let them decide
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;


  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for updates...');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info('Update available', { version: info.version });
    // Notify the renderer — Clippy tells the user an update exists
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', info.version);
    }
  });

  autoUpdater.on('update-not-available', () => {
    log.debug('No update available');
  });

  autoUpdater.on('download-progress', (progress) => {
    log.debug('Download progress', { percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info('Update downloaded', { version: info.version });
    updateDownloaded = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-ready', info.version);
    }
  });

  autoUpdater.on('error', (err) => {
    log.warn('Auto-update error (non-fatal)', String(err).substring(0, 200));
  });
}

export function checkForUpdates(): void {
  if (!app.isPackaged) {
    log.debug('Skipping update check in dev mode');
    return;
  }

  autoUpdater.checkForUpdates().catch((err) => {
    log.warn('Update check failed (non-fatal)', String(err).substring(0, 200));
  });
}

/**
 * Start a background timer that re-checks for updates every 24 hours.
 * Previously we only checked once at startup (+10s). If the app stays
 * running for days, users would never learn about new versions.
 */
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

export function startPeriodicUpdateChecks(): void {
  setInterval(() => {
    log.debug('Periodic update check (24h)');
    checkForUpdates();
  }, UPDATE_CHECK_INTERVAL);
}

/** User chose to download + install the update */
export function downloadUpdate(): void {
  log.info('User accepted update — downloading');
  autoUpdater.downloadUpdate().catch((err) => {
    log.error('Download failed', String(err).substring(0, 200));
  });
}

/** User chose to install the already-downloaded update */
export function installUpdate(): void {
  if (!updateDownloaded) {
    log.warn('installUpdate called but no update downloaded');
    return;
  }
  log.info('User requested update install — quitting and installing');
  // isSilent=true so installer doesn't show UI, isForceRunAfter=true to relaunch after
  // NOT silent — SmartScreen needs to show "More info → Run anyway" dialog for unsigned exe
  autoUpdater.quitAndInstall(false, true);
}
