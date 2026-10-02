import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_DIR = path.join(os.homedir(), '.clippyai', 'logs');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB per file
const MAX_LOG_FILES = 5;
const MAX_DATA_LENGTH = 1000;

let logFileReady = false;
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
  // scrubPII runs on JSON.stringify output, where each Windows backslash is
  // doubled ("C:\\Users\\name") — match that form too or the home path
  // leaks through every structured line.
  [new RegExp(JSON.stringify(HOME_DIR).slice(1, -1).replace(/\\/g, '\\\\'), 'gi'), '~'],
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

// ── Tool-arg redaction (Phase 3 guardrails) ─────────────────────────
// Tool args carry typed text, message bodies, HTTP headers and the like.
// Never log them verbatim: secrets → '[redacted]', free text → its length,
// other strings → first 80 chars, nested objects → their keys only.

const SECRET_KEY_RE = /pass|token|secret|auth|cookie|api_?key|headers/i;
const FREE_TEXT_KEY_RE = /^(text|body|content|message|script|expression|html|notes)$/i;
const MAX_ARG_STRING = 80;

export function redactArgs(args: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!args || typeof args !== 'object') return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) { out[k] = '[redacted]'; continue; }
    if (FREE_TEXT_KEY_RE.test(k)) { out[k] = { len: typeof v === 'string' ? v.length : JSON.stringify(v ?? null).length }; continue; }
    if (typeof v === 'string') { out[k] = v.length > MAX_ARG_STRING ? v.substring(0, MAX_ARG_STRING) + '…' : v; continue; }
    if (v && typeof v === 'object') { out[k] = { keys: Object.keys(v as object) }; continue; }
    out[k] = v;
  }
  return out;
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
      // Drain anything still buffered into the soon-to-be-archived file first
      // so we don't split a line across the rotation boundary.
      flushBuffer();
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const from = `${currentLogPath}.${i}`;
        const to = `${currentLogPath}.${i + 1}`;
        if (fs.existsSync(from)) {
          if (i === MAX_LOG_FILES - 1) fs.unlinkSync(from);
          else fs.renameSync(from, to);
        }
      }
      fs.renameSync(currentLogPath, `${currentLogPath}.1`);
      openLogFile();
    }
  } catch { /* file might not exist yet */ }
}

function openLogFile(): void {
  ensureLogDir();
  currentLogPath = path.join(LOG_DIR, getLogFileName());
  logFileReady = true;
}

// ── Buffered write path (v0.20.0 perf) ──────────────────────────────
// Every log call used to do synchronous scrubPII(JSON.stringify(...)) and a
// fs.statSync rotate check inline. A long task emits ~160 lines → 50-200ms of
// synchronous overhead + a syscall per line. We now buffer already-formatted
// lines (scrubPII/JSON.stringify still runs per call, preserving the exact
// format and PII guarantee) and flush them in FIFO order on a single ~250ms
// timer, check rotation at most every ~30s, and flush synchronously on exit
// and on ERROR so a crash never drops the line that explains it.
//
// The flush uses fs.appendFileSync (not a WriteStream): the per-call hot path
// is now zero-I/O (push to an array), and the once-per-250ms drain is a single
// synchronous append. Synchronous append is what makes the crash-safety
// guarantee real — once flushBuffer() returns, the bytes are in the OS, so an
// 'exit'/fatal-error flush cannot leave the explaining line stuck in a stream
// buffer the way logStream.write() could.
const FLUSH_INTERVAL_MS = 250;
const ROTATE_CHECK_INTERVAL_MS = 30_000;

let pendingLines: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let rotateTimer: ReturnType<typeof setInterval> | null = null;
let lastRotateCheck = 0;
let exitHooksInstalled = false;

/**
 * Append all buffered lines to the current log file in order, then clear the
 * buffer. Ordering is preserved: single-threaded JS means no call can
 * interleave between the join and the reset, and we write the whole batch as
 * one synchronous append. Durable on return (survives an immediately-following
 * crash), so it's safe to call from exit/fatal paths.
 */
function flushBuffer(): void {
  if (pendingLines.length === 0) return;
  if (!logFileReady) openLogFile();
  // Detach the batch BEFORE the syscall so lines logged during/after the write
  // queue cleanly behind it instead of being dropped or duplicated.
  const chunk = pendingLines.join('');
  pendingLines = [];
  try {
    fs.appendFileSync(currentLogPath, chunk);
  } catch { /* dir vanished mid-shutdown — nothing more we can safely do */ }
}

