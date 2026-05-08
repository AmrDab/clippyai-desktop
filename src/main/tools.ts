/**
 * ClippyAI Direct Tool Executor
 *
 * Replaces ClawdCursor's HTTP server with in-process tool execution.
 * Uses: nut-js (mouse/keyboard), PowerShell (Windows UIA), sharp (screenshots)
 *
 * No separate process, no HTTP, no port 3847, no startup failures.
 */

import { execFile, ChildProcess, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { shell, app } from 'electron';
import { createLogger, serializeErr } from './logger';
import { getCdpClient, listTabsRaw, DEFAULT_CDP_PORT } from './cdp-client';
import { docxFromBlocks } from './skills/generate/docx-from-blocks';
import { excelFromRows } from './skills/generate/excel-from-rows';
import { imageFromPrimitives } from './skills/generate/image-from-primitives';
import { pdfFromText } from './skills/generate/pdf-from-text';
import { qrcodeFromText } from './skills/generate/qrcode-from-text';

// ── Input sanitization (prevent PowerShell injection) ─────────────
function sanitizeAppName(name: string): string {
  // Only allow alphanumeric, spaces, dots, hyphens, underscores
  return name.replace(/[^a-zA-Z0-9\s.\-_]/g, '').substring(0, 50);
}

function sanitizeForSendKeys(str: string): string {
  // Only allow known SendKeys tokens
  const allowed = /^[a-zA-Z0-9\^%+{}\(\)~ ]*$/;
  if (!allowed.test(str)) return '';
  return str.substring(0, 50);
}

function sanitizeNumber(val: unknown): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

const log = createLogger('Tools');
const execFileAsync = promisify(execFile);
// exec removed — all commands use execFileAsync (safe) or shell.openExternal

// v0.11.26 — Abortable child-process registry. Sleep should KILL all
// in-flight tool executions, not just signal the loop. Per report
// 8836f5ec the user expected setMode('sleep') to behave like a Ctrl+C
// — kill running PowerShell processes too. The previous implementation
// only set cancelRequested=true, which the loop checks BETWEEN tool
// calls but ignores during a 30s outlook_send_email or 60s word_to_pdf.
//
// Pattern: every long-running execFileAsync call is wrapped in
// `execFileAbortable` which registers an AbortController, runs with
// `signal: ac.signal`, and unregisters on completion. brain.ts's
// setMode('sleep') calls `abortAllInFlightTools()` which fires
// ac.abort() on every registered controller — Node sends SIGKILL
// to the child process and the awaited promise rejects with AbortError.
const activeAborts = new Set<AbortController>();

async function execFileAbortable(
  file: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number; encoding?: BufferEncoding } = {},
): Promise<{ stdout: string; stderr: string }> {
  const ac = new AbortController();
  activeAborts.add(ac);
  try {
    // Cast widens the options type to match the original execFile signature.
    return await execFileAsync(file, args, { ...options, signal: ac.signal } as Parameters<typeof execFileAsync>[2]);
  } finally {
    activeAborts.delete(ac);
  }
}

/**
 * Abort every currently-running execFileAbortable call. Called by
 * brain.ts setMode('sleep') so sleep actually stops what Clippy is doing
 * instead of letting the current tool run to completion. Best-effort —
 * any tool that uses raw execFileAsync (not abortable) will still finish.
 */
export function abortAllInFlightTools(): number {
  const n = activeAborts.size;
  for (const ac of activeAborts) {
    try { ac.abort(); } catch { /* best effort */ }
  }
  activeAborts.clear();
  if (n > 0) log.info('abortAllInFlightTools', { aborted: n });
  return n;
}

// ── Path resolution ──────────────────────────────────────────────

// v0.11.27 — memoized. The scripts dir doesn't change at runtime, but
// `getScriptsDir` was called on every single tool invocation (including
// inside hot loops like read_screen-after-every-step). On a typical
// 40-step task that meant ~80 redundant `fs.existsSync` calls on the
// same two paths.
let _cachedScriptsDir: string | null = null;
function getScriptsDir(): string {
  if (_cachedScriptsDir) return _cachedScriptsDir;
  // Production: resources/scripts/
  const bundled = path.join(process.resourcesPath || '', 'scripts');
  if (fs.existsSync(bundled)) { _cachedScriptsDir = bundled; return bundled; }
  // Dev: assets/scripts/
  const dev = path.join(app.getAppPath(), 'assets', 'scripts');
  if (fs.existsSync(dev)) { _cachedScriptsDir = dev; return dev; }
  _cachedScriptsDir = path.join(__dirname, '../../assets/scripts');
  return _cachedScriptsDir;
}

// ── PowerShell Bridge (persistent UIA process) ───────────────────

let psBridge: ChildProcess | null = null;
let psReady = false;
let psQueue: Array<{ cmd: string; resolve: (v: string) => void; reject: (e: Error) => void }> = [];
let psBuffer = '';

// Health monitor state
let psHealthInterval: ReturnType<typeof setInterval> | null = null;
// Respawn rate limiter: max 3 respawns in any 60s rolling window.
// Once exceeded, psBridge stays null and psCommand falls back to one-off
// PowerShell calls indefinitely until the next app restart.
let psRespawnsThisMinute = 0;
let psRespawnWindowStart = 0;
let psDegraded = false; // permanently degraded for this session

function startPSBridge(): Promise<void> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(getScriptsDir(), 'ps-bridge.ps1');
    if (!fs.existsSync(scriptPath)) {
      log.warn('ps-bridge.ps1 not found — UIA tools unavailable', scriptPath);
      resolve();
      return;
    }

    log.info('Starting PowerShell UIA bridge...');
    psBridge = execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ], { maxBuffer: 10 * 1024 * 1024 });

    const timeout = setTimeout(() => {
      if (!psReady) {
        log.warn('PSBridge timeout (12s) — UIA may be slow on this machine');
        psReady = true; // continue anyway
        resolve();
      }
    }, 12000);

    psBridge.stdout?.on('data', (chunk: Buffer) => {
      // Wrap in try/catch — a throw inside this listener would bubble to
      // process.on('uncaughtException') and (previously) crash the app.
      try {
        const text = chunk.toString();
        psBuffer += text;

        // Check for ready signal
        if (!psReady && text.includes('READY')) {
          psReady = true;
          clearTimeout(timeout);
          log.info('PSBridge ready');
          resolve();
        }

        // Process completed responses (delimited by __END__)
        while (psBuffer.includes('__END__')) {
          const idx = psBuffer.indexOf('__END__');
          const response = psBuffer.substring(0, idx).trim();
          psBuffer = psBuffer.substring(idx + 7);
          // Guard the dequeue — if a timeout already rejected and removed
          // the queue entry, shift() returns undefined and the non-null
          // assertion would throw.
          const head = psQueue.shift();
          if (head) head.resolve(response);
        }
      } catch (e) {
        log.warn('PSBridge stdout handler error', serializeErr(e));
      }
    });

    psBridge.stderr?.on('data', (chunk: Buffer) => {
      log.warn('PSBridge stderr', chunk.toString().substring(0, 200));
    });

    psBridge.on('exit', (code) => {
      log.info('PSBridge exited', { code });
      psBridge = null;
      psReady = false;
      // Clear the health-check interval so a stale ping doesn't fire and
      // try to send to the now-dead process after a respawn starts a new one.
      if (psHealthInterval) {
        clearInterval(psHealthInterval);
        psHealthInterval = null;
      }
      // Reject any pending queries
      for (const q of psQueue) q.reject(new Error('PSBridge exited'));
      psQueue = [];
    });
  });
}

/**
 * Respawn the PSBridge if allowed by the rate limiter (max 3 in 60s).
 * Called from psHealthCheck on failure and could be extended to retry
 * after unexpected exits. Sets psDegraded=true and gives up permanently
 * if the limit is exceeded — psCommand falls back to one-off PowerShell.
 */
function maybeRespawnPSBridge(): void {
  const now = Date.now();
  // Roll the window if more than 60s has elapsed since the window started
  if (now - psRespawnWindowStart > 60_000) {
    psRespawnsThisMinute = 0;
    psRespawnWindowStart = now;
  }

  if (psRespawnsThisMinute >= 3) {
    if (!psDegraded) {
      psDegraded = true;
      log.error('PSBridge: 3 respawns in 60s — permanently degraded for this session. All UIA commands will use one-off PowerShell fallback. Restart the app to restore the bridge.');
    }
    return;
  }

  psRespawnsThisMinute++;
  log.warn('PSBridge: respawning', { attempt: psRespawnsThisMinute, windowStart: new Date(psRespawnWindowStart).toISOString() });
  startPSBridge().catch((err) => {
    log.warn('PSBridge respawn failed', serializeErr(err));
  });
}

/**
 * Health check: send a trivial PowerShell expression and expect the
 * sentinel back within 2 seconds. On failure, kill the bridge cleanly
 * and trigger a respawn (subject to rate limit).
 *
 * Runs every 30 seconds while the bridge is up. The interval is cleared
 * in the exit handler and restarted (via initTools → startPSBridge) if
 * the bridge respawns.
 */
async function psHealthCheck(): Promise<void> {
  if (!psReady || !psBridge) return; // bridge not up — nothing to check
  if (psDegraded) return; // permanently degraded — don't bother

  const local = psBridge;
  const PING_CMD = '& {1}';
  const PING_TIMEOUT_MS = 2000;

  try {
    const result = await Promise.race([
      psCommand(PING_CMD),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('health-check timeout (2s)')), PING_TIMEOUT_MS),
      ),
    ]);
    // Expected: the bridge echoes "1" followed by "__END__"
    if (!String(result).trim().startsWith('1')) {
      log.warn('PSBridge health check: unexpected response', { result: String(result).substring(0, 80) });
      // Unexpected response is a yellow flag but not fatal — don't kill
      // the bridge over one bad response.
    }
    // Happy path — bridge is healthy, do nothing.
  } catch (err) {
    log.warn('PSBridge health check failed — killing bridge and respawning', {
      msg: err instanceof Error ? err.message : String(err),
    });
    // Kill the bridge cleanly. The exit handler will reject any queued
    // promises, null out psBridge/psReady, and clear this interval.
    if (local && !local.killed) {
      try { local.kill(); } catch { /* already dead */ }
    }
    maybeRespawnPSBridge();
  }
}

/**
 * Write `data` to the bridge's stdin. Returns true on success, false if the
 * write failed (EPIPE, destroyed stream, etc.). Never throws — callers
 * handle false by falling back or rejecting the queued promise explicitly.
 *
 * This is the only place in the codebase that writes to psBridge.stdin.
 * Keeping all writes here makes it impossible for EPIPE to reach the
 * uncaughtException handler: the write is wrapped, any OS-level error is
 * caught here, and the caller is given a clean boolean.
 */
function safePsWrite(local: ChildProcess, data: string): boolean {
  if (!local.stdin || local.stdin.destroyed || !local.stdin.writable || local.killed) {
    return false;
  }
  try {
    local.stdin.write(data);
    return true;
  } catch (writeErr) {
    // EPIPE or similar OS pipe error. The bridge is dead. Log once so we
    // can detect patterns in boot.log, but do NOT propagate — the caller
    // will reject the pending promise with a clean error instead.
    log.warn('safePsWrite: stdin write failed (bridge likely dead)', {
      msg: writeErr instanceof Error ? writeErr.message : String(writeErr),
    });
    return false;
  }
}

