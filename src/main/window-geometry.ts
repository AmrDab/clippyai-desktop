/**
 * window-geometry.ts — pure rect math for the Clippy window (no Electron at
 * runtime; `Rectangle` is a type-only import). Split out of window.ts in
 * v0.23 so the display-change clamp (plan §1.5) is unit-testable.
 */

import type { Rectangle } from 'electron';

/** The slice of Electron's `Display` the clamp needs. */
export interface WorkAreaLike { workArea: Rectangle }

/** Clamp a rect so it lies fully within the display's work area. Shifts
 *  (never shrinks) the rect; callers size rects to fit a single display. */
export function clampRectToDisplay(rect: Rectangle, display: WorkAreaLike): Rectangle {
  const wa = display.workArea;
  const x = Math.round(Math.min(Math.max(rect.x, wa.x), wa.x + wa.width - rect.width));
  const y = Math.round(Math.min(Math.max(rect.y, wa.y), wa.y + wa.height - rect.height));
  return { x, y, width: rect.width, height: rect.height };
}

/** True when the clamp would move the rect (it is off / partly off the work area). */
export function rectNeedsClamp(rect: Rectangle, display: WorkAreaLike): boolean {
  const c = clampRectToDisplay(rect, display);
  return c.x !== rect.x || c.y !== rect.y;
}
