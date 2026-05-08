/**
 * Tier-5 fallback via clawdcursor subprocess.
 *
 * When in-process tools fail with structured codes (UI_NOT_FOUND, COM_ERROR,
 * TIMEOUT, PSBRIDGE_DEAD), retry the equivalent clawdcursor tool. clawdcursor
 * must be installed globally (npm i -g clawdcursor); if absent, this module
 * logs once and stays disabled — Clippy boots and runs normally without it.
 *
 * Lifecycle:
 *   - startClawd(): spawns `clawdcursor serve --port 0`, parses port from
 *     stdout, reads bearer token from ~/.clawdcursor/token. Non-blocking.
 *   - On unexpected exit: rate-limited respawn (max 3 / 60s).
 *   - stopClawd(): SIGTERM, 2s grace, SIGKILL fallback.
 */

import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Notification } from 'electron';
import { createLogger, serializeErr } from './logger';
import type { ToolResult } from './types/tool-result';

const log = createLogger('Clawd');
const execFileAsync = promisify(execFile);

export interface ClawdHandle {
  port: number;
  token: string;
  pid: number;
}

let handle: ClawdHandle | null = null;
let proc: ChildProcess | null = null;
let installed: boolean | null = null;
let binaryPath: string | null = null;
let respawns: number[] = [];
let intentionalStop = false;
let consentNoticeShown = false;
let unavailableLogged = false;
const MAX_RESPAWNS_60S = 3;

const TOKEN_PATH = path.join(os.homedir(), '.clawdcursor', 'token');

/**
 * Map of in-process tool names → clawdcursor tool names where an equivalent
 * exists.
 *
 * Mappings derived from clawdcursor's tool registry (see
 * ~/AppData/Roaming/npm/node_modules/clawdcursor/dist/tools/*.js). Only tools
 * with genuinely matching semantics are mapped.
 *
 * NOT mapped (intentional):
 *   - COM tools (outlook_*, excel_*, word_to_pdf, create_reminder): clawdcursor
 *     has no COM bridge; falling back to UI clicks for Outlook is worse than
 *     surfacing the COM error.
 *   - File tools (read_file, write_file, list_files, search_files_content):
 *     no clawdcursor equivalent; the in-process Node fs is authoritative.
 *   - System tools (system_info, list_processes, kill_process, ping_host,
 *     http_request, run_powershell): no equivalent or no benefit from a
 *     subprocess hop.
 *   - Agent loop (plan): clippy-internal.
 *   - Speech (speak_text): no clawdcursor counterpart.
 *   - Window management nuances (minimize_all_windows, show_desktop): no
 *     direct counterpart; minimize_window IS mapped.
 *   - cdp_* tools: clippy already owns the CDP client (Tier 0); a second
 *     CDP attach would conflict.
 *   - detect_webview_apps: in-process is authoritative.
 *   - desktop_screenshot: in-process via sharp is fast and sufficient.
 *
 * Mapped (equivalent semantics):
 */
export const TIER5_FALLBACK_MAP: Record<string, string> = {
  // UI-automation primitives — exact name match, exact semantics
  smart_click: 'smart_click',
  smart_type: 'smart_type',
  smart_read: 'smart_read',
  read_screen: 'read_screen',
  get_active_window: 'get_active_window',
  get_windows: 'get_windows',
  get_focused_element: 'get_focused_element',
  focus_window: 'focus_window',
  minimize_window: 'minimize_window',
  // Mouse/keyboard primitives — clawdcursor uses nut-js too, but if our
  // in-process call hit a UI_NOT_FOUND from a coordinate-resolver miss,
  // clawdcursor's a11y reasoner may resolve the same intent differently.
  mouse_click: 'mouse_click',
  mouse_double_click: 'mouse_double_click',
  mouse_right_click: 'mouse_right_click',
  mouse_hover: 'mouse_hover',
  mouse_drag: 'mouse_drag',
  mouse_scroll: 'mouse_scroll',
  type_text: 'type_text',
  key_press: 'key_press',
  // OCR — clawdcursor has its own OCR pipeline that may succeed on inputs
  // ours fails on.
  ocr_read_screen: 'ocr_read_screen',
};

export function isClawdReady(): boolean {
  return handle !== null;
}

export function getClawdHandle(): ClawdHandle | null {
  return handle;
}

export function isClawdInstalled(): boolean | null {
  return installed;
}

async function detectBinary(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('where', ['clawdcursor'], { timeout: 3000 });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
    return first || null;
  } catch {
    return null;
  }
}