async function psCommand(cmd: string): Promise<string> {
  // Atomic snapshot: capture psBridge in a local const BEFORE the ready
  // check. The exit handler sets psBridge=null asynchronously; without the
  // snapshot, the check (psBridge && psReady) could pass and then
  // psBridge could become null between the check and the write — that
  // was the exact race that caused the EPIPE storm (line 204 old code).
  const local = psBridge;
  if (
    !psReady
    || !local
    || !local.stdin
    || local.stdin.destroyed
    || !local.stdin.writable
    || local.killed
  ) {
    // Bridge not usable — one-off fallback
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd,
      ], { timeout: 10000 });
      return stdout.trim();
    } catch (err) {
      return `(PowerShell error: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Timeout: remove from queue so the response handler doesn't resolve
      // a dead promise later. We know index 0 is ours only if the queue is
      // strictly FIFO and we haven't been removed already — find by cmd.
      const idx = psQueue.findIndex((q) => q.cmd === cmd);
      if (idx !== -1) psQueue.splice(idx, 1);
      reject(new Error('PSBridge command timeout (10s)'));
    }, 10000);

    psQueue.push({
      cmd,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });

    // Use the local snapshot — NOT psBridge — so we write to the same
    // process we just validated above. If safePsWrite returns false, the
    // bridge died in the tiny window after our snapshot. Reject now rather
    // than waiting for the 10s timeout.
    if (!safePsWrite(local, cmd + '\n')) {
      clearTimeout(timer);
      // Remove the entry we just pushed
      const idx = psQueue.findIndex((q) => q.cmd === cmd);
      if (idx !== -1) psQueue.splice(idx, 1);
      reject(new Error('PSBridge stdin not writable (bridge died before write)'));
    }
  });
}

// ── Screen Scale ─────────────────────────────────────────────────

let screenScale = 1;

async function detectScreenScale(): Promise<void> {
  try {
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width`,
    ], { timeout: 5000 });
    const physicalWidth = parseInt(result.stdout.trim());
    if (physicalWidth > 0) {
      // Compare with logical screen size from Electron
      const { screen } = require('electron');
      const display = screen.getPrimaryDisplay();
      screenScale = physicalWidth / display.size.width;
      log.info('Screen scale detected', { physicalWidth, logicalWidth: display.size.width, scale: screenScale });
    }
  } catch {
    log.warn('Could not detect screen scale, using 1.0');
  }
}

// ── Tool Implementations ─────────────────────────────────────────

interface ToolResult {
  text: string;
  image?: { data: string; mimeType: string };
}

/**
 * Strip Clippy's own window(s) from a read_screen result so the brain
 * doesn't see itself at the top of the list and misinterpret focus_window
 * as having failed. Works for both JSON accessibility output ({"windows":[...]})
 * and OCR-formatted output (JSON element list or text positions).
 *
 * Generic — never hardcode other process names. Only our own name is removed.
 */
function stripOwnWindowFromScreen(raw: string): string {
  if (!raw) return raw;
  const OWN_PROCESS_NAMES = new Set(['ClippyAI', 'clippyai']);
  // Try accessibility-tree JSON shape first
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.windows)) {
      parsed.windows = parsed.windows.filter((w: { processName?: string }) =>
        !w.processName || !OWN_PROCESS_NAMES.has(w.processName),
      );
      return JSON.stringify(parsed);
    }
  } catch { /* not JSON — fall through */ }
  return raw;
}

async function readScreen(params: Record<string, unknown>): Promise<ToolResult> {
  const mode = String(params.mode || 'accessibility');

  if (mode === 'ocr') {
    // Dispatch to OCR tool
    return ocrReadScreen();
  }

  // Default: accessibility tree
  const scriptPath = path.join(getScriptsDir(), 'get-screen-context.ps1');
  try {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
    if (params.processId) args.push('-ProcessId', String(params.processId));
    const { stdout } = await execFileAsync('powershell.exe', args, {
      timeout: 10000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const filtered = stripOwnWindowFromScreen(stdout.trim());
    return { text: filtered || '(empty screen context)' };
  } catch (err) {
    return { text: `(read_screen error: ${err instanceof Error ? err.message : String(err)})` };
  }
}

async function getActiveWindow(): Promise<ToolResult> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(getScriptsDir(), 'get-foreground-window.ps1'),
    ], { timeout: 5000 });
    return { text: stdout.trim() || '(no active window)' };
  } catch {
    return { text: '(could not get active window)' };
  }
}

async function getWindows(): Promise<ToolResult> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(getScriptsDir(), 'get-windows.ps1'),
    ], { timeout: 5000 });
    return { text: stdout.trim() || '(no windows found)' };
  } catch {
    return { text: '(could not list windows)' };
  }
}

async function focusWindow(params: Record<string, unknown>): Promise<ToolResult> {
  const { processName, processId, title } = params;
  // Must have at least one identifier
  if (!processName && !processId && !title) {
    return { text: '(focus_window needs processName, processId, or title)' };
  }
  try {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(getScriptsDir(), 'focus-window.ps1')];
    if (title) {
      args.push('-Title', String(title));
    } else if (processName) {
      // Look up PID by process name first — using processName as a title
      // search fails because e.g. "msedge" doesn't appear in Edge's
      // window title ("...Microsoft Edge"). Resolving to PID is reliable.
      try {
        const { stdout: pidOut } = await execFileAsync('powershell.exe', [
          '-NoProfile', '-Command',
          `(Get-Process -Name '${sanitizeAppName(String(processName))}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).Id`,
        ], { timeout: 3000 });
        const pid = parseInt(pidOut.trim());
        if (pid > 0) {
          args.push('-ProcessId', String(pid));
        } else {
          // Fallback: try as title substring
          args.push('-Title', String(processName));
        }
      } catch {
        args.push('-Title', String(processName));
      }
    } else if (processId) {
      args.push('-ProcessId', String(processId));
    }
    const { stdout } = await execFileAsync('powershell.exe', args, { timeout: 5000 });
    return { text: stdout.trim() || 'Focused' };
  } catch (err) {
    // Fallback: try alt+tab
    try {
      await keyPress({ key: 'alt+tab' });
      return { text: 'Switched window via alt+tab' };
    } catch {
      return { text: `(focus_window error: ${err instanceof Error ? err.message : ''})` };
    }
  }
}

/**
 * Idempotent open_app: focus an existing window first, only launch new if
 * none found. Ported from ClawdCursor v0.8.3 — prevents N duplicate windows
 * stacking up during retry loops. Match order: processName exact →
 * processName substring → title substring.
 */
async function openApp(params: Record<string, unknown>): Promise<ToolResult> {
  const name = sanitizeAppName(String(params.name || ''));
  if (!name) return { text: '(no app name provided)' };

  // Step 1: Check if a window for this app already exists
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `$p = Get-Process -Name '${name}' -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; ` +
      `if ($p) { $p.Id } else { '' }`,
    ], { timeout: 3000 });
    const existingPid = parseInt(stdout.trim());
    if (existingPid > 0) {
      // Focus the existing window instead of launching a new one
      await focusWindow({ processName: name });
      return { text: `Focused existing ${name} (pid ${existingPid})` };
    }
  } catch { /* no existing window — launch new */ }

  // Step 2: Launch new
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command', 'Start-Process', '-FilePath', name,
    ], { timeout: 10000 });
    return { text: `Launched ${name}` };
  } catch (err) {
    return { text: `(could not open ${name}: ${err instanceof Error ? err.message : ''})` };
  }
}

async function typeText(params: Record<string, unknown>): Promise<ToolResult> {
  const text = String(params.text || '');
  if (!text) return { text: '(no text provided)' };
  try {
    // Write text to temp file to avoid PowerShell injection
    const tmpFile = path.join(os.tmpdir(), `clippy-type-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, text, 'utf-8');
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Set-Clipboard -Path '${tmpFile.replace(/'/g, "''")}'; ` +
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v'); ` +
      `Remove-Item '${tmpFile.replace(/'/g, "''")}'`,
    ], { timeout: 5000 });
    try { fs.unlinkSync(tmpFile); } catch {} // cleanup fallback
    // v0.11.23 — return the FULL char count + an unambiguously-marked
    // preview. Old code returned `Typed: ${text.substring(0,50)}` with no
    // length, no truncation marker — the model misread the truncated
    // preview as evidence the typing failed mid-sentence (see report
    // fbfc636e where 84 chars typed correctly but the model claimed
    // truncation because the result string ended at "...joy an"). The
    // clipboard-paste path is byte-exact; trust it and report accurately.
    const preview = text.length > 80 ? `${text.substring(0, 77)}...` : text;
    return { text: `Typed ${text.length} chars: "${preview}"` };
  } catch (err) {
    return { text: `(type_text error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function keyPress(params: Record<string, unknown>): Promise<ToolResult> {
  const key = String(params.key || '');
  if (!key) return { text: '(no key provided)' };
  // Map common key names to SendKeys format
  const keyMap: Record<string, string> = {
    'Return': '{ENTER}', 'Enter': '{ENTER}',
    'Tab': '{TAB}', 'Escape': '{ESCAPE}', 'Backspace': '{BACKSPACE}',
    'Delete': '{DELETE}', 'Up': '{UP}', 'Down': '{DOWN}',
    'Left': '{LEFT}', 'Right': '{RIGHT}',
    'Page_Down': '{PGDN}', 'Page_Up': '{PGUP}',
    'Home': '{HOME}', 'End': '{END}',
    'F1': '{F1}', 'F2': '{F2}', 'F3': '{F3}', 'F4': '{F4}', 'F5': '{F5}',
  };
  try {
    let sendKeysStr = '';
    if (key.includes('+')) {
      // Combo like ctrl+s, alt+tab
      const parts = key.toLowerCase().split('+');
      let modifiers = '';
      let mainKey = parts[parts.length - 1];
      for (const p of parts.slice(0, -1)) {
        if (p === 'ctrl' || p === 'control') modifiers += '^';
        else if (p === 'alt') modifiers += '%';
        else if (p === 'shift') modifiers += '+';
        else if (p === 'win' || p === 'meta' || p === 'cmd') modifiers += '^{ESC}'; // approximate
      }
      const mapped = keyMap[mainKey] || mainKey;
      sendKeysStr = `${modifiers}${mapped.length === 1 ? mapped : mapped}`;
    } else {
      sendKeysStr = keyMap[key] || key;
    }

    const safeSendKeys = sanitizeForSendKeys(sendKeysStr);
    if (!safeSendKeys) return { text: `(invalid key: ${key})` };
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${safeSendKeys}')`,
    ], { timeout: 5000 });
    return { text: `Pressed: ${key}` };
  } catch (err) {
    return { text: `(key_press error: ${err instanceof Error ? err.message : ''})` };
  }
}

