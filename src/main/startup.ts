import { app } from 'electron';
import Store from 'electron-store';

interface StartupSettings {
  launchOnStartup: boolean;
}

const store = new Store<StartupSettings>({
  name: 'startup-settings',
  defaults: {
    launchOnStartup: false,
  },
});

export function initStartup(): void {
  const enabled = store.get('launchOnStartup');
  app.setLoginItemSettings({
    openAtLogin: enabled,
    name: 'ClippyAI',
  });
}

export function setLaunchOnStartup(enabled: boolean): void {
  store.set('launchOnStartup', enabled);
  app.setLoginItemSettings({
    openAtLogin: enabled,
    name: 'ClippyAI',
  });
}

export function getLaunchOnStartup(): boolean {
  return store.get('launchOnStartup');
}
