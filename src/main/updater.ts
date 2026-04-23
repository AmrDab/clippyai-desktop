import { autoUpdater, UpdateInfo } from 'electron-updater';
import { app, BrowserWindow, shell } from 'electron';
import { createLogger } from './logger';
import { cleanupTools } from './tools';
import fs from 'fs';
import path from 'path';

const log = createLogger('Updater');

const GITHUB_OWNER = 'AmrDab';
const GITHUB_REPO = 'clippyai-desktop';
const RELEASE_PAGE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

// A version is marked failed after this many silent-failure detections.
//
// v0.11.6 used `2` on the theory that the first failure might be transient
// (AV scan still in progress, UAC fumble, etc.). In practice, NSIS silent
// failures caused by unsigned-installer policy are DETERMINISTIC — Defender
// doesn't change its mind on retry — so the "hedge" just made the user
// watch the same failed update attempt twice before escaping to manual
// install. Now: one silent failure is enough evidence, skip immediately.
// If the user manually installs a newer version, skip state self-clears.
const MAX_FAILURES_BEFORE_SKIP = 1;

// How long after an install attempt we still treat a version-mismatch as
// "install just failed" vs. "user downgraded by other means". 2h is long
// enough to cover a slow NSIS run + antivirus scan, short enough that a
// week-later relaunch doesn't trigger false positives.
const SILENT_FAILURE_WINDOW_MS = 2 * 60 * 60 * 1000;

let mainWindow: BrowserWindow | null = null;
let updateDownloaded = false;
let expectedVersion = '';
const skippedVersions: Set<string> = new Set();

interface UpdaterState {
  lastAttemptedVersion: string;
  lastAttemptedAt: string;
  skippedVersions: string[];
  failureCount: Record<string, number>;
}

function cacheDir(): string {
  // electron-updater's `updaterCacheDirName: clippyai-updater` (app-update.yml)
  // resolves to %LOCALAPPDATA%\clippyai-updater on Windows.
  const base = process.env.LOCALAPPDATA
    || path.join(app.getPath('home'), 'AppData', 'Local');
  return path.join(base, 'clippyai-updater');
}

function stateFilePath(): string {
  return path.join(app.getPath('userData'), 'updater-state.json');
}