// v0.11.22 — coordinate-space contract:
// All mouse_* tools below treat (x,y) as PHYSICAL pixels — same space as
// Windows.Media.Ocr output, UIA bounds, and PrimaryScreen.Bounds. The old
// `* Math.round(screenScale)` multiplier on these tools was based on a
// faulty assumption that the model would emit "logical" coordinates from
// screenshots. In practice screenshots are physical-pixel and OCR is
// physical-pixel, so the multiplier double-scaled on HiDPI displays
// (scale=1.5/2.0) and landed clicks in the wrong quadrant. smart_click
// already avoided the multiplier (correct); now everyone matches.
//
// The model is told (by the API tool description) to PREFER calling
// smart_click(target="text") or read_screen(mode='ocr')→mouse_click rather
// than estimating coords from desktop_screenshot, so this path is only
// exercised when the agent has a known-good coordinate.

async function mouseClick(params: Record<string, unknown>): Promise<ToolResult> {
  const x = Math.round(sanitizeNumber(params.x));
  const y = Math.round(sanitizeNumber(params.y));
  try {
    await clickPhysical(x, y);
    return { text: `Clicked at (${x},${y})` };
  } catch (err) {
    return { text: `(mouse_click error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function mouseDrag(params: Record<string, unknown>): Promise<ToolResult> {
  // v0.11.27 — use sanitizeNumber consistently with the rest of the
  // mouse_* family. Previously raw `Number(...)` cast which yields NaN
  // for non-numeric input → silently passed `NaN` to PowerShell as text.
  const sx = sanitizeNumber(params.startX);
  const sy = sanitizeNumber(params.startY);
  const ex = sanitizeNumber(params.endX);
  const ey = sanitizeNumber(params.endY);
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32 -Namespace API; ` +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${sx},${sy}); Start-Sleep -Milliseconds 50; ` +
      `[API.Win32]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 50; ` +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${ex},${ey}); Start-Sleep -Milliseconds 50; ` +
      `[API.Win32]::mouse_event(4,0,0,0,0)`,
    ], { timeout: 5000 });
    return { text: `Dragged from (${sx},${sy}) to (${ex},${ey})` };
  } catch (err) {
    return { text: `(mouse_drag error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function mouseScroll(params: Record<string, unknown>): Promise<ToolResult> {
  const x = Math.round(Number(params.x || 640));
  const y = Math.round(Number(params.y || 400));
  const direction = String(params.direction || 'down');
  const amount = Number(params.amount || 3);
  const delta = direction === 'up' ? 120 * amount : -120 * amount;
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32 -Namespace API; ` +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); ` +
      `[API.Win32]::mouse_event(0x0800,0,0,${delta},0)`,
    ], { timeout: 5000 });
    return { text: `Scrolled ${direction} at (${x},${y})` };
  } catch (err) {
    return { text: `(mouse_scroll error: ${err instanceof Error ? err.message : ''})` };
  }
}

/**
 * Run native Windows.Media.Ocr on a fresh screen capture and return the
 * parsed element list (text + bounding box per word/line). Returns null on
 * failure. Coordinates are PHYSICAL pixels — Windows OCR API does not
 * apply DPI scaling. Used by both `ocr_read_screen` (model-facing) and
 * `smart_click`'s OCR fallback (internal, no LLM round-trip).
 *
 * v0.11.22: factored out of ocrReadScreen so smart_click can ground
 * coordinate clicks against OCR locally instead of asking Kimi K2 to
 * pixel-locate from a screenshot — a documented LLM weakness.
 */
async function captureAndOcr(): Promise<{
  elements: Array<{ text: string; x: number; y: number; width: number; height: number; confidence?: number; line?: number }>;
  fullText: string;
} | null> {
  // v0.11.25 — every failure path now logs WHY it failed. Per report
  // ccd4d6f4, captureAndOcr returned null silently 3 times in one task;
  // the model and the diagnostician had zero visibility into which of the
  // four failure modes (script missing / screenshot crashed / OCR crashed
  // / parse failed / no elements) actually triggered. Fix: log each.
  const scriptPath = path.join(getScriptsDir(), 'ocr-recognize.ps1');
  if (!fs.existsSync(scriptPath)) {
    log.warn('captureAndOcr: script missing', { scriptPath, scriptsDir: getScriptsDir() });
    return null;
  }
  const tmpPng = path.join(os.tmpdir(), `clippy-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  try {
    // Step 1: capture screenshot (v0.11.26 abortable)
    try {
      await execFileAbortable('powershell.exe', [
        '-NoProfile', '-Command',
        `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
        `$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ` +
        `$bmp = New-Object System.Drawing.Bitmap($b.Width,$b.Height); ` +
        `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
        `$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ` +
        `$bmp.Save('${tmpPng.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); ` +
        `$g.Dispose(); $bmp.Dispose()`,
      ], { timeout: 10000 });
    } catch (capErr) {
      const e = capErr as { message?: string; stderr?: string };
      log.warn('captureAndOcr: screenshot failed', {
        error: (e.message || '').substring(0, 200),
        stderr: (e.stderr || '').substring(0, 200),
      });
      return null;
    }

    // Confirm the PNG was actually written before invoking OCR. If
    // CopyFromScreen silently no-op'd (e.g. session-locked), the OCR
    // script will throw a misleading error.
    if (!fs.existsSync(tmpPng)) {
      log.warn('captureAndOcr: tmp png never written', { tmpPng });
      return null;
    }

    // Step 2: OCR (v0.11.26 abortable)
    let stdout: string;
    try {
      const r = await execFileAbortable('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        '-ImagePath', tmpPng,
      ], { timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
      stdout = r.stdout;
    } catch (ocrErr) {
      const e = ocrErr as { message?: string; stderr?: string; code?: number };
      log.warn('captureAndOcr: ocr-recognize.ps1 failed', {
        exitCode: e.code,
        error: (e.message || '').substring(0, 200),
        stderr: (e.stderr || '').substring(0, 200),
      });
      return null;
    }

    // Step 3: parse
    let parsed: { error?: string; elements?: unknown; fullText?: unknown };
    try {
      parsed = JSON.parse(stdout.trim());
    } catch (parseErr) {
      log.warn('captureAndOcr: OCR returned non-JSON', {
        stdoutPreview: stdout.substring(0, 200),
        error: String(parseErr).substring(0, 100),
      });
      return null;
    }
    if (parsed.error) {
      log.warn('captureAndOcr: OCR script reported error', { error: parsed.error });
      return null;
    }
    if (!Array.isArray(parsed.elements)) {
      log.warn('captureAndOcr: OCR returned no elements array', { keys: Object.keys(parsed) });
      return null;
    }
    return {
      elements: parsed.elements as Array<{ text: string; x: number; y: number; width: number; height: number; confidence?: number; line?: number }>,
      fullText: String(parsed.fullText || ''),
    };
  } finally {
    try { fs.unlinkSync(tmpPng); } catch { /* cleanup */ }
  }
}

/**
 * Click at a precise (physical-pixel) coordinate via raw mouse_event.
 * Does NOT apply screenScale — caller is responsible for passing physical
 * pixels (UIA bounds, OCR element centers, or already-resolved coords).
 * Lifted out of smart_click so the OCR fallback can reuse the same code path.
 */
async function clickPhysical(x: number, y: number): Promise<void> {
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; ` +
    `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); ` +
    `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32 -Namespace API; ` +
    `[API.Win32]::mouse_event(2,0,0,0,0); [API.Win32]::mouse_event(4,0,0,0,0)`,
  ], { timeout: 5000 });
}

/**
 * Fuzzy-match `target` against a list of OCR text elements. Returns the
 * best-scoring element or null if nothing crosses the threshold.
 *
 * Scoring (cheap, deterministic — no embeddings):
 *   - exact (case-insensitive) trim match → 1.0
 *   - target appears as a whole-word substring → 0.9
 *   - target appears as a substring → 0.7 * (target.length / element.length)
 *   - element appears as a substring of target → 0.6 * (element.length / target.length)
 *   - first-letters acronym match (e.g. "NM" matches "New Mail") → 0.5
 * Threshold: 0.5. Below that, return null to signal "not found".
 */
function fuzzyMatchOcrElement(
  target: string,
  elements: Array<{ text: string; x: number; y: number; width: number; height: number }>,
  fgWindowBounds?: { x: number; y: number; width: number; height: number },
): { idx: number; score: number; element: { text: string; x: number; y: number; width: number; height: number } } | null {
  const t = target.trim().toLowerCase();
  if (!t) return null;
  let best: { idx: number; score: number; element: typeof elements[number] } | null = null;

  // ClawdCursor 0.8.8 trick: if we have foreground-window bounds, prefer
  // matches inside that window over matches in background windows. Reduces
  // the "matched a button label in a stale background window" bug.
  const inForeground = (el: { x: number; y: number; width: number; height: number }): boolean => {
    if (!fgWindowBounds) return true;
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    return (
      cx >= fgWindowBounds.x && cx <= fgWindowBounds.x + fgWindowBounds.width &&
      cy >= fgWindowBounds.y && cy <= fgWindowBounds.y + fgWindowBounds.height
    );
  };

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const e = el.text.trim().toLowerCase();
    if (!e) continue;
    let score = 0;
    if (e === t) score = 1.0;
    else if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(e)) score = 0.9;
    else if (e.includes(t)) score = 0.7 * (t.length / Math.max(e.length, 1));
    else if (t.includes(e) && e.length >= 3) score = 0.6 * (e.length / t.length);

    // Foreground bonus
    if (score > 0 && inForeground(el)) score += 0.05;

    if (score > 0 && (!best || score > best.score)) best = { idx: i, score, element: el };
  }
  return best && best.score >= 0.5 ? best : null;
}

async function smartClick(params: Record<string, unknown>): Promise<ToolResult> {
  const target = String(params.target || '');
  if (!target) return { text: '(no target provided)' };
  // Two-tier resolution (v0.11.22):
  //   Tier 1 — UIA accessibility tree (fast, exact, structured). Constrained
  //            to the foreground PID so a button label in a background window
  //            can't win the race. Patched in v0.11.21.
  //   Tier 2 — Local OCR via Windows.Media.Ocr. If UIA misses (the target
  //            window is a WebView/canvas/custom-rendered control that
  //            doesn't expose its UI tree — Edge web content, Electron
  //            apps without a11y enabled, games), fuzzy-match `target`
  //            against on-screen text and click the matched element's
  //            center. NO LLM round-trip — coordinates come from OCR's
  //            pre-computed boxes (physical pixels, no DPI scaling needed).
  //
  // This replaces the old "(not found)" fail path that forced the model to
  // estimate coords from a desktop_screenshot — a documented LLM weakness
  // that produced wrong-by-300px clicks (see v0.11.21 log report
  // fbfc636e... clicking outlook.live.com Send button).
  try {
    // Tier 1 — UIA
    let fgPid = 0;
    let fgBounds: { x: number; y: number; width: number; height: number } | undefined;
    try {
      const fg = await getActiveWindow();
      const parsed = JSON.parse(fg.text);
      if (typeof parsed.processId === 'number') fgPid = parsed.processId;
      if (parsed.bounds && typeof parsed.bounds.x === 'number') fgBounds = parsed.bounds;
    } catch { /* fall through */ }

    const findArgs = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(getScriptsDir(), 'find-element.ps1'),
      '-Name', target,
    ];
    if (fgPid > 0) findArgs.push('-ProcessId', String(fgPid));

    const { stdout } = await execFileAsync('powershell.exe', findArgs, { timeout: 15000 });
    let bounds: { x: number; y: number; width: number; height: number } | null = null;
    try {
      const out = stdout.trim();
      if (out.startsWith('[')) {
        const arr = JSON.parse(out);
        if (Array.isArray(arr) && arr.length > 0 && arr[0].bounds) bounds = arr[0].bounds;
      }
    } catch { /* fall through to OCR */ }

    if (bounds) {
      const ex = Math.round(bounds.x + bounds.width / 2);
      const ey = Math.round(bounds.y + bounds.height / 2);
      await clickPhysical(ex, ey);
      const where = fgPid > 0 ? ` in foreground window` : '';
      return { text: `Clicked "${target}" at (${ex},${ey})${where} via UIA` };
    }

    // Tier 2 — OCR fallback. The big win for WebViews and custom-rendered UIs.
    log.info('smart_click: UIA miss, falling back to OCR', { target, fgPid });
    const ocr = await captureAndOcr();
    if (!ocr) return { text: `(smart_click: "${target}" not found via UIA; OCR unavailable)` };
    const match = fuzzyMatchOcrElement(target, ocr.elements, fgBounds);
    if (match) {
      const cx = Math.round(match.element.x + match.element.width / 2);
      const cy = Math.round(match.element.y + match.element.height / 2);
      await clickPhysical(cx, cy);
      const inFg = fgBounds ? '' : ' (no foreground bounds — match may be outside focus)';
      return { text: `Clicked "${target}" at (${cx},${cy}) via OCR (matched "${match.element.text}", score ${match.score.toFixed(2)})${inFg}` };
    }
    return { text: `(smart_click: "${target}" not found via UIA or OCR — visible text: "${ocr.fullText.substring(0, 200)}…")` };
  } catch (err) {
    return { text: `(smart_click error for "${target}": ${err instanceof Error ? err.message : ''})` };
  }
}

async function smartType(params: Record<string, unknown>): Promise<ToolResult> {
  const target = String(params.target || '');
  const text = String(params.text || '');
  if (!target || !text) return { text: '(missing target or text)' };
  // Click the target field first, then type
  await smartClick({ target });
  await new Promise(r => setTimeout(r, 300));
  return typeText({ text });
}

/**
 * Resolve the user's default HTTPS browser process name by reading the
 * Windows UserChoice ProgID. Returns e.g. "chrome", "msedge", "firefox",
 * "brave", "opera". App-agnostic — works for any registered browser. Returns
 * empty string if the lookup fails (never throws).
 *
 * ProgID mapping is necessarily a short allowlist (the ProgID format is not
 * standardized). Unknown ProgIDs fall through to the foreground-window
 * heuristic in navigateBrowser.
 */
async function getDefaultBrowserProcessName(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice' -ErrorAction SilentlyContinue).ProgId",
    ], { timeout: 3000 });
    const progId = stdout.trim();
    if (!progId) return '';
    // Map common ProgIDs to process names. Pattern-match so future versions
    // (e.g. "ChromeHTML.Foo") still resolve correctly.
    const p = progId.toLowerCase();
    if (p.includes('chrome'))  return 'chrome';
    if (p.includes('msedge') || p.includes('edgehtm') || p.startsWith('appx')) return 'msedge';
    if (p.includes('firefox')) return 'firefox';
    if (p.includes('brave'))   return 'brave';
    if (p.includes('opera'))   return 'opera';
    if (p.includes('arc'))     return 'arc';
    if (p.includes('vivaldi')) return 'vivaldi';
    return '';
  } catch {
    return '';
  }
}

async function navigateBrowser(params: Record<string, unknown>): Promise<ToolResult> {
  const url = String(params.url || '');
  if (!url) return { text: '(no URL provided)' };
  try {
    // Use Electron's shell.openExternal — safe, validates URLs, no shell injection.
    await shell.openExternal(url);

    // On Windows, openExternal hands the URL to the default browser but does
    // NOT foreground that browser's window if it was already running (common
    // case: browser open in background with other tabs). The new URL opens
    // as a background tab and the user sees nothing. Auto-focus the default
    // browser so the page is visible — saves the agent a step and prevents
    // downstream read_screen from reading the wrong window.
    //
    // Best-effort: lookup default browser, give it ~500ms to receive the URL,
    // then focus it. If lookup fails we just skip — openExternal already fired.
    const browserName = await getDefaultBrowserProcessName();
    if (browserName) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        await focusWindow({ processName: browserName });
      } catch { /* best-effort foreground; ignore failures */ }
    }
    return { text: `Opened ${url}` };
  } catch (err) {
    return { text: `(navigate_browser error: ${err instanceof Error ? err.message : ''})` };
  }
}

// v0.11.23 — Screenshot downscale target. Above this width, native
// resolution is downscaled to TARGET_SCREENSHOT_WIDTH while preserving
// aspect ratio. Below, sent at native to preserve detail. 1280 catches
// 1366×768 laptops at native and downscales 1920+/2560+/4K to a model-
// friendly size. LLMs are measurably more accurate at coordinate
// estimation on ~1024-wide images than 2560+ (Anthropic computer-use
// reference: their pipeline downscales to 1024 before sending too).
const TARGET_SCREENSHOT_WIDTH = 1024;
const SCREENSHOT_DOWNSCALE_THRESHOLD = 1280;

async function desktopScreenshot(): Promise<ToolResult> {
  try {
    // Capture at native, then downscale only if larger than the threshold.
    // v0.11.26 abortable so sleep can kill an in-flight 10s capture.
    const { stdout } = await execFileAbortable('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
      `$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ` +
      `$nw = $b.Width; $nh = $b.Height; ` +
      `$bmp = New-Object System.Drawing.Bitmap($nw,$nh); ` +
      `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
      `$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ` +
      `$g.Dispose(); ` +
      // Decide whether to downscale
      `$tw = ${TARGET_SCREENSHOT_WIDTH}; $thr = ${SCREENSHOT_DOWNSCALE_THRESHOLD}; ` +
      `if ($nw -gt $thr) { ` +
      `  $sw = $tw; $sh = [int][Math]::Round($nh * ($tw / [double]$nw)); ` +
      `  $small = New-Object System.Drawing.Bitmap($sw,$sh); ` +
      `  $sg = [System.Drawing.Graphics]::FromImage($small); ` +
      `  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; ` +
      `  $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality; ` +
      `  $sg.DrawImage($bmp,0,0,$sw,$sh); ` +
      `  $sg.Dispose(); $bmp.Dispose(); $bmp = $small; ` +
      `} ` +
      `$fw = $bmp.Width; $fh = $bmp.Height; ` +
      `$ms = New-Object System.IO.MemoryStream; ` +
      `$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); ` +
      `$bmp.Dispose(); ` +
      // Emit as: NATIVE_W NATIVE_H FINAL_W FINAL_H<newline>BASE64
      `Write-Output ("$nw $nh $fw $fh"); ` +
      `Write-Output ([Convert]::ToBase64String($ms.ToArray()))`,
    ], { timeout: 10000, maxBuffer: 20 * 1024 * 1024 });

    const lines = stdout.trim().split(/\r?\n/);
    const headerParts = (lines[0] || '').split(' ');
    const nativeW = parseInt(headerParts[0] || '0', 10);
    const nativeH = parseInt(headerParts[1] || '0', 10);
    const finalW = parseInt(headerParts[2] || '0', 10);
    const finalH = parseInt(headerParts[3] || '0', 10);
    const base64 = (lines.slice(1).join('') || '').trim();
    const downscaled = nativeW > 0 && finalW > 0 && finalW < nativeW;
    const scale = downscaled ? nativeW / finalW : 1;

    let text: string;
    if (downscaled) {
      // Tell the model the scale factor explicitly. Modern LLMs are reliable
      // at multiplying small ints; this avoids a stateful coords-mode hack
      // in mouse_click. Coords from read_screen / OCR are still NATIVE
      // pixels — only screenshot-derived coords need scaling.
      text =
        `Screenshot captured at ${finalW}x${finalH} (downscaled from native ${nativeW}x${nativeH}, scale ${scale.toFixed(3)}x). ` +
        `If you click on a pixel you see in this screenshot at (sx,sy), call mouse_click(round(sx*${scale.toFixed(3)}), round(sy*${scale.toFixed(3)})) to convert to native coordinates. ` +
        `Coordinates from read_screen / ocr_read_screen / smart_click are already in native pixels — do NOT rescale those.`;
    } else {
      text = `Screenshot captured at ${finalW}x${finalH} (native — no downscale). Coordinates here ARE native pixels; pass directly to mouse_click.`;
    }

    return {
      text,
      image: { data: base64, mimeType: 'image/png' },
    };
  } catch (err) {
    return { text: `(screenshot error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function ocrReadScreen(): Promise<ToolResult> {
  // v0.11.22 — delegates to captureAndOcr() so smart_click and the
  // model-facing tool share the same screenshot + OCR pipeline.
  const ocr = await captureAndOcr();
  if (!ocr) return { text: '(ocr_read_screen: OCR unavailable — script missing or capture failed)' };
  let result = `=== OCR TEXT ===\n${ocr.fullText || '(no text detected)'}\n`;
  if (ocr.elements.length > 0) {
    result += `\n=== TEXT POSITIONS (for mouse_click targets) ===\n`;
    let currentLine = -1;
    for (const el of ocr.elements) {
      if (el.line !== currentLine) {
        currentLine = el.line ?? -1;
        result += `\n[Line ${currentLine}]\n`;
      }
      const cx = Math.round(el.x + el.width / 2);
      const cy = Math.round(el.y + el.height / 2);
      result += `  "${el.text}" → center(${cx}, ${cy})  rect(${el.x},${el.y},${el.width}x${el.height})\n`;
    }
  }
  return { text: result };
}

async function waitTool(params: Record<string, unknown>): Promise<ToolResult> {
  const seconds = Math.min(30, Math.max(0.1, Number(params.seconds || 1)));
  await new Promise(r => setTimeout(r, seconds * 1000));
  return { text: `Waited ${seconds}s` };
}

// ── Clipboard ────────────────────────────────────────────────────

async function readClipboard(): Promise<ToolResult> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command', 'Get-Clipboard -Raw',
    ], { timeout: 5000 });
    const text = stdout.trim();
    return { text: text ? `Clipboard: ${text.substring(0, 2000)}` : '(clipboard empty)' };
  } catch (err) {
    return { text: `(read_clipboard error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function writeClipboard(params: Record<string, unknown>): Promise<ToolResult> {
  const text = String(params.text || '');
  if (!text) return { text: '(no text provided)' };
  try {
    // Write via temp file to avoid shell-escaping issues with arbitrary text
    const tmpFile = path.join(os.tmpdir(), `clippy-clip-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, text, 'utf-8');
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Set-Clipboard -Value (Get-Content -Raw -LiteralPath '${tmpFile.replace(/'/g, "''")}')`,
    ], { timeout: 5000 });
    try { fs.unlinkSync(tmpFile); } catch { /* cleanup fallback */ }
    return { text: `Wrote ${text.length} chars to clipboard` };
  } catch (err) {
    return { text: `(write_clipboard error: ${err instanceof Error ? err.message : ''})` };
  }
}

// ── Mouse variants ───────────────────────────────────────────────

async function mouseDoubleClick(params: Record<string, unknown>): Promise<ToolResult> {
  // v0.11.22 — physical pixels, no screenScale multiplier (see mouseClick comment).
  const x = Math.round(sanitizeNumber(params.x));
  const y = Math.round(sanitizeNumber(params.y));
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); ` +
      `Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32 -Namespace API; ` +
      `[API.Win32]::mouse_event(2,0,0,0,0); [API.Win32]::mouse_event(4,0,0,0,0); ` +
      `Start-Sleep -Milliseconds 50; ` +
      `[API.Win32]::mouse_event(2,0,0,0,0); [API.Win32]::mouse_event(4,0,0,0,0)`,
    ], { timeout: 5000 });
    return { text: `Double-clicked at (${x},${y})` };
  } catch (err) {
    return { text: `(mouse_double_click error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function mouseRightClick(params: Record<string, unknown>): Promise<ToolResult> {
  // v0.11.22 — physical pixels, no screenScale multiplier (see mouseClick comment).
  const x = Math.round(sanitizeNumber(params.x));
  const y = Math.round(sanitizeNumber(params.y));
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); ` +
      `Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32 -Namespace API; ` +
      // 0x0008 = RIGHTDOWN, 0x0010 = RIGHTUP
      `[API.Win32]::mouse_event(8,0,0,0,0); [API.Win32]::mouse_event(16,0,0,0,0)`,
    ], { timeout: 5000 });
    return { text: `Right-clicked at (${x},${y})` };
  } catch (err) {
    return { text: `(mouse_right_click error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function mouseHover(params: Record<string, unknown>): Promise<ToolResult> {
  // v0.11.22 — physical pixels, no screenScale multiplier (see mouseClick comment).
  const x = Math.round(sanitizeNumber(params.x));
  const y = Math.round(sanitizeNumber(params.y));
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`,
    ], { timeout: 5000 });
    return { text: `Hovering at (${params.x},${params.y})` };
  } catch (err) {
    return { text: `(mouse_hover error: ${err instanceof Error ? err.message : ''})` };
  }
}

// ── Focused element inspection ───────────────────────────────────

async function getFocusedElement(): Promise<ToolResult> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName UIAutomationClient; ` +
      `$el = [System.Windows.Automation.AutomationElement]::FocusedElement; ` +
      `if ($el) { ` +
        `$name = $el.Current.Name; ` +
        `$type = $el.Current.LocalizedControlType; ` +
        `$auto = $el.Current.AutomationId; ` +
        `$b = $el.Current.BoundingRectangle; ` +
        `"name=$name | type=$type | id=$auto | bounds=$($b.X),$($b.Y),$($b.Width),$($b.Height)" ` +
      `} else { "(no focused element)" }`,
    ], { timeout: 5000 });
    return { text: stdout.trim() || '(no focused element)' };
  } catch (err) {
    return { text: `(get_focused_element error: ${err instanceof Error ? err.message : ''})` };
  }
}

// ── COM Automation Tools ─────────────────────────────────────────

/**
 * Structured result from a COM script invocation. brain.ts's hallucination
 * guard (brain.ts:726-750) checks destructive tool results for the
 * `(error:CODE)` prefix to detect false-success claims. errorCode lets
 * callers branch programmatically without string-parsing.
 */
type ComErrorCode =
  | 'OUTLOOK_NOT_RUNNING'   // _outlook-com-precheck: outlook_not_installed
  | 'OUTLOOK_NEW_NO_COM'    // _outlook-com-precheck: new_outlook_no_com
  | 'COM_ERROR'             // Generic COM activation / script runtime error
  | 'TIMEOUT'               // execFileAbortable timed out
  | 'PERMISSION_DENIED'     // Access denied from OS / UAC
  | 'SCRIPT_NOT_FOUND'      // .ps1 file missing from scripts dir
  | 'UNKNOWN';              // Unclassified failure

interface ComResult {
  ok: boolean;
  data?: unknown;        // Parsed JSON payload on success
  errorCode?: ComErrorCode;
  message: string;       // Human-readable summary (success or error)
}

/**
 * Map a raw error string from a PowerShell COM script to a ComErrorCode.
 * The precheck script emits structured reason strings; generic catch blocks
 * emit freetext. We classify by substring matching as a fallback.
 */
function classifyComError(errorField: string, rawMsg: string): ComErrorCode {
  // Structured reason strings from _outlook-com-precheck.ps1
  if (errorField === 'new_outlook_no_com') return 'OUTLOOK_NEW_NO_COM';
  if (errorField === 'outlook_not_installed') return 'OUTLOOK_NOT_RUNNING';

  // Freetext heuristics — order matters, more specific first
  const combined = (errorField + ' ' + rawMsg).toLowerCase();
  if (combined.includes('timeout') || combined.includes('timed out')) return 'TIMEOUT';
  if (combined.includes('access denied') || combined.includes('unauthorized') || combined.includes('permission')) return 'PERMISSION_DENIED';
  if (
    combined.includes('outlook') && (
      combined.includes('not installed') || combined.includes('not running') ||
      combined.includes('cannot create') || combined.includes('com object') ||
      combined.includes('0x80040154') || combined.includes('class not registered')
    )
  ) return 'OUTLOOK_NOT_RUNNING';
  if (
    combined.includes('com') || combined.includes('comobject') ||
    combined.includes('createobject') || combined.includes('progid')
  ) return 'COM_ERROR';

  return 'UNKNOWN';
}

/**
 * Human-readable message for the model when a COM call fails.
 * Format: `(error:CODE) <actionable sentence>`
 * brain.ts hallucination guard parses the `(error:CODE)` prefix.
 */
function comErrorMessage(code: ComErrorCode, scriptDetail: string): string {
  switch (code) {
    case 'OUTLOOK_NOT_RUNNING':
      return `(error:OUTLOOK_NOT_RUNNING) Outlook isn't running or isn't installed. Want me to start it, or use a browser-based approach instead?`;
    case 'OUTLOOK_NEW_NO_COM':
      return `(error:OUTLOOK_NEW_NO_COM) You have the new Outlook (olk.exe) which doesn't support COM automation. Use mailto: or open Outlook in the browser and I'll drive it via smart_click.`;
    case 'TIMEOUT':
      return `(error:TIMEOUT) The COM operation timed out. The app may be busy or frozen. ${scriptDetail}`;
    case 'PERMISSION_DENIED':
      return `(error:PERMISSION_DENIED) Access was denied. Try running as administrator or check file/app permissions. ${scriptDetail}`;
    case 'COM_ERROR':
      return `(error:COM_ERROR) COM automation failed. ${scriptDetail}`;
    case 'SCRIPT_NOT_FOUND':
      return `(error:SCRIPT_NOT_FOUND) Internal error: the automation script is missing. Reinstall ClippyAI. ${scriptDetail}`;
    default:
      return `(error:UNKNOWN) The operation failed. ${scriptDetail}`;
  }
}

/**
 * Run a bundled PowerShell COM script and return a structured ComResult.
 *
 * On success: ok=true, data=parsed JSON payload, message=success summary.
 * On failure: ok=false, errorCode=classified code, message=(error:CODE) text
 *   for brain.ts hallucination guard.
 *
 * All callers receive ToolResult via runComScript() which calls this
 * internally. The ComResult type is exported for callers that need to branch
 * on errorCode without re-parsing the message string.
 */
async function runComScriptStructured(
  scriptName: string,
  args: string[],
  timeoutMs = 20000,
): Promise<ComResult> {
  const scriptPath = path.join(getScriptsDir(), scriptName);
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      errorCode: 'SCRIPT_NOT_FOUND',
      message: comErrorMessage('SCRIPT_NOT_FOUND', `(${scriptName})`),
    };
  }

  try {
    // v0.11.26 — abortable so setMode('sleep') can kill the child mid-flight.
    const { stdout, stderr } = await execFileAbortable('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      ...args,
    ], { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 });

    // Last non-empty line is the JSON result
    const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] || '';
    try {
      const parsed = JSON.parse(lastLine);
      if (parsed.ok === false) {
        const errorField = String(parsed.error || '');
        const msgField = String(parsed.message || '');
        const code = classifyComError(errorField, msgField);
        return {
          ok: false,
          errorCode: code,
          message: comErrorMessage(code, msgField || errorField),
        };
      }
      return { ok: true, data: parsed, message: JSON.stringify(parsed) };
    } catch {
      // Not JSON — return raw output (shouldn't happen normally)
      const raw = stdout.trim() || stderr.trim() || '(no output)';
      return { ok: true, data: raw, message: raw };
    }
  } catch (err) {
    // v0.11.22 — capture stderr from the failed PowerShell invocation so the
    // model (and we) can actually diagnose what went wrong.
    // v0.11.26 — ALSO check stdout. The Fail() helper inside every COM
    // script writes JSON `{ok:false,error:"..."}` to STDOUT then `exit 1`.
    // execFileAsync rejects on exit-1 — but the err object's `stdout`
    // field contains that JSON. Previously we only looked at stderr (which
    // the scripts don't write to), missing the script's own clean error
    // message. Per report 8836f5ec the user was getting the generic
    // "Command failed: powershell.exe ..." message even though the script
    // had emitted a proper JSON error explaining the actual problem.
    const e = err as { message?: string; stderr?: string; stdout?: string; code?: number; signal?: string };
    const stderrTrimmed = (e.stderr || '').trim();
    const stdoutTrimmed = (e.stdout || '').trim();
    const rawMsg = e.message || String(err);

    log.warn('runComScript failed', {
      script: scriptName,
      argCount: args.length,
      code: e.code,
      signal: e.signal,
      stdoutPreview: stdoutTrimmed.substring(0, 200),
      stderrPreview: stderrTrimmed.substring(0, 200),
    });

    // Check if it was an abort (sleep/cancel signal) — not a COM failure
    if (rawMsg.includes('AbortError') || rawMsg.includes('signal is aborted')) {
      return { ok: false, errorCode: 'UNKNOWN', message: '(error:UNKNOWN) Operation was cancelled.' };
    }

    // Check for timeout specifically (execFileAbortable timeout option)
    if (rawMsg.includes('ETIMEDOUT') || rawMsg.includes('timed out') || e.signal === 'SIGTERM') {
      return {
        ok: false,
        errorCode: 'TIMEOUT',
        message: comErrorMessage('TIMEOUT', `(${scriptName} exceeded ${timeoutMs}ms)`),
      };
    }

    // 1. Try parsing stdout as JSON — that's where Fail() writes
    if (stdoutTrimmed) {
      const lines = stdoutTrimmed.split('\n').map((l) => l.trim()).filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      try {
        const parsed = JSON.parse(lastLine);
        if (parsed && parsed.ok === false && typeof parsed.error === 'string') {
          const code = classifyComError(parsed.error, parsed.message || '');
          return {
            ok: false,
            errorCode: code,
            message: comErrorMessage(code, parsed.message || parsed.error),
          };
        }
      } catch { /* not JSON, fall through */ }
    }

    // 2. Otherwise classify from stderr / exception message
    const detail = stderrTrimmed || rawMsg;
    const code = classifyComError('', detail);
    return {
      ok: false,
      errorCode: code,
      message: comErrorMessage(code, detail.substring(0, 300)),
    };
  }
}

