/**
 * mac-bridge-native.ts — Typed wrapper for the `clippy-mac-bridge` Swift
 * binary that v0.20.0 introduces as the foundational macOS automation layer.
 *
 * Why this module exists
 * ──────────────────────
 * Through v0.19.x the macOS port forwarded 31 of 32 OS-bridge call sites
 * to `powershell.exe`, which fails ENOENT in 5-30ms each on Darwin. The
 * forensic audit (`docs/v0.20.0-mac-tool-forensics.md`) confirmed task
 * completion was effectively zero — 14 user tasks over 3 days, 0 succeeded.
 * Clippy was operating blind because `read_screen`, `get_active_window`,
 * `get_windows`, `ocr_read_screen`, `smart_click`, `smart_type`,
 * `minimize_*`, `show_desktop`, etc. all returned the same kind of
 * `(error: …)` sentinel and the brain had nothing useful to do.
 *
 * v0.20.0 replaces that whole layer with a single signed Swift CLI bundled
 * inside the .app at `Contents/Resources/clippy-mac-bridge`. This file is
 * the TS adapter: per-subcommand typed function, structured error class,
 * cached path resolution, dev + production layouts.
 *
 * Subcommand coverage matches the design at
 * `docs/v0.20.0-mac-bridge-architecture.md` §2:
 *   • vision         screenshot / ocr / ocrScreen
 *   • a11y           a11yTree / a11yFind / a11yFocused / a11yClick /
 *                    a11ySetValue / a11yPress
 *   • windows        windows / activeWindow / focusWindow / minimizeWindow /
 *                    maximizeWindow / hideApp / minimizeAll / showDesktop
 *   • input          type / keypress / click / hover / drag / scroll
 *   • sys            activeApp / runningApps / browserURL / clipboardRead /
 *                    clipboardWrite / permissions
 *
 * Error contract
 * ──────────────
 * Every Swift subcommand emits exactly one JSON object to stdout. On
 * success the shape varies per subcommand (typed below). On failure the
 * shape is always `{ "error": string, "code": 1|2|3, ...extra }` AND the
 * process exits non-zero with the matching code:
 *   1 = permission denied (TCC: Screen Recording / Accessibility / Automation)
 *   2 = invalid arguments (TS-side bug)
 *   3 = operation failed (target gone, API failure, write failure)
 *
 * Per the bundle-anchors memory: every place that consumes this module
 * uses STATIC imports of its named exports (no `void X` anchors, no lazy
 * require). The Rollup tree-shake regression that bit v0.18.2 / v0.18.3 /
 * v0.19.0 won't recur on this path.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { createLogger } from './logger';

const execFileAsync = promisify(execFile);
const log = createLogger('MacBridge');

// ─── Error types ───────────────────────────────────────────────────────

export type BridgeFailureKind =
  | 'missing'       // binary not found at any candidate path
  | 'permission'    // TCC denial (exit code 1)
  | 'invalid-args'  // caller bug (exit code 2)
  | 'failure'       // operation failed (exit code 3)
  | 'parse'         // stdout wasn't JSON
  | 'platform'      // called from non-darwin
  | 'unknown';      // anything else

export class BridgeError extends Error {
  constructor(
    public kind: BridgeFailureKind,
    message: string,
    public exitCode?: number,
    public structured?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

// ─── Path resolution ───────────────────────────────────────────────────

let cachedBridgePath: string | null | undefined = undefined;

/**
 * Resolve the clippy-mac-bridge binary path.
 *
 * Production: <App>.app/Contents/Resources/clippy-mac-bridge (via
 *             electron-builder extraResources).
 * Dev:        <repo>/native/clippy-mac-bridge/.build/release/clippy-mac-bridge
 *
 * Returns null if absent at every candidate location.
 */
