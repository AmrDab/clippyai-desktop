/**
 * screenshot-helper.ts — shutter/thumbnail-suppressed macOS screenshot
 * (system screencapture first, bundled SCK Swift helper as fallback).
 *
 * ⚠️ NOT fully flash-free on macOS 15+ — see "What this does / doesn't
 * suppress" below. There are TWO distinct on-screen artifacts; the helper
 * only eliminates one of them.
 *
 * Why this module exists
 * ──────────────────────
 * macOS Sonoma 14.5+ / Sequoia / Tahoe changed `/usr/sbin/screencapture`
 * so every invocation flashes the screen + pops a thumbnail in the
 * bottom-right corner, even with `-x -o`. That's fine for an interactive
 * shortcut but jarring when ClippyAI fires a capture dozens of times
 * per task in the background. The system-wide workaround (`defaults
 * write com.apple.screencapture show-thumbnail -bool false`) was
 * explicitly rejected: it breaks Markup-before-save for every screenshot
 * tool on the user's Mac, not just ours.
 *
 * Root-cause fix: bundle a tiny Swift CLI (`native/screenshot-helper/`)
 * that calls ScreenCaptureKit (macOS 14+) directly, bypassing the
 * screencapture daemon.
 *
 * What this does / doesn't suppress (verified 2026-06-07 on macOS 26)
 * ──────────────────────────────────────────────────────────────────
 *   ✓ ELIMINATED: the screencapture-daemon shutter animation + the
 *     bottom-right thumbnail. SCK never invokes that daemon.
 *   ✗ NOT eliminated: the system Screen-Recording privacy indicator.
 *     On macOS 15+ even a one-shot `SCScreenshotManager.captureImage`
 *     spins up an internal `SCStream` (visible in unified logs as
 *     `SCStream initWithFilter… / dealloc`), so macOS lights the
 *     recording indicator for the duration of the grab. Apple makes
 *     this indicator unsuppressable by design — it's the source of the
 *     brief "flash" users report on each capture. There is NO API to
 *     capture the screen without it on 15+: `CGWindowListCreateImage`
 *     (the old flash-free path) was OBSOLETED in macOS 15.0 and is a
 *     hard compile error there. The only lever is to capture LESS —
 *     ambient/proactive context already uses AX text (read_screen
 *     accessibility), which is genuinely flash-free; image tools
 *     (desktop_screenshot / ocr_read_screen / cursor-vision) flash
 *     because they need real pixels.
 *
 * Fallback
 * ────────
 * If the helper binary is missing (a forgotten `npm run build-native`
 * during dev, or a corrupted .app bundle) OR exits non-zero for any
 * reason other than permission denied, the caller's loop falls back
 * to `/usr/sbin/screencapture`. Better to flash-screenshot than break
 * the feature entirely.
 *
 * Permission denied (exit code 1) is propagated as a distinct error
 * so the renderer can trigger the existing "open System Settings →
 * Screen Recording" prompt flow.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { createLogger } from './logger';

const execFileAsync = promisify(execFile);
const log = createLogger('ScreenshotHelper');

/** Region in macOS display-space POINTS (same units screencapture -R uses). */
export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type HelperFailureKind = 'missing' | 'permission' | 'invalid-args' | 'capture' | 'unknown';

export class HelperError extends Error {
  constructor(public kind: HelperFailureKind, message: string, public exitCode?: number) {
    super(message);
    this.name = 'HelperError';
  }
}

/**
 * Memoize the resolved helper path — it doesn't change at runtime and
 * `fs.existsSync` is a syscall we'd otherwise hit on every screenshot.
 */
let cachedHelperPath: string | null | undefined = undefined;

/**
 * Resolve the screenshot-helper binary path.
 *
 * Production layout (electron-builder extraResources):
 *   <App>.app/Contents/Resources/screenshot-helper
 *
 * Dev layout (npm run dev, no bundle):
 *   <repo>/native/screenshot-helper/.build/release/screenshot-helper
 *
 * Returns null if the binary doesn't exist at either location, so the
 * caller can decide to fall back rather than spawn-fail at run time.
 */