/**
 * Public wrapper: calls runComScriptStructured and converts to ToolResult.
 * All existing COM tool callers use this signature — no caller changes needed.
 *
 * On success: ToolResult.text = JSON payload string (unchanged behaviour).
 * On failure: ToolResult.text = `(error:CODE) <message>` for hallucination
 *   guard detection, replacing the previous `Error: ...` prefix which was
 *   not parseable by brain.ts.
 */
async function runComScript(
  scriptName: string,
  args: string[],
  timeoutMs = 20000,
): Promise<ToolResult> {
  const result = await runComScriptStructured(scriptName, args, timeoutMs);
  return { text: result.message };
}

async function createReminder(params: Record<string, unknown>): Promise<ToolResult> {
  const title = String(params.title || '').substring(0, 100);
  const datetime = String(params.datetime || '');
  const notes = String(params.notes || '').substring(0, 200);
  if (!title || !datetime) return { text: 'Error: title and datetime are required' };
  // v0.11.25 — pass title + notes via base64 to bypass PS tokenizer (newlines,
  // smart quotes, em-dashes) AND to defend against the cmd-injection vector
  // the previous string-interpolation impl had. The .ps1 now writes title/notes
  // to a JSON sidecar and launches show-reminder.ps1 with quoted paths only.
  const titleB64 = Buffer.from(title, 'utf8').toString('base64');
  const notesB64 = Buffer.from(notes, 'utf8').toString('base64');
  const result = await runComScript('com-create-reminder.ps1', [
    '-titleB64', titleB64, '-datetime', datetime, '-notesB64', notesB64,
  ], 15000);
  if (result.text.startsWith('Error:') || result.text.startsWith('(error:')) return result;
  try {
    const r = JSON.parse(result.text);
    return { text: `Reminder set! "${title}" will appear at ${r.scheduledFor} (task: ${r.taskName})` };
  } catch { return result; }
}

