import fs from 'fs';
import os from 'os';
import path from 'path';
import { app, net } from 'electron';
import { createLogger } from './logger';
import { spawn } from 'child_process';

const log = createLogger('ClawdBridge');
const BASE_URL = 'http://127.0.0.1:3847';
const TOKEN_PATH = path.join(os.homedir(), '.clawdcursor', 'token');

// Cache token for 30 seconds to avoid sync I/O on every tool call
let cachedToken = '';
let tokenCacheTime = 0;
const TOKEN_CACHE_TTL = 30_000;

function getToken(): string {
  if (cachedToken && Date.now() - tokenCacheTime < TOKEN_CACHE_TTL) {
    return cachedToken;
  }
  try {
    cachedToken = fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
    tokenCacheTime = Date.now();
    return cachedToken;
  } catch {
    log.warn('Could not read ClawdCursor token', TOKEN_PATH);
    return '';
  }
}

function headers(): Record<string, string> {
  const token = getToken();
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function request(url: string, options: { method: string; headers: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: options.method });
    for (const [key, val] of Object.entries(options.headers)) {
      req.setHeader(key, val);
    }
    req.on('response', (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk.toString(); });
      response.on('end', () => {
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          text: async () => data,
          json: async () => JSON.parse(data),
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

export interface ToolResult {
  text: string;
  image?: { data: string; mimeType: string };
}

export async function executeTool(tool: string, params: Record<string, unknown> = {}): Promise<ToolResult> {
  log.info(`executeTool: ${tool}`, params);
  const startTime = Date.now();
  const res = await request(`${BASE_URL}/execute/${tool}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(params),
  });
  const elapsed = Date.now() - startTime;
  if (!res.ok) {
    const body = await res.text();
    log.error(`executeTool ${tool} failed (${res.status}, ${elapsed}ms)`, body.substring(0, 300));
    throw new Error(`ClawdCursor tool '${tool}' failed (${res.status}): ${body}`);
  }
  const result = await res.json() as ToolResult;
  log.debug(`executeTool ${tool} ok (${elapsed}ms)`, result.text?.substring(0, 200));
  return result;
}

export async function takeScreenshot(): Promise<ToolResult> {
  return executeTool('desktop_screenshot');
}

export async function getActiveWindow(): Promise<ToolResult> {
  return executeTool('get_active_window');
}

export async function isClawdCursorRunning(): Promise<boolean> {
  try {
    const res = await request(`${BASE_URL}/health`, {
      method: 'GET',
      headers: headers(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve the ClawdCursor entry script and how to run it.
 *
 * In production, ClawdCursor is bundled inside the installer at:
 *   resources/clawdcursor/dist/index.js
 *
 * The Electron binary runs it via ELECTRON_RUN_AS_NODE=1, so the
 * installer doesn't need a separate Node.js runtime.
 *
 * In dev, we look for ./vendor/clawdcursor and run with regular `node`.
 */
function resolveClawdCursor(): { command: string; args: string[]; useElectronAsNode: boolean } {
  // Production: bundled under resources/clawdcursor/dist/index.js
  const bundled = path.join(process.resourcesPath || '', 'clawdcursor', 'dist', 'index.js');
  if (fs.existsSync(bundled)) {
    log.info('Using bundled ClawdCursor', bundled);
    return {
      command: process.execPath,
      args: [bundled, 'serve'],
      useElectronAsNode: true,
    };
  }

  // Dev: vendored copy alongside the repo
  const candidates = [
    path.join(app.getAppPath(), 'vendor', 'clawdcursor', 'dist', 'index.js'),
    path.join(app.getAppPath(), '..', 'vendor', 'clawdcursor', 'dist', 'index.js'),
    path.join(app.getAppPath(), '..', '..', 'vendor', 'clawdcursor', 'dist', 'index.js'),
    path.join(process.cwd(), 'vendor', 'clawdcursor', 'dist', 'index.js'),
  ];
  for (const vendored of candidates) {
    if (fs.existsSync(vendored)) {
      log.info('Using vendored ClawdCursor', vendored);
      return {
        command: 'node',
        args: [vendored, 'serve'],
        useElectronAsNode: false,
      };
    }
  }

  // Fallback: global install
  log.info('Using global ClawdCursor from PATH');
  return { command: 'clawdcursor', args: ['serve'], useElectronAsNode: false };
}

// Single restart function — prevents multiple instances
let isRestarting = false;
export async function restartClawdCursor(): Promise<void> {
  if (isRestarting) return;
  isRestarting = true;

  log.info('Restarting ClawdCursor serve...');
  try {
    const resolved = resolveClawdCursor();
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (resolved.useElectronAsNode) {
      env.ELECTRON_RUN_AS_NODE = '1';
    } else {
      delete env.ELECTRON_RUN_AS_NODE;
    }
    const proc = spawn(resolved.command, resolved.args, {
      detached: true,
      stdio: 'ignore',
      // shell: true is needed for the global PATH lookup; node/electron paths are absolute
      shell: resolved.command === 'clawdcursor',
      windowsHide: true,
      env,
    });
    proc.unref();
    log.info('ClawdCursor process spawned', { pid: proc.pid, command: resolved.command });

    // Wait for it to be ready (poll health endpoint)
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const running = await isClawdCursorRunning();
      if (running) {
        log.info(`ClawdCursor is ready after ${i + 1}s`);
        isRestarting = false;
        return;
      }
    }
    log.error('ClawdCursor failed to start within 15 seconds');
  } catch (err) {
    log.error('Failed to restart ClawdCursor', err);
  }
  isRestarting = false;
}
