import { globalShortcut, BrowserWindow } from 'electron';
import { Brain, brainSettingsStore as settingsStore } from './brain';
import { createLogger } from './logger';
import { triggerWritingAssist } from './writing-assist';

const log = createLogger('Hotkey');

// Module-local flag tracking voice recording state. globalShortcut doesn't
// give us key-up events (Electron has no real push-to-talk primitive), so
// we model voice as a TOGGLE: first press starts, second press stops.
// ESC in the renderer (handled by bubble.ts) always cancels.
let voiceRecording = false;

export function registerHotkey(win: BrowserWindow, brain: Brain): void {
  // Sleep/wake toggle (existing, since v0.1)
  globalShortcut.register('Ctrl+Shift+C', () => {
    const newMode = brain.getMode() === 'awake' ? 'sleep' : 'awake';
    brain.setMode(newMode);

    if (newMode === 'sleep') {
      win.hide();
    } else {
      win.show();
    }

    win.webContents.send('mode-change', newMode);
  });

  // v0.17.0 — Voice input toggle. Default Ctrl+Shift+Space. The user can
  // disable voice entirely from Settings; we still register the hotkey
  // but the renderer ignores voice-start when voice is disabled. (Not
  // worth re-registering on config change — keeps this code simple.)
  // Failed registration usually means another app holds the shortcut;
  // log a warning rather than crashing because Settings has a fallback
  // mic button.
  const voiceShortcut = (settingsStore.get('voiceHotkey') as string) || 'CommandOrControl+Shift+Space';
  const ok = globalShortcut.register(voiceShortcut, () => {
    if (brain.getMode() !== 'awake') {
      // No voice while sleeping — wake first.
      log.info('Voice.hotkey ignored (sleeping)');
      return;
    }
    voiceRecording = !voiceRecording;
    log.info('Voice.hotkey', { state: voiceRecording ? 'start' : 'stop' });
    if (!win.isDestroyed()) {
      win.webContents.send(voiceRecording ? 'voice-start' : 'voice-stop');
    }
  });
  if (!ok) {
    log.warn('Voice hotkey registration failed — another app may hold it', { shortcut: voiceShortcut });
  } else {
    log.info('Voice hotkey registered', { shortcut: voiceShortcut });
  }

  // v1 — writing assistant. ⌥G reads the focused field, lints it with the
  // on-device Harper engine, and pops a correction card near the field.
  const writingOk = globalShortcut.register('Alt+G', () => {
    if (win.isDestroyed()) return;
    // (Beta) gate — respect the live Settings toggle. Default true; checked at
    // press time so toggling in Settings takes effect immediately.
    if (settingsStore.get('writingAssistEnabled') === false) return;
    void triggerWritingAssist(win);
  });
  if (!writingOk) {
    log.warn('Writing-assist hotkey registration failed — another app may hold it', { shortcut: 'Alt+G' });
  } else {
    log.info('Writing-assist hotkey registered', { shortcut: 'Alt+G' });
  }
}

/** Reset the toggle state — called when the bubble's recorder finishes
 *  naturally (max-duration cap, transcription complete, etc.) so the
 *  next hotkey press starts a new recording instead of canceling a
 *  recording that already ended. */
export function noteVoiceRecorderStopped(): void {
  voiceRecording = false;
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll();
}