export function resolveBridgePath(): string | null {
  if (cachedBridgePath !== undefined) return cachedBridgePath;

  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'clippy-mac-bridge');
    if (fs.existsSync(bundled)) {
      cachedBridgePath = bundled;
      log.info('Using bundled clippy-mac-bridge', { path: bundled });
      return bundled;
    }
  }

  const devCandidates = [
    path.join(__dirname, '../../native/clippy-mac-bridge/.build/release/clippy-mac-bridge'),
    path.join(__dirname, '../../native/clippy-mac-bridge/.build/debug/clippy-mac-bridge'),
    path.join(app?.getAppPath?.() || '', 'native/clippy-mac-bridge/.build/release/clippy-mac-bridge'),
    path.join(app?.getAppPath?.() || '', 'native/clippy-mac-bridge/.build/debug/clippy-mac-bridge'),
  ];
  for (const candidate of devCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      cachedBridgePath = candidate;
      log.info('Using dev clippy-mac-bridge', { path: candidate });
      return candidate;
    }
  }

  log.warn('clippy-mac-bridge binary not found at any candidate location', {
    resourcesPath: process.resourcesPath,
    devCandidates,
  });
  cachedBridgePath = null;
  return null;
}

/**
 * Test-only: reset the cached resolved path. Used by smoke tests that
 * stub the binary at different locations.
 */
export function _resetBridgePathCache(): void {
  cachedBridgePath = undefined;
}

// ─── Core invoker ──────────────────────────────────────────────────────

interface InvokeOpts {
  timeoutMs?: number;
}

/**
 * Spawn the bridge with `args`. Returns the parsed JSON payload on success.
 * Throws BridgeError with a typed `kind` on every failure path so callers
 * can branch cleanly (e.g. show "open System Settings" only on `kind === 'permission'`).
 */
async function invoke<T = unknown>(
  args: readonly string[],
  opts: InvokeOpts = {},
): Promise<T> {
  if (process.platform !== 'darwin') {
    throw new BridgeError('platform', 'clippy-mac-bridge is macOS-only');
  }

  const bridgePath = resolveBridgePath();
  if (!bridgePath) {
    throw new BridgeError('missing', 'clippy-mac-bridge binary not found');
  }

  const timeoutMs = opts.timeoutMs ?? 8000;
  const subcommand = args[0] || '?';

  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;

  try {
    const result = await execFileAsync(bridgePath, args as string[], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024, // 16MB — AX trees can be large
    });
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = 0;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: string | number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8') || '';
    stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') || '';
    exitCode = typeof e.code === 'number' ? e.code : undefined;
    // execFile error.code can be the exit code (number), ENOENT (string), etc.
    if (e.code === 'ENOENT') {
      throw new BridgeError('missing', `bridge binary missing at ${bridgePath}`, undefined);
    }
  }

  // Bridge always writes a JSON object — even on errors. Parse it; if that
  // fails, the binary is broken or someone wrote stderr noise to stdout.
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    log.error('Bridge stdout was not JSON', { subcommand, exitCode, stdoutPreview: stdout.substring(0, 200), stderr: stderr.substring(0, 200) });
    throw new BridgeError(
      'parse',
      `bridge stdout not JSON (exit ${exitCode}): ${stdout.substring(0, 120)}`,
      exitCode,
    );
  }

  if (typeof payload.error === 'string') {
    const code = typeof payload.code === 'number' ? payload.code : exitCode;
    const kind: BridgeFailureKind =
      code === 1 ? 'permission' :
      code === 2 ? 'invalid-args' :
      code === 3 ? 'failure' : 'unknown';
    throw new BridgeError(kind, payload.error, code, payload);
  }

  return payload as T;
}

// ─── Typed result shapes ───────────────────────────────────────────────

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
  scale: number;
}

export interface OcrElement {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  line?: number;
}
export interface OcrResult {
  fullText: string;
  elements: OcrElement[];
}

export interface AxBounds { x: number; y: number; width: number; height: number }
export interface AxElement {
  role: string;
  subrole?: string;
  title: string;
  value: string | null;
  bounds: AxBounds;
  enabled: boolean;
  focused: boolean;
  path: number[];
  children?: AxElement[];
  cycle?: boolean;
}
export interface AxWindow {
  title: string;
  bounds: AxBounds;
  role: string;
  elements: AxElement[];
  sandboxedHint?: string;
}
export interface AxTree {
  app: string;
  pid: number;
  windows: AxWindow[];
  truncated?: boolean;
  nodeCount?: number;
  maxDepth?: number;
}

