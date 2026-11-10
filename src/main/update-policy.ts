/**
 * update-policy.ts — pure decisions for the updater (no Electron imports so
 * they are unit-testable): when an idle PC may install a downloaded update,
 * and how a recorded install attempt is judged on the next boot.
 */

/** How long the PC must be untouched before a downloaded update installs by itself. */
export const IDLE_INSTALL_SECONDS = 600;

export interface IdleInstallInput {
  platform: string;
  updateDownloaded: boolean;
  /** A silent attempt for this version already failed (counted at boot) — leave it to the manual tray path. */
  failedBefore: boolean;
  taskRunning: boolean;
  /** Anything else that means "someone is using Clippy": setup/Settings window open, agent session, game, approval prompt. */
  busyElsewhere: boolean;
  idleSeconds: number;
  /** An install is already underway, or the idle install already ran once in this process. */
  alreadyTried: boolean;
}

/** Windows only (the NSIS silent path); never mid-task, never for a version that already failed. */
export function shouldIdleInstall(i: IdleInstallInput): boolean {
  return i.platform === 'win32'
    && i.updateDownloaded
    && !i.failedBefore
    && !i.taskRunning
    && !i.busyElsewhere
    && !i.alreadyTried
    && i.idleSeconds >= IDLE_INSTALL_SECONDS;
}

/**
 * Compare semver-ish version strings. Returns negative if a<b, positive if
 * a>b, 0 if equal. Tolerates missing segments ("1.2" == "1.2.0"). We don't
 * need full semver (no prerelease tags in our version scheme).
 */
export function cmpVersion(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Judge a recorded install attempt at boot. 'succeeded' = we are on (or past)
 * the version that was attempted. 'failed' = we never reached it, however long
 * ago the attempt was (v0.24: an idle install that dies overnight is only seen
 * on the next boot, which can be many hours later — age must not discard it).
 * Users who moved past the version by any path land in 'succeeded' and are
 * cleared, never counted.
 */
export function classifyAttempt(attemptedVersion: string, currentVersion: string): 'none' | 'succeeded' | 'failed' {
  if (!attemptedVersion) return 'none';
  return cmpVersion(attemptedVersion, currentVersion) <= 0 ? 'succeeded' : 'failed';
}
