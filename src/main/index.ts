import { app, BrowserWindow, globalShortcut } from 'electron';
import { createWindow, createOnboardingWindow } from './window';
import { setupTray } from './tray';
import { registerHotkey } from './hotkey';
import { Brain } from './brain';
import { registerIpcHandlers } from './ipc';
import { initStartup } from './startup';
import { isLicensed, revalidateIfNeeded } from './license';
import { isProfileSetUp } from './brain';
import { restartClawdCursor, isClawdCursorRunning, cleanupClawdCursor } from './clawdbridge';
import { createLogger, cleanOldLogs } from './logger';
import { initUpdater, checkForUpdates } from './updater';

const log = createLogger('App');

// ── Single instance lock ─────────────────────────────────────────
// Prevents multiple Clippy instances from opening
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log.info('Another instance is already running — quitting');
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let brain: Brain | null = null;

// When user tries to launch a second instance, focus the existing one
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Suppress uncaught EPIPE errors (ClawdCursor pipe breaks) — log, don't show dialog
process.on('uncaughtException', (err) => {
  if (err.message?.includes('EPIPE') || err.message?.includes('broken pipe')) {
    log.warn('Suppressed EPIPE error (ClawdCursor pipe break)', err.message);
    return; // Don't show error dialog
  }
  log.error('Uncaught exception', err.message);
  // Re-throw non-EPIPE errors so Electron's default handler shows them
  throw err;
});

app.whenReady().then(async () => {
  log.info('ClippyAI starting', { version: '0.3.9' });
  initStartup();
  cleanOldLogs();

  // Auto-start ClawdCursor if not running (non-blocking — chat works without it)
  try {
    const running = await isClawdCursorRunning();
    if (!running) {
      await restartClawdCursor();
    } else {
      log.info('ClawdCursor already running');
    }
  } catch (err) {
    log.warn('ClawdCursor failed to start — desktop automation disabled, chat still works', String(err));
  }

  if (isLicensed()) {
    // Returning user — revalidate key in background
    log.info('License found, revalidating...');
    const stillValid = await revalidateIfNeeded();
    if (stillValid) {
      launchMainApp();
    } else {
      log.warn('License key no longer valid — showing onboarding');
      launchWithOnboarding();
    }
  } else {
    // First run or expired key — show onboarding
    log.info('No valid license — showing onboarding');
    launchWithOnboarding();
  }
});

function launchMainApp(): void {
  mainWindow = createWindow();
  brain = new Brain(mainWindow);
  registerIpcHandlers(brain, mainWindow);
  setupTray(mainWindow, brain);
  registerHotkey(mainWindow, brain);

  brain.setMode('awake');
  mainWindow.webContents.send('mode-change', 'awake');

  // Check for updates 10 seconds after launch (don't slow startup)
  initUpdater(mainWindow);
  setTimeout(() => checkForUpdates(), 10_000);

  // If user profile not set up (e.g. reinstall skipped onboarding), ask for name
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
  // Create main window but keep it hidden until license is entered
  mainWindow = createWindow();
  mainWindow.hide();
  brain = new Brain(mainWindow);
  registerIpcHandlers(brain, mainWindow);
  setupTray(mainWindow, brain);
  registerHotkey(mainWindow, brain);

  // Show onboarding wizard
  createOnboardingWindow();

  // When onboarding completes (license saved), show the main window
  // The 'onboarding-complete' IPC handler in ipc.ts shows mainWindow + sets awake
  log.info('Onboarding window opened, waiting for license entry');
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  cleanupClawdCursor();
  log.info('ClippyAI shutting down — cleaned up child processes');
});

app.on('window-all-closed', () => {
  // Stay alive in system tray
});
