import { autoUpdater, UpdateInfo } from 'electron-updater';
import { app, BrowserWindow, shell, powerMonitor } from 'electron';
import { createLogger, serializeErr } from './logger';
import * as telemetry from './telemetry';
import { cleanupTools, restoreTools } from './tools';
import * as quitState from './quit-state';
import { cmpVersion, classifyAttempt, shouldIdleInstall, shouldPromptStaleUpdate, resumeStillValid } from './update-policy';
import { installMethodFor } from './update-install-method';
import fs from 'fs';
import path from 'path';

const log = createLogger('Updater');

// v0.19.0 — was `https://github.com/AmrDab/clippyai-macos/releases/latest`.
// The repo is private, so the page itself 404'd for unauthenticated users
// even when the bubble appeared. Now points at the public marketing downloads
// page on clippyai.app, which is the single source of truth users already
// know. The electron-updater feed itself lives at download.clippyai.app/
// latest-mac.yml (configured in electron-builder.yml publish block).
//
// Windows keeps the v0.17.7 value: AmrDab/clippyai-desktop is public, and its
// releases page is where the NSIS installer + latest.yml actually live.
const RELEASE_PAGE = process.platform === 'win32'
  ? 'https://github.com/AmrDab/clippyai-desktop/releases/latest'
  : 'https://clippyai.app/downloads.html';

// macOS DMG/ZIP updates don't have the NSIS silent-failure failure mode that
// drove the failureCount/skippedVersions machinery on Windows. electron-updater
// handles DMG mounting and ZIP-based in-place replacement natively. We keep the
// state tracking infrastructure for now (cheap, useful for telemetry) but
// MAX_FAILURES_BEFORE_SKIP can stay at 1 since any failure is a clear signal.
// v0.23.2 — 2: the first failed attempt (silent) retries via the Explorer
// hand-off; only a second failure skips the version.
const MAX_FAILURES_BEFORE_SKIP = 2;

let mainWindow: BrowserWindow | null = null;
let updateDownloaded = false;
/** Version currently downloading in the background (one at a time). */
let backgroundDownloadFor: string | null = null;
let expectedVersion = '';
const skippedVersions: Set<string> = new Set();
// v0.11.23 — guard against double registration. The launchWithOnboarding
// path AND the post-onboarding IPC handler both used to call initUpdater +
// startPeriodicUpdateChecks, which registered electron-updater event
// listeners twice (so download-progress, update-downloaded, etc. fired
// twice) and scheduled two 24h setIntervals (so periodic checks ran 2×).
// Per report fbfc636e: "Checking for updates..." appeared twice on every
// scheduled tick. Idempotent guards below.
let updaterInitialized = false;
let periodicCheckScheduled = false;
// v0.21 — update offers are explicit bubble buttons, never "click Clippy".
// "Later" snoozes the offer for SNOOZE_MS (in-memory, so a relaunch clears
// it). While snoozed the 24h periodic check stays quiet and a user-quit does
// NOT run the install hand-off. Tray "Restart to update" ignores the snooze
// because it is itself an explicit user action.
const SNOOZE_MS = 24 * 60 * 60 * 1000;
let snoozedUntil = 0;
let snoozedVersion = '';
let onStateChange: (() => void) | null = null;

interface UpdaterState {
  lastAttemptedVersion: string;
  lastAttemptedAt: string;
  skippedVersions: string[];
  failureCount: Record<string, number>;
  /** When the pending version finished downloading (ISO) — for the "waited 3 days" mention. */
  downloadedVersion?: string;
  downloadedAt?: string;
  /** Version we already mentioned once because it waited days. */
  promptedVersion?: string;
  /** Set just before an idle install: come back in the state the user left. */
  resume?: { asleep: boolean; at: number };
}

