import { ipcMain, BrowserWindow, Menu, app, shell } from 'electron';
import { Brain, brainSettingsStore } from './brain';
import { executeTool } from './tools';
import { checkForUpdates, downloadUpdate, installUpdate } from './updater';
import { createLogger } from './logger';

const log = createLogger('IPC');
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
import { getUserProfile, saveUserProfile, isProfileSetUp } from './brain';
import { setClickThrough, createSettingsWindow, createOnboardingWindow, createLogWindow } from './window';
// updater imports moved to top of file
import fs from 'fs';
import path from 'path';

export function registerIpcHandlers(brain: Brain, mainWindow: BrowserWindow): void {
  // User typed a message in the bubble (with input validation)
  ipcMain.handle('user-message', async (_event, text: unknown) => {
    if (typeof text !== 'string') return 'Invalid input.';
    const trimmed = text.trim().substring(0, 4096);
    if (!trimmed) return '';
    try {
      const response = await brain.handleUserMessage(trimmed);
      return response || "Hmm, try again! 📎";
    } catch (err) {
      log.error('handleUserMessage threw', String(err));
      return "Something went wrong — try again! 📎";
    }
  });

  // Test ClawdCursor connection (safe, read-only)
  ipcMain.handle('test-clawdcursor', async () => {
    try {
      await executeTool('get_active_window', {});
      return true;
    } catch {
      return false;
    }
  });

  // Mode change from renderer
  ipcMain.on('mode-change', (_event, mode: 'awake' | 'sleep') => {
    brain.setMode(mode);
  });

  // Click-through toggle
  ipcMain.on('set-click-through', (_event, enabled: boolean) => {
    setClickThrough(mainWindow, enabled);
  });

  // Window drag movement — handled in window.ts with bounds checking
  // (removed duplicate handler here that lacked bounds checks)

  // License validation
  ipcMain.handle('validate-license', async (_event, key: string) => {
    return validateLicenseKey(key);
  });

  // Save license data from onboarding
  ipcMain.handle('save-license', async (_event, key: string, plan: string, buddyName: string, ttsVoice: string) => {
    saveLicense(key, plan, buddyName, ttsVoice);
    return true;
  });

  // Get stored config.
  // SECURITY: license key is NEVER returned raw to the renderer — only a
  // masked display string. The main process owns the key for API calls.
  // If the renderer ever needs to prove a key is present, use
  // `licenseKeyPresent: !!getLicenseKey()`.
  ipcMain.handle('get-config', async () => {
    const key = getLicenseKey();
    const masked = key
      ? (() => {
          const parts = key.split('-');
          return parts.length >= 4
            ? `${parts[0]}-****-****-${parts[parts.length - 1]}`
            : '****';
        })()
      : '';
    return {
      licenseKey: masked,
      licenseKeyPresent: !!key,
      plan: getPlan(),
      buddyName: getBuddyName(),
      ttsVoice: getTtsVoice(),
      proactiveInterval: brainSettingsStore.get('proactiveInterval'),
      proactiveEnabled: brainSettingsStore.get('proactiveEnabled'),
      ttsEnabled: licenseStore.get('ttsEnabled', true),
      speechRate: licenseStore.get('speechRate', 1.1),
      launchOnStartup: app.getLoginItemSettings().openAtLogin,
      appVersion: app.getVersion(),
    };
  });

  // Update settings (with validation)
  ipcMain.handle('update-settings', async (_event, settings: Record<string, unknown>) => {
    if (settings.buddyName !== undefined) {
      const name = String(settings.buddyName).trim().substring(0, 20);
      if (name) licenseStore.set('buddyName', name);
    }
    if (settings.ttsVoice !== undefined) licenseStore.set('ttsVoice', String(settings.ttsVoice));
    // Proactive interval + on/off both require restarting the brain loop so
    // the change takes effect immediately (not on next sleep/wake cycle).
    let proactiveChanged = false;
    if (settings.proactiveInterval !== undefined) {
      const interval = Math.max(5000, Math.min(300000, Number(settings.proactiveInterval) || 30000));
      brainSettingsStore.set('proactiveInterval', interval);
      proactiveChanged = true;
    }
    if (settings.proactiveEnabled !== undefined) {
      brainSettingsStore.set('proactiveEnabled', Boolean(settings.proactiveEnabled));
      proactiveChanged = true;
    }
    if (proactiveChanged) brain.restartProactiveLoop();
    // TTS toggle + speech rate — saved in licenseStore, broadcast to main window
    if (settings.ttsEnabled !== undefined) {
      licenseStore.set('ttsEnabled', Boolean(settings.ttsEnabled));
      mainWindow.webContents.send('tts-toggle', Boolean(settings.ttsEnabled));
    }
    if (settings.speechRate !== undefined) {
      const rate = Math.max(0.5, Math.min(2.0, Number(settings.speechRate) || 1.1));
      licenseStore.set('speechRate', rate);
      mainWindow.webContents.send('speech-rate', rate);
    }
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

  // Auto-update
  ipcMain.handle('check-for-updates', async () => {
    checkForUpdates();
    return true;
  });
  ipcMain.handle('download-update', async () => {
    downloadUpdate();
    return true;
  });
  ipcMain.handle('install-update', async () => {
    installUpdate();
    return true;
  });

  // User profile
  ipcMain.handle('get-user-profile', async () => getUserProfile());
  ipcMain.handle('save-user-profile', async (_event, data: Record<string, string>) => {
    saveUserProfile(data);
    return true;
  });
  ipcMain.handle('is-profile-set-up', async () => isProfileSetUp());

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

  // Report logs to backend (with optional user description)
  ipcMain.handle('report-logs', async (_event, content: string, description?: string) => {
    try {
      const { net } = await import('electron');
      const licenseKey = getLicenseKey();
      const req = net.request({ url: 'https://api.clippyai.app/report', method: 'POST' });
      req.setHeader('Content-Type', 'application/json');
      req.write(JSON.stringify({
        key: licenseKey,
        logs: content,
        description: (description || '').substring(0, 4000),
        version: app.getVersion(),
      }));
      req.end();
      return true;
    } catch { return false; }
  });

  // Launch on startup (uses Electron's native login item API)
  ipcMain.handle('get-launch-on-startup', async () => {
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('set-launch-on-startup', async (_event, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return true;
  });

  // Open Stripe customer portal (Manage Subscription).
  // POST the license key as a Bearer token (never in URL) and open the
  // returned Stripe portal URL externally. Prevents the key from leaking
  // into browser history, referrer headers, or HTTP access logs.
  ipcMain.handle('open-subscription-portal', async () => {
    const key = getLicenseKey();
    if (!key) return false;
    try {
      const { net } = await import('electron');
      const url = await new Promise<string | null>((resolve) => {
        const req = net.request({ url: 'https://api.clippyai.app/portal', method: 'POST' });
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('Authorization', `Bearer ${key}`);
        const timeout = setTimeout(() => { req.abort(); resolve(null); }, 15_000);
        req.on('response', (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk.toString(); });
          response.on('end', () => {
            clearTimeout(timeout);
            try {
              const parsed = JSON.parse(data) as { url?: string; error?: string };
              resolve(parsed.url || null);
            } catch { resolve(null); }
          });
        });
        req.on('error', () => { clearTimeout(timeout); resolve(null); });
        req.write('{}');
        req.end();
      });
      if (!url) return false;
      await shell.openExternal(url);
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
