import fs from 'fs';
import path from 'path';
import os from 'os';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_DIR = path.join(os.homedir(), '.clippyai', 'logs');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB per file
const MAX_LOG_FILES = 5;

let logStream: fs.WriteStream | null = null;
let currentLogPath = '';
let minLevel: LogLevel = 'DEBUG';

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: '\x1b[90m',  // grey
  INFO: '\x1b[36m',   // cyan
  WARN: '\x1b[33m',   // yellow
  ERROR: '\x1b[31m',  // red
};

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFileName(): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return `clippy-${date}.log`;
}

function rotateIfNeeded(): void {
  if (!currentLogPath) return;
  try {
    const stats = fs.statSync(currentLogPath);
    if (stats.size > MAX_LOG_SIZE) {
      if (logStream) {
        logStream.end();
        logStream = null;
      }
      // Rotate: rename current to .1, .1 to .2, etc.
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const from = `${currentLogPath}.${i}`;
        const to = `${currentLogPath}.${i + 1}`;
        if (fs.existsSync(from)) {
          if (i === MAX_LOG_FILES - 1) {
            fs.unlinkSync(from);
          } else {
            fs.renameSync(from, to);
          }
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

function formatMessage(level: LogLevel, component: string, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString();
  let line = `${timestamp} [${level}] [${component}] ${message}`;
  if (data !== undefined) {
    try {
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 0);
      // Truncate very long data
      line += ` | ${dataStr.length > 500 ? dataStr.substring(0, 500) + '...' : dataStr}`;
    } catch {
      line += ' | [unserializable data]';
    }
  }
  return line;
}

function writeLog(level: LogLevel, component: string, message: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const formatted = formatMessage(level, component, message, data);

  // Write to file
  if (!logStream) openLogStream();
  logStream!.write(formatted + '\n');

  // Also write to console with color
  const reset = '\x1b[0m';
  const color = LEVEL_COLORS[level];
  const consoleMsg = `${color}[${level}]${reset} [${component}] ${message}`;
  if (level === 'ERROR') {
    console.error(consoleMsg, data !== undefined ? data : '');
  } else if (level === 'WARN') {
    console.warn(consoleMsg, data !== undefined ? data : '');
  } else {
    console.log(consoleMsg, data !== undefined ? data : '');
  }

  rotateIfNeeded();
}

export function createLogger(component: string) {
  return {
    debug: (message: string, data?: unknown) => writeLog('DEBUG', component, message, data),
    info: (message: string, data?: unknown) => writeLog('INFO', component, message, data),
    warn: (message: string, data?: unknown) => writeLog('WARN', component, message, data),
    error: (message: string, data?: unknown) => writeLog('ERROR', component, message, data),
  };
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
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
      if (!file.startsWith('clippy-') || !file.endsWith('.log')) continue;
      const fullPath = path.join(LOG_DIR, file);
      try {
        const stats = fs.statSync(fullPath);
        if (stats.mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
        }
      } catch { /* skip files we can't stat */ }
    }
    // Also clean rotated files (.log.1, .log.2, etc.)
    for (const file of files) {
      if (/\.log\.\d+$/.test(file)) {
        const fullPath = path.join(LOG_DIR, file);
        try {
          const stats = fs.statSync(fullPath);
          if (stats.mtimeMs < cutoff) {
            fs.unlinkSync(fullPath);
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* log dir might not exist yet */ }
}

// Initialize on import
ensureLogDir();
