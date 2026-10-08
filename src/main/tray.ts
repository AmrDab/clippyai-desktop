import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron';
import path from 'path';
import { Brain, brainSettingsStore } from './brain';
import { createSettingsWindow } from './window';
import { getBuddyName } from './license';
import * as followMe from './follow-me';
import * as games from './games';

let tray: Tray | null = null;

function createTrayIcon(_awake: boolean): Electron.NativeImage {
  // Use the actual paperclip app icon for the system tray
  return nativeImage.createFromPath(path.join(__dirname, '../../build/icon.ico')).resize({ width: 16, height: 16 });
}

export function setupTray(win: BrowserWindow, brain: Brain): Tray {
  tray = new Tray(createTrayIcon(true));
  tray.setToolTip('ClippyAI');

  let muteVoice = false;

  function updateMenu(): void {
    const isAwake = brain.getMode() === 'awake';
    const buddyName = getBuddyName();

    const menu = Menu.buildFromTemplate([
      { label: `ClippyAI \u2014 ${buddyName}`, enabled: false },
      { type: 'separator' },
      { label: isAwake ? 'Status: Awake' : 'Status: Sleeping', enabled: false },
      {
        label: isAwake ? 'Go to Sleep' : 'Wake Up',
        click: () => {
          const newMode = isAwake ? 'sleep' : 'awake';
          brain.setMode(newMode);
          // Sleep stays visible — just stops brain loop
          if (!win.isVisible()) win.show();
          win.webContents.send('mode-change', newMode);
          tray!.setImage(createTrayIcon(newMode === 'awake'));
          updateMenu();
        },
      },
      { type: 'separator' },
      {
        // v0.19.0 — follow-me toggle. Label reflects current state so the
        // user always knows whether follow mode is active.
        label: followMe.isActive() ? 'Following cursor (click to stop)' : 'Follow my cursor',
        type: 'checkbox' as const,
        checked: followMe.isActive(),
        click: () => {
          if (followMe.isActive()) {
            followMe.stop('manual');
          } else {
            followMe.start(win);
          }
          updateMenu();
        },
      },
      {
        // v0.21 — local mini-games (free on every plan, no AI calls).
        label: 'Play',
        submenu: [
          { label: 'Catch', click: () => games.start('catch', 'tray') },
          { label: 'Hide-and-seek', click: () => games.start('hide', 'tray') },
          { label: 'Rock-paper-scissors', click: () => games.start('rps', 'tray') },
          { type: 'separator' },
          {
            label: games.isActive() ? `Stop game (${games.GAME_LABELS[games.activeGame()!]})` : 'Stop game',
            enabled: games.isActive(),
            click: () => games.stop('tray'),
          },
        ],
      },
      {
        label: 'Center on Screen',
        // v0.12.5 — rescue affordance when Clippy gets dragged off-screen
        // (multi-monitor disconnect, snap-to-edge gone wrong). Per polish
        // audit: previously only recovery was reinstall.
        click: () => {
          if (!win.isVisible()) win.show();
          win.center();
        },
      },
      {
        label: 'Settings...',
        click: () => createSettingsWindow(),
      },
      { label: `About ClippyAI v${app.getVersion()}`, enabled: false },
      { type: 'separator' },
      {
        label: 'Mute Voice',
        type: 'checkbox',
        checked: muteVoice,
        click: (item) => {
          muteVoice = item.checked;
          win.webContents.send('tts-toggle', !muteVoice);
        },
      },
      {
        label: 'Proactive Mode',
        type: 'checkbox',
        // Read live from the store so this reflects what Settings shows.
        checked: brainSettingsStore.get('proactiveEnabled'),
        click: (item) => {
          brainSettingsStore.set('proactiveEnabled', item.checked);
          brain.restartProactiveLoop();
          win.webContents.send('proactive-toggle', item.checked);
          updateMenu();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          win.destroy();
          app.quit();
        },
      },
    ]);

    tray!.setContextMenu(menu);
  }

  updateMenu();
  games.onStateChange(updateMenu);

  tray.on('double-click', () => {
    if (win.isVisible()) {
      win.focus();
    } else {
      win.show();
      brain.setMode('awake');
      tray!.setImage(createTrayIcon(true));
      win.webContents.send('mode-change', 'awake');
      updateMenu();
    }
  });

  return tray;
}