function cacheDir(): string {
  // electron-updater's `updaterCacheDirName: clippyai-updater` (app-update.yml)
  // resolves to %LOCALAPPDATA%\clippyai-updater on Windows (v0.17.7 path —
  // purgeCache/stale-installer cleanup depend on it) and to
  // ~/Library/Caches/clippyai-updater on macOS. Electron 29's
  // app.getPath() doesn't expose 'cache' as a key — build it from $HOME.
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA
      || path.join(app.getPath('home'), 'AppData', 'Local');
    return path.join(base, 'clippyai-updater');
  }
  const home = app.getPath('home');
  return path.join(home, 'Library', 'Caches', 'clippyai-updater');
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
      downloadedVersion: parsed.downloadedVersion,
      downloadedAt: parsed.downloadedAt,
      promptedVersion: parsed.promptedVersion,
      resume: parsed.resume,
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
    log.warn('State write failed', serializeErr(err));
  }
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
    log.warn('Cache purge failed', serializeErr(err));
  }
}

/**
 * Boot-time detection of a silent `quitAndInstall` failure.
 *
 * Flow: installUpdate() writes `{ version, timestamp }` to updater-state.json
 * just before quitAndInstall. If we boot and find an attempt recorded for a
 * version > our current version, the install failed — NSIS likely blocked by
 * SmartScreen/AV/UAC. Escalate. (v0.24: no age cutoff. An idle install that
 * dies overnight is only noticed at the next boot, hours later; discarding it
 * as "stale" left the cached installer to be retried forever.)
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
  const ageMs = Number.isFinite(attemptedAt) ? Date.now() - attemptedAt : 0;

  if (classifyAttempt(state.lastAttemptedVersion, currentVersion) === 'succeeded') {
    // We're now on (or past) the version we attempted. Install succeeded.
    log.info('Previous install attempt succeeded', {
      attempted: state.lastAttemptedVersion,
      current: currentVersion,
    });
    // Capture the version BEFORE clearing — the previous code cleared
    // lastAttemptedVersion first then tried to delete failureCount[''],
    // leaving stale failureCount entries that never cleaned up.
    const succeededVersion = state.lastAttemptedVersion;
    telemetry.track('update_installed', { to: succeededVersion });
    state.lastAttemptedVersion = '';
    state.lastAttemptedAt = '';
    delete state.failureCount[succeededVersion];
    writeState(state);
    return state;
  }

  // Silent failure confirmed. Record it.
  const v = state.lastAttemptedVersion;
  state.failureCount[v] = (state.failureCount[v] || 0) + 1;
  telemetry.track('update_failed', { to: v, reason: 'silent_install_failure', attempt: state.failureCount[v] });
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
  if (channel === 'update-ready') telemetry.track('update_prompt', { action: 'shown', surface: 'main' });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

export function initUpdater(win: BrowserWindow): void {
  mainWindow = win;

  // v0.11.23 — idempotent. Same root cause as startPeriodicUpdateChecks:
  // both launchWithOnboarding (no license) and the post-onboarding IPC
  // handler call this. Without the guard, every autoUpdater event
  // (`update-available`, `download-progress`, `update-downloaded`,
  // `error`) would fire its handler twice. Refresh `mainWindow` above so
  // late callers point notifications at the latest BrowserWindow, then
  // bail before re-registering listeners.
  if (updaterInitialized) {
    log.debug('initUpdater: already initialized, refreshed mainWindow only');
    return;
  }
  updaterInitialized = true;

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
    if (isSnoozed(info.version)) {
      log.info('Update-available suppressed (snoozed by user)', { version: info.version });
      return;
    }
    telemetry.track('update_offered', { to: info.version });
    // Download quietly; the user is only asked once it's ready to install
    // ("Restart to update / Later" on update-downloaded). Installing still
    // always waits for that click — nothing restarts on its own.
    if (backgroundDownloadFor === info.version || updateDownloaded) return;
    backgroundDownloadFor = info.version;
    log.info('Update available — downloading in the background', { version: info.version });
    autoUpdater.downloadUpdate().catch((err) => {
      backgroundDownloadFor = null;
      log.error('Background download failed — offering a manual download', serializeErr(err));
      telemetry.track('update_failed', { to: info.version, reason: 'download_failed', error: telemetry.errorCode((err as Error)?.message) });
      sendToRenderer('update-available', info.version); // fall back to the Download / Later offer
    });
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
    telemetry.track('update_downloaded', { to: info.version });
    onStateChange?.();
    if (process.platform !== 'win32') {
      sendToRenderer('update-ready', info.version);
    } else {
      // Windows installs by itself (idle or on Quit): no bubble, no voice. The
      // tray shows "Restart to update". Only an update that has waited for days is mentioned, once.
      const st = readState();
      if (st.downloadedVersion !== info.version) {
        st.downloadedVersion = info.version;
        st.downloadedAt = new Date().toISOString();
        writeState(st);
      }
      const at = Date.parse(st.downloadedAt || '');
      if (shouldPromptStaleUpdate(Number.isFinite(at) ? at : 0, Date.now(), st.promptedVersion === info.version)) {
        st.promptedVersion = info.version;
        writeState(st);
        sendToRenderer('update-ready', info.version, true);
      }
    }
  });

  autoUpdater.on('error', (err) => {
    // v0.19.0 — classify the error class first. electron-updater fires
    // 'error' for three meaningfully different conditions: (a) installed
    // version is newer than the published feed (we're on a dev/pre-release
    // build that hasn't been published yet — NOT a failure), (b) check-
    // stage transient errors (network, 404, DNS), and (c) post-download
    // errors (signature mismatch, write fail). Treat them differently so
    // the logs are honest and we don't fire user-facing bubbles for (a)/(b).
    const msg = (err as Error)?.message || String(err);
    const isDowngradeError = /latest version.*lower than current|no published version|cannot find latest/i.test(msg);

    if (isDowngradeError) {
      // The published GitHub release is older than our installed build.
      // This is the canonical "I'm on rc.X, latest published is .Y < .X"
      // state — Clippy is on the bleeding edge. Log as INFO so our
      // production support sweeps don't flag it as a real error, and
      // never fire a bubble.
      log.info('Updater: installed version is newer than published feed (no upgrade available)', {
        installed: app.getVersion(),
        feedError: msg.substring(0, 200),
      });
      return;
    }

    log.error('Auto-update error', serializeErr(err));
    telemetry.track('update_failed', { to: expectedVersion || undefined, reason: expectedVersion ? 'updater_error' : 'check_error', error: telemetry.errorCode(msg) });

    // v0.19.0 PR-2.2 — DO NOT surface a user-facing bubble for generic
    // updater errors when we don't have a real version in hand.
    // Generic errors (network blip, 404 on the release feed, DNS
    // failure, signature mismatch on a transient byte) are not
    // actionable for the user and produce embarrassing copy like
    // "Auto-update to vunknown isn't working on this machine."
    //
    // The user-facing failure bubble only fires from the silent-
    // install-failure path (line ~482) and the skipped-version path
    // (lines 256, 291) where we have a real `info.version` to show.
    // Generic errors retry silently on the next 24h tick.
    if (!expectedVersion) {
      log.debug('Auto-update error suppressed — no expectedVersion (transient/check-stage failure)');
      return;
    }
    sendToRenderer('update-failed', {
      version: expectedVersion,
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
    log.warn('Update check failed', serializeErr(err));
  });
}

const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;

export function startPeriodicUpdateChecks(): void {
  // v0.11.23 — idempotent. Calling twice (launchWithOnboarding +
  // post-onboarding IPC handler) used to schedule two 24h timers that
  // both fired on every tick.
  if (periodicCheckScheduled) {
    log.debug('startPeriodicUpdateChecks: already scheduled, skipping');
    return;
  }
  periodicCheckScheduled = true;
  setInterval(() => {
    log.debug('Periodic update check (24h)');
    checkForUpdates();
  }, UPDATE_CHECK_INTERVAL);
}

/** v0.21 — the tray rebuilds its menu when an update becomes ready. */
export function setOnUpdateStateChange(cb: () => void): void {
  onStateChange = cb;
}