function readState(): UpdaterState {
  try {
    const raw = fs.readFileSync(stateFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<UpdaterState>;
    return {
      lastAttemptedVersion: parsed.lastAttemptedVersion ?? '',
      lastAttemptedAt: parsed.lastAttemptedAt ?? '',
      skippedVersions: Array.isArray(parsed.skippedVersions) ? parsed.skippedVersions : [],
      failureCount: parsed.failureCount ?? {},
    };
  } catch {
    return { lastAttemptedVersion: '', lastAttemptedAt: '', skippedVersions: [], failureCount: {} };
  }
}

function writeState(state: UpdaterState): void {
  try {
    // Write atomically: tmp file + rename, so a crash mid-write doesn't
    // leave a truncated JSON that breaks all future boots.
    const target = stateFilePath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf-8' });
    fs.renameSync(tmp, target);
  } catch (err) {
    log.warn('State write failed', String(err));
  }
}

/**
 * Compare semver-ish version strings. Returns negative if a<b, positive if
 * a>b, 0 if equal. Tolerates missing segments ("1.2" == "1.2.0"). We don't
 * need full semver (no prerelease tags in our version scheme).
 */
function cmpVersion(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Nuke the entire electron-updater cache: installer.exe, pending/ staging,
 * sha512 checksums, everything. Called after a silent-failure detection so
 * the next update check gets a clean slate and can't re-fire
 * `update-downloaded` for the failed version.
 */
function purgeCache(reason: string): void {
  const dir = cacheDir();
  try {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      try {
        const stat = fs.lstatSync(full);
        if (stat.isDirectory()) {
          fs.rmSync(full, { recursive: true, force: true });
        } else {
          fs.unlinkSync(full);
        }
      } catch { /* best effort */ }
    }
    log.info('Cache purged', { reason, dir });
  } catch (err) {
    log.warn('Cache purge failed', String(err));
  }
}

/**
 * Boot-time detection of a silent `quitAndInstall` failure.
 *
 * Flow: installUpdate() writes `{ version, timestamp }` to updater-state.json
 * just before quitAndInstall. If we boot and find an attempt recorded for a
 * version > our current version AND the attempt is recent (< 2h), the install
 * failed — NSIS likely blocked by SmartScreen/AV/UAC. Escalate.
 */
function detectSilentFailure(): UpdaterState {
  const state = readState();
  const currentVersion = app.getVersion();

  // Purge entries for versions we've already moved past. Once the user
  // upgrades (by any path — auto-update or manual install), their skip
  // list becomes irrelevant.
  const staleSkipped = state.skippedVersions.filter((v) => cmpVersion(v, currentVersion) <= 0);
  if (staleSkipped.length > 0) {
    state.skippedVersions = state.skippedVersions.filter((v) => cmpVersion(v, currentVersion) > 0);
    for (const v of staleSkipped) delete state.failureCount[v];
    log.info('Cleared stale skip entries (user upgraded)', { cleared: staleSkipped, currentVersion });
  }

  if (!state.lastAttemptedVersion || !state.lastAttemptedAt) {
    writeState(state);
    return state;
  }

  const attemptedAt = Date.parse(state.lastAttemptedAt);
  const ageMs = Date.now() - attemptedAt;
  const attemptedVsCurrent = cmpVersion(state.lastAttemptedVersion, currentVersion);

  if (attemptedVsCurrent <= 0) {
    // We're now on (or past) the version we attempted. Install succeeded.
    log.info('Previous install attempt succeeded', {
      attempted: state.lastAttemptedVersion,
      current: currentVersion,
    });
    state.lastAttemptedVersion = '';
    state.lastAttemptedAt = '';
    delete state.failureCount[state.lastAttemptedVersion];
    writeState(state);
    return state;
  }

  if (ageMs > SILENT_FAILURE_WINDOW_MS) {
    // Attempt is old — user may have uninstalled and reinstalled an older
    // version deliberately, or OS was off for days. Don't penalize.
    log.warn('Stale install attempt ignored', {
      attempted: state.lastAttemptedVersion,
      ageHours: Math.round(ageMs / 3_600_000),
    });
    state.lastAttemptedVersion = '';
    state.lastAttemptedAt = '';
    writeState(state);
    return state;
  }

  // Silent failure confirmed. Record it.
  const v = state.lastAttemptedVersion;
  state.failureCount[v] = (state.failureCount[v] || 0) + 1;
  log.error('Silent install failure detected', {
    attemptedVersion: v,
    currentVersion,
    ageMinutes: Math.round(ageMs / 60_000),
    failureCount: state.failureCount[v],
  });

  if (state.failureCount[v] >= MAX_FAILURES_BEFORE_SKIP && !state.skippedVersions.includes(v)) {
    state.skippedVersions.push(v);
    log.error('Version marked as skipped — manual install required', { version: v });
  }

  // Clear the attempt so we don't double-count on next boot.
  state.lastAttemptedVersion = '';
  state.lastAttemptedAt = '';
  writeState(state);

  // Always purge the cache on a silent failure so the cached installer
  // can't re-trigger update-downloaded on this boot.
  purgeCache(`silent-failure v${v} (attempt ${state.failureCount[v]})`);

  return state;
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

export function initUpdater(win: BrowserWindow): void {
  mainWindow = win;

  // We manage install timing ourselves — no race with will-quit hooks.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  // Boot-time self-heal: detect if our last quitAndInstall silently failed.
  const state = detectSilentFailure();
  for (const v of state.skippedVersions) skippedVersions.add(v);
  if (skippedVersions.size > 0) {
    log.warn('Booting with skipped versions', { versions: [...skippedVersions] });
  }

  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for updates...');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info('Update available', { version: info.version, currentVersion: app.getVersion() });
    if (skippedVersions.has(info.version)) {
      log.warn('Update-available suppressed (version skipped)', { version: info.version });
      sendToRenderer('update-failed', {
        version: info.version,
        reason: 'previous-install-failed',
        manualUrl: RELEASE_PAGE,
      });
      return;
    }
    sendToRenderer('update-available', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    log.info('No update available', { currentVersion: app.getVersion() });
    sendToRenderer('update-not-available');
  });

  autoUpdater.on('download-progress', (progress) => {
    log.debug('Download progress', { percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    const installerPath = (autoUpdater as unknown as {
      downloadedUpdateHelper?: { file?: string };
    }).downloadedUpdateHelper?.file || '(unknown)';

    log.info('Update downloaded', {
      version: info.version,
      currentVersion: app.getVersion(),
      installerPath,
    });

    if (skippedVersions.has(info.version)) {
      log.warn('Update-downloaded suppressed (version skipped) — purging cache', {
        version: info.version,
      });
      purgeCache(`downloaded version ${info.version} is skipped`);
      sendToRenderer('update-failed', {
        version: info.version,
        reason: 'previous-install-failed',
        manualUrl: RELEASE_PAGE,
      });
      return;
    }

    updateDownloaded = true;
    expectedVersion = info.version;
    sendToRenderer('update-ready', info.version);
  });

  autoUpdater.on('error', (err) => {
    log.error('Auto-update error', String(err).substring(0, 400));
    sendToRenderer('update-failed', {
      version: expectedVersion || 'unknown',
      reason: 'updater-error',
      manualUrl: RELEASE_PAGE,
    });
  });
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
 * Open the GitHub release page so the user can download and install the
 * latest version manually. Used as the fallback when auto-update has
 * silently failed twice for the same version.
 */
export function openManualUpdatePage(): void {
  log.info('Opening manual update page', { url: RELEASE_PAGE });
  shell.openExternal(RELEASE_PAGE).catch((err) => {
    log.warn('Failed to open release page', String(err));
  });
}

/**
 * Install the already-downloaded update.
 *
 * 1. Record the attempt on disk (so boot-time detection can spot a silent
 *    failure if quitAndInstall returns without actually installing).
 * 2. Kill child processes (PSBridge) — releases file handles NSIS needs.
 * 3. Purge any stale installer.exe in the cache so electron-updater runs
 *    the freshly-verified file, not a stale one from a prior version.
 * 4. Hand off to quitAndInstall(silent=true, forceRunAfter=true). Combined
 *    with nsis.oneClick + runAfterFinish in electron-builder.yml, this gives
 *    a silent elevation-free install that auto-relaunches.
 *
 * History of update loop bugs (each fixed in turn):
 * - v0.9.9:   cleanupTools ran in will-quit AFTER quitAndInstall → file locks
 * - v0.10.9:  cleanupTools moved BEFORE quitAndInstall → locks fixed
 * - v0.11.1:  NSIS oneClick:false couldn't find install dir → wrong path
 * - v0.11.4:  Switched to oneClick:true → fixed path, no registry lookup
 * - v0.11.4:  Stale cache age-based cleanup → partial self-heal
 * - v0.11.6:  Durable install-attempt record + silent-failure detection +
 *             manual-install fallback. Closes the remaining loop hole when
 *             NSIS is blocked by AV/SmartScreen without surfacing an error.
 */
export function installUpdate(): void {
  if (!updateDownloaded) {
    log.warn('installUpdate called but no update downloaded');
    return;
  }

  const installerPath = (autoUpdater as unknown as {
    downloadedUpdateHelper?: { file?: string };
  }).downloadedUpdateHelper?.file || '(unknown)';

  log.info('Install.start', {
    currentVersion: app.getVersion(),
    targetVersion: expectedVersion,
    installerPath,
  });

  // RC1: durable record — MUST write before quitAndInstall, MUST fsync (we
  // do that inside writeState via tmp+rename). If NSIS silently fails, the
  // next boot sees this file and knows to purge + fall back.
  const state = readState();
  state.lastAttemptedVersion = expectedVersion;
  state.lastAttemptedAt = new Date().toISOString();
  writeState(state);
  log.info('Install.attemptRecorded', {
    version: expectedVersion,
    stateFile: stateFilePath(),
  });

  // Phase 1: Kill child processes (PSBridge holds powershell.exe handles
  // to files NSIS will need to replace).
  try {
    cleanupTools();
  } catch (err) {
    log.warn('cleanupTools error (non-fatal)', String(err));
  }

  // Phase 2: Delete any stale installer.exe sitting in the cache root.
  // electron-updater copies pending/<name>.exe → installer.exe and runs
  // installer.exe. If the copy fails silently (locked by AV scanner), it
  // runs an old installer.exe from a previous version → update loop.
  try {
    const staleInstaller = path.join(cacheDir(), 'installer.exe');
    if (fs.existsSync(staleInstaller)) {
      fs.unlinkSync(staleInstaller);
      log.info('Install.cacheClean', { deleted: staleInstaller });
    }
  } catch (err) {
    log.warn('Install.cacheClean failed (non-fatal)', String(err));
  }

  // Phase 3: Hand off to NSIS.
  setTimeout(() => {
    log.info('Install.exec', { action: 'quitAndInstall', silent: true, forceRunAfter: true });
    autoUpdater.quitAndInstall(true, true);
  }, 1500);
}
