import { app, BrowserWindow, globalShortcut, crashReporter, powerMonitor } from 'electron';
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
    // path is deterministic per-platform:
    //   Windows: %APPDATA%\ClippyAI\boot.log
    //   macOS:   ~/Library/Application Support/ClippyAI/boot.log
    // v0.20 port note: the mac fork hardcoded the darwin path; restored
    // the win32 branch when the tree was adopted back into this repo.
    let dir = '';
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || '';
      if (!appData) return '';
      dir = path.join(appData, 'ClippyAI');
    } else {
      const home = process.env.HOME || '';
      if (!home) return '';
      dir = path.join(home, 'Library', 'Application Support', 'ClippyAI');
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

// 3. Disable hardware acceleration ON WINDOWS ONLY.
//
// HISTORY: a broken GPU driver on Windows customer machines tore down the
// main process with 0xc0000005 (access violation) when Chromium tried to
// initialize the GPU subsystem. CPU-only rendering was the safe choice.
//
// v0.20.0-alpha.3 — gated to win32. On macOS the GPU stack is far more
// stable AND the always-on-top translucent bubble + sprite animations rely
// on Core Animation / Metal to feel fluid. With this flag set unconditionally
// every CSS transform, every sprite drawImage, every setBounds on the
// frameless transparent window went through SwiftShader (software WebGL).
// That's "0% CPU but the interface still feels laggy" — the GPU process
// shipped with --use-gl=angle --use-angle=swiftshader-webgl and the
// renderer with --disable-gpu-compositing. Visible in `ps aux` on alpha.2.
//
// If a Mac user ever reports a GPU crash, we can flip this back to
// unconditional + add a setting — but the default needs to favor real
// GPU acceleration on the platform that handles it well.
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
  bootLog('HW_ACCELERATION_DISABLED');
}

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
// v0.20.0-alpha.12 — STATIC import (NOT dynamic import()/require()) so
// Rollup keeps this module in the bundle. The alpha.11 attempt used
// `import('./window-follow').then(...)` and `require('./window-follow')`
// which both get tree-shaken; the runtime crashed with "module load
// failed (non-fatal)". 5th occurrence of this Rollup bug — see memory
// entry feedback-clippy-bundle-anchors.
import * as windowFollowMod from './window-follow';
import * as quitState from './quit-state';
import { brainSettingsStore } from './brain';

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
// HARDENED (v0.20.0): the prior handler logged only `reason.message`, which
// made the 29h, 18,544-line "conversion failure" storm in
// clippy-2026-05-27.log impossible to trace — no stack, and it flooded the
// log at 1Hz forever. We now (1) log the full stack on the FIRST sighting of
// each distinct reason, and (2) rate-limit repeats so a tight reject loop can
// never flood again: repeats are counted and summarized at most once/minute.
interface RejectionRecord { count: number; lastLoggedAt: number; }

/**
 * Pure throttle bookkeeping for the unhandledRejection handler, extracted so
 * the rate-limit logic can be unit-tested without spawning a process or
 * triggering real rejections (see scripts/test-rejection-throttle.js).
 *
 * Mutates `map` in place and returns a decision:
 *   - isFirst:   true on the FIRST sighting of `key` — the caller should log
 *                the full stack.
 *   - shouldLog: true when the caller should emit a log line. Always true on
 *                the first sighting; on repeats, true at most once per
 *                throttleMs (and resets the window + repeat counter when it
 *                fires) so a tight reject loop can never flood again.
 *   - count:     repeats accumulated since the last log fired (0 on first
 *                sighting; the running tally otherwise, reset to 0 when a
 *                throttled summary is emitted).
 *
 * Behavior is identical to the prior inline handler: first → log with stack;
 * repeats → counted, summarized at most once/minute.
 */
