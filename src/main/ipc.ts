import { ipcMain, BrowserWindow, Menu, app, shell, dialog } from 'electron';
import { Brain, brainSettingsStore } from './brain';
import { executeTool } from './tools';
import { checkForUpdates, downloadUpdate, installUpdate, initUpdater, startPeriodicUpdateChecks, openManualUpdatePage } from './updater';
import { createLogger, serializeErr, ingestRendererLog } from './logger';

const log = createLogger('IPC');

// Worker base URL — mirrors API_BASE in brain.ts / license.ts. Kept here so
// the free-signup handler doesn't reach across modules for a constant.
const WORKER_API_BASE = 'https://api.clippyai.app';

import {
  validateLicenseKey,
  saveLicense,
  clearLicense,
  clearAllLocalData,
  getLicenseKey,
  getPlan,
  getBuddyName,
  getTtsVoice,
  getUserApps,
  setUserApps,
  getApiKeysPresence,
  setApiKeyPresence,
  API_CAPABLE_APP_IDS,
  // v0.20.0 (voice v1) — optional OpenAI voice
  isOpenAiKeyPresent,
  setOpenAiKeyPresence,
  getTtsEngine,
  setTtsEngine,
  getUsage,
  store as licenseStore,
} from './license';
import { setSecret, clearSecret } from './skills/secrets';
import { API_KEYCHAIN_SERVICE } from './api-routes';
// v0.20.0 (voice v1) — STATIC import (bundle-anchor rule) for the
// main-process OpenAI TTS proxy. Key never leaves main; renderer gets bytes.
import * as openaiVoice from './openai-voice';
// STATIC namespace import (bundle-anchor rule) — lazy require()/dynamic
// import() get tree-shaken out of the Rollup bundle, so follow-me's
// survival must NOT depend on another module's import edge. See brain.ts /
// index.ts which import follow-me the same way.
import * as followMeMod from './follow-me';
import { getUserProfile, saveUserProfile, isProfileSetUp } from './brain';
import * as profileMod from './profile';
// v0.20.0-alpha.12 — static import for window-follow (NOT lazy require)
// to keep Rollup from tree-shaking it. See memory: feedback-clippy-bundle-anchors.
import * as windowFollowMod from './window-follow';
import { setClickThrough, createSettingsWindow, createOnboardingWindow, createLogWindow, hideWritingBadge } from './window';
// Badge click reuses the ⌥G correction flow.
import { triggerWritingAssist } from './writing-assist';
// updater imports moved to top of file
import fs from 'fs';
import path from 'path';

// v0.19.0.1 — STATIC IMPORTS for PR-5 (Guardrails / undo / action log).
//
// HISTORY: rc.5 shipped `void _bundleAnchorX` references hoping that would
// be enough to keep the modules in the Rollup bundle. It wasn't — `void X`
// is treated as a side-effect-free no-op, so Rollup tree-shook the imports
// away and the lazy `require('./X')` sites in brain.ts + ipc.ts blew up at
// runtime with MODULE_NOT_FOUND ("Cannot find module './permission-policy'").
// v0.19.0 went out with this bug; users saw `handleUserMessage threw` on
// EVERY message that hit the Guardrails class-policy gate.
//
// FIX: replace lazy require() at every call site with the namespace imported
// here, so the modules become real used edges in the dependency graph and
// Rollup can never drop them. permissionPolicyMod / actionHistoryMod /
// toolUndoMod / undoMod are referenced inside the handler bodies below.
import * as permissionPolicyMod from './permission-policy';
import * as toolUndoMod from './tool-undo';
import * as undoMod from './undo';
import * as actionHistoryMod from './action-history';
// v0.20.0 — onboarding permission walkthrough: read macOS permission state,
// open exact System Preferences panes, surface SR dialog, and restart.
import { permissions, requestScreenRecording } from './mac-bridge-native';
// v1 writing-assist (⌥G) — STATIC namespace import (bundle-anchor rule) so
// Rollup can't tree-shake the focused-field writer out of the bundle.
import * as macBridge from './mac-bridge-native';

