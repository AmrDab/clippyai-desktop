/**
 * Tier-5 fallback via clawdcursor subprocess.
 *
 * When in-process tools fail with structured codes (UI_NOT_FOUND, AX_ERROR,
 * TIMEOUT, BRIDGE_DEAD), retry the equivalent clawdcursor tool. clawdcursor
 * must be installed globally (npm i -g clawdcursor); if absent, this module
 * logs once and stays disabled — Clippy boots and runs normally without it.
 *
 * Lifecycle:
 *   - startClawd(): spawns `clawdcursor agent --no-llm --port 3847 --accept`,
 *     waits for ready signal on stdout, reads bearer token from
 *     ~/.clawdcursor/token. Non-blocking.
 *   - On unexpected exit: rate-limited respawn (max 3 / 60s).
 *   - stopClawd(): SIGTERM, 2s grace, SIGKILL fallback.
 *
 * v1.5.x protocol: MCP JSON-RPC at POST /mcp
 *   Request: {"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}
 *   Headers: Content-Type: application/json, Accept: application/json, text/event-stream
 *   Response: {"result":{"content":[{"type":"text","text":"..."}]},"jsonrpc":"2.0","id":N}
 */

import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
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

// v1.5.x — fixed port (default for `clawdcursor agent`). Using a fixed
// port avoids having to parse it from stdout (which broke with --port 0
// because the OS-assigned port never appeared in the log line).
const CLAWD_PORT = 3847;

// JSON-RPC id counter — monotonically increasing per process lifetime.
let rpcId = 0;

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
 * Mappings derived from clawdcursor's tool registry (on macOS the global
 * install lives under the npm prefix, e.g.
 * /usr/local/lib/node_modules/clawdcursor/dist/tools/*.js or
 * ~/.npm-global/...). Only tools with genuinely matching semantics are mapped.
 *
 * NOT mapped (intentional):
 *   - macOS app-scripting tools (mail_*, calendar_*, reminders_*): these go
 *     through AppleScript/Apple Events in-process; falling back to blind UI
 *     clicks is worse than surfacing the AppleScript error.
 *   - File tools (read_file, write_file, list_files, search_files_content):
 *     no clawdcursor equivalent; the in-process Node fs is authoritative.
 *   - System tools (system_info, list_processes, kill_process, ping_host,
 *     http_request, run_shell): no equivalent or no benefit from a
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
    // v0.20.0 — `where` is Windows-only; on macOS/Linux it doesn't exist, so
    // detection ALWAYS failed (silently disabling the Tier-5 fallback). Use the
    // platform-correct locator: `where` on Windows, `command -v` elsewhere.
    const [bin, args] = process.platform === 'win32'
      ? ['where', ['clawdcursor']]
      : ['/bin/sh', ['-c', 'command -v clawdcursor']];
    const { stdout } = await execFileAsync(bin as string, args as string[], { timeout: 3000 });
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

/**
 * v0.12.3 — generate a fresh per-session bearer token and write it to the
 * token file BEFORE clawdcursor reads it at startup. Per security audit
 * finding #4: previously the token was static (set once at clawdcursor
 * install via `consent --accept`) and the file was world-readable for the
 * current user. Any other local process running as the same user could
 * read it and drive Clippy's UI primitives.
 *
 * Per-session rotation means a leaked token is invalid the moment Clippy
 * restarts (or stopClawd is called). Combined with the file-permission
 * tightening below, the attack surface is materially smaller.
 *
 * Returns the new token (or null if write failed — clawd uses the prior
 * token in that case, which is the previous behavior, so this is graceful).
 */
