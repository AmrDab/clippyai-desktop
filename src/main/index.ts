import { app, BrowserWindow, globalShortcut, crashReporter } from 'electron';
import fs from 'fs';
import path from 'path';

// ── EARLY BOOT DIAGNOSTICS (BEFORE any other code) ───────────────────
//
// A customer hit a 0xc0000005 access violation in Electron's native
// bootstrap — logger.ts had not yet been initialized, so we have no trace
// of what stage of startup failed. Everything below must run BEFORE any
// other import or initialization can possibly trigger a crash.

// 1. Persist a tiny "I got this far" marker to a guaranteed-writable path
//    so we can see in the next launch exactly which startup phase died.
const BOOT_LOG_PATH = (() => {
  try {
    // app.getPath('userData') isn't available before whenReady, but the
    // path is deterministic and we can compute it. On Windows:
    //   %APPDATA%\ClippyAI\boot.log
    const appData = process.env.APPDATA || '';
    const dir = path.join(appData, 'ClippyAI');
    if (appData && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'boot.log');
  } catch { return ''; }
})();

function bootLog(phase: string): void {
  if (!BOOT_LOG_PATH) return;
  try {
    const line = `${new Date().toISOString()} | pid=${process.pid} | ${phase}\n`;
    // appendFileSync is synchronous — even if we crash the next line, this
    // line has flushed to disk.
    fs.appendFileSync(BOOT_LOG_PATH, line);
  } catch { /* ignore — we tried */ }
}

bootLog('PROCESS_START');

// 2. Enable the native crash reporter IMMEDIATELY. Writes a .dmp file to
//    app.getPath('crashDumps') when the main or any child process crashes.
//    uploadToServer:false — we don't have a crash-receive endpoint, users
//    can attach the dump via the Report Issue feature instead.
try {
  crashReporter.start({
    productName: 'ClippyAI',
    companyName: 'Cloudana',
    submitURL: '', // required field, empty is fine with uploadToServer:false
    uploadToServer: false,
    ignoreSystemCrashHandler: false,
    compress: true,
  });
  bootLog('CRASH_REPORTER_STARTED');
} catch (err) {
  bootLog(`CRASH_REPORTER_FAILED: ${err instanceof Error ? err.message : String(err)}`);
}

// 3. Disable hardware acceleration. A broken GPU driver on the customer's
//    machine can tear down the main process with 0xc0000005 when Chromium
//    tries to initialize the GPU subsystem. Running CPU-only is a bit
//    slower for canvas animation but rock-solid on mismatched hardware.
//    If this ever becomes a visible perf issue, we can expose a setting to
//    flip it back on — but for a static sprite-sheet animation it's moot.
app.disableHardwareAcceleration();
bootLog('HW_ACCELERATION_DISABLED');

import { createWindow, createOnboardingWindow } from './window';
import { setupTray } from './tray';
import { registerHotkey } from './hotkey';
import { Brain } from './brain';
import { registerIpcHandlers } from './ipc';
import { initStartup } from './startup';
import { isLicensed, revalidateIfNeeded } from './license';
import { isProfileSetUp } from './brain';
import { initTools, cleanupTools } from './tools';
import { createLogger, cleanOldLogs } from './logger';
import { initUpdater, checkForUpdates, startPeriodicUpdateChecks } from './updater';

bootLog('IMPORTS_LOADED');

const log = createLogger('App');

// ── Single instance lock ─────────────────────────────────────────
// BUG FIX: `app.quit()` is async — it queues a quit for the next tick but
// execution continues. If we didn't early-return here, the rest of this file
// (whenReady handler, window creation, etc.) would still run in parallel with
// the quit, racing against the primary instance. That's how we'd get "Clippy
// refuses to open after update" — the new process launches as a second
// instance, tries to initialize, and crashes half-initialized.
// Using app.exit(0) for synchronous immediate shutdown.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log.info('Another instance is already running — quitting');
  app.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let brain: Brain | null = null;

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Suppress uncaught errors from PowerShell pipes
process.on('uncaughtException', (err) => {
  if (err.message?.includes('EPIPE') || err.message?.includes('broken pipe')) {
    log.warn('Suppressed pipe error', err.message);
    return;
  }
  bootLog(`UNCAUGHT_EXCEPTION: ${err.message}`);
  log.error('Uncaught exception', err.message);
  app.exit(1);
});

// Unhandled promise rejections — previously silent, could mask bugs.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  bootLog(`UNHANDLED_REJECTION: ${msg}`);
  log.error('Unhandled rejection', msg);
  // Do NOT exit — promise rejections are usually recoverable (network
  // errors, missing optional features). Logging is enough.
});

app.whenReady().then(async () => {
  bootLog('APP_READY');
  log.info('ClippyAI starting', { version: app.getVersion() });
  log.info('Crash dumps path', crashReporter.getUploadedReports()
    ? app.getPath('crashDumps')
    : '(not available)');
  initStartup();
  cleanOldLogs();

  // Initialize direct tools (in-process, no server)
  try {
    await initTools();
  } catch (err) {
    log.warn('Tools init failed — desktop automation may be limited', String(err));
  }

  if (isLicensed()) {
    log.info('License found, revalidating...');
    const stillValid = await revalidateIfNeeded();
    if (stillValid) {
      bootLog('LAUNCHING_MAIN');
      launchMainApp();
    } else {
      bootLog('LICENSE_INVALID_ONBOARDING');
      log.warn('License key no longer valid — showing onboarding');
      launchWithOnboarding();
    }
  } else {
    bootLog('NO_LICENSE_ONBOARDING');
    log.info('No valid license — showing onboarding');
    launchWithOnboarding();
  }
  bootLog('WHENREADY_COMPLETE');
});

function launchMainApp(): void {
  mainWindow = createWindow();
  brain = new Brain(mainWindow);
  registerIpcHandlers(brain, mainWindow);
  setupTray(mainWindow, brain);
  registerHotkey(mainWindow, brain);

  brain.setMode('awake');
  mainWindow.webContents.send('mode-change', 'awake');

  initUpdater(mainWindow);
  setTimeout(() => checkForUpdates(), 10_000);
  startPeriodicUpdateChecks(); // re-check every 24h in case app stays running

  if (!isProfileSetUp()) {
    setTimeout(() => {
      mainWindow?.webContents.send('clippy-speak', {
        text: "Hey! I don't think we've met yet. What should I call you? Just type your name! 📎",
        animate: 'Wave',
      });
    }, 3000);
  }

  log.info('ClippyAI ready');
}

function launchWithOnboarding(): void {
  mainWindow = createWindow();
  mainWindow.hide();
  brain = new Brain(mainWindow);
  registerIpcHandlers(brain, mainWindow);
  setupTray(mainWindow, brain);
  registerHotkey(mainWindow, brain);

  createOnboardingWindow();
  log.info('Onboarding window opened, waiting for license entry');
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  cleanupTools();
  log.info('ClippyAI shutting down');
});

app.on('window-all-closed', () => {
  // Stay alive in system tray
});
