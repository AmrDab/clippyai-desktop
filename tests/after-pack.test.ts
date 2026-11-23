/**
 * scripts/after-pack.js: which Electron fuses each build flips (2026-11 scan).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const req = createRequire(import.meta.url);
const { FuseV1Options, FuseVersion } = req('@electron/fuses');
const { fuseConfig } = req(path.join(__dirname, '..', 'scripts', 'after-pack.js'));

describe('after-pack fuses', () => {
  it.each(['darwin', 'win32'])('%s: no inspector, no NODE_OPTIONS', (platform) => {
    const c = fuseConfig(platform, 1);
    expect(c.version).toBe(FuseVersion.V1);
    expect(c[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
    expect(c[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false);
  });

  it('macOS validates the embedded asar hash and loads the app only from app.asar', () => {
    for (const arch of [1 /* x64 */, 3 /* arm64 */]) {
      const c = fuseConfig('darwin', arch);
      expect(c[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true);
      expect(c[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true);
    }
    expect(fuseConfig('darwin', 3).resetAdHocDarwinSignature).toBe(true);
    expect(fuseConfig('darwin', 1).resetAdHocDarwinSignature).toBe(false);
  });

  it('Windows leaves the asar fuses at their defaults (unsupported in Electron 29)', () => {
    const c = fuseConfig('win32', 1);
    expect(c[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBeUndefined();
    expect(c[FuseV1Options.OnlyLoadAppFromAsar]).toBeUndefined();
    expect(c.resetAdHocDarwinSignature).toBe(false);
  });

  it('RunAsNode stays on: the agent bridge and ClawHub run.js skills need it (see after-pack.js)', () => {
    expect(fuseConfig('darwin', 3)[FuseV1Options.RunAsNode]).toBe(true);
    expect(fuseConfig('win32', 1)[FuseV1Options.RunAsNode]).toBe(true);
  });
});
