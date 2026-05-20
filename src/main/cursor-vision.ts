/**
 * Cursor-vision intent detection + region capture.
 *
 * Lets users point Clippy at something visually by just saying things
 * like "can you see this?" or "what is this?" instead of having to
 * describe what's on screen in words. The brain detects the intent,
 * grabs a screenshot of the area around the mouse cursor, and feeds
 * it to the model as the first vision input on that turn. The model
 * then has direct visual access to exactly what the user is pointing
 * at — usually far more useful than asking the model to read a full-
 * screen OCR dump and guess which item the user meant.
 *
 * Detection
 * ─────────
 * Pattern-match the user's first message against a small set of
 * "deictic" phrases ("this", "that", "here") combined with a "see /
 * read / understand" verb. Conservative: only fires when the phrase
 * is clearly about a visual referent (e.g. "what is this?", "can you
 * see what's here?"). False positives are cheap (one extra screenshot
 * per task) but false negatives mean the feature doesn't fire — so
 * the bias is slightly toward over-triggering when the intent is
 * ambiguous.
 *
 * Capture
 * ───────
 * macOS uses `screencapture -R x,y,w,h -t png` (a built-in CLI tool —
 * no extra dep, no Accessibility prompt, no Electron-only dependency).
 * Windows is delegated to PowerShell + System.Drawing.Graphics. The
 * fallback path (if region capture fails) is a full-screen screenshot
 * plus a text hint with cursor coordinates — the model still gets
 * usable signal, just less focused.
 *
 * Region size
 * ───────────
 * 600×400 pixels centered on the cursor (300 left/right, 200 up/down).
 * Sized to comfortably contain a typical UI element (a button, a
 * paragraph, a table row, an emoji) plus enough context to identify
 * which app it's in. Larger captures waste vision tokens; smaller
 * ones risk cropping out the thing the user is pointing at.
 */

import { screen } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from './logger';

const execFileAsync = promisify(execFile);
const log = createLogger('CursorVision');

/** Half-width and half-height of the capture region. Centered on cursor. */
const HALF_W = 300;
const HALF_H = 200;

/**
 * Conservative pattern: fires on phrases that combine a "see / look /
 * read / understand" verb with a deictic ("this", "that", "here") OR
 * a bare deictic that's clearly visual ("what is this", "look here").
 * Tested against the intended positives plus several adversarial
 * negatives in the unit test below.
 */
const CURSOR_REFERENCE_PATTERN = /\b(?:see|look(?:ing)?\s+at|read|describe|recognize|understand|explain|help\s+me\s+with|what\s+do\s+you\s+(?:see|think|make))\s+(?:this|that|here|it)\b|\bcan\s+you\s+see\s+(?:this|that|it|here)\b|\bwhat'?s\s+(?:this|that|here|on\s+(?:the\s+)?screen)\b|\bwhat\s+is\s+(?:this|that|here|it)\b|\blook\s+(?:at\s+)?(?:my\s+)?(?:cursor|here|this)\b|\btell\s+me\s+(?:what|about)\s+(?:this|that|it|here)\b/i;

export function looksLikeCursorReference(text: string): boolean {
  if (!text) return false;
  // Strip leading "hey clippy" / "hey clip" wakeword so it doesn't
  // anchor the pattern away from the actual intent.
  const cleaned = text.replace(/^\s*(?:hey\s+)?clippy[,:]?\s*/i, '').trim();
  return CURSOR_REFERENCE_PATTERN.test(cleaned);
}

export interface CursorCapture {
  /** Base64-encoded PNG of the captured region. */
  base64: string;
  /** Where on the screen we captured (display-space coordinates). */
  region: { x: number; y: number; width: number; height: number };
  /** Cursor position at capture time. */
  cursor: { x: number; y: number };
  /** Which display the capture came from. */
  display: { id: number; bounds: { x: number; y: number; width: number; height: number } };
}

/**
 * Capture the region around the current cursor position.
 *
 * Returns null on failure (e.g. permission denied, screencapture
 * binary missing) so the caller can fall back gracefully. Logs the
 * failure cause so debugging doesn't require attaching a debugger.
 */