/** Version of a fully downloaded, installable update — or null. */
export function getPendingUpdateVersion(): string | null {
  return updateDownloaded ? expectedVersion : null;
}

export function snoozeUpdate(version: string): void {
  snoozedUntil = Date.now() + SNOOZE_MS;
  snoozedVersion = version;
  log.info('Update snoozed by user', { version, until: new Date(snoozedUntil).toISOString() });
  telemetry.track('update_snoozed', { to: version });
}

function isSnoozed(version: string): boolean {
  return snoozedVersion === version && Date.now() < snoozedUntil;
}

/**
 * v0.21 — called from the user-initiated quit paths (tray Quit, context-menu
 * Quit). If an update is downloaded and the user hasn't said "Later", hand
 * off to the install path, which quits the app itself. Returns true when it
 * took over the quit; the caller must then NOT call app.quit() itself.
 *
 * This is deliberately not `autoInstallOnAppQuit = true`: electron-updater's
 * quit hook runs AFTER our will-quit cleanupTools, i.e. with PSBridge still
 * holding file handles (the v0.9.9 lock bug). installUpdate() keeps the
 * v0.10.9 ordering — cleanupTools first, then the installer hand-off — and
 * on macOS it is told not to relaunch, because the user asked to quit.
 */
export function installOnUserQuit(): boolean {
  if (!updateDownloaded || isSnoozed(expectedVersion)) return false;
  // Windows (v0.24): install silently on the way out. Telemetry showed most
  // users never click "Restart now" (it opens Explorer for a double-click), so
  // downloaded updates sat uninstalled. The installer is now signed and we
  // strip Mark-of-the-Web first. If a silent attempt for this version already
  // failed, the boot-time check counted it — don't retry silently; the user
  // keeps the manual tray path.
  if (process.platform === 'win32') {
    if (installMethodFor(readState().failureCount[expectedVersion] || 0) !== 'silent') return false;
    void installSilently('on_quit');
    return true;
  }
  log.info('User quit with a downloaded update — installing on the way out', { version: expectedVersion });
  autoUpdater.autoRunAppAfterInstall = false;
  void installUpdate();
  return true;
}

