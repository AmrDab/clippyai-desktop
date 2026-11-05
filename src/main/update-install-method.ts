// v0.23.2 — how to install a downloaded Windows update. Since the installer
// is signed (Trusted Signing) and electron-updater's download carries no
// Mark-of-the-Web, a silent NSIS install works the way VS Code / Slack do it.
// If one silent attempt for a version didn't land (the boot check counts it),
// the next attempt falls back to the v0.11.24 Explorer hand-off.
export type InstallMethod = 'silent' | 'explorer';

export function installMethodFor(failedAttempts: number): InstallMethod {
  return failedAttempts > 0 ? 'explorer' : 'silent';
}
