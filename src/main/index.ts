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
import { createLogger, cleanOldLogs, serializeErr } from './logger';
import { initUpdater, checkForUpdates, startPeriodicUpdateChecks } from './updater';
import { startScheduler, stopScheduler } from './scheduler';

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

// Uncaught errors — log loudly, never crash. Previously called app.exit(1)
// which killed the user's session mid-task on any non-EPIPE throw (e.g.
// PSBridge stdout listener throwing because psQueue.shift() returned
// undefined). The asymmetry with unhandledRejection (which only logs) was
// itself a bug — they should behave the same way. The user sees Clippy
// "shut down on its own and had to be reopened mid task" because of this.
//
// EPIPE BRANCH REMOVED (was lines 113-115).
// What it was masking: psCommand() in tools.ts used psBridge! (non-null
// assertion) to write to stdin AFTER the exit handler could have nulled
// psBridge — a classic TOCTOU race. The OS pipe was closed but the write
// still fired, producing EPIPE. The swallower hid ~500K of these per
// session from clippy-2026-05-05.log.1.
//
// Why it is now safe to remove: tools.ts safePsWrite() wraps every
// stdin.write() in try/catch and returns boolean. psCommand() atomically
// snapshots psBridge before the ready-check and uses the snapshot for
// the write — the module variable changing concurrently no longer matters.
// No write can reach an uncaught exception path.
//
// How to detect regression: if EPIPE ever returns here, search boot.log
// for lines matching "UNCAUGHT_EXCEPTION.*EPIPE". That would mean a new
// code path in tools.ts (or elsewhere) is writing to a pipe without going
// through safePsWrite.
process.on('uncaughtException', (err) => {
  bootLog(`UNCAUGHT_EXCEPTION: ${err.message}`);
  log.error('Uncaught exception (continuing)', err.stack || err.message);
  // Do NOT exit. The renderer + agent loop are robust to one tool failing.
  // A crash here is worse than any individual tool error.
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
  // v0.17.7 — single canonical startup line with OS + version + node info so
  // every support report has unambiguous platform attribution. Before this,
  // os_platform only appeared in the system-info bundle header — JSONL log
  // lines had no OS marker, making mac-vs-windows triage harder.
  log.info('System.startup', {
    app_version: app.getVersion(),
    os_platform: process.platform,        // 'win32' | 'darwin' | 'linux'
    os_release: require('os').release(),
    os_arch: process.arch,
    electron_version: process.versions.electron,
    node_version: process.versions.node,
  });
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
    log.warn('Tools init failed — desktop automation may be limited', serializeErr(err));
  }

  // Tier 5 fallback: clawdcursor is optional. Spawn in background; missing
  // or broken clawdcursor must NEVER block clippy from starting.
  import('./clawd-fallback').then((m) =>
    m.startClawd().catch((err) => log.warn('clawdcursor fallback unavailable', err.message)),
  );

  // v0.13.0 — mail-environment probe (classic Outlook? olk? default mailto
  // handler?). Cached + injected into system prompt context so the model
  // picks the right send-email backend on the first call rather than
  // trial-and-error through all 5 paths.
  import('./mail-env').then((m) =>
    m.probeMailEnvironment().catch((err) => log.warn('mail-env probe failed (non-fatal)', err.message)),
  );

  // v0.15.0 — mcp-chrome probe. Detects whether the user has the mcp-chrome
  // extension running on localhost:12306. When present, browser tools route
  // through the user's REAL signed-in tabs instead of a spawned debug
  // browser. Non-blocking; the extension is optional.
  import('./mcp-chrome').then((m) =>
    m.probeMcpChrome().then((s) => {
      if (s.ready) log.info('mcp-chrome ready — browser tools will use user session');
      else log.info('mcp-chrome not detected — browser tools will use spawned CDP fallback');
    }).catch((err) => log.warn('mcp-chrome probe failed (non-fatal)', err.message)),
  );

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

  // v0.16.0 — start the cursor position pump at 1Hz so Clippy can glance
  // toward the user's cursor. Renderer's cursor-look logic throttles
  // glances to one per 8s. Bumps to 30Hz briefly during play-tag mode
  // via the play-tag IPC handlers in ipc.ts.
  import('./window').then((w) => {
    if (mainWindow) w.startCursorPoll(mainWindow);
  });

  // v0.19.0 — inject window reference into follow-me module so subsequent
  // callers (tools, IPC) don't need to pass it explicitly.
  import('./follow-me').then((fm) => {
    if (mainWindow) fm.setMainWindow(mainWindow);
  }).catch((err: Error) => log.warn('follow-me module load failed (non-fatal)', err.message));

  brain.setMode('awake');
  mainWindow.webContents.send('mode-change', 'awake');

  initUpdater(mainWindow);
  setTimeout(() => checkForUpdates(), 10_000);
  startPeriodicUpdateChecks(); // re-check every 24h in case app stays running

  // v0.16.1 — time-based liveliness pings (morning greet, stretch reminder,
  // wrap-up tip). Setinterval-based, gated on brain.getMode() === 'awake'
  // and once-per-day for daily events. See src/main/scheduler.ts.
  startScheduler(mainWindow, brain);

  if (!isProfileSetUp()) {
    setTimeout(() => {
      // D9: log direct webContents.send so the audit trail matches what
      // the user actually saw on screen.
      const text = "Hey! I don't think we've met yet. What should I call you? Just type your name! 📎";
      log.info('Clippy.say', { text, animation: 'Wave', trigger: 'name_prompt' });
      mainWindow?.webContents.send('clippy-speak', { text, animate: 'Wave' });
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

  // Wire updater here too — unlicensed users are the MOST likely to be on
  // a stale version (they may have installed once long ago, never paid,
  // and never relaunched). Without this, they could never auto-update.
  initUpdater(mainWindow);
  setTimeout(() => checkForUpdates(), 10_000);
  startPeriodicUpdateChecks();

  createOnboardingWindow();
  log.info('Onboarding window opened, waiting for license entry');
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopScheduler();
  // Stop clawdcursor first — SIGTERM is async, so this fires the signal
  // and returns immediately. clawdcursor exits cleanly on SIGTERM thanks
  // to the MCP server lifecycle changes; if it's slow, stopClawd's 2s
  // grace + SIGKILL fallback runs in the background while we proceed.
  import('./clawd-fallback')
    .then((m) => m.stopClawd())
    .catch((err) => log.warn('clawdcursor stop failed', serializeErr(err)));
  cleanupTools();
  log.info('ClippyAI shutting down');
});

app.on('window-all-closed', () => {
  // Stay alive in system tray
});