function readToken(): string | null {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const raw = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

function showConsentNotice(): void {
  if (consentNoticeShown) return;
  consentNoticeShown = true;
  try {
    const n = new Notification({
      title: 'Tier 5 fallback disabled',
      body: 'Run `clawdcursor consent --accept` once to enable desktop UI fallback.',
      silent: true,
    });
    n.show();
  } catch (err) {
    log.warn('Failed to show consent notification', serializeErr(err));
  }
}

export async function startClawd(): Promise<void> {
  if (handle || proc) return; // already running
  if (installed === false) return; // already known absent

  if (!binaryPath) {
    binaryPath = await detectBinary();
    if (!binaryPath) {
      installed = false;
      if (!unavailableLogged) {
        log.info('clawdcursor not installed — Tier 5 fallback disabled (install with: npm i -g clawdcursor)');
        unavailableLogged = true;
      }
      return;
    }
  }

  intentionalStop = false;

  let resolved = false;
  let detectedPort: number | null = null;
  let stdoutBuf = '';
  let stderrBuf = '';
  let readyTimer: NodeJS.Timeout | null = null;

  const child = spawn(binaryPath, ['serve', '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc = child;

  const finalize = (ok: boolean, reason?: string) => {
    if (resolved) return;
    resolved = true;
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    if (!ok) {
      installed = false;
      log.warn('clawdcursor failed to start — Tier 5 disabled', { reason, stderr: stderrBuf.slice(0, 500) });
      // Heuristic: consent missing typically prints "consent" in stderr.
      if (/consent/i.test(stderrBuf)) showConsentNotice();
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      proc = null;
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    if (detectedPort === null) {
      // clawdcursor logs: "Tool server: http://127.0.0.1:<PORT>"
      const m = stdoutBuf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        detectedPort = Number(m[1]);
        const token = readToken();
        if (!token) {
          finalize(false, 'token file missing');
          return;
        }
        handle = { port: detectedPort, token, pid: child.pid || -1 };
        installed = true;
        log.info('clawdcursor ready', { port: detectedPort, pid: child.pid });
        finalize(true);
      }
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
  });

  child.on('error', (err) => {
    finalize(false, `spawn error: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    if (!resolved) {
      finalize(false, `exited before ready (code=${code}, signal=${signal})`);
      return;
    }
    handle = null;
    proc = null;
    if (intentionalStop) {
      log.info('clawdcursor stopped (intentional)');
      return;
    }
    log.warn('clawdcursor exited unexpectedly', { code, signal });
    // Rate-limited respawn
    const now = Date.now();
    respawns = respawns.filter((t) => now - t < 60_000);
    if (respawns.length >= MAX_RESPAWNS_60S) {
      log.error('clawdcursor respawn rate limit hit — staying disabled');
      installed = false;
      return;
    }
    respawns.push(now);
    setTimeout(() => {
      startClawd().catch((err) => log.warn('respawn failed', serializeErr(err)));
    }, 1000);
  });

  // 10s ready timeout
  readyTimer = setTimeout(() => {
    finalize(false, 'ready timeout (10s)');
  }, 10_000);
}

export async function stopClawd(): Promise<void> {
  intentionalStop = true;
  const p = proc;
  if (!p || p.killed) {
    handle = null;
    proc = null;
    return;
  }
  try {
    p.kill('SIGTERM');
  } catch { /* already dead */ }

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    p.once('exit', finish);
    setTimeout(() => {
      if (!done) {
        try {
          if (p.pid) process.kill(p.pid, 'SIGKILL');
        } catch { /* already dead */ }
      }
      finish();
    }, 2000);
  });

  handle = null;
  proc = null;
}

export async function clawdHealth(): Promise<boolean> {
  const h = handle;
  if (!h) return false;
  return new Promise<boolean>((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: h.port,
        path: '/health',
        timeout: 1000,
        headers: { Authorization: `Bearer ${h.token}` },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function callClawdTool(
  name: string,
  params: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<ToolResult> {
  const h = handle;
  if (!h) return { text: `(error:CLAWD_FAILED) clawdcursor not ready` };

  return new Promise<ToolResult>((resolve) => {
    const body = JSON.stringify(params || {});
    const req = http.request(
      {
        host: '127.0.0.1',
        port: h.port,
        path: `/execute/${encodeURIComponent(name)}`,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${h.token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== undefined && res.statusCode >= 400) {
            resolve({ text: `(error:CLAWD_FAILED) HTTP ${res.statusCode}: ${raw.slice(0, 200)}` });
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            // clawdcursor returns either {text, image?} or {result}/{content}
            if (typeof parsed?.text === 'string') {
              resolve({ text: parsed.text, image: parsed.image });
              return;
            }
            if (typeof parsed?.result === 'string') {
              resolve({ text: parsed.result });
              return;
            }
            resolve({ text: raw });
          } catch {
            resolve({ text: raw });
          }
        });
      },
    );
    req.on('error', (err) => {
      resolve({ text: `(error:CLAWD_FAILED) ${err.message}` });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ text: `(error:CLAWD_FAILED) request timeout after ${timeoutMs}ms` });
    });
    req.write(body);
    req.end();
  });
}