export interface AxMatch {
  role: string;
  title: string;
  bounds: AxBounds;
  pid: number;
  path: number[];
}
export interface AxFindResult {
  matches: AxMatch[];
  count?: number;
  truncated?: boolean;
}

export interface AxFocusedResult {
  role: string;
  title: string;
  value: string | null;
  bounds: AxBounds;
  pid: number;
  app: string;
  focused?: null;
  reason?: string;
}

export interface AxSelectedTextResult {
  hasSelection: boolean;
  selectedText: string;
  length: number;
  app: string;
  role: string;
}

export interface WindowInfo {
  windowID: number;
  pid: number;
  app: string;
  title: string;
  titleGated?: boolean;
  bounds: AxBounds;
  layer: number;
  alpha: number;
  minimized: boolean;
}
export interface WindowsResult {
  windows: WindowInfo[];
  titlesGated?: boolean;
  titlesGatedReason?: string;
}

export interface ActiveAppResult {
  app: string;
  pid: number;
  bundleID: string;
  bundlePath?: string;
  executablePath?: string;
  isElectron: boolean;
}

export interface RunningAppEntry {
  app: string;
  pid: number;
  bundleID: string;
  activationPolicy: 'regular' | 'accessory' | 'prohibited';
}

export interface BrowserUrlResult {
  app: string;
  url: string;
  title: string;
  tabs?: { url: string; title: string; active: boolean }[];
}

export interface ClipboardReadResult {
  text: string;
  types: string[];
  changeCount?: number;
}

export interface PermissionsResult {
  screenRecording: 'granted' | 'denied' | 'undetermined';
  accessibility: 'granted' | 'denied';
  automation: Record<string, 'granted' | 'denied' | 'undetermined' | 'unknown'>;
  _hint?: Record<string, string>;
}

// ─── Vision ────────────────────────────────────────────────────────────

export function screenshot(opts: { output: string; region?: string; display?: number }): Promise<ScreenshotResult> {
  const args = ['screenshot', '--output', opts.output];
  if (opts.region) args.push('--region', opts.region);
  if (opts.display != null) args.push('--display', String(opts.display));
  return invoke<ScreenshotResult>(args, { timeoutMs: 8000 });
}

export function ocr(opts: { image: string; languages?: string[]; mode?: 'accurate' | 'fast' }): Promise<OcrResult> {
  const args = ['ocr', '--image', opts.image];
  if (opts.languages?.length) args.push('--languages', opts.languages.join(','));
  if (opts.mode) args.push('--mode', opts.mode);
  return invoke<OcrResult>(args, { timeoutMs: 12000 });
}

export function ocrScreen(opts: { region?: string; languages?: string[]; mode?: 'accurate' | 'fast' } = {}): Promise<OcrResult> {
  const args = ['ocr-screen'];
  if (opts.region) args.push('--region', opts.region);
  if (opts.languages?.length) args.push('--languages', opts.languages.join(','));
  if (opts.mode) args.push('--mode', opts.mode);
  return invoke<OcrResult>(args, { timeoutMs: 15000 });
}

// ─── Accessibility ─────────────────────────────────────────────────────

export function a11yTree(opts: { pid?: number; maxDepth?: number; includeEmpty?: boolean } = {}): Promise<AxTree> {
  const args = ['a11y-tree'];
  if (opts.pid != null) args.push('--pid', String(opts.pid));
  if (opts.maxDepth != null) args.push('--max-depth', String(opts.maxDepth));
  if (opts.includeEmpty != null) args.push('--include-empty', String(opts.includeEmpty));
  return invoke<AxTree>(args, { timeoutMs: 10000 });
}

export function a11yFind(opts: { text: string; role?: string; pid?: number; all?: boolean }): Promise<AxFindResult> {
  const args = ['a11y-find', '--text', opts.text];
  if (opts.role) args.push('--role', opts.role);
  if (opts.pid != null) args.push('--pid', String(opts.pid));
  if (opts.all) args.push('--all', 'true');
  return invoke<AxFindResult>(args, { timeoutMs: 8000 });
}

export function a11yFocused(): Promise<AxFocusedResult> {
  return invoke<AxFocusedResult>(['a11y-focused'], { timeoutMs: 5000 });
}

