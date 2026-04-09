import { ipcMain, BrowserWindow, Menu, app, shell } from 'electron';
import { Brain, brainSettingsStore } from './brain';
import { executeTool } from './clawdbridge';
import {
  validateLicenseKey,
  saveLicense,
  clearLicense,
  getLicenseKey,
  getPlan,
  getBuddyName,
  getTtsVoice,
  store as licenseStore,
} from './license';
import { setClickThrough, createSettingsWindow, createOnboardingWindow, createLogWindow } from './window';
import fs from 'fs';
import path from 'path';

export function registerIpcHandlers(brain: Brain, mainWindow: BrowserWindow): void {
  // User typed a message in the bubble
  ipcMain.handle('user-message', async (_event, text: string) => {
    return brain.handleUserMessage(text);
  });

  // Execute a ClawdCursor tool directly
  ipcMain.handle('execute-tool', async (_event, tool: string, params: Record<string, unknown>) => {
    return executeTool(tool, params);
  });

  // Mode change from renderer
  ipcMain.on('mode-change', (_event, mode: 'awake' | 'sleep') => {
    brain.setMode(mode);
  });

  // Click-through toggle
  ipcMain.on('set-click-through', (_event, enabled: boolean) => {
    setClickThrough(mainWindow, enabled);
  });

  // Window drag movement
  ipcMain.on('move-window', (_event, deltaX: number, deltaY: number) => {
    if (mainWindow.isDestroyed()) return;
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(x + deltaX, y + deltaY);
  });

  // License validation
  ipcMain.handle('validate-license', async (_event, key: string) => {
    return validateLicenseKey(key);
  });

  // Save license data from onboarding
  ipcMain.handle('save-license', async (_event, key: string, plan: string, buddyName: string, ttsVoice: string) => {
    saveLicense(key, plan, buddyName, ttsVoice);
    return true;
  });

  // Get stored config
  ipcMain.handle('get-config', async () => {
    return {
      licenseKey: getLicenseKey(),
      plan: getPlan(),
      buddyName: getBuddyName(),
      ttsVoice: getTtsVoice(),
      proactiveInterval: brainSettingsStore.get('proactiveInterval'),
      proactiveEnabled: brainSettingsStore.get('proactiveEnabled'),
      aiEndpoint: brainSettingsStore.get('aiEndpoint'),
    };
  });

  // Update settings
  ipcMain.handle('update-settings', async (_event, settings: Record<string, unknown>) => {
    if (settings.buddyName !== undefined) licenseStore.set('buddyName', settings.buddyName as string);
    if (settings.ttsVoice !== undefined) licenseStore.set('ttsVoice', settings.ttsVoice as string);
    if (settings.proactiveInterval !== undefined) brainSettingsStore.set('proactiveInterval', settings.proactiveInterval as number);
    if (settings.proactiveEnabled !== undefined) brainSettingsStore.set('proactiveEnabled', settings.proactiveEnabled as boolean);
    if (settings.aiEndpoint !== undefined) brainSettingsStore.set('aiEndpoint', settings.aiEndpoint as string);
    return true;
  });

  // Open settings window
  ipcMain.on('open-settings', () => {
    createSettingsWindow();
  });

  // Open external URL (whitelisted domains only)
  ipcMain.handle('open-external-url', async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'buy.stripe.com' || parsed.hostname === 'clippyai.app' || parsed.hostname === 'api.clippyai.app') {
        await shell.openExternal(url);
        return true;
      }
    } catch { /* invalid URL */ }
    return false;
  });

  // Clear license (for re-entering a different key)
  ipcMain.handle('clear-license', async () => {
    clearLicense();
    return true;
  });

  // Open onboarding window (from settings "Change License Key")
  ipcMain.on('open-onboarding', () => {
    createOnboardingWindow();
  });

  // Close onboarding window
  ipcMain.on('close-onboarding', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  });

  // Log file operations
  const logDir = path.join(app.getPath('home'), '.clippyai', 'logs');

  ipcMain.handle('read-log-file', async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const logFile = path.join(logDir, `clippy-${today}.log`);
      if (fs.existsSync(logFile)) {
        return fs.readFileSync(logFile, 'utf-8');
      }
      // Try yesterday's if today's doesn't exist yet
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const yesterdayFile = path.join(logDir, `clippy-${yesterday}.log`);
      if (fs.existsSync(yesterdayFile)) {
        return fs.readFileSync(yesterdayFile, 'utf-8');
      }
      return null;
    } catch { return null; }
  });

  ipcMain.handle('clear-log-file', async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const logFile = path.join(logDir, `clippy-${today}.log`);
      if (fs.existsSync(logFile)) fs.writeFileSync(logFile, '');
      return true;
    } catch { return false; }
  });

  // Onboarding complete — show main window and activate
  ipcMain.on('onboarding-complete', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      brain.setMode('awake');
      mainWindow.webContents.send('mode-change', 'awake');
    }
  });

  // Right-click context menu
  let voiceMuted = false;

  ipcMain.on('show-context-menu', (_event) => {
    const isAwake = brain.getMode() === 'awake';

    const menu = Menu.buildFromTemplate([
      {
        label: '💬 Chat...',
        click: () => mainWindow.webContents.send('clippy-speak', {
          text: 'What can I help you with?',
          animate: 'Wave',
        }),
      },
      { type: 'separator' },
      {
        label: isAwake ? '💤 Sleep' : '☀️ Wake Up',
        click: () => {
          const newMode = isAwake ? 'sleep' : 'awake';
          brain.setMode(newMode);
          // Sleep = stay visible but stop brain loop. Don't hide.
          mainWindow.webContents.send('mode-change', newMode);
        },
      },
      {
        label: voiceMuted ? '🔊 Unmute Voice' : '🔇 Mute Voice',
        click: () => {
          voiceMuted = !voiceMuted;
          mainWindow.webContents.send('tts-toggle', !voiceMuted);
        },
      },
      { type: 'separator' },
      {
        label: '📋 View Logs',
        click: () => createLogWindow(),
      },
      {
        label: '⚙️ Settings',
        click: () => createSettingsWindow(),
      },
      { type: 'separator' },
      {
        label: '❌ Quit ClippyAI',
        click: () => {
          mainWindow.destroy();
          app.quit();
        },
      },
    ]);

    menu.popup({ window: mainWindow });
  });
}