export function recordRejection(
  map: Map<string, RejectionRecord>,
  key: string,
  now: number,
  throttleMs: number,
): { shouldLog: boolean; isFirst: boolean; count: number } {
  const seen = map.get(key);
  if (!seen) {
    map.set(key, { count: 0, lastLoggedAt: now });
    return { shouldLog: true, isFirst: true, count: 0 };
  }
  seen.count++;
  if (now - seen.lastLoggedAt >= throttleMs) {
    seen.lastLoggedAt = now;
    const count = seen.count;
    seen.count = 0;
    return { shouldLog: true, isFirst: false, count };
  }
  return { shouldLog: false, isFirst: false, count: seen.count };
}

const _rejThrottle = new Map<string, RejectionRecord>();
const _REJ_THROTTLE_MS = 60_000;
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? (reason.stack || msg) : msg;
  const key = msg || 'unknown';
  const now = Date.now();
  const decision = recordRejection(_rejThrottle, key, now, _REJ_THROTTLE_MS);
  if (decision.isFirst) {
    bootLog(`UNHANDLED_REJECTION: ${msg}`);
    log.error('Unhandled rejection', stack);
  } else if (decision.shouldLog) {
    log.error('Unhandled rejection (repeating)', `${stack} — ${decision.count}× in the last minute`);
  }
  // Do NOT exit — promise rejections are usually recoverable (network
  // errors, missing optional features). Logging is enough.
});