async function readFile(params: Record<string, unknown>): Promise<ToolResult> {
  const filePath = String(params.path || '');
  if (!filePath) return { text: 'Error: path is required' };
  const result = await runComScript('com-read-file.ps1', ['-path', filePath], 10000);
  if (result.text.startsWith('Error:') || result.text.startsWith('(error:')) return result;
  try {
    const r = JSON.parse(result.text);
    return { text: `File: ${filePath}\nLines: ${r.lines} | Size: ${r.sizeBytes} bytes\n\n${r.content}` };
  } catch { return result; }
}

async function writeFile(params: Record<string, unknown>): Promise<ToolResult> {
  const filePath = String(params.path || '');
  const content = String(params.content || '');
  const mode = String(params.mode || 'create');
  if (!filePath) return { text: 'Error: path is required' };
  // v0.11.25 — pass file content via base64 (preserves newlines, all
  // bytes, all chars). Previously a content like "hello\n -mode overwrite"
  // would be re-tokenized by PS and silently flip the mode arg.
  const contentB64 = Buffer.from(content, 'utf8').toString('base64');
  const result = await runComScript('com-write-file.ps1', [
    '-path', filePath, '-contentB64', contentB64, '-mode', mode,
  ], 10000);
  if (result.text.startsWith('Error:') || result.text.startsWith('(error:')) return result;
  try {
    const r = JSON.parse(result.text);
    return { text: `File written: ${r.path} (${r.bytesWritten} bytes, mode=${r.mode})` };
  } catch { return result; }
}

