import { describe, it, expect } from 'vitest';
import { gazeToward, ambientAnimationForApp, AmbientThrottle } from '../src/main/spatial-presence';

// Ported from clippyai-macos#24's smoke checks.
describe('spatial-presence', () => {
  it('gazeToward picks the dominant axis and nulls when on-target', () => {
    const clippy = { x: 1000, y: 500, width: 200, height: 200 };
    expect(gazeToward(clippy, { x: 100, y: 450, width: 400, height: 300 })).toBe('LookLeft');
    expect(gazeToward(clippy, { x: 1020, y: 900, width: 300, height: 300 })).toBe('LookDown');
    expect(gazeToward(clippy, { x: 1010, y: 510, width: 180, height: 180 })).toBeNull();
  });

  it('maps app flavors; unknown apps stay quiet', () => {
    expect(ambientAnimationForApp('iTerm2')).toBe('GetTechy');
    expect(ambientAnimationForApp('Figma')).toBe('GetArtsy');
    expect(ambientAnimationForApp('Google Chrome')).toBe('Searching');
    expect(ambientAnimationForApp('SomeRandomApp')).toBeNull();
    expect(ambientAnimationForApp('')).toBeNull();
  });

  it('AmbientThrottle enforces global + per-app windows and resets', () => {
    const th = new AmbientThrottle(90_000, 300_000);
    const t0 = 1_000_000;
    expect(th.allow('Chrome', t0)).toBe(true);
    expect(th.allow('Figma', t0 + 10_000)).toBe(false); // global window
    expect(th.allow('Figma', t0 + 95_000)).toBe(true);
    expect(th.allow('Chrome', t0 + 200_000)).toBe(false); // per-app window
    expect(th.allow('Chrome', t0 + 301_000)).toBe(true);
    th.reset();
    expect(th.allow('Chrome', t0 + 302_000)).toBe(true);
  });
});
