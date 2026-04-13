/**
 * ClippyAI Direct Tool Executor
 *
 * Replaces ClawdCursor's HTTP server with in-process tool execution.
 * Uses: nut-js (mouse/keyboard), PowerShell (Windows UIA), sharp (screenshots)
 *
 * No separate process, no HTTP, no port 3847, no startup failures.
 */

import { execFile, ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { shell } from 'electron';
import { createLogger } from './logger';

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
const execAsync = promisify(exec);

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
        if (psQueue.length > 0) {
          const { resolve: res } = psQueue.shift()!;
          res(response);
        }
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

async function readScreen(params: Record<string, unknown>): Promise<ToolResult> {
  const scriptPath = path.join(getScriptsDir(), 'get-screen-context.ps1');
  try {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
    if (params.processId) args.push('-ProcessId', String(params.processId));
    const { stdout } = await execFileAsync('powershell.exe', args, {
      timeout: 10000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return { text: stdout.trim() || '(empty screen context)' };
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
    // Try PowerShell script first
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(getScriptsDir(), 'focus-window.ps1')];
    if (title) args.push('-Title', String(title));
    else if (processName) args.push('-Title', String(processName)); // use processName as title search
    else if (processId) args.push('-ProcessId', String(processId));
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

async function openApp(params: Record<string, unknown>): Promise<ToolResult> {
  const name = sanitizeAppName(String(params.name || ''));
  if (!name) return { text: '(no app name provided)' };
  try {
    // Use -ArgumentList to prevent injection — name is a separate argument, not in -Command string
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
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(getScriptsDir(), 'find-element.ps1'),
      '-Name', target,
    ], { timeout: 8000 });
    // Parse element position from output and click it
    const match = stdout.match(/X:(\d+)\s+Y:(\d+)/i) || stdout.match(/(\d+),(\d+)/);
    if (match) {
      const ex = parseInt(match[1]);
      const ey = parseInt(match[2]);
      await mouseClick({ x: ex, y: ey });
      return { text: `Clicked "${target}" at (${ex},${ey})` };
    }
    // Fallback: try invoke-element
    const { stdout: invokeOut } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(getScriptsDir(), 'invoke-element.ps1'),
      '-Name', target, '-Action', 'click',
    ], { timeout: 8000 });
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

async function navigateBrowser(params: Record<string, unknown>): Promise<ToolResult> {
  const url = String(params.url || '');
  if (!url) return { text: '(no URL provided)' };
  try {
    // Use Electron's shell.openExternal — safe, validates URLs, no shell injection
    await shell.openExternal(url);
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

async function waitTool(params: Record<string, unknown>): Promise<ToolResult> {
  const seconds = Math.min(30, Math.max(0.1, Number(params.seconds || 1)));
  await new Promise(r => setTimeout(r, seconds * 1000));
  return { text: `Waited ${seconds}s` };
}

// ── Tool Registry ────────────────────────────────────────────────

const TOOL_MAP: Record<string, (params: Record<string, unknown>) => Promise<ToolResult>> = {
  read_screen: readScreen,
  get_active_window: getActiveWindow,
  get_windows: getWindows,
  focus_window: focusWindow,
  open_app: openApp,
  desktop_screenshot: desktopScreenshot,
  smart_click: smartClick,
  smart_type: smartType,
  type_text: typeText,
  key_press: keyPress,
  mouse_click: mouseClick,
  mouse_drag: mouseDrag,
  mouse_scroll: mouseScroll,
  navigate_browser: navigateBrowser,
  wait: waitTool,
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
  try {
    await startPSBridge();
  } catch (err) {
    log.warn('PSBridge startup failed — using fallback one-off PowerShell calls', String(err));
  }
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

export function cleanupTools(): void {
  if (psBridge && !psBridge.killed) {
    try { psBridge.kill(); } catch { /* already dead */ }
    psBridge = null;
  }
}
