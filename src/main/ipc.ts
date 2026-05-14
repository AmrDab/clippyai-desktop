import { ipcMain, BrowserWindow, Menu, app, shell } from 'electron';
import { Brain, brainSettingsStore } from './brain';
import { executeTool } from './tools';
import { checkForUpdates, downloadUpdate, installUpdate, initUpdater, startPeriodicUpdateChecks, openManualUpdatePage } from './updater';
import { createLogger, serializeErr, ingestRendererLog } from './logger';

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
      log.error('handleUserMessage threw', serializeErr(err));
      return "Something went wrong — try again! 📎";
    }
  });

  // v0.11.28 — renderer log bridge. Renderer-side errors and warnings get
  // forwarded here and written to the same JSONL log as main, so a "Report
  // issue" bundle includes UI-layer failures (animation load errors,
  // bubble click-handler exceptions, etc) — previously invisible because
  // they only hit DevTools console.
  ipcMain.on('renderer-log', (_event, payload: unknown) => {
    try {
      const p = payload as {
        level?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
        component?: string;
        message?: string;
        data?: unknown;
      };
      const level = p?.level && ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(p.level) ? p.level : 'INFO';
      const component = typeof p?.component === 'string' ? p.component.substring(0, 40) : 'Renderer';
      const message = typeof p?.message === 'string' ? p.message.substring(0, 500) : '(no message)';
      // v0.12.3 — bound the data payload BEFORE handing it to the logger.
      // Per security audit finding #5: previously a circular object would
      // make JSON.stringify throw inside the logger's truncate path, and a
      // multi-MB payload would force a multi-MB log line + write spike
      // before truncation kicked in. Here we serialize first, length-cap,
      // and replace with a placeholder if anything goes wrong.
      let safeData: unknown = undefined;
      if (p?.data !== undefined) {
        try {
          const serialized = JSON.stringify(p.data);
          if (typeof serialized === 'string' && serialized.length <= 4000) {
            safeData = p.data;
          } else if (typeof serialized === 'string') {
            safeData = { _truncated: true, _bytes: serialized.length, _preview: serialized.substring(0, 500) };
          } else {
            // JSON.stringify returned undefined (e.g. function value) — drop
            safeData = '[non-serializable]';
          }
        } catch {
          // Circular reference or stringify threw
          safeData = '[circular-or-throws]';
        }
      }
      ingestRendererLog(level, component, message, safeData);
    } catch (err) {
      log.warn('renderer-log ingest failed', serializeErr(err));
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

  // License validation. Returns `{valid, plan, reason?}` to keep the
  // renderer's existing shape working; `reason: 'unreachable'` lets
  // onboarding show "Couldn't reach validation server — check your
  // internet" instead of "Invalid license" when the worker is down.
  ipcMain.handle('validate-license', async (_event, key: string) => {
    const result = await validateLicenseKey(key);
    if (result.state === 'valid') {
      return { valid: true, plan: result.plan };
    }
    return { valid: false, plan: '', reason: result.state };
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
      // v0.12.3 — exposed cooldown + bubble auto-hide
      proactiveCooldownMs: brainSettingsStore.get('proactiveCooldownMs'),
      bubbleAutoHideMs: brainSettingsStore.get('bubbleAutoHideMs'),
      ttsEnabled: licenseStore.get('ttsEnabled', true),
      speechRate: licenseStore.get('speechRate', 1.1),
      // v0.16.0 — pitch + volume
      speechPitch: licenseStore.get('speechPitch', 1.0),
      speechVolume: licenseStore.get('speechVolume', 0.9),
      // v0.17.0 — voice input (offline whisper.cpp)
      voiceEnabled: licenseStore.get('voiceEnabled', true),
      // v0.17.2 — wake-word preference (UI works now, runtime stub until
      // we ship the on-device wake-word model)
      wakeWordEnabled: licenseStore.get('wakeWordEnabled', false),
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
    // v0.12.3 — proactive cooldown after speaking. 0 = no cooldown.
    if (settings.proactiveCooldownMs !== undefined) {
      const cooldown = Math.max(0, Math.min(1800000, Number(settings.proactiveCooldownMs) || 0));
      brainSettingsStore.set('proactiveCooldownMs', cooldown);
      // No restart needed — proactiveCheck reads the value live.
    }
    // v0.12.3 — bubble auto-hide timeout. 0 = manual / never auto-hide.
    if (settings.bubbleAutoHideMs !== undefined) {
      const hideMs = Math.max(0, Math.min(120000, Number(settings.bubbleAutoHideMs) || 0));
      brainSettingsStore.set('bubbleAutoHideMs', hideMs);
      mainWindow.webContents.send('bubble-auto-hide', hideMs);
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
    // v0.16.0 — pitch + volume customization
    if (settings.speechPitch !== undefined) {
      const pitch = Math.max(0.5, Math.min(2.0, Number(settings.speechPitch) || 1.0));
      licenseStore.set('speechPitch', pitch);
      mainWindow.webContents.send('speech-pitch', pitch);
    }
    if (settings.speechVolume !== undefined) {
      const vol = Math.max(0, Math.min(1, Number(settings.speechVolume) || 0.9));
      licenseStore.set('speechVolume', vol);
      mainWindow.webContents.send('speech-volume', vol);
    }
    // v0.17.0 — voice input on/off
    if (settings.voiceEnabled !== undefined) {
      licenseStore.set('voiceEnabled', Boolean(settings.voiceEnabled));
      mainWindow.webContents.send('voice-toggle', Boolean(settings.voiceEnabled));
    }
    // v0.17.2 — wake-word preference. Persisted but not yet honored at
    // runtime; saving here so when the on-device wake-word model ships,
    // existing-user preferences carry over without a fresh prompt.
    if (settings.wakeWordEnabled !== undefined) {
      licenseStore.set('wakeWordEnabled', Boolean(settings.wakeWordEnabled));
    }
    return true;
  });

  // Open settings window
  ipcMain.on('open-settings', () => {
    createSettingsWindow();
  });

  // Open external URL (whitelisted protocols + domains)
  ipcMain.handle('open-external-url', async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      // mailto: links go to the user's default mail client. No hostname,
      // safe to allow unconditionally — every Settings → About → Support
      // click was silently failing the hostname check.
      if (parsed.protocol === 'mailto:') {
        await shell.openExternal(url);
        return true;
      }
      if (parsed.hostname === 'buy.stripe.com' || parsed.hostname === 'clippyai.app' || parsed.hostname === 'api.clippyai.app' || parsed.hostname === 'github.com') {
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
  ipcMain.handle('open-manual-update', async () => {
    openManualUpdatePage();
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

  // v0.12.5 — manual proactive trigger. Bypasses the interval timer +
  // screen_unchanged guard so the user can validate Brain settings without
  // waiting. Wired to the "Try a tip now" button in Settings → Brain.
  ipcMain.handle('fire-proactive-tip', async () => {
    try {
      return await brain.fireProactiveTipManually();
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });

  // v0.14.1 — Settings → Skills tab support. Lists installed ClawHub skills,
  // searches ClawHub for new ones, installs, and uninstalls. Each lands in
  // ~/.clippyai/skills/<slug>/ and the registry is refreshed so newly-
  // installed skills are callable as skill__<slug> on the very next /v1/turn.
  ipcMain.handle('skills-list', async () => {
    try {
      const reg = await import('./skill-registry');
      const manifests = [...reg.getRegistry().values()];
      return manifests.map((m) => ({
        slug: m.slug,
        name: m.name,
        description: m.description,
        version: m.version,
        installedAt: m.installedAt,
        toolName: reg.slugToToolName(m.slug),
        installPath: m.installPath,
        capability_tags: m.capability_tags,
      }));
    } catch (err) {
      log.warn('skills-list failed', serializeErr(err));
      return [];
    }
  });

  ipcMain.handle('skills-search', async (_event, query: string) => {
    try {
      const ch = await import('./clawhub');
      if (!query || !query.trim()) return [];
      const results = await ch.searchSkills(query.trim(), 10);
      // Enrich with safety classification so the UI can show a colored badge.
      const enriched = await Promise.all(results.map(async (r) => {
        const scan = await ch.getSkillScan(r.slug);
        return {
          slug: r.slug,
          name: r.displayName,
          summary: r.summary,
          version: r.version,
          score: r.score,
          safety: ch.classifySkillSafety(scan),
          capability_tags: scan?.capability_tags || [],
        };
      }));
      return enriched;
    } catch (err) {
      log.warn('skills-search failed', serializeErr(err));
      return [];
    }
  });

  ipcMain.handle('skills-install', async (_event, slug: string, version?: string) => {
    try {
      const ch = await import('./clawhub');
      const reg = await import('./skill-registry');
      const manifest = await ch.installSkill(slug, version);
      await reg.refreshSkillRegistry();
      return { ok: true, slug: manifest.slug, name: manifest.name, version: manifest.version };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('skills-uninstall', async (_event, slug: string) => {
    try {
      const ch = await import('./clawhub');
      const reg = await import('./skill-registry');
      const skillsDir = ch.getSkillsDir();
      const targetDir = path.join(skillsDir, slug);
      // Path-confinement: must be inside skillsDir + must exist + must be a directory.
      const resolved = path.resolve(targetDir);
      if (!resolved.startsWith(path.resolve(skillsDir) + path.sep)) {
        return { ok: false, error: 'invalid_slug' };
      }
      if (!fs.existsSync(resolved)) return { ok: false, error: 'not_installed' };
      await fs.promises.rm(resolved, { recursive: true, force: true });
      await reg.refreshSkillRegistry();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // v0.14.1 — Settings → Brain "Mail Setup" status. Surfaces the boot-time
  // mail-env probe result so users troubleshooting email send can see
  // "olk installed but NOT default mailto" without sending a log report.
  // v0.14.1 — Settings → About shows which Kimi model served the last
  // /v1/turn response. Cached at module level in brain.ts; returns null
  // before the first turn (user hasn't chatted yet).
  ipcMain.handle('active-model', async () => {
    try {
      const b = await import('./brain');
      return b.getLastSeenModel();
    } catch (err) {
      log.warn('active-model failed', serializeErr(err));
      return null;
    }
  });

  // v0.17.0 — Voice input. Renderer captures audio via getUserMedia,
  // encodes 16 kHz mono PCM WAV, sends the Uint8Array over IPC. Main
  // process spawns bundled whisper-cli, returns the transcript. We do
  // NOT auto-route to handleUserMessage from here — the renderer gets
  // the transcript back so it can show it in the bubble first, let the
  // user edit/cancel, then explicitly send. That mirrors Siri/Whisper
  // dictation patterns and avoids stuck-recording → unwanted-action.
  ipcMain.handle('transcribe-audio', async (_event, wavBytes: unknown, initialPrompt?: unknown) => {
    try {
      const stt = await import('./stt');
      // wavBytes comes over IPC as either Uint8Array (typed array) or a
      // plain object {0: byte, 1: byte, ...} when serialized through
      // structured clone — coerce to Buffer for safety.
      const buf = Buffer.isBuffer(wavBytes)
        ? wavBytes
        : Buffer.from(wavBytes as ArrayBufferLike);
      const prompt = typeof initialPrompt === 'string' ? initialPrompt : undefined;
      return await stt.transcribeWav(buf, { initialPrompt: prompt, timeoutMs: 30_000 });
    } catch (err) {
      log.warn('transcribe-audio failed', serializeErr(err));
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('stt-status', async () => {
    try {
      const stt = await import('./stt');
      return stt.isSttReady();
    } catch {
      return { ready: false, reason: 'stt module load failed' };
    }
  });

  // v0.15.0 — Settings → Web tab: mcp-chrome status + on-demand refresh.
  ipcMain.handle('mcp-chrome-status', async () => {
    try {
      const m = await import('./mcp-chrome');
      return m.getMcpChromeStatus();
    } catch (err) {
      log.warn('mcp-chrome-status failed', serializeErr(err));
      return null;
    }
  });
  ipcMain.handle('mcp-chrome-refresh', async () => {
    try {
      const m = await import('./mcp-chrome');
      return await m.refreshMcpChromeStatus();
    } catch (err) {
      log.warn('mcp-chrome-refresh failed', serializeErr(err));
      return null;
    }
  });

  ipcMain.handle('mail-env-status', async () => {
    try {
      const m = await import('./mail-env');
      return m.getCachedMailEnvironment();
    } catch (err) {
      log.warn('mail-env-status failed', serializeErr(err));
      return null;
    }
  });

  ipcMain.handle('clear-log-file', async () => {
    // v0.12.5 — clear ALL clippy-*.log files in the log directory plus
    // their rotated *.log.N siblings, not just today's. Per support
    // report fabb85b7: user clicked "Clear" and yesterday's log was
    // still on disk + still in the next report bundle. The View Logs
    // window's Clear button now matches the user's mental model: all
    // history goes.
    try {
      if (!fs.existsSync(logDir)) return true;
      const files = fs.readdirSync(logDir);
      let cleared = 0;
      for (const f of files) {
        // Match clippy-2026-05-10.log + clippy-2026-05-10.log.1 etc.
        if (!/^clippy-\d{4}-\d{2}-\d{2}\.log(\.\d+)?$/.test(f)) continue;
        try {
          const fullPath = path.join(logDir, f);
          // Truncate today's active log to empty; delete any rotated
          // siblings outright (the writer doesn't hold them open).
          if (/\.\d+$/.test(f)) {
            fs.unlinkSync(fullPath);
          } else {
            fs.writeFileSync(fullPath, '');
          }
          cleared++;
        } catch { /* skip unreadable file, continue */ }
      }
      log.info('Logs cleared', { cleared, logDir });
      return true;
    } catch (err) {
      log.warn('clear-log-file failed', serializeErr(err));
      return false;
    }
  });

  // Report logs to backend (with optional user description).
  // v0.11.28 — assembled by support-bundle.ts. Sections: system info,
  // last task slice (isolated by task_id), boot.log, full clippy.log,
  // crash dump filenames. PII-scrubbed across the whole bundle. Manifest
  // is appended to the description so the engineer reading the KV entry
  // sees app_version + last_task_id + chars without parsing the body.
  ipcMain.handle('report-logs', async (_event, content: string, description?: string) => {
    try {
      const { net } = await import('electron');
      const { buildBundle } = await import('./support-bundle');
      const licenseKey = getLicenseKey();

      const { logs, manifest } = buildBundle(content);
      const fullDescription = `${description || ''}\n\n[manifest] ${JSON.stringify(manifest)}`.substring(0, 4000);

      const req = net.request({ url: 'https://api.clippyai.app/report', method: 'POST' });
      req.setHeader('Content-Type', 'application/json');
      req.write(JSON.stringify({
        key: licenseKey,
        logs,
        description: fullDescription,
        version: app.getVersion(),
      }));
      req.end();
      log.info('Report.upload', { manifest });
      return true;
    } catch (err) {
      log.error('Report.upload failed', serializeErr(err));
      return false;
    }
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

  // Onboarding complete — show main window, activate brain, start updater.
  // Uses .handle() so the onboarding renderer can AWAIT completion before
  // closing its window. The old .on() (fire-and-forget) caused a race:
  // onboarding closed before the main window was ready, leaving Clippy
  // in a half-initialized state.
  ipcMain.handle('onboarding-complete', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;

    // Wait for the renderer to be ready before sending events
    if (!mainWindow.webContents.isLoading()) {
      mainWindow.show();
    } else {
      await new Promise<void>((resolve) => {
        mainWindow!.webContents.once('did-finish-load', () => {
          mainWindow!.show();
          resolve();
        });
      });
    }

    // Activate brain
    brain.setMode('awake');
    mainWindow.webContents.send('mode-change', 'awake');

    // Initialize updater (launchMainApp does this but onboarding path skipped it)
    initUpdater(mainWindow);
    setTimeout(() => checkForUpdates(), 10_000);
    startPeriodicUpdateChecks();

    // Clippy asks for the user's name (removed from onboarding form)
    if (!isProfileSetUp()) {
      setTimeout(() => {
        // D9: log direct webContents.send so the audit trail matches what
        // the user actually saw on screen.
        const text = "Hey! I don't think we've met yet. What should I call you? Just type your name! 📎";
        log.info('Clippy.say', { text, animation: 'Wave', trigger: 'name_prompt' });
        mainWindow?.webContents.send('clippy-speak', { text, animate: 'Wave' });
      }, 3000);
    }

    return true;
  });

  // Right-click context menu
  let voiceMuted = false;

  ipcMain.on('show-context-menu', (_event) => {
    const isAwake = brain.getMode() === 'awake';

    const menu = Menu.buildFromTemplate([
      {
        label: '💬 Chat...',
        click: () => {
          const text = 'What can I help you with?';
          log.info('Clippy.say', { text, animation: 'Wave', trigger: 'chat_menu' });
          mainWindow.webContents.send('clippy-speak', { text, animate: 'Wave' });
        },
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
        // v0.12.5 — rescue when Clippy is dragged off-screen.
        label: '🎯 Center on Screen',
        click: () => {
          if (!mainWindow.isVisible()) mainWindow.show();
          mainWindow.center();
        },
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