async function runPowershell(params: Record<string, unknown>): Promise<ToolResult> {
  const script = String(params.script || '');
  if (!script) return { text: 'Error: script is required' };
  // v0.11.25 — pass via base64. Multi-line scripts were silently
  // truncated to first line by PS tokenizer, then "succeeded" with
  // partial execution. Subagent A flagged this as a latent P1.
  const scriptB64 = Buffer.from(script, 'utf8').toString('base64');
  const result = await runComScript('com-run-powershell.ps1', ['-scriptB64', scriptB64], 20000);
  if (result.text.startsWith('Error:') || result.text.startsWith('(error:')) return result;
  try {
    const r = JSON.parse(result.text);
    return { text: r.output?.substring(0, 3000) || '(no output)' };
  } catch { return result; }
}

// ── Agent loop tools ────────────────────────────────────────────

async function planTool(params: Record<string, unknown>): Promise<ToolResult> {
  // No-op executor — the value is in the model emitting structured plans into
  // its own context. We just acknowledge so the loop continues.
  const goal = String(params.goal || '').substring(0, 200);
  const steps = Array.isArray(params.steps) ? params.steps.map(String).slice(0, 12) : [];
  if (!goal || steps.length === 0) return { text: 'Error: goal and steps are required' };
  log.info('Plan', { goal, steps });
  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return { text: `Plan acknowledged.\nGoal: ${goal}\n${numbered}` };
}

// ── Tier 1: System / network / files ─────────────────────────────

async function systemInfo(params: Record<string, unknown>): Promise<ToolResult> {
  const fields = String(params.fields || '');
  const result = await runComScript('com-system-info.ps1', ['-fields', fields], 8000);
  return result;
}

async function listProcesses(params: Record<string, unknown>): Promise<ToolResult> {
  const sortBy = String(params.sortBy || 'ram');
  const top = String(Number(params.top) || 10);
  const result = await runComScript('com-list-processes.ps1', ['-sortBy', sortBy, '-top', top], 8000);
  return result;
}

async function speakText(params: Record<string, unknown>): Promise<ToolResult> {
  const text = String(params.text || '');
  if (!text) return { text: 'Error: text is required' };
  const rate = String(Number(params.rate) || 0);
  // v0.11.25 — base64 encode. Spoken text is often verbatim user/model
  // output containing punctuation that breaks the PS tokenizer.
  const textB64 = Buffer.from(text, 'utf8').toString('base64');
  const result = await runComScript('com-speak-text.ps1', ['-textB64', textB64, '-rate', rate], 5000);
  return result;
}

async function searchFilesContent(params: Record<string, unknown>): Promise<ToolResult> {
  const pattern = String(params.pattern || '');
  if (!pattern) return { text: 'Error: pattern is required' };
  const args = ['-pattern', pattern];
  if (params.path) args.push('-path', String(params.path));
  if (params.glob) args.push('-glob', String(params.glob));
  const result = await runComScript('com-search-files.ps1', args, 30000);
  return result;
}

async function pingHost(params: Record<string, unknown>): Promise<ToolResult> {
  const host = String(params.host || '');
  if (!host) return { text: 'Error: host is required' };
  const count = String(Number(params.count) || 4);
  // Note: -hostName in script (host is a reserved-ish param name in some PS contexts)
  const result = await runComScript('com-ping-host.ps1', ['-hostName', host, '-count', count], 15000);
  return result;
}

async function httpRequest(params: Record<string, unknown>): Promise<ToolResult> {
  const url = String(params.url || '');
  if (!url) return { text: 'Error: url is required' };
  const args = ['-url', url];
  if (params.method) args.push('-method', String(params.method));
  // v0.11.25 — headers (JSON) and body via base64. Headers JSON contains
  // double-quotes; bodies routinely contain newlines/JSON/special chars.
  // Both broke the PS tokenizer when passed raw.
  if (params.headers) {
    const headersB64 = Buffer.from(String(params.headers), 'utf8').toString('base64');
    args.push('-headersB64', headersB64);
  }
  if (params.body) {
    const bodyB64 = Buffer.from(String(params.body), 'utf8').toString('base64');
    args.push('-bodyB64', bodyB64);
  }
  const result = await runComScript('com-http-request.ps1', args, 20000);
  return result;
}

// ── Tier 2: Office COM ───────────────────────────────────────────

async function outlookSendEmail(params: Record<string, unknown>): Promise<ToolResult> {
  const to = String(params.to || '');
  const subject = String(params.subject || '');
  const body = String(params.body || '');
  if (!to || !subject || !body) return { text: 'Error: to, subject, and body are required' };

  // v0.11.26 — REMOVED the v0.11.25 registry probe. Per report 8836f5ec
  // the probe (`Test-Path 'Registry::HKEY_CLASSES_ROOT\Outlook.Application'`)
  // returned false on a user machine that DOES have classic Outlook
  // installed. The probe was a false-negative source — better to attempt
  // the COM call directly and let the .ps1's own catch block emit a
  // clean JSON error if Outlook isn't actually available.
  //
  // The original v0.11.25 motivation (avoid silent crash on Outlook-new)
  // is preserved by the runComScript fix below — the script's Fail()
  // JSON output (which DOES fire even when Outlook.Application can't
  // be activated) is now surfaced from execFileAsync's error.stdout
  // instead of falling through to the generic "Command failed" message.
  //
  // Encode body + subject as UTF-8 base64 to bypass PowerShell's
  // command-line tokenizer (v0.11.22 fix; multi-line bodies, em-dashes,
  // smart quotes were silently truncated).
  const subjectB64 = Buffer.from(subject, 'utf8').toString('base64');
  const bodyB64 = Buffer.from(body, 'utf8').toString('base64');
  const args = ['-to', to, '-subjectB64', subjectB64, '-bodyB64', bodyB64];
  if (params.cc) args.push('-cc', String(params.cc));
  if (params.attachments) args.push('-attachments', String(params.attachments));
  const result = await runComScript('com-outlook-send-email.ps1', args, 30000);
  return result;
}

async function outlookReadInbox(params: Record<string, unknown>): Promise<ToolResult> {
  const count = String(Number(params.count) || 10);
  const unreadOnly = params.unreadOnly === true || params.unreadOnly === 'true' ? 'true' : 'false';
  const result = await runComScript('com-outlook-read-inbox.ps1', ['-count', count, '-unreadOnly', unreadOnly], 20000);
  return result;
}

async function excelRead(params: Record<string, unknown>): Promise<ToolResult> {
  const filePath = String(params.path || '');
  if (!filePath) return { text: 'Error: path is required' };
  const args = ['-path', filePath];
  if (params.sheet) args.push('-sheet', String(params.sheet));
  if (params.range) args.push('-range', String(params.range));
  const result = await runComScript('com-excel-read.ps1', args, 30000);
  return result;
}

async function wordToPdf(params: Record<string, unknown>): Promise<ToolResult> {
  const input = String(params.input || '');
  if (!input) return { text: 'Error: input is required' };
  const args = ['-inputPath', input];
  if (params.output) args.push('-outputPath', String(params.output));
  const result = await runComScript('com-word-to-pdf.ps1', args, 60000);
  return result;
}

async function excelWrite(params: Record<string, unknown>): Promise<ToolResult> {
  const filePath = String(params.path || '');
  const data = params.data;
  if (!filePath) return { text: 'Error: path is required' };
  if (data === undefined || data === null) return { text: 'Error: data is required' };
  // Accept either a JSON string (from the model) or a real array; serialize either way.
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  const args = ['-path', filePath, '-data', dataStr];
  if (params.sheet) args.push('-sheet', String(params.sheet));
  if (params.range) args.push('-range', String(params.range));
  return await runComScript('com-excel-write.ps1', args, 30000);
}

