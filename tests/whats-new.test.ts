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
    expect(whatsNewToShow('0.98.0', '0.99.0', true)).toBeNull();
  });
});

describe('v0.23 notes', () => {
  it('shows the 0.23 card once when upgrading from 0.22', () => {
    const notes = whatsNewToShow('0.22.4', '0.23.0', true);
    expect(notes && notes.length).toBeGreaterThan(0);
    expect(whatsNewToShow('0.23.0', '0.23.1', true)).toBeNull();
  });
});

describe("v0.24 notes", () => {
  it("shows three short lines once when upgrading from 0.23", () => {
    const notes = whatsNewToShow("0.23.2", "0.24.0", true);
    expect(notes).toHaveLength(3);
    expect(notes!.join(" ")).toMatch(/quietly/);
    expect(notes!.join(" ")).toMatch(/same license key/);
    expect(notes!.join(" ")).toMatch(/Portuguese, Spanish and French/);
    expect(whatsNewToShow("0.24.0", "0.24.1", true)).toBeNull();
  });
});

describe('whatsNewToShow on macOS', () => {
  it("does not promise silent installs on darwin; keeps the other 0.24 notes", () => {
    const win = whatsNewToShow('0.23.2', '0.24.2', true)!;
    const mac = whatsNewToShow('0.23.2', '0.24.2', true, 'darwin')!;
    expect(win[0]).toMatch(/install \*\*quietly/);
    expect(mac[0]).not.toMatch(/install \*\*quietly/);
    expect(mac.slice(1)).toEqual(win.slice(1));
  });
});
