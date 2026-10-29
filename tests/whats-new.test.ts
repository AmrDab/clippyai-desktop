import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getVersion: () => '0.22.0' } }));
vi.mock('electron-store', () => ({ default: class { get() { return undefined; } set() { /* noop */ } } }));
vi.mock('../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn() }) }));

import { whatsNewToShow } from '../src/main/whats-new';

describe('whatsNewToShow', () => {
  it('shows nothing on a fresh install', () => {
    expect(whatsNewToShow(undefined, '0.22.0', false)).toBeNull();
  });
  it('shows the notes to a user upgrading from before v0.22 (no stored version)', () => {
    expect(whatsNewToShow(undefined, '0.22.0', true)?.length).toBeGreaterThan(0);
  });
  it('shows the notes after a minor update', () => {
    expect(whatsNewToShow('0.21.1', '0.22.0', true)?.length).toBeGreaterThan(0);
  });
  it('stays quiet on a patch update or a relaunch', () => {
    expect(whatsNewToShow('0.22.0', '0.22.1', true)).toBeNull();
    expect(whatsNewToShow('0.22.0', '0.22.0', true)).toBeNull();
  });
  it('stays quiet for a version with no notes', () => {
    expect(whatsNewToShow('0.22.0', '0.23.0', true)).toBeNull();
  });
});