export function a11yClick(opts: { pid: number; path: number[] }): Promise<{ ok: true }> {
  return invoke<{ ok: true }>(
    ['a11y-click', '--pid', String(opts.pid), '--path', opts.path.join(',')],
    { timeoutMs: 5000 },
  );
}

export function a11ySetValue(opts: { pid: number; path: number[]; value: string }): Promise<{ ok: true; strategy?: string; previous?: string }> {
  return invoke(
    ['a11y-set-value', '--pid', String(opts.pid), '--path', opts.path.join(','), '--value', opts.value],
    { timeoutMs: 6000 },
  );
}

/**
 * Read-and-replace the system-wide FOCUSED element's text in one call (the
 * Grammarly-style "rewrite the field I'm in" primitive). Race-free: reads and
 * writes the same live AXFocusedUIElement, so there's no stale path between a
 * separate read and write. Returns the `previous` text for undo.
 */
export function a11yFocusedSetValue(opts: { value: string }): Promise<{ ok: true; strategy?: string; previous?: string }> {
  return invoke(
    ['a11y-focused-set-value', '--value', opts.value],
    { timeoutMs: 6000 },
  );
}

/**
 * Read whatever text the user currently has highlighted/selected in the
 * system-wide focused element (any app, via Accessibility). "Nothing
 * selected" is a clean result, not an error: hasSelection=false, selectedText="".
 */
export function a11ySelectedText(): Promise<AxSelectedTextResult> {
  return invoke<AxSelectedTextResult>(['a11y-selected-text'], { timeoutMs: 5000 });
}

export function a11yPress(opts: { pid: number; path: number[] }): Promise<{ ok: true }> {
  return invoke(
    ['a11y-press', '--pid', String(opts.pid), '--path', opts.path.join(',')],
    { timeoutMs: 5000 },
  );
}

// ─── Window management ────────────────────────────────────────────────

export function listWindows(opts: { onScreenOnly?: boolean } = {}): Promise<WindowsResult> {
  const args = ['windows'];
  if (opts.onScreenOnly != null) args.push('--on-screen-only', String(opts.onScreenOnly));
  return invoke<WindowsResult>(args, { timeoutMs: 4000 });
}

export function activeWindow(): Promise<WindowInfo & { titlesGated?: boolean }> {
  return invoke(['active-window'], { timeoutMs: 4000 });
}

export function focusWindow(opts: { pid: number; titleSubstring?: string }): Promise<{ ok: true; target: string; partial?: boolean }> {
  const args = ['focus-window', '--pid', String(opts.pid)];
  if (opts.titleSubstring) args.push('--title-substring', opts.titleSubstring);
  return invoke(args, { timeoutMs: 5000 });
}

export function minimizeWindow(opts: { pid: number; titleSubstring?: string }): Promise<{ ok: true }> {
  const args = ['minimize-window', '--pid', String(opts.pid)];
  if (opts.titleSubstring) args.push('--title-substring', opts.titleSubstring);
  return invoke(args, { timeoutMs: 4000 });
}

export function maximizeWindow(opts: { pid: number; mode?: 'zoom' | 'fullscreen' }): Promise<{ ok: true }> {
  const args = ['maximize-window', '--pid', String(opts.pid)];
  if (opts.mode) args.push('--mode', opts.mode);
  return invoke(args, { timeoutMs: 4000 });
}

export function hideApp(opts: { pid: number }): Promise<{ ok: true }> {
  return invoke(['hide-app', '--pid', String(opts.pid)], { timeoutMs: 3000 });
}

export function minimizeAll(): Promise<{ ok: true }> {
  return invoke(['minimize-all'], { timeoutMs: 3000 });
}

export function showDesktop(): Promise<{ ok: true }> {
  return invoke(['show-desktop'], { timeoutMs: 3000 });
}

// ─── Input synthesis ──────────────────────────────────────────────────

export function typeText(opts: { text: string }): Promise<{ ok: true; chars: number }> {
  return invoke(['type', '--text', opts.text], { timeoutMs: 10000 });
}

export function keypress(opts: { combo?: string; keyCode?: number; modifiers?: string }): Promise<{ ok: true; combo?: string }> {
  const args = ['keypress'];
  if (opts.combo) args.push('--combo', opts.combo);
  if (opts.keyCode != null) args.push('--key-code', String(opts.keyCode));
  if (opts.modifiers) args.push('--modifiers', opts.modifiers);
  return invoke(args, { timeoutMs: 4000 });
}

