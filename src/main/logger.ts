import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_DIR = path.join(os.homedir(), '.clippyai', 'logs');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB per file
const MAX_LOG_FILES = 5;
const MAX_DATA_LENGTH = 1000;

let logStream: fs.WriteStream | null = null;
let currentLogPath = '';
// Production default: INFO. Dev (electron-vite dev): DEBUG.
let minLevel: LogLevel = app?.isPackaged ? 'INFO' : 'DEBUG';

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: '\x1b[90m',  // grey
  INFO: '\x1b[36m',   // cyan
  WARN: '\x1b[33m',   // yellow
  ERROR: '\x1b[31m',  // red
};

// ── PII scrubbing ───────────────────────────────────────────────────

const USERNAME = os.userInfo().username;
const HOME_DIR = os.homedir();
// Match common sensitive patterns
const PII_PATTERNS: Array<[RegExp, string]> = [
  // Absolute paths containing the username → replace with ~
  [new RegExp(HOME_DIR.replace(/\\/g, '\\\\'), 'gi'), '~'],
  [new RegExp(HOME_DIR.replace(/\\/g, '/'), 'gi'), '~'],
  // Username in isolation
  [new RegExp(`\\b${USERNAME}\\b`, 'gi'), '<user>'],
  // Email addresses
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>'],
  // License keys (format: CLIP-XXXX-XXXX-XXXX-XXXX)
  [/CLIP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/gi, 'CLIP-****-****-****-****'],
];

export function scrubPII(text: string): string {
  let result = text;
  for (const [pattern, replacement] of PII_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ── Log infrastructure ──────────────────────────────────────────────

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFileName(): string {
  const date = new Date().toISOString().split('T')[0];
  return `clippy-${date}.log`;
}

function rotateIfNeeded(): void {
  if (!currentLogPath) return;
  try {
    const stats = fs.statSync(currentLogPath);
    if (stats.size > MAX_LOG_SIZE) {
      if (logStream) { logStream.end(); logStream = null; }
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const from = `${currentLogPath}.${i}`;
        const to = `${currentLogPath}.${i + 1}`;
        if (fs.existsSync(from)) {
          if (i === MAX_LOG_FILES - 1) fs.unlinkSync(from);
          else fs.renameSync(from, to);
        }
      }
      fs.renameSync(currentLogPath, `${currentLogPath}.1`);
      openLogStream();
    }
  } catch { /* file might not exist yet */ }
}

function openLogStream(): void {
  ensureLogDir();
  currentLogPath = path.join(LOG_DIR, getLogFileName());
  logStream = fs.createWriteStream(currentLogPath, { flags: 'a' });
}

// ── Structured JSON log line ────────────────────────────────────────

interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  data?: unknown;
  // v0.11.28 — task correlation id propagated by .child({task_id}) so a single
  // user request can be traced across brain → tools → script log lines.
  task_id?: string;
  // v0.11.28 — 'main' (default) or 'renderer' (forwarded via IPC bridge).
  source?: 'main' | 'renderer';
}

/**
 * Serialize an error to a structured object that survives JSON.stringify.
 * Replaces ad-hoc String(err) / err.message log sites — those drop the stack
 * and any custom fields. Use this for every catch-block that logs.
 */
export function serializeErr(err: unknown): {
  message: string;
  name?: string;
  stack?: string;
  code?: string | number;
  cause?: unknown;
} {
  if (err instanceof Error) {
    const out: ReturnType<typeof serializeErr> = {
      message: err.message,
      name: err.name,
      stack: err.stack?.split('\n').slice(0, 12).join('\n'),
    };
    const code = (err as Error & { code?: string | number }).code;
    if (code !== undefined) out.code = code;
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause !== undefined) out.cause = cause instanceof Error ? serializeErr(cause) : cause;
    return out;
  }
  if (typeof err === 'string') return { message: err };
  try { return { message: JSON.stringify(err) }; }
  catch { return { message: '[unserializable error]' }; }
}

