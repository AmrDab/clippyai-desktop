/**
 * macOS automation bridge — thin wrappers over `osascript` for AppleScript
 * execution and small shell helpers (pbcopy, pbpaste, screencapture, etc.).
 *
 * Why no persistent process: osascript cold start is ~50-80ms (vs ~500ms
 * for PowerShell), so the spawn-per-call cost is well within the budget
 * for Tier 1-3 tool latency. We can revisit a persistent Swift helper for
 * AXUIElement-deep automation (M3+) if profiling shows the per-call
 * overhead dominates.
 *
 * All inputs sourced from model-supplied params are passed via the `-e`
 * inline-script form with positional arguments AppleScript references via
 * "item N of args of me" — never by string interpolation — so the model
 * cannot inject AppleScript.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger, serializeErr } from './logger';

const execFileAsync = promisify(execFile);
const log = createLogger('MacBridge');

export interface RunOptions {
  timeoutMs?: number;
  /** Args passed to AppleScript; reference as `item N of argv`. */
  args?: string[];
  /** Stdin input piped into osascript. */
  stdin?: string;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Run an AppleScript snippet via osascript. Arguments are passed as positional
 * args (AppleScript reads them as `argv` if you define an `on run argv` handler,
 * or via `item 1 of argv` etc.). The caller's script source is trusted; the
 * `args` array is what we treat as untrusted model input.
 */
export async function runApplescript(script: string, opts: RunOptions = {}): Promise<RunResult> {
  const timeout = opts.timeoutMs ?? 10_000;
  const cmdArgs = ['-e', script];
  if (opts.args && opts.args.length > 0) {
    // -- separator forces osascript to treat the rest as script arguments,
    // not as additional -e snippets.
    cmdArgs.push('--', ...opts.args);
  }
  try {
    const child = execFileAsync('osascript', cmdArgs, {
      timeout,
      maxBuffer: 5 * 1024 * 1024,
    });
    if (opts.stdin && child.child.stdin) {
      child.child.stdin.write(opts.stdin);
      child.child.stdin.end();
    }
    const { stdout, stderr } = await child;
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      error: e.message,
    };
  }
}

/**
 * Convenience: run a single-expression AppleScript and return the trimmed
 * stdout, or an `(error: ...)` sentinel string. Used by the read-only tools
 * (getActiveWindow, getWindows, etc.) that want to feed the result straight
 * back to the model.
 */
export async function asValue(script: string, opts: RunOptions = {}): Promise<string> {
  const r = await runApplescript(script, opts);
  if (!r.ok) {
    log.debug('asValue failed', { err: r.error, stderr: r.stderr.substring(0, 200) });
    return `(error: ${r.error ?? r.stderr.trim() ?? 'unknown'})`;
  }
  return r.stdout.trim();
}

/**
 * Look up a running application's process ID by name. Returns 0 if not
 * running. We prefer exact bundle/process-name matches because partial
 * matches across user-installed apps too easily land on the wrong target
 * ("Slack" matching "Slack Helper", etc.).
 */
export async function getAppPidByName(name: string): Promise<number> {
  const script = `
    on run argv
      set targetName to item 1 of argv
      tell application "System Events"
        try
          set p to first process whose name is targetName
          return unix id of p as text
        on error
          return ""
        end try
      end tell
    end run
  `;
  const r = await runApplescript(script, { args: [name], timeoutMs: 3000 });
  if (!r.ok) return 0;
  const pid = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : 0;
}

/**
 * Run a CLI tool with `execFile`-safe arg arrays. Wraps the rest of this
 * module so callers don't import child_process directly for trivial shells
 * like pbcopy / pbpaste / screencapture.
 */
export async function runCli(
  cmd: string,
  args: string[] = [],
  opts: { timeoutMs?: number; stdin?: string; maxBuffer?: number } = {},
): Promise<RunResult> {
  try {
    const child = execFileAsync(cmd, args, {
      timeout: opts.timeoutMs ?? 5_000,
      maxBuffer: opts.maxBuffer ?? 5 * 1024 * 1024,
    });
    if (opts.stdin !== undefined && child.child.stdin) {
      child.child.stdin.write(opts.stdin);
      child.child.stdin.end();
    }
    const { stdout, stderr } = await child;
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      error: e.message,
    };
  }
}

/**
 * AppleScript key code lookup table. Used by keyPress to map readable
 * key names ("Return", "Tab", "F5") into the numeric key codes that
 * System Events' `key code` command expects.
 *
 * Reference: Mac virtual key codes (Apple HIToolbox/Events.h).
 */
export const KEY_CODES: Record<string, number> = {
  Return: 36, Enter: 36,
  Tab: 48,
  Space: 49,
  Delete: 51, Backspace: 51,
  Escape: 53,
  ForwardDelete: 117,
  Up: 126, Down: 125, Left: 123, Right: 124,
  Home: 115, End: 119,
  PageUp: 116, PageDown: 121,
  F1: 122, F2: 120, F3: 99, F4: 118,
  F5: 96, F6: 97, F7: 98, F8: 100,
  F9: 101, F10: 109, F11: 103, F12: 111,
};

/**
 * Modifier mapping used by keyPress / typeText for combos like "cmd+s".
 * Returns the AppleScript `using` clause fragment, e.g.
 * `using {command down, shift down}`.
 */
export function modifiersClause(mods: string[]): string {
  const map: Record<string, string> = {
    cmd: 'command down', command: 'command down', meta: 'command down', win: 'command down',
    ctrl: 'control down', control: 'control down',
    alt: 'option down', option: 'option down',
    shift: 'shift down',
  };
  const flags = mods.map((m) => map[m.toLowerCase()]).filter(Boolean);
  if (flags.length === 0) return '';
  return ` using {${flags.join(', ')}}`;
}
