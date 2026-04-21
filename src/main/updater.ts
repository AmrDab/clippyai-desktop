import { autoUpdater, UpdateInfo } from 'electron-updater';
import { app, BrowserWindow } from 'electron';
import { createLogger } from './logger';
import { cleanupTools } from './tools';
import fs from 'fs';
import path from 'path';

const log = createLogger('Updater');

let mainWindow: BrowserWindow | null = null;
let updateDownloaded = false;
let expectedVersion = '';

export function initUpdater(win: BrowserWindow): void {
  mainWindow = win;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // ── Startup self-healing ────────────────────────────────────────
  // If a previous update failed (stale installer in cache from a
  // different version), clear it so we get a clean download next time.
  // This prevents the "downloads update but installs old version" loop.
  clearStalePendingUpdates();

  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for updates...');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info('Update available', { version: info.version, currentVersion: app.getVersion() });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', info.version);
    }
  });

  autoUpdater.on('update-not-available', () => {
    log.info('No update available', { currentVersion: app.getVersion() });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-not-available');
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    log.debug('Download progress', { percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info('Update downloaded', {
      version: info.version,
      currentVersion: app.getVersion(),
      // Log the actual file path electron-updater will run
      installerPath: (autoUpdater as any).downloadedUpdateHelper?.file || '(unknown)',
    });
    updateDownloaded = true;
    expectedVersion = info.version;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-ready', info.version);
    }
  });

  autoUpdater.on('error', (err) => {
    log.warn('Auto-update error', String(err).substring(0, 300));
  });
}

/**
 * Clear stale pending updates from the electron-updater cache.
 * If the app starts and finds a pending update for a version OTHER than
 * the current one, the previous install failed. Clear it so the next
 * checkForUpdates gets a clean download.
 */
function clearStalePendingUpdates(): void {
  try {
    const cacheDir = path.join(
      app.getPath('userData').replace(/[/\\]ClippyAI$/, ''),
      '..', 'Local', 'clippyai-updater',
    );
    const pendingDir = path.join(cacheDir, 'pending');

    if (fs.existsSync(pendingDir)) {
      const files = fs.readdirSync(pendingDir);
      if (files.length > 0) {
        log.warn('Stale pending update found — clearing cache', {
          files,
          currentVersion: app.getVersion(),
        });
        for (const file of files) {
          try { fs.unlinkSync(path.join(pendingDir, file)); } catch { /* best effort */ }
        }
      }
    }

    // Also check if installer.exe in the cache root is stale
    const installerPath = path.join(cacheDir, 'installer.exe');
    if (fs.existsSync(installerPath)) {
      const stats = fs.statSync(installerPath);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
      if (ageHours > 48) {
        log.warn('Stale installer.exe in cache (>48h old) — deleting', {
          ageHours: Math.round(ageHours),
          size: stats.size,
        });
        try { fs.unlinkSync(installerPath); } catch { /* best effort */ }
      }
    }
  } catch (err) {
    log.debug('Cache cleanup skipped', String(err));
  }
}

export function checkForUpdates(): void {
  if (!app.isPackaged) {
    log.debug('Skipping update check in dev mode');
    return;
  }

  autoUpdater.checkForUpdates().catch((err) => {
    log.warn('Update check failed', String(err).substring(0, 200));
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
 * Three-phase approach to prevent the update loop:
 * 1. Kill all child processes (PSBridge) so no file handles block NSIS
 * 2. Wait for Windows to release handles
 * 3. Call quitAndInstall — NSIS installs to fixed path (oneClick:true)
 *
 * History of update loop bugs and their fixes:
 * - v0.9.9: cleanupTools ran in will-quit AFTER quitAndInstall → file locks
 * - v0.10.9: cleanupTools moved BEFORE quitAndInstall → fixed locks
 * - v0.11.1: NSIS oneClick:false couldn't find install dir → wrong path
 * - v0.11.4: Switched to oneClick:true → fixed path, no registry lookup
 * - v0.11.4: Added stale cache cleanup on startup → self-healing
 */
export function installUpdate(): void {
  if (!updateDownloaded) {
    log.warn('installUpdate called but no update downloaded');
    return;
  }

  log.info('Install.start', {
    currentVersion: app.getVersion(),
    targetVersion: expectedVersion,
    installerPath: (autoUpdater as any).downloadedUpdateHelper?.file || '(unknown)',
  });

  // Phase 1: Kill child processes
  try {
    cleanupTools();
  } catch (err) {
    log.warn('cleanupTools error (non-fatal)', String(err));
  }

  // Phase 2: Nuke the stale installer.exe from the updater cache.
  // electron-updater downloads to pending/ then copies to installer.exe,
  // then runs installer.exe. If the copy FAILS silently (locked file,
  // permissions), it runs the OLD installer.exe from a previous version.
  // This was the root cause of the update loop on v0.11.1.
  // Deleting installer.exe forces electron-updater to use the fresh file.
  try {
    const cacheDir = path.join(
      process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'),
      'clippyai-updater',
    );
    const staleInstaller = path.join(cacheDir, 'installer.exe');
    if (fs.existsSync(staleInstaller)) {
      fs.unlinkSync(staleInstaller);
      log.info('Install.cacheClean', { deleted: staleInstaller });
    }
  } catch (err) {
    log.warn('Install.cacheClean failed (non-fatal)', String(err));
  }

  // Phase 3: Wait for handle release, then install
  setTimeout(() => {
    log.info('Install.exec', { action: 'quitAndInstall', silent: true, forceRunAfter: true });
    autoUpdater.quitAndInstall(true, true);
  }, 1500);
}
