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
import { shell } from 'electron';
import { createLogger } from './logger';
import { getCdpClient, listTabsRaw, DEFAULT_CDP_PORT } from './cdp-client';

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
import { app } from 'electron';

const log = createLogger('Tools');
const execFileAsync = promisify(execFile);
// exec removed — all commands use execFileAsync (safe) or shell.openExternal

// ── Path resolution ──────────────────────────────────────────────

function getScriptsDir(): string {
  // Production: resources/scripts/
  const bundled = path.join(process.resourcesPath || '', 'scripts');
  if (fs.existsSync(bundled)) return bundled;
  // Dev: assets/scripts/
  const dev = path.join(app.getAppPath(), 'assets', 'scripts');
  if (fs.existsSync(dev)) return dev;
  return path.join(__dirname, '../../assets/scripts');
}

// ── PowerShell Bridge (persistent UIA process) ───────────────────

let psBridge: ChildProcess | null = null;
let psReady = false;
let psQueue: Array<{ cmd: string; resolve: (v: string) => void; reject: (e: Error) => void }> = [];
let psBuffer = '';

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
        log.warn('PSBridge stdout handler error', String(e).substring(0, 200));
      }
    });

    psBridge.stderr?.on('data', (chunk: Buffer) => {
      log.warn('PSBridge stderr', chunk.toString().substring(0, 200));
    });

    psBridge.on('exit', (code) => {
      log.info('PSBridge exited', { code });
      psBridge = null;
      psReady = false;
      // Reject any pending queries
      for (const q of psQueue) q.reject(new Error('PSBridge exited'));
      psQueue = [];
    });
  });
}