/**
 * v0.24 — Windows silent install. Same ordering as installUpdate() (record
 * the attempt, release PSBridge locks, clear a stale installer.exe), then a
 * silent NSIS run. 'on_quit': no relaunch, because the user asked to quit.
 * 'idle': the PC has been untouched for a while, so relaunch on the new
 * version. A silent failure is caught on the next boot by detectSilentFailure().
 */
async function installSilently(mode: 'on_quit' | 'idle'): Promise<void> {
  if (process.platform !== 'win32') return; // NSIS + PowerShell path; macOS uses installUpdate()
  const relaunch = mode === 'idle';
  const installerPath = (autoUpdater as unknown as {
    downloadedUpdateHelper?: { file?: string };
  }).downloadedUpdateHelper?.file || '';
  log.info(relaunch ? 'PC idle with a downloaded update — installing silently' : 'User quit with a downloaded update — installing silently', { version: expectedVersion, installerPath });
  if (relaunch && (!installerPath || !fs.existsSync(installerPath))) {
    log.warn('Idle install skipped — no installer on disk', { version: expectedVersion });
    telemetry.track('update_failed', { to: expectedVersion, reason: 'install_not_started', mode });
    return;
  }
  telemetry.track('update_install_started', { to: expectedVersion, mode });
  telemetry.flushBeforeInstall();

  const state = readState();
  state.lastAttemptedVersion = expectedVersion;
  state.lastAttemptedAt = new Date().toISOString();
  writeState(state);

  try { cleanupTools(); } catch (err) { log.warn('cleanupTools error (non-fatal)', serializeErr(err)); }
  try {
    const staleInstaller = path.join(cacheDir(), 'installer.exe');
    if (fs.existsSync(staleInstaller)) fs.unlinkSync(staleInstaller);
  } catch (err) {
    log.warn('Install.cacheClean failed (non-fatal)', serializeErr(err));
  }
  if (installerPath && fs.existsSync(installerPath)) {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      await promisify(execFile)('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Unblock-File -LiteralPath '${installerPath.replace(/'/g, "''")}'`,
      ], { timeout: 4000 });
    } catch (err) {
      log.warn('Install.unblockMOTW failed (non-fatal)', serializeErr(err));
    }
  }

  quitState.setQuitting();
  let started = true;
  try {
    // electron-updater 6.x returns false (it does not throw) when it could not start the installer.
    started = (autoUpdater.quitAndInstall(true, relaunch) as unknown) !== false;
  } catch (err) {
    log.error('quitAndInstall threw', serializeErr(err));
    started = false;
  }
  if (!started) {
    installNotStarted(mode);
    return;
  }
  if (!relaunch) {
    // quitAndInstall only quits when it managed to start the installer. The
    // user asked to quit either way — make sure we do.
    setTimeout(() => app.quit(), 3000);
  } else {
    // Belt and braces: a relaunching install quits within moments. Still alive
    // well after the call means nothing ran — undo the prep and carry on.
    setTimeout(() => { if (quitState.isQuitting()) installNotStarted(mode); }, 20_000).unref?.();
  }
}

/**
 * The installer hand-off did not start. Forget the recorded attempt (the next
 * boot must not count a failure that never ran). On an idle install nobody
 * asked to quit: stay up, make closing the window hide to tray again and give
 * the PowerShell host back. On a user quit the app still quits.
 */
function installNotStarted(mode: 'on_quit' | 'idle'): void {
  log.error('Install not started', { mode, version: expectedVersion });
  telemetry.track('update_failed', { to: expectedVersion, reason: 'install_not_started', mode });
  const st = readState();
  st.lastAttemptedVersion = '';
  st.lastAttemptedAt = '';
  writeState(st);
  if (mode === 'on_quit') {
    setTimeout(() => app.quit(), 3000);
    return;
  }
  quitState.setQuitting(false);
  const st2 = readState();
  delete st2.resume;
  writeState(st2);
  try { restoreTools(); } catch (err) { log.warn('restoreTools error (non-fatal)', serializeErr(err)); }
}

// ── v0.24 idle install ────────────────────────────────────────────────
const IDLE_CHECK_MS = 60_000;
let idleWatcher: ReturnType<typeof setInterval> | null = null;
let idleInstallTried = false;

/**
 * Once an update is downloaded, install it (with relaunch) when no task is
 * running and the PC has been idle for 10 minutes. `isTaskActive` is the
 * brain's in-flight-task flag; `isBusyElsewhere` covers open setup/Settings windows,
 * an agent session, a game and a pending approval prompt. Idempotent; one attempt per process, so a
 * silent failure can't loop — the next boot's check counts it.
 */
export function startIdleInstall(isTaskActive: () => boolean, isBusyElsewhere: () => boolean, isAsleep: () => boolean = () => false): void {
  if (idleWatcher || process.platform !== 'win32') return;
  idleWatcher = setInterval(() => {
    try {
      if (!updateDownloaded) return;
      if (!shouldIdleInstall({
        platform: process.platform,
        updateDownloaded,
        failedBefore: (readState().failureCount[expectedVersion] || 0) > 0,
        taskRunning: isTaskActive(),
        busyElsewhere: isBusyElsewhere(),
        idleSeconds: powerMonitor.getSystemIdleTime(),
        alreadyTried: idleInstallTried,
      })) return;
      idleInstallTried = true;
      // Silent relaunch: remember whether Clippy was asleep so he comes back the same way.
      const st = readState();
      st.resume = { asleep: isAsleep(), at: Date.now() };
      writeState(st);
      void installSilently('idle');
    } catch (err) {
      log.warn('Idle install check failed (non-fatal)', serializeErr(err));
    }
  }, IDLE_CHECK_MS);
}

export function downloadUpdate(): void {
  log.info('User accepted update — downloading');
  autoUpdater.downloadUpdate().catch((err) => {
    log.error('Download failed', serializeErr(err));
    telemetry.track('update_failed', { reason: 'download_failed', error: telemetry.errorCode((err as Error)?.message) });
  });
}

/**
 * Open the cached installer if available, otherwise fall back to the GitHub
 * release page. This lets the user click through the SmartScreen "More info
 * → Run anyway" prompt without re-downloading anything.
 *
 * SmartScreen blocks the NSIS /S (silent) flag on unsigned installers, but
 * the same installer opened interactively via shell.openPath IS allowed —
 * Windows shows the SmartScreen dialog and the user can approve it.
 */
export function openManualUpdatePage(): void {
  const cachedInstaller = path.join(cacheDir(), 'installer.exe');
  if (fs.existsSync(cachedInstaller)) {
    log.info('Opening cached installer (SmartScreen dialog will appear)', { cachedInstaller });
    shell.openPath(cachedInstaller).then((err) => {
      if (err) {
        log.warn('shell.openPath failed, falling back to releases page', err);
        shell.openExternal(RELEASE_PAGE).catch(() => {});
      }
    });
  } else {
    log.info('No cached installer — opening releases page', { url: RELEASE_PAGE });
    shell.openExternal(RELEASE_PAGE).catch((err) => {
      log.warn('Failed to open release page', serializeErr(err));
    });
  }
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
export async function installUpdate(): Promise<void> {
  if (!updateDownloaded) {
    log.warn('installUpdate called but no update downloaded');
    return;
  }

  const installerPath = (autoUpdater as unknown as {
    downloadedUpdateHelper?: { file?: string };
  }).downloadedUpdateHelper?.file || '(unknown)';

  telemetry.track('update_install_started', { to: expectedVersion });
  telemetry.flushBeforeInstall();
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
    log.warn('cleanupTools error (non-fatal)', serializeErr(err));
  }

  // macOS (Squirrel.Mac): electron-updater installs by unpacking the downloaded
  // ZIP and swapping the .app bundle in place, then relaunching. EVERYTHING
  // below this point — installer.exe lookup, PowerShell Unblock-File, Explorer
  // hand-off — is Windows-NSIS-specific and never installs on macOS (it hunts
  // for a .exe, shells powershell.exe, and shows Finder a file the user can't
  // run). Hand straight to quitAndInstall. isSilent=false lets Squirrel do its
  // normal swap; isForceRunAfter=true relaunches Clippy on the new version.
  if (process.platform === 'darwin') {
    log.info('Install.exec', { action: 'quitAndInstall', platform: 'darwin', installerPath });
    // The main window's close handler hides-to-tray by default and would block
    // the quit quitAndInstall needs (app hangs, update never swaps). Flag a
    // real quit so the window is allowed to close. See quit-state.ts.
    quitState.setQuitting();
    // v0.21 — installOnUserQuit() clears autoRunAppAfterInstall so a plain
    // Quit swaps the bundle without relaunching; the explicit "Restart to
    // update" button keeps the relaunch.
    const relaunch = autoUpdater.autoRunAppAfterInstall;
    sendToRenderer('clippy-speak', {
      text: relaunch
        ? `v${expectedVersion} is ready — installing now. I'll be right back on the new version! 📎`
        : `Installing v${expectedVersion} on the way out. See you on the new version next time! 📎`,
      animate: 'GetAttention',
    });
    // Small delay so the message paints before the app quits to swap itself.
    setTimeout(() => autoUpdater.quitAndInstall(false, relaunch), 1200);
    return;
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
    log.warn('Install.cacheClean failed (non-fatal)', serializeErr(err));
  }

  // Phase 3: Hand the installer to the user via Explorer. (v0.11.24)
  //
  // === ARCHITECTURAL ROOT-CAUSE FIX ===
  // After 12 patches across v0.11.6 → v0.11.23 trying to programmatically
  // launch the installer (quitAndInstall silent, quitAndInstall non-silent,
  // shell.openPath, child_process.spawn), the failure mode kept shifting:
  //   v0.11.6 - silent install blocked by SmartScreen, no UI
  //   v0.11.17 - non-silent quitAndInstall, NSIS oneClick still hides UI
  //   v0.11.18 - shell.openPath inherited Electron's invisible-window flag
  //   v0.11.21 - child_process.spawn(detached) — succeeds, then NSIS dies
  //              silently because Mark of the Web + low-reputation publisher
  //              => SmartScreen kills oneClick installers with no dialog
  //
  // The root cause is structural, not technical: you cannot reliably
  // auto-launch an installer from a quitting Electron parent process on
  // modern Windows when:
  //   (a) the parent holds file locks the installer needs to release,
  //   (b) SmartScreen treats programmatic launches of low-reputation
  //       signed installers as suspicious and silently kills oneClick
  //       installers (no UI exists for "Run anyway"),
  //   (c) AV heuristics flag parent-process-replacement.
  //
  // Squirrel.windows solves this with a separate updater-helper process
  // that outlives the app. That's a 200+ LOC architectural rewrite. The
  // simpler fix that works 100% of the time:
  //
  //   1. Strip Mark-of-the-Web from the cached installer (Unblock-File)
  //   2. Open File Explorer with the installer selected
  //   3. User double-clicks → Windows handles the launch the way it
  //      knows how → SmartScreen "Run anyway" appears naturally → install
  //      completes → ClippyAI auto-relaunches via NSIS runAfterFinish
  //
  // Tradeoff: one extra click vs full auto-install. After 12 failed
  // patches, we accept the click.
  if (!installerPath || installerPath === '(unknown)' || !fs.existsSync(installerPath)) {
    log.error('Install.exec aborted — no installer at expected path', { installerPath });
    telemetry.track('update_failed', { to: expectedVersion, reason: 'installer_missing' });
    sendToRenderer('update-failed', {
      version: expectedVersion || 'unknown',
      reason: 'installer-missing',
      manualUrl: RELEASE_PAGE,
    });
    return;
  }

  // Step 1 — strip Mark-of-the-Web. PowerShell's Unblock-File removes the
  // Zone.Identifier alternate data stream that Windows attaches to files
  // downloaded from the internet. Without this, SmartScreen can engage
  // even when the user double-clicks, because the file is still flagged
  // as "downloaded." Best-effort — non-fatal if it fails.
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Unblock-File -LiteralPath '${installerPath.replace(/'/g, "''")}'`,
    ], { timeout: 4000 });
    log.info('Install.unblockedMOTW', { installerPath });
  } catch (err) {
    log.warn('Install.unblockMOTW failed (non-fatal)', serializeErr(err));
  }

  // v0.23.2 — silent install first: the installer is signed and this copy
  // has no Mark-of-the-Web, so NSIS runs without SmartScreen. The Explorer
  // hand-off below is the fallback once a silent attempt didn't land.
  if (installMethodFor(state.failureCount[expectedVersion] || 0) === 'silent') {
    const relaunch = autoUpdater.autoRunAppAfterInstall;
    log.info('Install.exec', { action: 'quitAndInstall', platform: 'win32', relaunch, installerPath });
    sendToRenderer('clippy-speak', {
      text: relaunch
        ? `Installing v${expectedVersion}. I'll be right back on the new version! 📎`
        : `Installing v${expectedVersion} on the way out. See you on the new version next time! 📎`,
      animate: 'GetAttention',
    });
    quitState.setQuitting();
    setTimeout(() => autoUpdater.quitAndInstall(true, relaunch), 1200);
    return;
  }

  // Step 2 — open File Explorer with the installer selected. The user
  // double-clicks to install; NSIS runAfterFinish auto-relaunches Clippy.
  // shell.showItemInFolder is sync on Windows and never throws.
  log.info('Install.exec', { action: 'showItemInFolder', installerPath });
  shell.showItemInFolder(installerPath);

  // Speak after opening Explorer so the message lands in front of the
  // user (Explorer takes focus). 2.5s gives them time to read before
  // Clippy quits to release file locks for the install.
  sendToRenderer('clippy-speak', {
    text: `v${expectedVersion} is downloaded and ready! I just opened Explorer with the installer — double-click ClippyAI-Setup-${expectedVersion}.exe to update. I'll relaunch on the new version automatically. 📎`,
    animate: 'GetAttention',
  });

  // Quit after 4 seconds so file locks release and the user has time to
  // see the message. The user may take longer than 4s to actually click;
  // that's fine — once we quit, locks release and the install can run
  // when they do. setQuitting() so the hide-to-tray close handler doesn't
  // block the quit (which would keep file locks held → install can't replace
  // the running exe).
  quitState.setQuitting();
  setTimeout(() => app.quit(), 4000);
}

/** First launch after an idle-install relaunch: how the user left Clippy (once), or null. */
export function consumeUpdateResume(): { asleep: boolean } | null {
  const st = readState();
  if (!st.resume) return null;
  const r = st.resume;
  delete st.resume;
  writeState(st);
  return resumeStillValid(r.at, Date.now()) ? { asleep: r.asleep } : null;
}
