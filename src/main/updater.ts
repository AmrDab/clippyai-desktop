import { autoUpdater, UpdateInfo } from 'electron-updater';
import { app, BrowserWindow } from 'electron';
import { createLogger } from './logger';
import { cleanupTools } from './tools';

const log = createLogger('Updater');

let mainWindow: BrowserWindow | null = null;
let updateDownloaded = false;

export function initUpdater(win: BrowserWindow): void {
  mainWindow = win;

  // Don't auto-download — notify user, let them decide
  autoUpdater.autoDownload = false;
  // DO install on natural quit if an update is downloaded. This is the
  // fallback if the explicit quitAndInstall path fails or the user quits
  // normally with a pending update.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for updates...');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info('Update available', { version: info.version });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', info.version);
    }
  });

  autoUpdater.on('update-not-available', () => {
    log.debug('No update available');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-not-available');
    }
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

const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;

export function startPeriodicUpdateChecks(): void {
  setInterval(() => {
    log.debug('Periodic update check (24h)');
    checkForUpdates();
  }, UPDATE_CHECK_INTERVAL);
}

export function downloadUpdate(): void {
  log.info('User accepted update — downloading');
  autoUpdater.downloadUpdate().catch((err) => {
    log.error('Download failed', String(err).substring(0, 200));
  });
}

/**
 * Install the already-downloaded update.
 *
 * CRITICAL: Kill PSBridge and all child processes BEFORE calling
 * quitAndInstall. The old code relied on the `will-quit` handler to
 * run cleanupTools(), but that races with the NSIS installer:
 *
 *   OLD (broken):
 *     quitAndInstall() → app.quit() → will-quit → cleanupTools()
 *     ↑ NSIS spawned here but files still locked by PSBridge
 *
 *   NEW (fixed):
 *     cleanupTools() → wait 1.5s → quitAndInstall()
 *     ↑ PSBridge dead, files released, NSIS can replace exe
 *
 * The 1.5s delay matches the NSIS customInit Sleep and gives Windows
 * time to release file handles after taskkill.
 */
export function installUpdate(): void {
  if (!updateDownloaded) {
    log.warn('installUpdate called but no update downloaded');
    return;
  }
  log.info('Pre-update cleanup — killing PSBridge before NSIS install');

  // Step 1: Kill PSBridge + children synchronously
  try {
    cleanupTools();
  } catch (err) {
    log.warn('cleanupTools error (non-fatal)', String(err));
  }

  // Step 2: Wait for Windows to release file handles, then install
  setTimeout(() => {
    log.info('Calling quitAndInstall (silent=true, forceRunAfter=true)');
    // isSilent=true: no NSIS wizard
    // isForceRunAfter=true: relaunch after install
    autoUpdater.quitAndInstall(true, true);
  }, 1500);
}
