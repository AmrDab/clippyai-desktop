import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron';
import path from 'path';
import { Brain } from './brain';
import { createSettingsWindow } from './window';
import { getBuddyName } from './license';

let tray: Tray | null = null;

function createTrayIcon(awake: boolean): Electron.NativeImage {
  // 16x16 circle as a data URI PNG — green for awake, grey for sleep
  // Pre-encoded tiny PNGs to avoid buffer format issues on Windows
  const greenCircle = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAO0lEQVR4nGNgoAXwWR/wHxumSDNRhhDSjNcQYjVjNYRUzRiGjBpABQMojkaqJCRiDcGrmZAhRGkmFQAAAJ9lKE8XC1oAAAAASUVORK5CYII=';
  const greyCircle = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAO0lEQVR4nGNgoAWYN2/ef2yYIs1EGUJIM15DiNWM1RBSNWMYMmoAFQygOBqpkpCINQSvZkKGEKWZVAAAOiC8THLi6UwAAAAASUVORK5CYII=';

  try {
    return nativeImage.createFromDataURL(awake ? greenCircle : greyCircle);
  } catch {
    // Fallback: use the build icon
    return nativeImage.createFromPath(path.join(__dirname, '../../build/icon.ico'));
  }
}

export function setupTray(win: BrowserWindow, brain: Brain): Tray {
  tray = new Tray(createTrayIcon(true));
  tray.setToolTip('ClippyAI');

  let muteVoice = false;
  let proactiveMode = true;

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
        checked: proactiveMode,
        click: (item) => {
          proactiveMode = item.checked;
          win.webContents.send('proactive-toggle', proactiveMode);
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
