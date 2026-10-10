import { app } from 'electron';
import Store from 'electron-store';

interface StartupSettings {
  launchOnStartup: boolean;
  /** v0.21 — true once the default has been written to the OS. */
  osSynced: boolean;
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
    osSynced: false,
  },
});

export function initStartup(): void {
  // v0.21 containment — apply the stored preference to the OS ONCE (first
  // run). It used to re-assert on every boot whenever the OS state
  // disagreed, which silently re-added the login item after the user had
  // removed it in Task Manager > Startup apps / System Settings. The OS
  // entry is the user's; after the first sync only the Settings toggle
  // (setLaunchOnStartup) touches it.
  if (store.get('osSynced')) return;
  const desired = store.get('launchOnStartup');
  store.set('osSynced', true);
  // Calling setLoginItemSettings fires SMLoginItemSetEnabled, which logs a
  // "Failed to register the login item" error on unsigned macOS builds
  // (Apple requires Developer ID signing); skip when already in agreement.
  if (app.getLoginItemSettings().openAtLogin === desired) return;
  app.setLoginItemSettings({
    openAtLogin: desired,
    name: 'ClippyAI',
  });
}

export function setLaunchOnStartup(enabled: boolean): void {
  store.set('launchOnStartup', enabled);
  store.set('osSynced', true);
  app.setLoginItemSettings({
    openAtLogin: enabled,
    name: 'ClippyAI',
  });
}

export function getLaunchOnStartup(): boolean {
  return store.get('launchOnStartup');
}