async function psCommand(cmd: string): Promise<string> {
  if (!psBridge || !psReady) {
    // Fallback: one-off powershell call
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
    const timer = setTimeout(() => reject(new Error('PSBridge command timeout (10s)')), 10000);
    psQueue.push({
      cmd,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    psBridge!.stdin?.write(cmd + '\n');
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
    return { text: `Typed: ${text.substring(0, 50)}` };
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

async function mouseClick(params: Record<string, unknown>): Promise<ToolResult> {
  const x = sanitizeNumber(params.x) * Math.round(screenScale);
  const y = sanitizeNumber(params.y) * Math.round(screenScale);
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); ` +
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32 -Namespace API; ` +
      `[API.Win32]::mouse_event(2,0,0,0,0); [API.Win32]::mouse_event(4,0,0,0,0)`,
    ], { timeout: 5000 });
    return { text: `Clicked at (${params.x},${params.y})` };
  } catch (err) {
    return { text: `(mouse_click error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function mouseDrag(params: Record<string, unknown>): Promise<ToolResult> {
  const sx = Math.round(Number(params.startX || 0) * screenScale);
  const sy = Math.round(Number(params.startY || 0) * screenScale);
  const ex = Math.round(Number(params.endX || 0) * screenScale);
  const ey = Math.round(Number(params.endY || 0) * screenScale);
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
    return { text: `Dragged from (${params.startX},${params.startY}) to (${params.endX},${params.endY})` };
  } catch (err) {
    return { text: `(mouse_drag error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function mouseScroll(params: Record<string, unknown>): Promise<ToolResult> {
  const x = Math.round(Number(params.x || 640) * screenScale);
  const y = Math.round(Number(params.y || 400) * screenScale);
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
    return { text: `Scrolled ${direction} at (${params.x},${params.y})` };
  } catch (err) {
    return { text: `(mouse_scroll error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function smartClick(params: Record<string, unknown>): Promise<ToolResult> {
  const target = String(params.target || '');
  if (!target) return { text: '(no target provided)' };
  // 15s timeout — customer machines with slow UIA (PSBridge 12s startup)
  // need more time for find-element searches in complex ribbon UIs like Paint.
  // The old 8s timeout caused frequent smart_click failures.
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(getScriptsDir(), 'find-element.ps1'),
      '-Name', target,
    ], { timeout: 15000 });
    const match = stdout.match(/X:(\d+)\s+Y:(\d+)/i) || stdout.match(/(\d+),(\d+)/);
    if (match) {
      const ex = parseInt(match[1]);
      const ey = parseInt(match[2]);
      await mouseClick({ x: ex, y: ey });
      return { text: `Clicked "${target}" at (${ex},${ey})` };
    }
    // Fallback: try invoke-element (UIA Invoke pattern)
    const { stdout: invokeOut } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(getScriptsDir(), 'invoke-element.ps1'),
      '-Name', target, '-Action', 'click',
    ], { timeout: 15000 });
    return { text: invokeOut.trim() || `Clicked "${target}"` };
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

async function desktopScreenshot(): Promise<ToolResult> {
  try {
    // Use PowerShell to capture screen as base64 PNG
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
      `$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ` +
      `$bmp = New-Object System.Drawing.Bitmap($b.Width,$b.Height); ` +
      `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
      `$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ` +
      `$ms = New-Object System.IO.MemoryStream; ` +
      `$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); ` +
      `[Convert]::ToBase64String($ms.ToArray())`,
    ], { timeout: 10000, maxBuffer: 20 * 1024 * 1024 });
    return {
      text: 'Screenshot captured',
      image: { data: stdout.trim(), mimeType: 'image/png' },
    };
  } catch (err) {
    return { text: `(screenshot error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function ocrReadScreen(): Promise<ToolResult> {
  const scriptPath = path.join(getScriptsDir(), 'ocr-recognize.ps1');
  if (!fs.existsSync(scriptPath)) {
    return { text: '(ocr-recognize.ps1 not found — OCR unavailable)' };
  }
  // Capture screenshot to temp file, run OCR on it, return text + positions
  const tmpPng = path.join(os.tmpdir(), `clippy-ocr-${Date.now()}.png`);
  try {
    // Step 1: capture screenshot to temp PNG
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
      `$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ` +
      `$bmp = New-Object System.Drawing.Bitmap($b.Width,$b.Height); ` +
      `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
      `$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ` +
      `$bmp.Save('${tmpPng.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); ` +
      `$g.Dispose(); $bmp.Dispose()`,
    ], { timeout: 10000 });

    // Step 2: run OCR on the temp PNG
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      '-ImagePath', tmpPng,
    ], { timeout: 15000, maxBuffer: 5 * 1024 * 1024 });

    const raw = stdout.trim();
    if (!raw) return { text: '(OCR returned no output)' };

    // Step 3: parse and format
    try {
      const parsed = JSON.parse(raw);
      if (parsed.error) return { text: `(OCR error: ${parsed.error})` };
      // Format: return full text first, then element positions for coordinate-based clicking
      let result = `=== OCR TEXT ===\n${parsed.fullText || '(no text detected)'}\n`;
      if (parsed.elements && parsed.elements.length > 0) {
        result += `\n=== TEXT POSITIONS (for mouse_click targets) ===\n`;
        // Group by line for readability
        let currentLine = -1;
        for (const el of parsed.elements) {
          if (el.line !== currentLine) {
            currentLine = el.line;
            result += `\n[Line ${currentLine}]\n`;
          }
          const cx = Math.round(el.x + el.width / 2);
          const cy = Math.round(el.y + el.height / 2);
          result += `  "${el.text}" → center(${cx}, ${cy})  rect(${el.x},${el.y},${el.width}x${el.height})\n`;
        }
      }
      return { text: result };
    } catch {
      // Couldn't parse JSON — return raw output
      return { text: raw };
    }
  } catch (err) {
    return { text: `(ocr_read_screen error: ${err instanceof Error ? err.message : String(err)})` };
  } finally {
    try { fs.unlinkSync(tmpPng); } catch { /* cleanup */ }
  }
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
  const x = sanitizeNumber(params.x) * Math.round(screenScale);
  const y = sanitizeNumber(params.y) * Math.round(screenScale);
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
    return { text: `Double-clicked at (${params.x},${params.y})` };
  } catch (err) {
    return { text: `(mouse_double_click error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function mouseRightClick(params: Record<string, unknown>): Promise<ToolResult> {
  const x = sanitizeNumber(params.x) * Math.round(screenScale);
  const y = sanitizeNumber(params.y) * Math.round(screenScale);
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); ` +
      `Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32 -Namespace API; ` +
      // 0x0008 = RIGHTDOWN, 0x0010 = RIGHTUP
      `[API.Win32]::mouse_event(8,0,0,0,0); [API.Win32]::mouse_event(16,0,0,0,0)`,
    ], { timeout: 5000 });
    return { text: `Right-clicked at (${params.x},${params.y})` };
  } catch (err) {
    return { text: `(mouse_right_click error: ${err instanceof Error ? err.message : ''})` };
  }
}

