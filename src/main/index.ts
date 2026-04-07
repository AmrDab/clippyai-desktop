import { app, BrowserWindow, globalShortcut } from 'electron';
import { createWindow } from './window';
import { setupTray } from './tray';
import { registerHotkey } from './hotkey';
import { Brain } from './brain';
import { registerIpcHandlers } from './ipc';
import { initStartup } from './startup';
import { isLicensed, isFirstRun, startTrial, getTrialStatus } from './license';
import { restartClawdCursor, isClawdCursorRunning } from './clawdbridge';
import { createLogger } from './logger';

const log = createLogger('App');

let mainWindow: BrowserWindow | null = null;
let brain: Brain | null = null;

app.whenReady().then(async () => {
  log.info('ClippyAI starting', { version: '0.1.0' });
  initStartup();

  // Auto-start ClawdCursor if not running
  const running = await isClawdCursorRunning();
  if (!running) {
    await restartClawdCursor();
  } else {
    log.info('ClawdCursor already running');
  }

  // First run? Auto-start the 7-day trial — no onboarding wizard.
  const firstRun = isFirstRun();
  if (firstRun) {
    const trial = startTrial();
    log.info('First run — started 7-day trial', { expiresAt: new Date(trial.expiresAt).toISOString() });
  } else if (!isLicensed()) {
    // Trial expired or no license
    log.warn('Not licensed and not first run — trial may have expired');
  }

  const trialStatus = getTrialStatus();
  log.info('Trial status', trialStatus);

  mainWindow = createWindow();
  brain = new Brain(mainWindow);

  registerIpcHandlers(brain, mainWindow);
  setupTray(mainWindow, brain);
  registerHotkey(mainWindow, brain);

  // Always go straight to awake mode — no onboarding screen
  brain.setMode('awake');
  mainWindow.webContents.send('mode-change', 'awake');

  // First run: send a friendly welcome bubble after 2 seconds
  if (firstRun) {
    setTimeout(() => {
      mainWindow?.webContents.send('clippy-speak', {
        text: "Hi! I'm Clippy 📎 Your 7-day free trial is active. Click me anytime to chat, or just ask me to do something!",
        animate: 'Wave',
      });
    }, 2500);
  } else if (trialStatus.isTrial && trialStatus.daysLeft <= 2 && trialStatus.daysLeft > 0) {
    // Nudge in the last 2 days of trial
    setTimeout(() => {
      mainWindow?.webContents.send('clippy-speak', {
        text: `${trialStatus.daysLeft} day${trialStatus.daysLeft === 1 ? '' : 's'} left in your trial! Visit clippyai.app to keep me around.`,
        animate: 'GetAttention',
      });
    }, 5000);
  } else if (trialStatus.expired) {
    setTimeout(() => {
      mainWindow?.webContents.send('clippy-speak', {
        text: "Your trial ended! Visit clippyai.app to subscribe and keep me as your buddy.",
        animate: 'Alert',
      });
    }, 5000);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Stay alive in system tray
});
