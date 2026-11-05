import { describe, it, expect } from 'vitest';
import { clampRectToDisplay, rectNeedsClamp } from '../src/main/window-geometry';

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const leftDisplay = { workArea: { x: -2560, y: 0, width: 2560, height: 1400 } };
const clippy = { width: 300, height: 360 };

describe('clampRectToDisplay — display-change clamp (plan §1.5)', () => {
  it('leaves a rect that already fits alone', () => {
    const r = { x: 1600, y: 660, ...clippy };
    expect(clampRectToDisplay(r, primary)).toEqual(r);
    expect(rectNeedsClamp(r, primary)).toBe(false);
  });

  it('pulls a rect left behind on an unplugged right-hand monitor back into the primary work area', () => {
    const r = { x: 1920 + 1500, y: 300, ...clippy }; // was on the second display
    const c = clampRectToDisplay(r, primary);
    expect(c).toEqual({ x: 1920 - 300, y: 300, ...clippy });
    expect(rectNeedsClamp(r, primary)).toBe(true);
  });

  it('handles negative-coordinate displays (monitor to the left of primary)', () => {
    const r = { x: -3000, y: -50, ...clippy };
    expect(clampRectToDisplay(r, leftDisplay)).toEqual({ x: -2560, y: 0, ...clippy });
  });

  it('respects the taskbar: bottom edge is the work area, not the screen', () => {
    const r = { x: 100, y: 1040 - 100, ...clippy }; // hangs below the work area after a DPI change
    expect(clampRectToDisplay(r, primary)).toEqual({ x: 100, y: 1040 - 360, ...clippy });
  });

  it('shifts, never shrinks, and rounds', () => {
    const r = { x: 10.6, y: 20.4, ...clippy };
    const c = clampRectToDisplay(r, primary);
    expect(c.width).toBe(300);
    expect(c.height).toBe(360);
    expect(Number.isInteger(c.x) && Number.isInteger(c.y)).toBe(true);
  });
});
