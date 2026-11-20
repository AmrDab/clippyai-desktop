// v0.23.2 — how to install a downloaded Windows update. Since the installer
// is signed (Trusted Signing) and electron-updater's download carries no
// Mark-of-the-Web, a silent NSIS install works the way VS Code / Slack do it.
// If one silent attempt for a version didn't land (the boot check counts it),
// the next attempt falls back to the v0.11.24 Explorer hand-off.
export type InstallMethod = 'silent' | 'explorer';

export function installMethodFor(failedAttempts: number): InstallMethod {
  return failedAttempts > 0 ? 'explorer' : 'silent';
}

/**
 * v0.24.12 — "Restart to update": how long after quitAndInstall the app may
 * still be running before we conclude the installer never took over. The app
 * has flagged a real quit and released its tools by then, so it must undo
 * both or it stays half shut down (the window closes instead of hiding, the
 * tools are gone). Squirrel.Mac downloads its own copy first, hence the
 * longer wait there; a silent NSIS install quits within moments.
 */
export function installWatchdogMs(platform: string): number {
  return platform === 'darwin' ? 120_000 : 20_000;
}

/**
 * Update events go to the bubble window; Settings has its own listeners for
 * the same update-* channels (its "Check for updates" row). Sent only to the
 * bubble, a check from Settings got no answer and ended after 30 s with
 * "Couldn't reach the update server". clippy-speak and the like stay bubble-only.
 */
export function alsoForSettings(channel: string): boolean {
  return channel.startsWith('update-');
}