async function mouseHover(params: Record<string, unknown>): Promise<ToolResult> {
  const x = sanitizeNumber(params.x) * Math.round(screenScale);
  const y = sanitizeNumber(params.y) * Math.round(screenScale);
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

async function runComScript(
  scriptName: string,
  args: string[],
  timeoutMs = 20000,
): Promise<ToolResult> {
  const scriptPath = path.join(getScriptsDir(), scriptName);
  if (!fs.existsSync(scriptPath)) {
    return { text: `(script not found: ${scriptName})` };
  }
  try {
    const { stdout, stderr } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      ...args,
    ], { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 });
    // Last non-empty line is the JSON result
    const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] || '';
    try {
      const parsed = JSON.parse(lastLine);
      if (parsed.ok === false) return { text: `Error: ${parsed.error}` };
      return { text: JSON.stringify(parsed) };
    } catch {
      // Not JSON — return raw output (shouldn't happen normally)
      return { text: stdout.trim() || stderr.trim() || '(no output)' };
    }
  } catch (err) {
    return { text: `(com script error: ${err instanceof Error ? err.message : String(err)})` };
  }
}

async function createReminder(params: Record<string, unknown>): Promise<ToolResult> {
  const title = String(params.title || '').substring(0, 100);
  const datetime = String(params.datetime || '');
  const notes = String(params.notes || '').substring(0, 200);
  if (!title || !datetime) return { text: 'Error: title and datetime are required' };
  const result = await runComScript('com-create-reminder.ps1', [
    '-title', title, '-datetime', datetime, '-notes', notes,
  ], 15000);
  if (result.text.startsWith('Error:')) return result;
  try {
    const r = JSON.parse(result.text);
    return { text: `Reminder set! "${title}" will appear at ${r.scheduledFor} (task: ${r.taskName})` };
  } catch { return result; }
}

async function readFile(params: Record<string, unknown>): Promise<ToolResult> {
  const filePath = String(params.path || '');
  if (!filePath) return { text: 'Error: path is required' };
  const result = await runComScript('com-read-file.ps1', ['-path', filePath], 10000);
  if (result.text.startsWith('Error:')) return result;
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
  const result = await runComScript('com-write-file.ps1', [
    '-path', filePath, '-content', content, '-mode', mode,
  ], 10000);
  if (result.text.startsWith('Error:')) return result;
  try {
    const r = JSON.parse(result.text);
    return { text: `File written: ${r.path} (${r.bytesWritten} bytes, mode=${r.mode})` };
  } catch { return result; }
}

async function runPowershell(params: Record<string, unknown>): Promise<ToolResult> {
  const script = String(params.script || '');
  if (!script) return { text: 'Error: script is required' };
  const result = await runComScript('com-run-powershell.ps1', ['-script', script], 20000);
  if (result.text.startsWith('Error:')) return result;
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
  const result = await runComScript('com-speak-text.ps1', ['-text', text, '-rate', rate], 5000);
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
  if (params.headers) args.push('-headers', String(params.headers));
  if (params.body) args.push('-body', String(params.body));
  const result = await runComScript('com-http-request.ps1', args, 20000);
  return result;
}

// ── Tier 2: Office COM ───────────────────────────────────────────

async function outlookSendEmail(params: Record<string, unknown>): Promise<ToolResult> {
  const to = String(params.to || '');
  const subject = String(params.subject || '');
  const body = String(params.body || '');
  if (!to || !subject || !body) return { text: 'Error: to, subject, and body are required' };
  const args = ['-to', to, '-subject', subject, '-body', body];
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
  const args = ['-subject', subject, '-start', start];
  if (params.durationMin !== undefined) args.push('-durationMin', String(Number(params.durationMin) || 30));
  if (params.attendees) args.push('-attendees', String(params.attendees));
  if (params.location) args.push('-location', String(params.location));
  if (params.body) args.push('-body', String(params.body));
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
      log.warn('CDP browser spawn failed', String(err));
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
      return { text: `(cdp_connect: ${result.error}. Auto-launch failed: ${spawned.error})` };
    }
    result = await client.connect();
    if (!result.ok) return { text: `(cdp_connect: still failed after launching browser: ${result.error})` };
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
};

// ── Public API ───────────────────────────────────────────────────

let initialized = false;

export async function initTools(): Promise<void> {
  if (initialized) return;
  log.info('Initializing direct tools...');
  try {
    await detectScreenScale();
  } catch (err) {
    log.warn('Screen scale detection failed', String(err));
  }
  // PSBridge warmup is SLOW (~12s on fresh Windows installs) and blocking
  // it here makes Clippy show nothing for ~12s after click-to-launch. Start
  // it in the background and let psCommand() fall back to one-off PowerShell
  // calls until the bridge reports READY. Users get a responsive app now;
  // per-call overhead of one-off PS is ~100-500ms until warmup completes.
  startPSBridge().catch((err) => {
    log.warn('PSBridge startup failed — using fallback one-off PowerShell calls', String(err));
  });
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
    log.error(`Tool ${tool} failed (${elapsed}ms)`, String(err));
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