/** Periodic + throttled rotate check, kept off the per-line hot path. */
function maybeRotate(force = false): void {
  const now = Date.now();
  if (!force && now - lastRotateCheck < ROTATE_CHECK_INTERVAL_MS) return;
  lastRotateCheck = now;
  rotateIfNeeded();
}

function flushAndCheckRotate(): void {
  flushBuffer();
  maybeRotate();
}

/** Ensure the 250ms flush timer + 30s rotate timer + exit hooks are armed. */
function ensureTimers(): void {
  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushAndCheckRotate();
      // Re-arm only if more lines arrived while we were flushing.
      if (pendingLines.length > 0) ensureTimers();
    }, FLUSH_INTERVAL_MS);
    // Don't keep the event loop (and thus the app) alive just for logging.
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }
  if (rotateTimer === null) {
    rotateTimer = setInterval(() => maybeRotate(true), ROTATE_CHECK_INTERVAL_MS);
    if (typeof rotateTimer.unref === 'function') rotateTimer.unref();
  }
  if (!exitHooksInstalled) {
    exitHooksInstalled = true;
    // CRITICAL crash-safety: drain the buffer synchronously on the way out so
    // a process exiting (clean or fatal) never drops the lines explaining why.
    // 'exit' fires for normal/most fatal terminations and must be synchronous.
    const drain = () => { flushBuffer(); };
    process.once('exit', drain);
    process.once('beforeExit', drain);
    process.once('SIGINT', () => { flushBuffer(); });
    process.once('SIGTERM', () => { flushBuffer(); });
  }
}

/**
 * Public flush hook (used by shutdown paths / tests). Drains buffered lines
 * and forces an immediate rotate check. Exported so callers that want a hard
 * guarantee (e.g. just before app.quit) can demand it without waiting 250ms.
 */
export function flushLogs(): void {
  flushBuffer();
  maybeRotate(true);
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
    // v0.19.0 — was a bare `return '[unserializable]'` which produced
    // useless log lines (saw it on every electron-updater error in
    // 0.19.0-rc.3 production logs — `data: "[unserializable]"`).
    // JSON.stringify chokes on circular refs (common with electron-
    // updater errors wrapping HTTPError + Response objects). Replace
    // with a structured best-effort snapshot.
    if (data instanceof Error) {
      const e = data as Error & { code?: string | number; cause?: unknown };
      return {
        error: e.message,
        name: e.name,
        code: e.code,
        stack: e.stack?.split('\n').slice(0, 6).join('\n'),
        cause: e.cause instanceof Error
          ? { message: e.cause.message, name: e.cause.name }
          : String(e.cause ?? ''),
      };
    }
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      const safe: Record<string, string> = {};
      // First level only — no recursion so we can't re-enter a cycle.
      for (const k of Object.keys(obj).slice(0, 12)) {
        try {
          const v = obj[k];
          safe[k] = v instanceof Error ? v.message : String(v).substring(0, 200);
        } catch { safe[k] = '[unreadable]'; }
      }
      return { _serializerFallback: 'circular-or-non-json', keys: safe };
    }
    return { _serializerFallback: 'unknown', type: typeof data, str: String(data).substring(0, 200) };
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
  // Format (scrubPII + JSON.stringify) still runs per call — same line shape,
  // same PII guarantee — but the result is buffered and flushed on a timer
  // instead of written + statSync'd synchronously on every call.
  let line: string;
  try {
    line = scrubPII(JSON.stringify(entry)) + '\n';
  } catch {
    // Fallback: at least buffer something
    line = `${entry.ts} [${level}] [${component}] ${scrubPII(message)}\n`;
  }
  pendingLines.push(line);
  ensureTimers();

  // ── Console output: colored human-readable (dev convenience) ────
  const reset = '\x1b[0m';
  const color = LEVEL_COLORS[level];
  const consoleMsg = `${color}[${level}]${reset} [${component}] ${message}`;
  if (level === 'ERROR') console.error(consoleMsg, data !== undefined ? data : '');
  else if (level === 'WARN') console.warn(consoleMsg, data !== undefined ? data : '');
  else console.log(consoleMsg, data !== undefined ? data : '');

  // Flush ERROR lines promptly: if the process is about to crash, the line
  // explaining the crash must already be on disk, not stuck in the 250ms
  // buffer. WARN/INFO/DEBUG ride the normal flush timer.
  if (level === 'ERROR') flushBuffer();
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
