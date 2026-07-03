import { app } from 'electron';
import Store from 'electron-store';

interface StartupSettings {
  launchOnStartup: boolean;
}

const store = new Store<StartupSettings>({
  name: 'startup-settings',
  defaults: {
    // v0.19.0 PR-6.3 — default ON. Clippy is a "buddy that's just there"
    // app, not a launch-on-demand tool. The Settings toggle (General →
    // Launch on startup) lets users opt out if they really want to.
    // Onboarding step 3 surfaces the same toggle so first-run users see
    // the intent up front.
    launchOnStartup: true,
  },
});

export function initStartup(): void {
  // Only sync if the persisted preference disagrees with the OS state.
  // Calling setLoginItemSettings on every boot fires SMLoginItemSetEnabled
  // which logs a "Failed to register the login item" error on unsigned
  // builds (Apple requires Developer ID signing for login-item registration).
  // Once the app is signed for distribution this becomes a no-op idempotency
  // check; until then the early-return avoids a noisy boot.
  const desired = store.get('launchOnStartup');
  const current = app.getLoginItemSettings().openAtLogin;
  if (desired === current) return;
  app.setLoginItemSettings({
    openAtLogin: desired,
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
