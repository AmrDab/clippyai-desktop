import { globalShortcut, BrowserWindow } from 'electron';
import { Brain } from './brain';

export function registerHotkey(win: BrowserWindow, brain: Brain): void {
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
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll();
}
