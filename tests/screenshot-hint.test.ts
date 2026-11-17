import { describe, it, expect } from 'vitest';
import { screenshotHint } from '../src/main/screenshot-hint';

describe('screenshotHint', () => {
  it('darwin Retina: factor is points/final (2.1875), not native/final (4.375)', () => {
    const t = screenshotHint({ platform: 'darwin', nativeW: 4480, nativeH: 2520, finalW: 1024, finalH: 576, pointW: 2240 });
    expect(t).toContain('mouse_click(round(sx*2.1875), round(sy*2.1875))');
    expect(t).not.toContain('4.375');
    expect(t).toContain('points');
  });
  it('darwin non-Retina uses the same factor as native', () => {
    const t = screenshotHint({ platform: 'darwin', nativeW: 2560, nativeH: 1440, finalW: 1024, finalH: 576, pointW: 2560 });
    expect(t).toContain('sx*2.5)');
  });
  it('darwin small Retina display that is not downscaled still needs a 2x hint', () => {
    const t = screenshotHint({ platform: 'darwin', nativeW: 1280, nativeH: 800, finalW: 1280, finalH: 800, pointW: 640 });
    expect(t).toContain('sx*0.5)');
  });
  it('darwin without a point width falls back to native', () => {
    const t = screenshotHint({ platform: 'darwin', nativeW: 2048, nativeH: 1152, finalW: 1024, finalH: 576 });
    expect(t).toContain('sx*2)');
  });
  it('win32 is unchanged: native physical pixels, 3 decimals', () => {
    const t = screenshotHint({ platform: 'win32', nativeW: 3840, nativeH: 2400, finalW: 1024, finalH: 640, pointW: 1707 });
    expect(t).toContain('downscaled from native 3840x2400, scale 3.750x');
    expect(t).toContain('mouse_click(round(sx*3.750), round(sy*3.750)) to convert to native pixels');
  });
  it('win32 not downscaled', () => {
    expect(screenshotHint({ platform: 'win32', nativeW: 1280, nativeH: 720, finalW: 1280, finalH: 720 }))
      .toContain('native — no downscale');
  });
});