export function click(opts: { x: number; y: number; button?: 'left' | 'right' | 'middle'; count?: 1 | 2 | 3 }): Promise<{ ok: true }> {
  const args = ['click', '--x', String(Math.round(opts.x)), '--y', String(Math.round(opts.y))];
  if (opts.button) args.push('--button', opts.button);
  if (opts.count) args.push('--count', String(opts.count));
  return invoke(args, { timeoutMs: 4000 });
}

export function hover(opts: { x: number; y: number }): Promise<{ ok: true }> {
  return invoke(['hover', '--x', String(Math.round(opts.x)), '--y', String(Math.round(opts.y))], { timeoutMs: 3000 });
}

export function drag(opts: { from: { x: number; y: number }; to: { x: number; y: number }; durationMs?: number }): Promise<{ ok: true }> {
  const args = ['drag',
    '--from', `${Math.round(opts.from.x)},${Math.round(opts.from.y)}`,
    '--to', `${Math.round(opts.to.x)},${Math.round(opts.to.y)}`];
  if (opts.durationMs) args.push('--duration-ms', String(opts.durationMs));
  return invoke(args, { timeoutMs: (opts.durationMs ?? 300) + 5000 });
}

export function scroll(opts: { x: number; y: number; dy: number; dx?: number; unit?: 'pixel' | 'line' }): Promise<{ ok: true }> {
  const args = ['scroll',
    '--x', String(Math.round(opts.x)),
    '--y', String(Math.round(opts.y)),
    '--dy', String(Math.round(opts.dy))];
  if (opts.dx != null) args.push('--dx', String(Math.round(opts.dx)));
  if (opts.unit) args.push('--unit', opts.unit);
  return invoke(args, { timeoutMs: 4000 });
}

// ─── System state ─────────────────────────────────────────────────────

export function activeApp(): Promise<ActiveAppResult> {
  return invoke<ActiveAppResult>(['active-app'], { timeoutMs: 3000 });
}

export function runningApps(): Promise<{ apps: RunningAppEntry[] }> {
  return invoke(['running-apps'], { timeoutMs: 4000 });
}

export function browserURL(opts: { app?: 'safari' | 'chrome' | 'edge' | 'arc' | 'brave' } = {}): Promise<BrowserUrlResult> {
  const args = ['browser-url'];
  if (opts.app) args.push('--app', opts.app);
  return invoke<BrowserUrlResult>(args, { timeoutMs: 5000 });
}

export function clipboardRead(): Promise<ClipboardReadResult> {
  return invoke<ClipboardReadResult>(['clipboard-read'], { timeoutMs: 2000 });
}

export function clipboardWrite(opts: { text: string }): Promise<{ ok: true; bytes: number }> {
  return invoke(['clipboard-write', '--text', opts.text], { timeoutMs: 2000 });
}

export function permissions(): Promise<PermissionsResult> {
  return invoke<PermissionsResult>(['permissions'], { timeoutMs: 3000 });
}

/** Surface macOS's native Screen-Recording dialog (CGRequestScreenCaptureAccess
 *  via the Swift bridge). Returns whether access is granted afterward. The grant
 *  usually needs an app relaunch to take effect. */
export async function requestScreenRecording(): Promise<{ granted: boolean }> {
  try {
    const out = await invoke<{ granted?: boolean }>(['request-screen-recording'], { timeoutMs: 5000 });
    return { granted: !!(out as { granted?: boolean }).granted };
  } catch {
    return { granted: false };
  }
}

// ─── Availability helper ──────────────────────────────────────────────

/**
 * True iff we're on darwin AND the bridge binary exists. Use this at
 * tool-dispatch boundaries to decide whether to route through the bridge
 * or fall back to AppleScript / PS / etc. Logged once on first call.
 */
let cachedAvailable: boolean | undefined;
export function isBridgeAvailable(): boolean {
  if (cachedAvailable !== undefined) return cachedAvailable;
  cachedAvailable = process.platform === 'darwin' && resolveBridgePath() !== null;
  return cachedAvailable;
}