export function resolveHelperPath(): string | null {
  if (cachedHelperPath !== undefined) return cachedHelperPath;

  // Production: bundled resource. `process.resourcesPath` points at
  // <App>.app/Contents/Resources/ when running inside the packaged app.
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'screenshot-helper');
    if (fs.existsSync(bundled)) {
      cachedHelperPath = bundled;
      log.info('Using bundled screenshot-helper', { path: bundled });
      return bundled;
    }
  }

  // Dev: src/main is compiled to out/main, then we step back to repo root.
  // From the source tree at runtime (electron-vite dev), __dirname is
  // typically `<repo>/out/main`, so `../..` lands in `<repo>/`.
  // From the test-runner CJS context, __dirname is `<repo>/src/main`,
  // so the same `../..` still lands in `<repo>/`. Both work.
  const devCandidates = [
    path.join(__dirname, '../../native/screenshot-helper/.build/release/screenshot-helper'),
    path.join(app?.getAppPath?.() || '', 'native/screenshot-helper/.build/release/screenshot-helper'),
  ];
  for (const candidate of devCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      cachedHelperPath = candidate;
      log.info('Using dev screenshot-helper', { path: candidate });
      return candidate;
    }
  }

  log.warn('screenshot-helper binary not found at any candidate location', {
    resourcesPath: process.resourcesPath,
    devCandidates,
  });
  cachedHelperPath = null;
  return null;
}

/**
 * Invoke the bundled helper binary to write a PNG of either the full
 * main display (region omitted) or a specific rectangle.
 *
 * Returns void on success — the PNG is written to `outputPath` by the
 * helper. Throws `HelperError` with a specific `kind` on failure so
 * the caller can decide whether to fall back, prompt for permission,
 * or abort.
 */
export async function captureViaHelper(
  outputPath: string,
  region?: CaptureRegion,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new HelperError('missing', 'screenshot-helper is macOS-only');
  }

  const helperPath = resolveHelperPath();
  if (!helperPath) {
    throw new HelperError('missing', 'screenshot-helper binary not found');
  }

  const args = ['--output', outputPath];
  if (region) {
    args.push('--region', `${region.x},${region.y},${region.width},${region.height}`);
  }

  const timeoutMs = options.timeoutMs ?? 8000;
  try {
    await execFileAsync(helperPath, args, { timeout: timeoutMs });
  } catch (err) {
    // Node's execFile-rejected error doesn't have a strict public type
    // for the `code` field. In practice:
    //   - System-level pre-exec errors → code is the errno string
    //     ('ENOENT' if the binary is gone).
    //   - Child exited non-zero → code is the numeric exit status.
    //   - Killed by signal → code is undefined and `signal` is set.
    // Treat the error as an `unknown` shape we narrow ourselves.
    const e = err as Record<string, unknown>;
    const rawCode = e.code;
    const exitCode: number | undefined = typeof rawCode === 'number' ? rawCode : undefined;
    const stderr = typeof e.stderr === 'string'
      ? e.stderr
      : Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf8') : '';
    const stdout = typeof e.stdout === 'string'
      ? e.stdout
      : Buffer.isBuffer(e.stdout) ? e.stdout.toString('utf8') : '';
    const errMsg = typeof e.message === 'string' ? e.message : '';
    const msg = (stderr || stdout || errMsg || '').trim();

    // System-level errors before the helper even ran.
    if (rawCode === 'ENOENT') {
      throw new HelperError('missing', `helper binary disappeared: ${helperPath}`);
    }

    // Helper's documented exit codes (see main.swift):
    //   1 = permission denied
    //   2 = invalid args
    //   3 = capture failed
    if (exitCode === 1) {
      throw new HelperError('permission', msg || 'Screen Recording permission denied', 1);
    }
    if (exitCode === 2) {
      throw new HelperError('invalid-args', msg || 'Invalid arguments to screenshot-helper', 2);
    }
    if (exitCode === 3) {
      throw new HelperError('capture', msg || 'Capture failed', 3);
    }
    throw new HelperError('unknown', msg || `helper exited with code ${exitCode ?? '?'}`, exitCode);
  }
}

/** Absolute path to the system screenshot tool (the Cmd+Shift+3 mechanism). */
const SCREENCAPTURE_BIN = '/usr/sbin/screencapture';

