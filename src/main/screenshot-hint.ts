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
