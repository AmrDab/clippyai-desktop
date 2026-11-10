import { describe, it, expect } from 'vitest';
import { shouldIdleInstall, classifyAttempt, cmpVersion, shouldPromptStaleUpdate, resumeStillValid, STALE_UPDATE_MS, IDLE_INSTALL_SECONDS, type IdleInstallInput } from '../src/main/update-policy';

const ready: IdleInstallInput = {
  platform: 'win32', updateDownloaded: true, failedBefore: false, taskRunning: false, busyElsewhere: false, idleSeconds: IDLE_INSTALL_SECONDS, alreadyTried: false,
};

describe('shouldIdleInstall', () => {
  it('installs once everything lines up (idle >= 600 s)', () => {
    expect(shouldIdleInstall(ready)).toBe(true);
    expect(shouldIdleInstall({ ...ready, idleSeconds: 5000 })).toBe(true);
  });
  it('waits while the user is around', () => {
    expect(shouldIdleInstall({ ...ready, idleSeconds: IDLE_INSTALL_SECONDS - 1 })).toBe(false);
  });
  it('never interrupts a running task', () => {
    expect(shouldIdleInstall({ ...ready, taskRunning: true })).toBe(false);
  });
  it('waits while a setup/Settings window, agent session, game or approval is open', () => {
    expect(shouldIdleInstall({ ...ready, busyElsewhere: true })).toBe(false);
  });
  it('needs a downloaded update', () => {
    expect(shouldIdleInstall({ ...ready, updateDownloaded: false })).toBe(false);
  });
  it('leaves a version that already failed silently to the manual path', () => {
    expect(shouldIdleInstall({ ...ready, failedBefore: true })).toBe(false);
  });
  it('tries only once per run', () => {
    expect(shouldIdleInstall({ ...ready, alreadyTried: true })).toBe(false);
  });
  it('is Windows-only', () => {
    expect(shouldIdleInstall({ ...ready, platform: 'darwin' })).toBe(false);
  });
});

describe('classifyAttempt', () => {
  it('no recorded attempt', () => {
    expect(classifyAttempt('', '0.23.0')).toBe('none');
  });
  it('succeeded when we are on or past the attempted version', () => {
    expect(classifyAttempt('0.24.0', '0.24.0')).toBe('succeeded');
    expect(classifyAttempt('0.24.0', '0.25.1')).toBe('succeeded');
  });
  it('failed when still on an older version, however old the attempt is', () => {
    expect(classifyAttempt('0.24.0', '0.23.4')).toBe('failed');
  });
});

describe('shouldPromptStaleUpdate', () => {
  const now = 10 * STALE_UPDATE_MS;
  it('stays quiet until the update has waited 3 days, then speaks once', () => {
    expect(shouldPromptStaleUpdate(now - STALE_UPDATE_MS + 1, now, false)).toBe(false);
    expect(shouldPromptStaleUpdate(now - STALE_UPDATE_MS, now, false)).toBe(true);
    expect(shouldPromptStaleUpdate(now - STALE_UPDATE_MS, now, true)).toBe(false);
    expect(shouldPromptStaleUpdate(0, now, false)).toBe(false);
  });
});

describe('resumeStillValid', () => {
  it('only trusts a recent idle-relaunch record', () => {
    expect(resumeStillValid(1000, 2000)).toBe(true);
    expect(resumeStillValid(1000, 1000 + 7 * 60 * 60 * 1000)).toBe(false);
    expect(resumeStillValid(0, 2000)).toBe(false);
  });
});

describe('cmpVersion', () => {
  it('tolerates missing segments', () => {
    expect(cmpVersion('1.2', '1.2.0')).toBe(0);
    expect(cmpVersion('0.24.0', '0.23.9')).toBeGreaterThan(0);
  });
});
