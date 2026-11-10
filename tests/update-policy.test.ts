import { describe, it, expect } from 'vitest';
import { shouldIdleInstall, classifyAttempt, cmpVersion, IDLE_INSTALL_SECONDS, type IdleInstallInput } from '../src/main/update-policy';

const ready: IdleInstallInput = {
  platform: 'win32', updateDownloaded: true, failedBefore: false, taskRunning: false, idleSeconds: IDLE_INSTALL_SECONDS, alreadyTried: false,
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

describe('cmpVersion', () => {
  it('tolerates missing segments', () => {
    expect(cmpVersion('1.2', '1.2.0')).toBe(0);
    expect(cmpVersion('0.24.0', '0.23.9')).toBeGreaterThan(0);
  });
});