// Fixed enum → fixed URL mapping for open-permission-pane.
// SECURITY: only these three x-apple.systempreferences URLs are ever opened;
// the handler rejects any unknown kind, preventing arbitrary URL passthrough.
const PERMISSION_PANES: Record<string, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
};

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

  // v0.19.0 — follow-me cursor mode IPC handlers.
  // Renderer sends 'follow-me-stop' when user presses Esc while follow mode
  // is active. reason: 'esc' lets telemetry distinguish user-driven stops.
  ipcMain.on('follow-me-stop', (_event, reason: string) => {
    try {
      followMeMod.stop(reason ?? 'esc');
    } catch { /* non-fatal */ }
  });
  // Renderer queries active state to decide whether to send 'follow-me-stop'
  // on Esc (avoids suppressing normal Esc behaviour when not in follow mode).
  ipcMain.handle('follow-me-active', () => {
    try {
      return followMeMod.isActive();
    } catch { return false; }
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

  // Free-tier signup. POSTs { email } to the worker's /v1/free-signup
  // endpoint; on 200 the worker mints a free license key, which we persist
  // via the existing license store so subsequent /v1/turn calls are
  // authenticated. Returns { licenseKey, plan } to onboarding, or
  // { error } ('invalid_email' | 'rate_limited' | 'offline') for a
  // friendly inline message. The key is logged main-side only — it never
  // rides into a renderer console.
  ipcMain.handle('free-signup', async (_event, email: string) => {
    const trimmed = (typeof email === 'string' ? email : '').trim();
    // Cheap client-side gate so an obviously-bad address never hits the
    // worker (and never burns a rate-limit slot). The worker is still the
    // source of truth — it re-validates and may 400 anyway.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
      return { error: 'invalid_email' };
    }
    try {
      const { net } = await import('electron');
      return await new Promise<{ licenseKey: string; plan: string } | { error: string }>((resolve) => {
        const req = net.request({ url: `${WORKER_API_BASE}/v1/free-signup`, method: 'POST' });
        req.setHeader('Content-Type', 'application/json');
        const timeout = setTimeout(() => { req.abort(); resolve({ error: 'offline' }); }, 15_000);
        req.on('response', (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk.toString(); });
          response.on('end', () => {
            clearTimeout(timeout);
            const status = response.statusCode || 0;
            let parsed: { licenseKey?: string; plan?: string; error?: string } = {};
            try { parsed = JSON.parse(data); } catch { /* fall through to status-based mapping */ }
            if (status === 200 && parsed.licenseKey) {
              const plan = parsed.plan || 'free';
              // Persist immediately so the very next turn is authenticated.
              // buddyName/ttsVoice are committed later in step 3; pass the
              // current stored values so we don't clobber a returning user.
              saveLicense(parsed.licenseKey, plan, getBuddyName(), getTtsVoice());
              log.info('FreeSignup.success', { plan, keyTail: parsed.licenseKey.slice(-4) });
              resolve({ licenseKey: parsed.licenseKey, plan });
            } else if (status === 400) {
              resolve({ error: parsed.error || 'invalid_email' });
            } else if (status === 429) {
              resolve({ error: parsed.error || 'rate_limited' });
            } else {
              log.warn('FreeSignup.unexpected', { status });
              resolve({ error: 'offline' });
            }
          });
        });
        req.on('error', (err) => {
          clearTimeout(timeout);
          log.error('FreeSignup.error', serializeErr(err));
          resolve({ error: 'offline' });
        });
        req.write(JSON.stringify({ email: trimmed }));
        req.end();
      });
    } catch (err) {
      log.error('FreeSignup.failed', serializeErr(err));
      return { error: 'offline' };
    }
  });

  // Save license data from onboarding
  ipcMain.handle('save-license', async (_event, key: string, plan: string, buddyName: string, ttsVoice: string) => {
    saveLicense(key, plan, buddyName, ttsVoice);
    return true;
  });

  // Brain orientation status — onboarding step 3 calls this to render the
  // per-file ✓/✗ list. The check itself ran at app-ready (see index.ts);
  // this just exposes the cached result.
  ipcMain.handle('orient-brain', async () => {
    const { orient } = await import('./orient');
    return orient();
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
      // v0.19.0 PR-2 — bubble v2 prefs (default state + pin)
      bubbleDefaultState: brainSettingsStore.get('bubbleDefaultState'),
      bubblePinned: brainSettingsStore.get('bubblePinned'),
      // v0.19.0 — contextual-suggestion energy level
      clippyEnergy: brainSettingsStore.get('clippyEnergy'),
      ttsEnabled: licenseStore.get('ttsEnabled', true),
      // v0.20.0 (voice v1) — TTS engine picker + OpenAI key presence.
      // Renderer reads ttsEngine to decide whether to attempt the OpenAI
      // path; openaiKeyPresent drives the Settings UI state. The key
      // VALUE never appears here — presence boolean only.
      ttsEngine: getTtsEngine(),
      openaiKeyPresent: isOpenAiKeyPresent(),
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
      // v0.19.0 — follow-me cursor mode settings
      followOffsetX: brainSettingsStore.get('followOffsetX'),
      followOffsetY: brainSettingsStore.get('followOffsetY'),
      followEasing: brainSettingsStore.get('followEasing'),
      // v0.20.0-alpha.11 — focused-window follow toggle
      windowFollowEnabled: brainSettingsStore.get('windowFollowEnabled'),
      // v0.20.0 (Beta) — ⌥G writing-assistant toggle
      writingAssistEnabled: brainSettingsStore.get('writingAssistEnabled'),
      // feat/pricing-free-tier — last usage snapshot for the Settings meter.
      // tokensAllowed === 0 means "not yet seen a turn" → meter hides itself.
      ...getUsage(),
    };
  });

  // Update settings (with validation)
  ipcMain.handle('update-settings', async (_event, settings: Record<string, unknown>) => {
    if (settings.buddyName !== undefined) {
      const name = String(settings.buddyName).trim().substring(0, 20);
      if (name) licenseStore.set('buddyName', name);
    }
    if (settings.ttsVoice !== undefined) {
      const voice = String(settings.ttsVoice);
      licenseStore.set('ttsVoice', voice);
      // Broadcast so the renderer's TTS instance switches voice LIVE. It only
      // called setPreferredVoice once at config-load, so changing the voice in
      // Settings previously took effect on the next restart. Mirrors tts-engine.
      mainWindow.webContents.send('speech-voice', voice);
    }
    // Proactive interval + on/off both require restarting the brain loop so
    // the change takes effect immediately (not on next sleep/wake cycle).
    let proactiveChanged = false;
    if (settings.proactiveInterval !== undefined) {
      const interval = Math.max(5000, Math.min(300000, Number(settings.proactiveInterval) || 300000));
      brainSettingsStore.set('proactiveInterval', interval);
      proactiveChanged = true;
      // v0.18.0 — broadcast on dedicated `proactive-interval` channel
      // (separate from boolean `proactive-toggle` to avoid reshaping
      // a channel that tray.ts already uses with a boolean payload).
      mainWindow.webContents.send('proactive-interval', interval);
    }
    if (settings.proactiveEnabled !== undefined) {
      const enabled = Boolean(settings.proactiveEnabled);
      brainSettingsStore.set('proactiveEnabled', enabled);
      proactiveChanged = true;
      // v0.18.0 — same shape as tray.ts:74 sends on this channel.
      mainWindow.webContents.send('proactive-toggle', enabled);
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
    // v0.19.0 PR-2 — bubble default-state + pin. Both broadcast so the
    // renderer's BubbleController can react without a round-trip getConfig.
    if (settings.bubbleDefaultState !== undefined) {
      const v = String(settings.bubbleDefaultState);
      const state: 'compact' | 'standard' = v === 'compact' ? 'compact' : 'standard';
      brainSettingsStore.set('bubbleDefaultState', state);
      mainWindow.webContents.send('bubble-default-state', state);
    }
    // v0.19.0 — bubble pinned (stays open across messages)
    if (settings.bubblePinned !== undefined) {
      const pinned = Boolean(settings.bubblePinned);
      brainSettingsStore.set('bubblePinned', pinned);
      mainWindow.webContents.send('bubble-pinned', pinned);
    }
    if (proactiveChanged) brain.restartProactiveLoop();
    // TTS toggle + speech rate — saved in licenseStore, broadcast to main window
    if (settings.ttsEnabled !== undefined) {
      licenseStore.set('ttsEnabled', Boolean(settings.ttsEnabled));
      mainWindow.webContents.send('tts-toggle', Boolean(settings.ttsEnabled));
    }
    // v0.20.0 (voice v1) — TTS engine picker: 'system' (free, default,
    // offline) vs 'openai' (premium, requires a key). Broadcast so the
    // renderer's TTS instance switches engine live without a reload.
    if (settings.ttsEngine !== undefined) {
      const engine = String(settings.ttsEngine) === 'openai' ? 'openai' : 'system';
      setTtsEngine(engine);
      mainWindow.webContents.send('tts-engine', engine);
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
    // v0.19.0 — Clippy energy level for the contextual-suggestion rule engine.
    if (settings.clippyEnergy !== undefined) {
      const energy = String(settings.clippyEnergy);
      if (['subtle', 'default', 'lively'].includes(energy)) {
        brainSettingsStore.set('clippyEnergy', energy as 'subtle' | 'default' | 'lively');
      }
    }
    // v0.19.0 — follow-me cursor mode options. Live-update setOptions() so
    // changes in the Settings slider take effect without a restart.
    if (settings.followOffsetX !== undefined) {
      const offX = Math.max(-400, Math.min(400, Number(settings.followOffsetX) || 220));
      brainSettingsStore.set('followOffsetX', offX);
      try {
        followMeMod.setOptions({ offsetX: offX });
      } catch { /* non-fatal */ }
    }
    if (settings.followOffsetY !== undefined) {
      const offY = Math.max(-300, Math.min(300, Number(settings.followOffsetY) || 120));
      brainSettingsStore.set('followOffsetY', offY);
      try {
        followMeMod.setOptions({ offsetY: offY });
      } catch { /* non-fatal */ }
    }
    if (settings.followEasing !== undefined) {
      const ease = Math.max(0.05, Math.min(0.40, Number(settings.followEasing) || 0.18));
      brainSettingsStore.set('followEasing', ease);
      try {
        followMeMod.setOptions({ easing: ease });
      } catch { /* non-fatal */ }
    }
    // v0.20.0-alpha.11 — focused-window follow toggle. Live-applies: when
    // turned off we stop the poll interval immediately; when re-enabled we
    // restart with the existing brain/window references.
    if (settings.windowFollowEnabled !== undefined) {
      const enabled = Boolean(settings.windowFollowEnabled);
      brainSettingsStore.set('windowFollowEnabled', enabled);
      try {
        if (enabled) {
          windowFollowMod.startWindowFollow(mainWindow, brain);
        } else {
          windowFollowMod.stopWindowFollow();
        }
      } catch (err) {
        log.warn('window-follow toggle failed (non-fatal)', err instanceof Error ? err.message : String(err));
      }
    }
    // v0.20.0 (Beta) — writing-assistant toggle. Just persist; the ⌥G
    // orchestrator reads this at trigger time (no live wiring to restart).
    if (settings.writingAssistEnabled !== undefined) {
      brainSettingsStore.set('writingAssistEnabled', Boolean(settings.writingAssistEnabled));
    }
    // v0.19.0 PR-6 — onboarding app picker. setUserApps re-validates
    // against the KNOWN_APP_IDS whitelist; any unknown ID is silently
    // dropped, so a malicious renderer can't sneak in "foo-bar" and
    // poison tools.ts later.
    if (settings.userApps !== undefined) {
      const raw = settings.userApps;
      const arr = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
      setUserApps(arr);
    }
    return true;
  });

  // v0.19.0 — "Don't suggest this again" denylist append.
  // Triggered when the user right-clicks a rule-fired bubble and chooses
  // "Don't suggest this again". Idempotent: adding an already-denylisted
  // ID is harmless.
  ipcMain.handle('add-suggestion-denylist', async (_event, ruleId: unknown) => {
    if (typeof ruleId !== 'string' || !ruleId.trim()) return false;
    const id = ruleId.trim().substring(0, 80); // cap length; no traversal risk
    const current = brainSettingsStore.get('suggestionDenylist') as string[];
    if (!current.includes(id)) {
      brainSettingsStore.set('suggestionDenylist', [...current, id]);
      log.info('Suggestion.denied', { rule_id: id });
      // v0.20.0-alpha.3 — keep brain's cached denylist Set in sync, otherwise
      // the rule that was just denied could still fire on the next proactive
      // tick before the next process restart (the brain reads from its
      // cached Set, not settingsStore live).
      brain.rebuildSuggestionCaches();
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

  // Clear license + ALL local state (Keychain tokens + on-disk profile) so a
  // user who clears the app leaves nothing orphaned and re-onboards cleanly.
  // "Change key" (Settings → License). License-ONLY clear: drops the stored
  // key/plan so onboarding can capture a new one, but PRESERVES the user's
  // profile, learned instincts, connected-app Keychain tokens, and history.
  // (Before alpha.20 this called clearAllLocalData() and silently nuked the
  // whole persona on a simple key swap — see reset-app below for the explicit
  // full-wipe path.)
  ipcMain.handle('clear-license', async () => {
    clearLicense();
    return true;
  });

  // "Reset ClippyAI" (Settings → License → Danger zone). The EXPLICIT
  // full-wipe path: clears license + persona + instincts + Keychain tokens +
  // history, then relaunches into a fresh onboarding. Gated by a native
  // confirm dialog owned by main so a compromised renderer can't trigger a
  // silent wipe. Resolves false on cancel; on confirm the app relaunches and
  // the promise never settles in the renderer.
  ipcMain.handle('reset-app', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts = {
      type: 'warning' as const,
      buttons: ['Cancel', 'Reset ClippyAI'],
      defaultId: 0,
      cancelId: 0,
      title: 'Reset ClippyAI',
      message: 'Reset ClippyAI to a fresh install?',
      detail:
        'This erases your license, the profile Clippy has built about you (your name and details), learned instincts, connected-app keys, and action history — then relaunches into onboarding.\n\nThis cannot be undone.',
    };
    const { response } = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);
    if (response !== 1) return false; // cancelled
    await clearAllLocalData();
    app.relaunch();
    app.exit(0);
    return true; // not reached
  });

  // ── v0.20.0 — permission walkthrough (onboarding) ─────────────────
  // Four handlers that the onboarding renderer calls to query macOS
  // permission state, open the exact System Preferences pane, surface
  // the Screen Recording prompt, and restart to apply new grants.

  ipcMain.handle('get-permissions', async () => {
    try { return await permissions(); } catch { return null; }
  });

  ipcMain.handle('open-permission-pane', async (_e, kind: unknown) => {
    const url = PERMISSION_PANES[String(kind)];
    if (!url) return false; // fixed enum -> fixed URL; no arbitrary scheme passthrough
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('request-screen-recording', async () => {
    try { return await requestScreenRecording(); } catch { return { granted: false }; }
  });

  // ── v1 — writing assistant (⌥G) ──────────────────────────────────
  // The card renderer calls these. 'apply' writes the corrected text back
  // into the system-wide focused field via the Swift bridge; on a non-AX-
  // writable surface the bridge throws and we report it (select-all+type
  // fallback is a TODO). 'dismiss' just closes the card window.
  ipcMain.handle('writing-assist:apply', async (_e, value: unknown) => {
    if (typeof value !== 'string') return { ok: false };
    try {
      await macBridge.a11yFocusedSetValue({ value });
      return { ok: true };
    } catch (err) {
      // v1: report; fallback to select-all+type is a TODO.
      log.warn('writing-assist:apply failed', { err: String(err) });
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.on('writing-assist:dismiss', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) w.close();
  });

  // Always-on watcher → badge → full card. Clicking the badge runs the exact
  // ⌥G flow (read focused field, lint, present correction card) and hides the
  // badge so it doesn't sit on top of the card.
  ipcMain.on('writing-badge:open', () => {
    hideWritingBadge();
    void triggerWritingAssist(mainWindow);
  });

  ipcMain.handle('restart-app', async () => {
    app.relaunch();
    app.exit(0);
    return true; // not reached
  });

  // ── v0.19.0 PR-6 — onboarding app picker + API-key state ───────────
  // Renderer reads/writes the selected app IDs (step 4) and stores
  // per-app API tokens in the macOS Keychain (step 5 + Settings → Apps).
  //
  // SECURITY: the actual token NEVER leaves main once written. The renderer
  // can SET a token (write path), it can CLEAR a token, and it can read a
  // presence boolean — but it can't read the raw token back. That's why
  // get-api-keys returns Record<appId, boolean>, not Record<appId, string>.

  ipcMain.handle('get-user-apps', async () => {
    return getUserApps();
  });

  ipcMain.handle('set-user-apps', async (_event, apps: unknown) => {
    const arr = Array.isArray(apps) ? apps.filter((x): x is string => typeof x === 'string') : [];
    setUserApps(arr);
    return getUserApps();
  });

  ipcMain.handle('get-api-keys', async () => {
    return getApiKeysPresence();
  });

  ipcMain.handle('set-api-key', async (_event, appId: unknown, token: unknown) => {
    // Reject anything not in the API_CAPABLE_APP_IDS whitelist BEFORE we
    // touch the keychain. Same defense-in-depth pattern as the license
    // store's setUserApps — even though setSecret won't throw, we don't
    // want unknown service/account combos accumulating in the user's
    // keychain (visible in Keychain Access.app).
    if (typeof appId !== 'string') return { ok: false, error: 'invalid-app-id' };
    if (typeof token !== 'string') return { ok: false, error: 'invalid-token' };
    const allow = new Set<string>(API_CAPABLE_APP_IDS as readonly string[]);
    if (!allow.has(appId)) return { ok: false, error: 'unknown-app-id' };
    const trimmed = token.trim();
    if (!trimmed) return { ok: false, error: 'empty-token' };
    // Soft length cap — real tokens are <1KB; anything larger is almost
    // certainly a copy-paste mistake (user pasted the entire instructions
    // block by accident, or a malicious renderer is trying to bloat the
    // keychain). 4096 covers every legit token format we know of.
    if (trimmed.length > 4096) return { ok: false, error: 'token-too-large' };
    try {
      await setSecret(API_KEYCHAIN_SERVICE, appId, trimmed);
      setApiKeyPresence(appId, true);
      return { ok: true };
    } catch (err) {
      log.warn('set-api-key failed', { appId, msg: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: 'keychain-write-failed' };
    }
  });

  ipcMain.handle('clear-api-key', async (_event, appId: unknown) => {
    if (typeof appId !== 'string') return { ok: false, error: 'invalid-app-id' };
    const allow = new Set<string>(API_CAPABLE_APP_IDS as readonly string[]);
    if (!allow.has(appId)) return { ok: false, error: 'unknown-app-id' };
    try {
      await clearSecret(API_KEYCHAIN_SERVICE, appId);
      setApiKeyPresence(appId, false);
      return { ok: true };
    } catch (err) {
      log.warn('clear-api-key failed', { appId, msg: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: 'keychain-clear-failed' };
    }
  });

  // v0.19.0 PR-6 — chip on step-6 ("Try one of these as your first ask")
  // OR on the post-onboarding overlay closes the onboarding window AND
  // pumps the chip's prompt as a normal user message through the bubble's
  // first turn. Renderer-side bubble code already knows how to render +
  // route a "user-message"; this IPC just unifies the entry point so we
  // can fire the same flow from EITHER the onboarding window (which closes
  // itself) OR the main window's overlay.
  ipcMain.handle('first-win-chip', async (_event, text: unknown) => {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim().substring(0, 4096);
    if (!trimmed || !mainWindow || mainWindow.isDestroyed()) return false;
    // Wait for the main window to be visible before pumping; otherwise
    // the renderer's bubble controller isn't initialized yet and we'd
    // lose the message. onboarding-complete already shows the window,
    // but we re-guard here in case this comes from the overlay path
    // (where the window is already up — show() is a no-op).
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.webContents.send('first-win-chip', trimmed);
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
  // v0.14.1 — Settings → About shows which AI model served the last
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

  // v0.20.0 (voice v1) — OpenAI TTS proxy. The renderer's tts.ts calls
  // this ONLY when the user picked the OpenAI engine; we read the key in
  // main (Keychain or env), call gpt-4o-mini-tts, and return the audio
  // BYTES. The key never crosses the bridge. On no-key/error the renderer
  // falls back to local SpeechSynthesis — Clippy never goes mute.
  ipcMain.handle('synthesize-speech', async (_event, text: unknown, voice?: unknown) => {
    try {
      if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, error: 'empty-text' };
      }
      const v = typeof voice === 'string' && voice.trim() ? voice.trim() : undefined;
      // voice v2 — pick the TTS path. The renderer only attempts this
      // handler when the OpenAI engine is selected (config.ttsEngine).
      //   • personal OpenAI key present → existing BYO, direct-to-OpenAI,
      //     UNMETERED path (unchanged).
      //   • no personal key → the worker's metered premium endpoint, which
      //     uses ITS key + meters 300 min/mo. This delivers the Max-tier
      //     "premium voice, no API key needed" promise.
      // On ANY non-OK result (capped/not-entitled/network/etc.) we return
      // unavailable:true so the renderer falls back to the local SYSTEM
      // voice — Clippy never goes mute. The license/OpenAI key never
      // crosses into the renderer; only audio bytes (or a flag) do.
      const r = openaiVoice.isOpenAiVoiceConfigured()
        ? await openaiVoice.synthesizeSpeech(text, { voice: v })
        : await openaiVoice.synthesizeViaWorker(text, v);
      if (!r.ok) {
        return { ok: false, error: r.error, unavailable: r.unavailable === true };
      }
      // Hand back a plain Uint8Array — structured-clone-safe over IPC.
      return { ok: true, audio: r.audio, mimeType: r.mimeType };
    } catch (err) {
      log.warn('synthesize-speech failed', serializeErr(err));
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // v0.20.0 (voice v1) — write the user-provided OpenAI key to Keychain
  // (service `clippyai-api`, account `openai`) + flip the presence flag.
  // Write-only: there is no get-openai-key handler, so the key value can
  // never be read back into the renderer. Mirrors set-api-key.
  ipcMain.handle('set-openai-key', async (_event, token: unknown) => {
    if (typeof token !== 'string' || token.trim().length < 8) {
      return { ok: false, error: 'invalid-key' };
    }
    try {
      await setSecret(API_KEYCHAIN_SERVICE, openaiVoice.OPENAI_KEYCHAIN_ACCOUNT, token.trim());
      setOpenAiKeyPresence(true);
      return { ok: true };
    } catch (err) {
      log.warn('set-openai-key failed', { msg: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: 'keychain-write-failed' };
    }
  });

  ipcMain.handle('clear-openai-key', async () => {
    try {
      await clearSecret(API_KEYCHAIN_SERVICE, openaiVoice.OPENAI_KEYCHAIN_ACCOUNT);
      setOpenAiKeyPresence(false);
      // If the user removes the key, drop back to the free System engine
      // so we don't leave them on a now-broken OpenAI path.
      setTtsEngine('system');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tts-engine', 'system');
      }
      return { ok: true };
    } catch (err) {
      log.warn('clear-openai-key failed', { msg: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: 'keychain-clear-failed' };
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

    // v0.20.0-alpha.6 — bootstrap the profile/ workspace (IDENTITY.md,
    // USER.md, SOUL.md, MEMORY.md) so the worker model has tailored
    // context from turn 1. The user-name field is filled later when
    // the user answers Clippy's first-meeting prompt; the other fields
    // come from license/onboarding inputs.
    try {
      const existing = profileMod.getUserFields();
      profileMod.writeOnboardingProfile({
        buddyName: getBuddyName() || 'Clippy',
        ttsVoice: getTtsVoice() || '',
        userName: existing['Name'] || '',
        userApps: getUserApps(),
      });
    } catch (err) {
      log.warn('Profile bootstrap on onboarding-complete failed (non-fatal)', err);
    }

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
    } else {
      // v0.19.0 PR-6 — "first-5-wins" overlay. If the user already has a
      // profile (returning user — re-running onboarding to change apps,
      // for example) we skip the name prompt and instead surface the
      // 5 quick-win chips after a 3s settle. New users get the chips
      // AFTER they answer the name prompt — see the rendezvous logic in
      // src/renderer/main.ts which schedules this same overlay there.
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('first-win-overlay');
        }
      }, 3000);
    }

    return true;
  });

  // v0.17.8 — Guardrails: permission policy + action history IPC handlers.
  // These are the renderer-facing API for Settings → Guardrails.
  ipcMain.handle('guardrails:get-policy', async () => {
    return permissionPolicyMod.getPolicy();
  });
  ipcMain.handle('guardrails:set-policy', async (_event, payload: unknown) => {
    const p = payload as { mode?: import('./permission-policy').Mode; classOverrides?: Record<string, import('./permission-policy').ClassDecision> };
    return permissionPolicyMod.setPolicy({
      mode: p?.mode,
      classOverrides: p?.classOverrides as Partial<Record<import('./tool-meta').ActionClass, import('./permission-policy').ClassDecision>>,
    });
  });
  ipcMain.handle('guardrails:get-history', async () => {
    return actionHistoryMod.getAll();
  });
  ipcMain.handle('guardrails:clear-history', async () => {
    actionHistoryMod.clear();
    return true;
  });

  // v0.19.0 — Undo: apply the inverse of a recorded action.
  // Returns { ok, detail } — the renderer shows this as a toast.
  // Trust budget: if we're unsure (entry not found, already undone, no
  // inverse recorded), return ok:false with an honest reason. Never claim
  // success when we didn't actually undo.
  ipcMain.handle('action-undo', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) {
      return { ok: false, detail: 'Invalid action id.' };
    }
    try {
      const entry = actionHistoryMod.findById(id);
      if (!entry) return { ok: false, detail: 'Action not found in history.' };
      if (entry.undone) return { ok: false, detail: 'Already undone.' };
      if (!entry.inverse) return { ok: false, detail: 'This action is not undoable.' };

      const result = await undoMod.applyInverse(entry.inverse);

      if (result.ok) {
        actionHistoryMod.markUndone(id);
        log.info('action-undo success', { id, tool: entry.tool });
      } else {
        log.warn('action-undo failed', { id, tool: entry.tool, detail: result.detail });
      }
      return result;
    } catch (err) {
      log.error('action-undo threw', serializeErr(err));
      return { ok: false, detail: `Undo error: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // Right-click context menu
  let voiceMuted = false;

  ipcMain.on('show-context-menu', (_event, ruleId?: string) => {
    const isAwake = brain.getMode() === 'awake';

    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
      {
        label: '💬 Chat...',
        click: () => {
          const text = 'What can I help you with?';
          log.info('Clippy.say', { text, animation: 'Wave', trigger: 'chat_menu' });
          mainWindow.webContents.send('clippy-speak', { text, animate: 'Wave' });
        },
      },
    ];

    // v0.19.0 — "Don't suggest this again" appears when the current visible
    // tip was fired by a deterministic rule (ruleId present).
    if (ruleId && typeof ruleId === 'string') {
      menuTemplate.push({
        label: "🚫 Don't suggest this again",
        click: () => {
          const current = brainSettingsStore.get('suggestionDenylist') as string[];
          if (!current.includes(ruleId)) {
            brainSettingsStore.set('suggestionDenylist', [...current, ruleId]);
            log.info('Suggestion.denied', { rule_id: ruleId, source: 'context_menu' });
          }
        },
      });
    }

    menuTemplate.push(
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
    );

    const menu = Menu.buildFromTemplate(menuTemplate);
    menu.popup({ window: mainWindow });
  });
}