function truncateData(data: unknown): unknown {
  if (data === undefined) return undefined;
  try {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (str.length > MAX_DATA_LENGTH) {
      return typeof data === 'string'
        ? str.substring(0, MAX_DATA_LENGTH) + '…'
        : JSON.parse(str.substring(0, MAX_DATA_LENGTH) + '"}'); // best-effort
    }
    return data;
  } catch {
    // If we can't serialize, return a safe placeholder
    if (data instanceof Error) return { error: data.message, stack: data.stack?.substring(0, 300) };
    return '[unserializable]';
  }
}

// v0.11.28 — current task id, set by brain.beginTask() / endTask().
// Brain enforces single in-flight task (isExecuting flag), so this is race-free.
// Tools, scripts, anything triggered from inside a task picks it up automatically.
let currentTaskId: string | undefined;
export function setCurrentTaskId(id: string | undefined): void { currentTaskId = id; }
export function getCurrentTaskId(): string | undefined { return currentTaskId; }

function writeLog(
  level: LogLevel,
  component: string,
  message: string,
  data?: unknown,
  ctx?: { task_id?: string; source?: 'main' | 'renderer' },
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg: message,
  };

  // Explicit ctx.task_id wins; otherwise inherit the active task id (if any).
  const taskId = ctx?.task_id ?? currentTaskId;
  if (taskId) entry.task_id = taskId;
  if (ctx?.source) entry.source = ctx.source;

  if (data !== undefined) {
    entry.data = truncateData(data);
  }

  // ── File output: structured JSON (one object per line) ──────────
  if (!logStream) openLogStream();
  try {
    const jsonLine = scrubPII(JSON.stringify(entry));
    logStream!.write(jsonLine + '\n');
  } catch {
    // Fallback: at least write something
    logStream!.write(`${entry.ts} [${level}] [${component}] ${scrubPII(message)}\n`);
  }

  // ── Console output: colored human-readable (dev convenience) ────
  const reset = '\x1b[0m';
  const color = LEVEL_COLORS[level];
  const consoleMsg = `${color}[${level}]${reset} [${component}] ${message}`;
  if (level === 'ERROR') console.error(consoleMsg, data !== undefined ? data : '');
  else if (level === 'WARN') console.warn(consoleMsg, data !== undefined ? data : '');
  else console.log(consoleMsg, data !== undefined ? data : '');

  rotateIfNeeded();
}

// ── Public API ──────────────────────────────────────────────────────

export interface Logger {
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
  /** Returns a new logger that injects task_id (and optional source override) into every line. */
  child: (ctx: { task_id?: string; source?: 'main' | 'renderer' }) => Logger;
}

function makeLogger(component: string, ctx?: { task_id?: string; source?: 'main' | 'renderer' }): Logger {
  return {
    debug: (message: string, data?: unknown) => writeLog('DEBUG', component, message, data, ctx),
    info: (message: string, data?: unknown) => writeLog('INFO', component, message, data, ctx),
    warn: (message: string, data?: unknown) => writeLog('WARN', component, message, data, ctx),
    error: (message: string, data?: unknown) => writeLog('ERROR', component, message, data, ctx),
    child: (extra) => makeLogger(component, { ...ctx, ...extra }),
  };
}

export function createLogger(component: string): Logger {
  return makeLogger(component);
}

/**
 * Direct entry-point used by the renderer→main IPC bridge (preload).
 * Lets renderer-side errors and warnings land in the same JSONL file.
 */
export function ingestRendererLog(
  level: LogLevel,
  component: string,
  message: string,
  data?: unknown,
  task_id?: string,
): void {
  writeLog(level, component, message, data, { task_id, source: 'renderer' });
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function getLogLevel(): LogLevel {
  return minLevel;
}

export function getLogDir(): string {
  return LOG_DIR;
}

/**
 * Delete log files older than 24 hours. Call at app startup.
 */
export function cleanOldLogs(): void {
  ensureLogDir();
  try {
    const files = fs.readdirSync(LOG_DIR);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const file of files) {
      const fullPath = path.join(LOG_DIR, file);
      if (!file.startsWith('clippy-')) continue;
      if (!file.endsWith('.log') && !/\.log\.\d+$/.test(file)) continue;
      try {
        const stats = fs.statSync(fullPath);
        if (stats.mtimeMs < cutoff) fs.unlinkSync(fullPath);
      } catch { /* skip files we can't stat */ }
    }
  } catch { /* log dir might not exist yet */ }
}

// Initialize on import
ensureLogDir();