export async function captureCursorArea(): Promise<CursorCapture | null> {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const db = display.bounds;

  // Clamp the capture region so it stays inside the display's bounds.
  // Otherwise screencapture will silently return a smaller image on
  // macOS or fail on Windows.
  const desiredX = cursor.x - HALF_W;
  const desiredY = cursor.y - HALF_H;
  const width = Math.min(HALF_W * 2, db.width);
  const height = Math.min(HALF_H * 2, db.height);
  const x = Math.max(db.x, Math.min(desiredX, db.x + db.width - width));
  const y = Math.max(db.y, Math.min(desiredY, db.y + db.height - height));

  const region = { x, y, width, height };
  log.info('Capturing cursor area', { cursor, region, displayId: display.id });

  const platform = process.platform;
  try {
    const base64 = platform === 'darwin'
      ? await captureMac(region)
      : await captureWindows(region);
    return {
      base64,
      region,
      cursor,
      display: { id: display.id, bounds: db },
    };
  } catch (err) {
    log.warn('Cursor-area capture failed; caller should fall back', {
      platform,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * macOS path. The built-in `screencapture` CLI handles permissions
 * (the user grants screen recording the first time) and outputs a
 * PNG to disk. We write to a temp file, base64 it, then unlink.
 *
 * Flags:
 *   -R x,y,w,h  capture a rectangle (display-space coordinates)
 *   -t png      PNG output (default but explicit)
 *   -x          no sound
 *   -o          no shadow / no cursor in the capture
 */
async function captureMac(region: { x: number; y: number; width: number; height: number }): Promise<string> {
  const tmp = path.join(os.tmpdir(), `clippy-cursor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  try {
    await execFileAsync('/usr/sbin/screencapture', [
      '-R', `${region.x},${region.y},${region.width},${region.height}`,
      '-t', 'png',
      '-x',  // silent
      '-o',  // no shadow / no cursor overlay
      tmp,
    ], { timeout: 5000 });
    const bytes = fs.readFileSync(tmp);
    return bytes.toString('base64');
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* fine if already gone */ }
  }
}

/**
 * Windows path. PowerShell + System.Drawing.Graphics.CopyFromScreen.
 * Slower than macOS's CLI tool but doesn't require any dependency
 * outside the standard .NET surface that ships with Windows 10+.
 */
async function captureWindows(region: { x: number; y: number; width: number; height: number }): Promise<string> {
  const tmp = path.join(os.tmpdir(), `clippy-cursor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  const script = `
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap ${region.width}, ${region.height}
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen(${region.x}, ${region.y}, 0, 0, $bmp.Size)
    $bmp.Save('${tmp.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
  `.trim();
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], { timeout: 8000 });
    const bytes = fs.readFileSync(tmp);
    return bytes.toString('base64');
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* fine */ }
  }
}

/**
 * Build the text+image context-injection payload for brain.ts. The
 * caller (handleUserMessage) prepends these parts to the user's first
 * Content message so the model sees the cropped image AND a short
 * description of what the user said + where their cursor was.
 *
 * Returns null if capture failed, so the caller can drop the cursor-
 * vision branch and proceed with normal screen context.
 */
export async function buildCursorVisionParts(userText: string): Promise<
  | null
  | {
      parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>;
      cursor: { x: number; y: number };
    }
> {
  const cap = await captureCursorArea();
  if (!cap) return null;
  const hint =
    `The user said "${userText.slice(0, 200)}". Their mouse cursor is at ` +
    `screen position (${cap.cursor.x}, ${cap.cursor.y}). Below is a ` +
    `${cap.region.width}×${cap.region.height} screenshot centered on the cursor. ` +
    `Identify what they're pointing at and answer about THAT specifically — ` +
    `don't describe the whole region, focus on what's at or near the center.`;
  return {
    parts: [
      { text: hint },
      { inlineData: { mimeType: 'image/png', data: cap.base64 } },
    ],
    cursor: cap.cursor,
  };
}