async function outlookCreateEvent(params: Record<string, unknown>): Promise<ToolResult> {
  const subject = String(params.subject || '');
  const start = String(params.start || '');
  if (!subject || !start) return { text: 'Error: subject and start are required' };
  // v0.11.25 — base64-encode subject / location / body. Meeting body
  // routinely contains newlines + Unicode that the PS tokenizer mangles.
  const subjectB64 = Buffer.from(subject, 'utf8').toString('base64');
  const args = ['-subjectB64', subjectB64, '-start', start];
  if (params.durationMin !== undefined) args.push('-durationMin', String(Number(params.durationMin) || 30));
  if (params.attendees) args.push('-attendees', String(params.attendees));
  if (params.location) {
    const locationB64 = Buffer.from(String(params.location), 'utf8').toString('base64');
    args.push('-locationB64', locationB64);
  }
  if (params.body) {
    const bodyB64 = Buffer.from(String(params.body), 'utf8').toString('base64');
    args.push('-bodyB64', bodyB64);
  }
  return await runComScript('com-outlook-create-event.ps1', args, 20000);
}

async function outlookUpcoming(params: Record<string, unknown>): Promise<ToolResult> {
  const daysAhead = String(Number(params.daysAhead) || 7);
  const count = String(Number(params.count) || 20);
  return await runComScript('com-outlook-upcoming.ps1', ['-daysAhead', daysAhead, '-count', count], 20000);
}

async function listFiles(params: Record<string, unknown>): Promise<ToolResult> {
  const filePath = String(params.path || '');
  if (!filePath) return { text: 'Error: path is required' };
  const args = ['-path', filePath];
  if (params.filter) args.push('-filter', String(params.filter));
  if (params.recurse !== undefined) args.push('-recurse', params.recurse ? 'true' : 'false');
  if (params.top !== undefined) args.push('-top', String(Number(params.top) || 100));
  return await runComScript('com-list-files.ps1', args, 15000);
}

