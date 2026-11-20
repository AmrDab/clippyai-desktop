/**
 * Text hint that tells the model how to map screenshot pixels to mouse_click
 * coordinates. The click coordinate space differs by platform:
 *   - win32: PHYSICAL pixels (the capture is DPI-aware), so the factor is
 *     nativeW / finalW.
 *   - darwin: POINTS (CGEvent / screencapture -R / Vision OCR via the bridge).
 *     A Retina capture is 2x the point size, so a factor based on native
 *     pixels would be too big by the backing scale; use the display's point
 *     width instead.
 */
export function screenshotHint(opts: {
  platform: NodeJS.Platform;
  nativeW: number;
  nativeH: number;
  finalW: number;
  finalH: number;
  /** darwin only: primary display width in points. Falls back to native pixels when unknown. */
  pointW?: number;
}): string {
  const { platform, nativeW, nativeH, finalW, finalH } = opts;
  const darwin = platform === 'darwin';
  const spaceW = darwin && opts.pointW && opts.pointW > 0 ? opts.pointW : nativeW;
  const unit = darwin ? 'points' : 'native pixels';
  const scale = finalW > 0 && finalW !== spaceW ? spaceW / finalW : 1;
  if (scale === 1) {
    return `Screenshot captured at ${finalW}x${finalH} (${darwin ? 'no rescale needed' : 'native — no downscale'}). Coordinates here ARE ${unit}; pass directly to mouse_click.`;
  }
  const f = darwin ? scale.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : scale.toFixed(3);
  const from = darwin
    ? `downscaled from native ${nativeW}x${nativeH} pixels = ${spaceW}-point-wide display`
    : `downscaled from native ${nativeW}x${nativeH}`;
  return `Screenshot captured at ${finalW}x${finalH} (${from}, scale ${f}x). ` +
    `If you click on a pixel you see in this screenshot at (sx,sy), call mouse_click(round(sx*${f}), round(sy*${f})) to convert to ${unit}. ` +
    `Coordinates from read_screen / ocr_read_screen / smart_click are already in ${unit} — do NOT rescale those.`;
}

// ── v0.24.12: a screenshot of one window (win32) ────────────────────────
// desktop_screenshot used to capture the whole primary screen (3840x2400)
// and shrink it to 1024x640, so a small dialog was a few unreadable pixels.
// It now captures the foreground window. The image no longer starts at the
// screen's (0,0), so a pixel maps to the screen through an origin AND a scale.

export interface ShotRegion { x: number; y: number; width: number; height: number }

/** How a pixel of the image maps to the screen: screen = origin + pixel * scale. */
export interface ShotMapping { originX: number; originY: number; scale: number }

export function shotMapping(region: ShotRegion, finalW: number): ShotMapping {
  return { originX: region.x, originY: region.y, scale: finalW > 0 && finalW !== region.width ? region.width / finalW : 1 };
}

/** The scale as the hint prints it (3 decimals). The model multiplies by THIS number, so the tests use it too. */
export function printedScale(m: ShotMapping): number {
  return Number(m.scale.toFixed(3));
}

/** Screen (physical pixel) coordinate of image pixel (sx,sy), computed the way the hint tells the model to. */
export function shotToScreen(m: ShotMapping, sx: number, sy: number): { x: number; y: number } {
  const f = printedScale(m);
  return { x: Math.round(m.originX + sx * f), y: Math.round(m.originY + sy * f) };
}

/** The mouse_click expression for the hint: `round(X0 + sx*F)`, with the parts that are 0 / 1 left out. */
function axisExpr(origin: number, scale: number, v: 'sx' | 'sy'): string {
  const scaled = scale === 1 ? v : `${v}*${scale.toFixed(3)}`;
  if (origin === 0) return scale === 1 ? v : `round(${scaled})`;
  const sum = origin > 0 ? `${origin} + ${scaled}` : `${scaled} - ${-origin}`;
  return scale === 1 ? sum : `round(${sum})`;
}

/** win32 hint for a window (or whole-screen) capture, in physical pixels. */
export function windowShotHint(opts: {
  region: ShotRegion;
  finalW: number;
  finalH: number;
  /** `"Title" (process)` when the capture is one window; absent for the whole screen. */
  window?: string;
}): string {
  const { region, finalW, finalH } = opts;
  const m = shotMapping(region, finalW);
  const what = opts.window ? `Screenshot of the foreground window ${opts.window}` : 'Screenshot of the whole screen';
  const area = `${finalW}x${finalH} image of the screen area at (${region.x},${region.y}), ${region.width}x${region.height} native pixels` +
    (m.scale === 1 ? '' : `, scale ${m.scale.toFixed(3)}x`);
  const plain = m.scale === 1 && region.x === 0 && region.y === 0;
  const click = plain
    ? 'Coordinates here ARE native pixels; pass directly to mouse_click.'
    : `To click a pixel you see in this image at (sx,sy), call mouse_click(${axisExpr(region.x, m.scale, 'sx')}, ${axisExpr(region.y, m.scale, 'sy')}).`;
  return `${what}: ${area}. ${click} ` +
    'Coordinates from read_screen / ocr_read_screen / smart_click are already native pixels — do NOT convert those.' +
    (opts.window ? ' For the whole screen call desktop_screenshot with region:"screen".' : '');
}