function rotateToken(): string | null {
  try {
    const dir = path.dirname(TOKEN_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const token = randomBytes(32).toString('hex');
    // Atomic write: tmp file + rename so a concurrent reader never sees
    // a partial token.
    const tmp = TOKEN_PATH + '.tmp';
    fs.writeFileSync(tmp, token, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, TOKEN_PATH);
    // Best-effort: tighten the Windows ACL to the current user only. icacls is
    // Windows-only — on macOS/Linux the file is already created mode 0o600 above,
    // so skip it (previously it ENOENT'd on every startup on non-Windows).
    if (process.platform === 'win32') {
      try {
        const username = os.userInfo().username;
        execFile('icacls', [TOKEN_PATH, '/inheritance:r', '/grant', `${username}:F`], { timeout: 3000 }, (err) => {
          if (err) log.warn('clawd token icacls failed (non-fatal)', { err: serializeErr(err) });
        });
      } catch (err) {
        log.warn('clawd token icacls spawn failed (non-fatal)', { err: serializeErr(err) });
      }
    }
    return token;
  } catch (err) {
    log.warn('clawd token rotation failed — falling back to existing token', { err: serializeErr(err) });
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

  // v0.12.3 — rotate the bearer token to a fresh per-session value BEFORE
  // spawning clawd, so the file it reads at startup contains a token that
  // wasn't valid for any prior session. If rotation fails (disk full,
  // permission), we still spawn — clawd uses whatever's already on disk
  // (graceful degradation matching pre-v0.12.3 behavior).
  const rotatedToken = rotateToken();
  if (rotatedToken) log.info('clawd token rotated for this session');

  let resolved = false;
  let stdoutBuf = '';
  let stderrBuf = '';
  let readyTimer: NodeJS.Timeout | null = null;

  // v1.5.x: verb changed from `serve` to `agent`; REST removed, only MCP
  // JSON-RPC at POST /mcp. Fixed port avoids the --port 0 bug where stdout
  // printed "http://127.0.0.1:0" literally instead of the actual OS port.
  const child = spawn(binaryPath, ['agent', '--no-llm', '--port', String(CLAWD_PORT), '--accept'], {
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
    if (stdoutBuf.length > 4000) stdoutBuf = stdoutBuf.slice(-4000);
    // v1.5.x ready signal: "desktop control active on 127.0.0.1:<PORT>" or
    // the legacy "Tool server: http://127.0.0.1:<PORT>". Either way we use
    // the fixed CLAWD_PORT — no parsing needed.
    if (handle === null && /desktop control active|Tool server/i.test(stdoutBuf)) {
      const token = readToken();
      if (!token) {
        finalize(false, 'token file missing after ready signal');
        return;
      }
      handle = { port: CLAWD_PORT, token, pid: child.pid || -1 };
      installed = true;
      log.info('clawdcursor ready', { port: CLAWD_PORT, pid: child.pid });
      finalize(true);
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
  // v1.5.x: no /health endpoint — probe with a lightweight tools/list call.
  return new Promise<boolean>((resolve) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: h.port,
        path: '/mcp',
        method: 'POST',
        timeout: 2000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Accept': 'application/json, text/event-stream',
          Authorization: `Bearer ${h.token}`,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

export async function callClawdTool(
  name: string,
  params: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<ToolResult> {
  const h = handle;
  if (!h) return { text: `(error:CLAWD_FAILED) clawdcursor not ready` };

  // v1.5.x MCP JSON-RPC protocol. REST /execute/:name removed.
  return new Promise<ToolResult>((resolve) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name, arguments: params || {} },
    });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: h.port,
        path: '/mcp',
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          // Required by clawdcursor v1.5.x — server rejects without this Accept header.
          'Accept': 'application/json, text/event-stream',
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
            const parsed = JSON.parse(raw) as {
              result?: { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
              error?: { code?: number; message?: string };
            };
            if (parsed.error) {
              resolve({ text: `(error:CLAWD_FAILED) ${parsed.error.message || JSON.stringify(parsed.error)}` });
              return;
            }
            const content = parsed.result?.content ?? [];
            const textPart = content.find((c) => c.type === 'text');
            const imagePart = content.find((c) => c.type === 'image' && c.data);
            resolve({
              text: textPart?.text ?? raw,
              ...(imagePart ? { image: { data: imagePart.data!, mimeType: imagePart.mimeType ?? 'image/png' } } : {}),
            });
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

/**
 * v0.13.0 — submit a plain-English task to clawd-cursor's `/task` endpoint.
 * Per the OpenClaw integration recommendations: this is L4 — only used when
 * L1 (native), L2 (browser-direct), and L3 (downloaded skill) all fail or
 * don't fit. clawd-cursor's agent runs the task internally; we poll for
 * completion via `/task-status` or rely on returnPartial mode.
 *
 * Args:
 *   task — short imperative sentence ("Open Notepad and write Hello")
 *   appHint — optional process name to focus first (e.g. "olk", "msedge")
 *   timeoutMs — overall budget; default 120s
 *
 * Returns: ToolResult with text=summary or (error:CLAWD_TASK_FAILED).
 */
export async function submitClawdTask(
  task: string,
  opts: { appHint?: string; timeoutMs?: number } = {},
): Promise<ToolResult> {
  const h = handle;
  if (!h) return { text: '(error:CLAWD_FAILED) clawdcursor not ready. Install: npm i -g clawdcursor && clawdcursor consent --accept' };
  if (!task || task.trim().length === 0) return { text: '(error:MISSING_TASK) task description is required' };
  const timeoutMs = opts.timeoutMs ?? 120_000;

  // v1.5.x: POST /task removed. Delegate via MCP `submit_task` tool.
  // Note: submit_task requires the clawdcursor agent to be started WITH an
  // LLM backend. When started with --no-llm (tools-only mode), the agent
  // will reject submit_task with an error — that error is surfaced back
  // to the caller rather than failing silently.
  return new Promise<ToolResult>((resolve) => {
    const reqBody = JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: {
        name: 'submit_task',
        arguments: {
          task: task.trim(),
          timeout: Math.floor(timeoutMs / 1000),
          ...(opts.appHint ? { app: opts.appHint } : {}),
        },
      },
    });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: h.port,
        path: '/mcp',
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(reqBody),
          'Accept': 'application/json, text/event-stream',
          Authorization: `Bearer ${h.token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== undefined && res.statusCode >= 400) {
            resolve({ text: `(error:CLAWD_TASK_FAILED) HTTP ${res.statusCode}: ${raw.slice(0, 300)}` });
            return;
          }
          try {
            const parsed = JSON.parse(raw) as {
              result?: { content?: Array<{ type: string; text?: string }> };
              error?: { code?: number; message?: string };
            };
            if (parsed.error) {
              resolve({ text: `(error:CLAWD_TASK_FAILED) ${parsed.error.message || JSON.stringify(parsed.error)}` });
              return;
            }
            const content = parsed.result?.content ?? [];
            const textPart = content.find((c) => c.type === 'text');
            resolve({ text: textPart?.text ?? raw.slice(0, 1500) });
          } catch {
            resolve({ text: raw.slice(0, 1500) });
          }
        });
      },
    );
    req.on('error', (err) => {
      resolve({ text: `(error:CLAWD_TASK_FAILED) ${err.message}` });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ text: `(error:CLAWD_TASK_FAILED) request timed out after ${timeoutMs}ms` });
    });
    req.write(reqBody);
    req.end();
  });
}