async function minimizeAllWindows(): Promise<ToolResult> {
  // Shell.Application's MinimizeAll() is the canonical Win+D equivalent.
  // We tried key_press("win+d") first — nut.js doesn't reliably send the
  // Windows key, so the model claimed success without anything happening.
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "(New-Object -ComObject Shell.Application).MinimizeAll()",
    ], { timeout: 5000 });
    return { text: 'Minimized all windows.' };
  } catch (err) {
    return { text: `(minimize_all_windows error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function showDesktop(): Promise<ToolResult> {
  // Shell.Application.ToggleDesktop() is the true Win+D — toggles between
  // showing the desktop and restoring all windows.
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "(New-Object -ComObject Shell.Application).ToggleDesktop()",
    ], { timeout: 5000 });
    return { text: 'Toggled show-desktop.' };
  } catch (err) {
    return { text: `(show_desktop error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function minimizeWindow(params: Record<string, unknown>): Promise<ToolResult> {
  const procName = sanitizeAppName(String(params.processName || ''));
  if (!procName) return { text: 'Error: processName is required' };
  // Use Win32 ShowWindow via P/Invoke. SW_MINIMIZE = 6.
  const ps = `
$sig = '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'
Add-Type -MemberDefinition $sig -Name Win -Namespace P -Using System.Runtime.InteropServices
$procs = Get-Process -Name '${procName}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
if (-not $procs) { Write-Output 'NOTFOUND'; exit 0 }
foreach ($p in $procs) { [P.Win]::ShowWindow($p.MainWindowHandle, 6) | Out-Null }
Write-Output ('OK:' + $procs.Count)
`.trim();
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', ps,
    ], { timeout: 5000 });
    const last = stdout.trim().split('\n').pop()?.trim() || '';
    if (last === 'NOTFOUND') return { text: `(minimize_window: no window for "${procName}")` };
    return { text: `Minimized ${procName}.` };
  } catch (err) {
    return { text: `(minimize_window error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function killProcess(params: Record<string, unknown>): Promise<ToolResult> {
  const args: string[] = [];
  if (params.procPid !== undefined) args.push('-procPid', String(Number(params.procPid) || 0));
  if (params.name) args.push('-name', String(params.name));
  if (args.length === 0) return { text: 'Error: procPid or name is required' };
  return await runComScript('com-kill-process.ps1', args, 8000);
}

// ── Browser CDP tools (Tier 0) ───────────────────────────────────
//
// Connect to Edge/Chrome via Chrome DevTools Protocol. Gives the model
// structured DOM access — selectors, text content, click/type, evaluate
// JS — without screenshots or UIA. Browser must be launched with
// --remote-debugging-port=<port>. cdp_connect tries to auto-launch if
// no live endpoint is found.

const CDP_PORT = DEFAULT_CDP_PORT;

/** Spawn Edge or Chrome with a remote-debugging port enabled. */
async function spawnCdpBrowser(): Promise<{ ok: boolean; error?: string }> {
  // Try Edge first (default Windows browser), fall back to Chrome.
  const candidates: Array<{ exe: string; args: string[] }> = [
    {
      exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      args: [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(os.tmpdir(), 'clippy-cdp-edge')}`],
    },
    {
      exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(os.tmpdir(), 'clippy-cdp-chrome')}`],
    },
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c.exe)) continue;
    try {
      const child = spawn(c.exe, c.args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      // Give the browser ~1.5s to bind the debug port
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: true };
    } catch (err) {
      log.warn('CDP browser spawn failed', serializeErr(err));
    }
  }
  return { ok: false, error: 'Neither Edge nor Chrome was found in their default install paths.' };
}

async function cdpConnect(_params: Record<string, unknown>): Promise<ToolResult> {
  const client = getCdpClient();
  let result = await client.connect();
  if (!result.ok) {
    // Try to spawn a browser with CDP enabled, then retry.
    const spawned = await spawnCdpBrowser();
    if (!spawned.ok) {
      // v0.11.27 — explicit anti-retry guidance. Per log analysis (May 7),
      // 4/5 recent reports showed the model burning the runaway guard
      // by retrying cdp_connect 3x in a row when ECONNREFUSED. The error
      // message now tells the model exactly what to do INSTEAD of retry.
      return { text:
        `(cdp_connect failed: ${result.error}. Auto-launch failed: ${spawned.error}. ` +
        `DO NOT call cdp_connect again — it will keep failing. ` +
        `Alternatives in order of preference: ` +
        `(1) For email — use outlook_send_email if classic Outlook is installed. ` +
        `(2) For web tasks — use smart_click + smart_type on the visible browser window via UIA + OCR (no CDP needed). ` +
        `(3) For URL navigation — use shell openExternal via navigate_browser. ` +
        `(4) Last resort — ask user to relaunch their browser with --remote-debugging-port=${CDP_PORT}. ` +
        `Do not retry CDP this turn.)`,
      };
    }
    result = await client.connect();
    if (!result.ok) {
      return { text:
        `(cdp_connect: still failed after launching browser: ${result.error}. ` +
        `DO NOT call cdp_connect again. Use smart_click + smart_type on the foreground browser window instead.)`,
      };
    }
  }
  return { text: `Connected to "${result.title}" at ${result.url}` };
}

async function cdpPageContext(_params: Record<string, unknown>): Promise<ToolResult> {
  const client = getCdpClient();
  if (!client.isConnected()) return { text: '(cdp_page_context: not connected — call cdp_connect first)' };
  try {
    const ctx = await client.getPageContext();
    return { text: ctx || '(no interactive elements found)' };
  } catch (e) {
    return { text: `(cdp_page_context error: ${e instanceof Error ? e.message : ''})` };
  }
}

async function cdpReadText(params: Record<string, unknown>): Promise<ToolResult> {
  const client = getCdpClient();
  if (!client.isConnected()) return { text: '(cdp_read_text: not connected — call cdp_connect first)' };
  const selector = String(params.selector || 'body');
  const maxLength = Number(params.maxLength) || 3000;
  try {
    const text = await client.readText(selector, maxLength);
    return { text };
  } catch (e) {
    return { text: `(cdp_read_text error: ${e instanceof Error ? e.message : ''})` };
  }
}

async function cdpClick(params: Record<string, unknown>): Promise<ToolResult> {
  const client = getCdpClient();
  if (!client.isConnected()) return { text: '(cdp_click: not connected — call cdp_connect first)' };
  const selector = params.selector ? String(params.selector) : '';
  const text = params.text ? String(params.text) : '';
  if (!selector && !text) return { text: 'Error: cdp_click requires selector or text' };
  const r = text ? await client.clickByText(text) : await client.click(selector);
  if (!r.success) return { text: `(cdp_click failed: ${r.error})` };
  return { text: `Clicked ${selector || `"${text}"`} via ${r.method}` };
}

async function cdpType(params: Record<string, unknown>): Promise<ToolResult> {
  const client = getCdpClient();
  if (!client.isConnected()) return { text: '(cdp_type: not connected — call cdp_connect first)' };
  const selector = params.selector ? String(params.selector) : '';
  const label = params.label ? String(params.label) : '';
  const text = String(params.text || '');
  if (!text) return { text: 'Error: cdp_type requires text' };
  if (!selector && !label) return { text: 'Error: cdp_type requires selector or label' };
  const r = label ? await client.typeByLabel(label, text) : await client.typeInField(selector, text);
  if (!r.success) return { text: `(cdp_type failed: ${r.error})` };
  return { text: `Typed "${text.substring(0, 60)}" into ${selector || `label="${label}"`}` };
}

async function cdpSelectOption(params: Record<string, unknown>): Promise<ToolResult> {
  const client = getCdpClient();
  if (!client.isConnected()) return { text: '(cdp_select_option: not connected — call cdp_connect first)' };
  const selector = String(params.selector || '');
  const value = String(params.value || '');
  if (!selector || !value) return { text: 'Error: cdp_select_option requires selector and value' };
  const r = await client.selectOption(selector, value);
  return { text: r.success ? `Selected "${value}" in ${selector}` : `(cdp_select_option failed: ${r.error})` };
}

async function cdpEvaluate(params: Record<string, unknown>): Promise<ToolResult> {
  const client = getCdpClient();
  if (!client.isConnected()) return { text: '(cdp_evaluate: not connected — call cdp_connect first)' };
  const js = String(params.javascript || '');
  if (!js) return { text: 'Error: cdp_evaluate requires javascript' };
  try {
    const r = await client.evaluate(js);
    const text = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
    return { text: text || '(undefined)' };
  } catch (e) {
    return { text: `(cdp_evaluate error: ${e instanceof Error ? e.message : ''})` };
  }
}

async function cdpWaitForSelector(params: Record<string, unknown>): Promise<ToolResult> {
  const client = getCdpClient();
  if (!client.isConnected()) return { text: '(cdp_wait_for_selector: not connected — call cdp_connect first)' };
  const selector = String(params.selector || '');
  if (!selector) return { text: 'Error: cdp_wait_for_selector requires selector' };
  const timeout = Number(params.timeout) || 10_000;
  const r = await client.waitForSelector(selector, timeout);
  return { text: r.success ? `Element "${selector}" found` : `(cdp_wait_for_selector failed: ${r.error})` };
}

async function cdpListTabs(_params: Record<string, unknown>): Promise<ToolResult> {
  try {
    const tabs = await listTabsRaw(CDP_PORT);
    if (tabs.length === 0) return { text: `(no tabs — launch browser with --remote-debugging-port=${CDP_PORT})` };
    return {
      text: tabs.map((t, i) => `${i + 1}. "${t.title}" — ${t.url}`).join('\n'),
    };
  } catch (e) {
    return { text: `(cdp_list_tabs: ${e instanceof Error ? e.message : ''})` };
  }
}

async function cdpSwitchTab(params: Record<string, unknown>): Promise<ToolResult> {
  const client = getCdpClient();
  const target = String(params.target || '');
  if (!target) return { text: 'Error: cdp_switch_tab requires target' };
  const r = await client.switchTab(target);
  return { text: r.ok ? `Switched to "${r.title}" at ${r.url}` : `(cdp_switch_tab: ${r.error})` };
}

async function cdpScroll(params: Record<string, unknown>): Promise<ToolResult> {
  const client = getCdpClient();
  if (!client.isConnected()) return { text: '(cdp_scroll: not connected — call cdp_connect first)' };
  const dir = String(params.direction || 'down');
  const amount = Number(params.amount) || 500;
  const pixels = amount * (dir === 'down' ? 1 : -1);
  try {
    await client.evaluate(`window.scrollBy(0, ${pixels})`);
    return { text: `Scrolled ${dir} by ${Math.abs(pixels)}px` };
  } catch (e) {
    return { text: `(cdp_scroll error: ${e instanceof Error ? e.message : ''})` };
  }
}

// ── Electron WebView app detection ───────────────────────────────
//
// Many "native" Windows apps are Electron / WebView2 wrappers (Slack,
// Teams, Discord, VS Code, Notion, New Outlook). Their accessibility
// trees are mostly empty — UI lives inside an embedded Chromium. This
// tool flags those candidates so the agent knows to relaunch with CDP
// instead of fighting the empty UIA tree.
//
// Cherry-picked from clawdcursor/src/tools/electron_bridge.ts but
// reimplemented compactly without a platform abstraction.

const KNOWN_WEBVIEW_APPS: Array<{ procPrefixes: string[]; name: string; flag: string }> = [
  { procPrefixes: ['olk'], name: 'New Outlook', flag: '--remote-debugging-port=9223' },
  { procPrefixes: ['ms-teams', 'teams'], name: 'Microsoft Teams', flag: '--remote-debugging-port=9223' },
  { procPrefixes: ['discord'], name: 'Discord', flag: '--remote-debugging-port=9223' },
  { procPrefixes: ['slack'], name: 'Slack', flag: '--remote-debugging-port=9223' },
  { procPrefixes: ['code', 'code - insiders'], name: 'VS Code', flag: '--inspect=9223' },
  { procPrefixes: ['notion'], name: 'Notion', flag: '--remote-debugging-port=9223' },
  { procPrefixes: ['obsidian'], name: 'Obsidian', flag: '--remote-debugging-port=9223' },
  { procPrefixes: ['spotify'], name: 'Spotify', flag: '--remote-debugging-port=9223' },
  { procPrefixes: ['github desktop', 'githubdesktop'], name: 'GitHub Desktop', flag: '--remote-debugging-port=9223' },
];

async function probeCdpPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 500 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function detectWebviewApps(_params: Record<string, unknown>): Promise<ToolResult> {
  try {
    // Reuse get_windows to enumerate processes (PowerShell-backed).
    const winResult = await getWindows();
    type WinInfo = { processName?: string; title?: string; processId?: number };
    let windows: WinInfo[] = [];
    try {
      const parsed = JSON.parse(winResult.text);
      windows = Array.isArray(parsed) ? parsed : (parsed.windows || []);
    } catch {
      return { text: '(detect_webview_apps: could not parse window list)' };
    }
    const cdpPort = (await probeCdpPort(9223)) ? 9223 : (await probeCdpPort(9222)) ? 9222 : null;
    const matches: Array<{ name: string; processName: string; title: string; flag: string }> = [];
    for (const w of windows) {
      const pn = (w.processName || '').toLowerCase();
      for (const fp of KNOWN_WEBVIEW_APPS) {
        if (fp.procPrefixes.some((p) => pn.startsWith(p))) {
          matches.push({ name: fp.name, processName: w.processName || '', title: w.title || '', flag: fp.flag });
          break;
        }
      }
    }
    if (matches.length === 0) {
      return { text: cdpPort ? `No known WebView apps in window list. CDP IS live on port ${cdpPort} — call cdp_connect.` : 'No known WebView apps detected, no live CDP endpoint.' };
    }
    const lines = matches.map((m) =>
      cdpPort
        ? `${m.name} ("${m.title}") detected — CDP live on ${cdpPort}, call cdp_connect.`
        : `${m.name} ("${m.title}") — UI lives in embedded Chromium. Ask user to relaunch with: ${m.processName} ${m.flag}`,
    );
    return { text: lines.join('\n') };
  } catch (e) {
    return { text: `(detect_webview_apps error: ${e instanceof Error ? e.message : ''})` };
  }
}

// ── Tool Registry ────────────────────────────────────────────────

const TOOL_MAP: Record<string, (params: Record<string, unknown>) => Promise<ToolResult>> = {
  read_screen: readScreen,
  get_active_window: getActiveWindow,
  get_windows: getWindows,
  get_focused_element: getFocusedElement,
  focus_window: focusWindow,
  open_app: openApp,
  desktop_screenshot: desktopScreenshot,
  smart_click: smartClick,
  smart_type: smartType,
  type_text: typeText,
  key_press: keyPress,
  mouse_click: mouseClick,
  mouse_double_click: mouseDoubleClick,
  mouse_right_click: mouseRightClick,
  mouse_hover: mouseHover,
  mouse_drag: mouseDrag,
  mouse_scroll: mouseScroll,
  navigate_browser: navigateBrowser,
  read_clipboard: readClipboard,
  write_clipboard: writeClipboard,
  wait: waitTool,
  ocr_read_screen: ocrReadScreen,
  // COM automation
  create_reminder: createReminder,
  read_file: readFile,
  write_file: writeFile,
  run_powershell: runPowershell,
  // Agent loop
  plan: planTool,
  // System / network
  system_info: systemInfo,
  list_processes: listProcesses,
  speak_text: speakText,
  search_files_content: searchFilesContent,
  ping_host: pingHost,
  http_request: httpRequest,
  // Office COM
  outlook_send_email: outlookSendEmail,
  outlook_read_inbox: outlookReadInbox,
  outlook_create_event: outlookCreateEvent,
  outlook_upcoming: outlookUpcoming,
  excel_read: excelRead,
  excel_write: excelWrite,
  word_to_pdf: wordToPdf,
  // Files / processes
  list_files: listFiles,
  kill_process: killProcess,
  // Window management
  minimize_all_windows: minimizeAllWindows,
  show_desktop: showDesktop,
  minimize_window: minimizeWindow,
  // Browser CDP (Tier 0)
  cdp_connect: cdpConnect,
  cdp_page_context: cdpPageContext,
  cdp_read_text: cdpReadText,
  cdp_click: cdpClick,
  cdp_type: cdpType,
  cdp_select_option: cdpSelectOption,
  cdp_evaluate: cdpEvaluate,
  cdp_wait_for_selector: cdpWaitForSelector,
  cdp_list_tabs: cdpListTabs,
  cdp_switch_tab: cdpSwitchTab,
  cdp_scroll: cdpScroll,
  detect_webview_apps: detectWebviewApps,
  // Aliases
  smart_read: readScreen,
  // Tier 1 — local artifact generation (no GUI automation required)
  generate_docx: docxFromBlocks,
  generate_excel: excelFromRows,
  generate_image: imageFromPrimitives,
  generate_pdf: pdfFromText,
  generate_qrcode: qrcodeFromText,
};

// ── Public API ───────────────────────────────────────────────────

let initialized = false;

export async function initTools(): Promise<void> {
  if (initialized) return;
  log.info('Initializing direct tools...');
  try {
    await detectScreenScale();
  } catch (err) {
    log.warn('Screen scale detection failed', serializeErr(err));
  }
  // PSBridge warmup is SLOW (~12s on fresh Windows installs) and blocking
  // it here makes Clippy show nothing for ~12s after click-to-launch. Start
  // it in the background and let psCommand() fall back to one-off PowerShell
  // calls until the bridge reports READY. Users get a responsive app now;
  // per-call overhead of one-off PS is ~100-500ms until warmup completes.
  startPSBridge().catch((err) => {
    log.warn('PSBridge startup failed — using fallback one-off PowerShell calls', serializeErr(err));
  });

  // Health monitor: every 30s, ping the bridge. On failure: kill + respawn
  // (max 3 per 60s window, then permanent degradation to one-off fallback).
  // The interval is also cleared in the PSBridge exit handler so a stale
  // ping cannot fire and try to write to a bridge that is mid-respawn.
  psHealthInterval = setInterval(() => {
    psHealthCheck().catch((err) => {
      // psHealthCheck never throws by design — this is a belt-and-suspenders
      // catch in case an internal promise rejects unexpectedly.
      log.warn('psHealthCheck uncaught error', serializeErr(err));
    });
  }, 30_000);

  initialized = true;
  log.info('Tools ready', { toolCount: Object.keys(TOOL_MAP).length });
}

export async function executeTool(tool: string, params: Record<string, unknown> = {}): Promise<ToolResult> {
  const fn = TOOL_MAP[tool];
  if (!fn) {
    log.warn(`Unknown tool: ${tool}`);
    return { text: `(unknown tool: ${tool})` };
  }

  const startTime = Date.now();
  try {
    const result = await fn(params);
    const elapsed = Date.now() - startTime;
    log.debug(`Tool ${tool} ok (${elapsed}ms)`, result.text?.substring(0, 100));
    return result;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    log.error(`Tool ${tool} failed (${elapsed}ms)`, serializeErr(err));
    return { text: `(tool ${tool} error: ${err instanceof Error ? err.message : String(err)})` };
  }
}

/**
 * Cleanup on app quit. Must kill PSBridge FORCEFULLY and SYNCHRONOUSLY — if
 * we just send SIGTERM and return, the PowerShell subprocess (and anything
 * it spawned) can linger, holding file handles on our install directory.
 * During auto-update that means the NSIS installer can't replace ClippyAI.exe
 * and the whole update fails silently.
 *
 * Uses taskkill /T /F on Windows which kills the process + entire tree
 * immediately. Synchronous child_process.spawnSync so this blocks until the
 * OS confirms the kill before we hand control back to app.quit.
 */
export function cleanupTools(): void {
  // Stop the health monitor first so it can't fire during teardown and
  // attempt a respawn while we're in the middle of killing the bridge.
  if (psHealthInterval) {
    clearInterval(psHealthInterval);
    psHealthInterval = null;
  }

  if (psBridge && !psBridge.killed && psBridge.pid) {
    try {
      const { spawnSync } = require('child_process') as typeof import('child_process');
      spawnSync('taskkill', ['/F', '/T', '/PID', String(psBridge.pid)], { timeout: 3000 });
    } catch {
      // Fallback: normal kill. Won't handle children, but better than nothing.
      try { psBridge.kill('SIGKILL'); } catch { /* already dead */ }
    }
    psBridge = null;
  }
}