/**
 * Capture via the system `/usr/sbin/screencapture` — the SAME tool the
 * Cmd+Shift+3 keystroke uses.
 *
 * Why this is (we believe) lower-flash than the in-process SCK helper:
 * empirical unified-log tracing on macOS 26 shows `screencapture`
 * brokers the grab through the system `replayd` daemon (ReplayKit), i.e.
 * the *system* owns the capture, not our app. A one-shot system capture
 * does not engage the per-app screen-recording privacy indicator the way
 * an app holding its own `SCStream` does — which is exactly why pressing
 * Cmd+Shift+3 never shows the "recording" flash. The screenshot-helper
 * binary, by contrast, calls `SCScreenshotManager.captureImage`
 * IN-PROCESS, which spins a short-lived `SCStream` attributed to ClippyAI
 * → indicator → the flash users report.
 *
 * Flags:
 *   -x        no shutter sound
 *   -t png    PNG output
 *   -R x,y,w,h  region in display-space POINTS (omit = main display)
 * Writing straight to a file path means no floating thumbnail (that UI is
 * only for interactive Cmd+Shift+3/4/5, never for programmatic file grabs).
 * The cursor is excluded by default (we never pass -C).
 *
 * Requires the app to hold Screen Recording permission, same as SCK.
 * Throws HelperError so `captureScreen` can fall back to the SCK helper.
 */
export async function captureViaScreencapture(
  outputPath: string,
  region?: CaptureRegion,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new HelperError('missing', 'screencapture is macOS-only');
  }

  const args = ['-x', '-t', 'png'];
  if (region) {
    args.push('-R', `${region.x},${region.y},${region.width},${region.height}`);
  }
  args.push(outputPath);

  const timeoutMs = options.timeoutMs ?? 8000;
  try {
    await execFileAsync(SCREENCAPTURE_BIN, args, { timeout: timeoutMs });
  } catch (err) {
    const e = err as Record<string, unknown>;
    const stderr = typeof e.stderr === 'string'
      ? e.stderr
      : Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf8') : '';
    const errMsg = typeof e.message === 'string' ? e.message : '';
    const msg = (stderr || errMsg || '').trim();
    const low = msg.toLowerCase();
    // screencapture prints "could not create image from display" + the TCC
    // layer logs "user declined TCCs" on a permission denial.
    if (low.includes('declined') || low.includes('tcc') || low.includes('not authorized')
        || low.includes('permission') || low.includes('could not create image')) {
      throw new HelperError('permission', msg || 'Screen Recording permission denied', 1);
    }
    throw new HelperError('capture', msg || 'screencapture failed', 3);
  }

  // screencapture can exit 0 yet write nothing on some edge failures —
  // verify a non-empty PNG actually landed before claiming success.
  let size = 0;
  try { size = fs.statSync(outputPath).size; } catch { /* missing → size stays 0 */ }
  if (size <= 0) {
    throw new HelperError('capture', 'screencapture produced no output file');
  }
}

/**
 * Preferred screen-capture entry point. Tries the lower-flash system
 * `screencapture` path first; if it fails for any reason OTHER than a
 * permission denial, falls back to the in-process SCK helper binary so a
 * capture still happens. Permission denials are propagated unchanged
 * (the SCK helper would hit the same wall) so the caller can surface the
 * "grant Screen Recording" prompt.
 *
 * Returns which backend produced the image, for diagnostics.
 */
export async function captureScreen(
  outputPath: string,
  region?: CaptureRegion,
  options: { timeoutMs?: number } = {},
): Promise<{ via: 'screencapture' | 'sck-helper' }> {
  try {
    await captureViaScreencapture(outputPath, region, options);
    return { via: 'screencapture' };
  } catch (err) {
    if (err instanceof HelperError && err.kind === 'permission') throw err;
    log.warn('screencapture failed; falling back to in-process SCK helper', {
      kind: err instanceof HelperError ? err.kind : 'unknown',
      msg: err instanceof Error ? err.message : String(err),
    });
    await captureViaHelper(outputPath, region, options);
    return { via: 'sck-helper' };
  }
}

/**
 * Test hook — reset the memoized helper path so unit tests can stub
 * different filesystem layouts. NOT exposed in the public surface.
 */
export function _resetHelperPathCache(): void {
  cachedHelperPath = undefined;
}
