import { app, BrowserWindow, globalShortcut } from 'electron';
import { createWindow, createOnboardingWindow } from './window';
import { setupTray } from './tray';
import { registerHotkey } from './hotkey';
import { Brain } from './brain';
import { registerIpcHandlers } from './ipc';
import { initStartup } from './startup';
import { isLicensed, revalidateIfNeeded } from './license';
import { restartClawdCursor, isClawdCursorRunning } from './clawdbridge';
import { createLogger, cleanOldLogs } from './logger';

const log = createLogger('App');

let mainWindow: BrowserWindow | null = null;
let brain: Brain | null = null;

app.whenReady().then(async () => {
  log.info('ClippyAI starting', { version: '0.3.0' });
  initStartup();
  cleanOldLogs();

  // Auto-start ClawdCursor if not running
  const running = await isClawdCursorRunning();
  if (!running) {
    await restartClawdCursor();
  } else {
    log.info('ClawdCursor already running');
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
});

app.on('window-all-closed', () => {
  // Stay alive in system tray
});
