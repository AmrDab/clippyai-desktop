import { app, BrowserWindow, globalShortcut } from 'electron';
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
import { initUpdater, checkForUpdates } from './updater';

const log = createLogger('App');

// ── Single instance lock ─────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log.info('Another instance is already running — quitting');
  app.quit();
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
  log.error('Uncaught exception', err.message);
  throw err;
});

app.whenReady().then(async () => {
  log.info('ClippyAI starting', { version: '0.5.2' });
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
      launchMainApp();
    } else {
      log.warn('License key no longer valid — showing onboarding');
      launchWithOnboarding();
    }
  } else {
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

  initUpdater(mainWindow);
  setTimeout(() => checkForUpdates(), 10_000);

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
