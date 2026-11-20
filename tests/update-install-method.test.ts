import { describe, it, expect } from 'vitest';
import { installMethodFor } from '../src/main/update-install-method';

describe('installMethodFor', () => {
  it('installs silently first, falls back to Explorer after a failed attempt', () => {
    expect(installMethodFor(0)).toBe('silent');
    expect(installMethodFor(1)).toBe('explorer');
  });
});

import { installWatchdogMs, alsoForSettings } from '../src/main/update-install-method';

describe('installWatchdogMs', () => {
  it('Windows gets the 20 s watchdog, macOS the long one', () => {
    expect(installWatchdogMs('win32')).toBe(20_000);
    expect(installWatchdogMs('darwin')).toBe(120_000);
  });
});

describe('alsoForSettings', () => {
  it('every update result the Settings window listens for reaches it', () => {
    for (const ch of ['update-not-available', 'update-available', 'update-ready', 'update-failed']) expect(alsoForSettings(ch)).toBe(true);
  });
  it('speech and animations stay with the bubble', () => {
    for (const ch of ['clippy-speak', 'play-animation']) expect(alsoForSettings(ch)).toBe(false);
  });
});