app.whenReady().then(async () => {
  bootLog('APP_READY');
  log.info('ClippyAI starting', { version: app.getVersion() });
  log.info('Crash dumps path', app.getPath('crashDumps'));

  // Clippy reads his own brain files before doing anything else. The
  // result is cached; the same OrientationResult is what the onboarding
  // window queries via the orient-brain IPC. See src/main/orient.ts for
  // the canonical-truth rationale.
  const { orient } = await import('./orient');
  orient();

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

/**
 * Wire Electron's powerMonitor to Clippy's mode so Clippy sleeps when
 * the OS sleeps (or the screen locks) and wakes when it wakes. Runs once
 * at app launch and is idempotent — `app` is a singleton so re-listeners
 * would just stack up; we only call this from launchMainApp.
 *
 * Behavior:
 *   - Remembers the mode we were in BEFORE the suspend so manual-sleep
 *     state survives a lock/unlock cycle. If you manually put Clippy to
 *     sleep and then lock the screen, unlock does NOT auto-wake him.
 *   - Only restores to 'awake' on resume; never auto-flips from 'sleep'
 *     to 'awake' if the user didn't choose 'awake' themselves.
 *
 * Cross-platform:
 *   macOS    — suspend (sleep/lid), resume, lock-screen, unlock-screen
 *   Windows  — suspend, resume, lock-screen, unlock-screen
 *   Linux    — suspend, resume (lock-screen support varies by DE)
 */
let _powerMonitorWired = false;
let _modeBeforeSuspend: 'awake' | 'sleep' | null = null;

function wirePowerMonitor(brainRef: Brain, mw: BrowserWindow): void {
  if (_powerMonitorWired) return;
  _powerMonitorWired = true;

  const goToSleep = (trigger: string): void => {
    if (brainRef.getMode() === 'sleep') {
      log.info('PowerMonitor.suspend_noop', { trigger, reason: 'already_sleeping' });
      return;
    }
    _modeBeforeSuspend = 'awake';
    log.info('PowerMonitor.suspend → sleep', { trigger });
    brainRef.setMode('sleep');
    if (!mw.isDestroyed()) mw.webContents.send('mode-change', 'sleep');
  };

  const wakeIfWeSlept = (trigger: string): void => {
    if (_modeBeforeSuspend !== 'awake') {
      log.info('PowerMonitor.resume_noop', { trigger, reason: 'was_not_auto_slept' });
      return;
    }
    _modeBeforeSuspend = null;
    log.info('PowerMonitor.resume → awake', { trigger });
    brainRef.setMode('awake');
    if (!mw.isDestroyed()) mw.webContents.send('mode-change', 'awake');
  };

  powerMonitor.on('suspend', () => goToSleep('suspend'));
  powerMonitor.on('resume', () => wakeIfWeSlept('resume'));
  powerMonitor.on('lock-screen', () => goToSleep('lock-screen'));
  powerMonitor.on('unlock-screen', () => wakeIfWeSlept('unlock-screen'));

  // Wake-on-activity watchdog. macOS can fire a spurious `suspend` with NO
  // matching `resume` (observed: resume → suspend 1.4s later → stuck asleep
  // 51 min while the user kept working). Since wake otherwise only happens on
  // an OS resume/unlock, Clippy gets stranded asleep — and an asleep Clippy
  // stops following windows ("can't switch between windows"). Safety net: if we
  // auto-slept (_modeBeforeSuspend==='awake') but the user is clearly active
  // (low system idle), wake back up. Only ever undoes OUR auto-sleep; a real
  // system sleep suspends this process so the timer doesn't run.
  const WAKE_WATCHDOG_MS = 4000;
  const WAKE_ON_ACTIVITY_IDLE_SEC = 3;
  setInterval(() => {
    try {
      if (brainRef.getMode() !== 'sleep') return;
      if (_modeBeforeSuspend !== 'awake') return; // honor manual/real sleeps
      if (powerMonitor.getSystemIdleTime() <= WAKE_ON_ACTIVITY_IDLE_SEC) {
        wakeIfWeSlept('activity-watchdog');
      }
    } catch { /* non-fatal */ }
  }, WAKE_WATCHDOG_MS);
  // 'shutdown' fires on Linux/macOS when the OS is about to shut down.
  // We can't block it; just log so we know why the next session looks
  // like a fresh start.
  powerMonitor.on('shutdown', () => log.info('PowerMonitor.shutdown', { pid: process.pid }));

  log.info('PowerMonitor wired', { platform: process.platform });
}

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

  // v0.20.0-alpha.11 — start the focused-window follow loop. Polls the
  // active-window API at 1Hz and glides Clippy to the bottom-right corner
  // of whatever window is in front, so he doesn't seem "stuck" when the
  // user switches Spaces / monitors / apps. Respects a 30s cooldown after
  // any manual drag and skips during in-flight tool calls.
  try {
    const enabled = brainSettingsStore.get('windowFollowEnabled');
    if (enabled !== false) {
      windowFollowMod.startWindowFollow(mainWindow, brain);
    } else {
      log.info('WindowFollow disabled in settings, skipping start');
    }
  } catch (err) {
    log.warn('WindowFollow start failed (non-fatal)', serializeErr(err));
  }

  brain.setMode('awake');
  mainWindow.webContents.send('mode-change', 'awake');

  // v0.20.0-alpha.7 — follow the OS power state. When the system suspends
  // (lid close, low battery, manual sleep) or locks the screen, Clippy goes
  // to sleep too — no proactive ticks, no in-flight tool fire, no animation.
  // On resume/unlock we restore whatever mode we were in BEFORE the suspend.
  // If the user had manually put Clippy to sleep before locking, unlock
  // does NOT silently wake it. powerMonitor works cross-platform (mac/
  // win32/linux); each event maps to whatever signal the OS surfaces:
  //   - mac: suspend = sleep / hibernate, lock-screen = TouchID lock
  //   - win32: suspend = sleep, lock-screen = Win+L
  //   - linux: suspend = systemd sleep, lock-screen = X/Wayland session-lock
  wirePowerMonitor(brain, mainWindow);

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

// Mark a genuine quit IN PROGRESS before any window gets its `close` event, so
// the main window's hide-to-tray close handler lets the app actually exit.
// Covers tray Quit, menu "Quit ClippyAI", Cmd+Q, and quitAndInstall (which all
// route through app.quit() → before-quit). Without this the window blocks the
// quit and the only way out is Force Quit (and updates hang). See quit-state.ts.
app.on('before-quit', () => quitState.setQuitting());

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopScheduler();
  // v0.20.0-alpha.11 — stop the focused-window follow loop. Cheap (just a
  // clearInterval) but keeps the process exit clean.
  try {
    windowFollowMod.stopWindowFollow();
  } catch { /* non-fatal */ }
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
