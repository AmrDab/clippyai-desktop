// input-monitor.ts — owns the long-running `clippy-input-monitor` native
// helper and turns its NDJSON stream into Clippy triggers + a redacted
// rolling context.
//
// Privacy: the helper starts DISABLED and emits nothing until enable(). We
// enable on awake + eyes-open and disable on sleep / eyes-closed; disable()
// also wipes the in-memory rolling buffer. Raw keystrokes never touch disk.
//
// Bundle-anchor rule: this module MUST be reached via a static
// `import * as inputMonitorMod from './input-monitor'` from its consumer
// (index.ts / brain.ts) — a lazy require()/dynamic import() gets tree-shaken
// out of the Rollup production bundle.

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { createLogger } from './logger';
import { TriggerMatcher, RollingBuffer, type Trigger } from './input-triggers';

const log = createLogger('input-monitor');

let cachedBinPath: string | null | undefined = undefined;

/**
 * Resolve the clippy-input-monitor binary path (mirrors screenshot-helper).
 *   Production: <App>.app/Contents/Resources/clippy-input-monitor
 *   Dev:        <repo>/native/clippy-input-monitor/.build/release/clippy-input-monitor
 * Returns null if not found so the caller can no-op rather than spawn-fail.
 */
export function resolveMonitorPath(): string | null {
  if (cachedBinPath !== undefined) return cachedBinPath;

  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'clippy-input-monitor');
    if (fs.existsSync(bundled)) {
      cachedBinPath = bundled;
      log.info('Using bundled clippy-input-monitor', { path: bundled });
      return bundled;
    }
  }

  const devCandidates = [
    path.join(__dirname, '../../native/clippy-input-monitor/.build/release/clippy-input-monitor'),
    path.join(app?.getAppPath?.() || '', 'native/clippy-input-monitor/.build/release/clippy-input-monitor'),
  ];
  for (const c of devCandidates) {
    if (c && fs.existsSync(c)) {
      cachedBinPath = c;
      log.info('Using dev clippy-input-monitor', { path: c });
      return c;
    }
  }

  log.warn('clippy-input-monitor binary not found at any candidate location', {
    resourcesPath: process.resourcesPath,
    devCandidates,
  });
  cachedBinPath = null;
  return null;
}

export interface InputMonitorCallbacks {
  /** A wake phrase ("hello clippy") was typed while awake. */
  onSummon?: (phrase: string) => void;
  /** ESC was pressed. */
  onEscape?: () => void;
  /** Secure-input (password field) state changed. */
  onSecureChange?: (on: boolean) => void;
  /** Input Monitoring permission is missing (a prompt was triggered). */
  onPermissionMissing?: () => void;
}

/**
 * Manages the native input-monitor process and dispatches its events to the
 * pure TriggerMatcher / RollingBuffer (see input-triggers.ts).
 */
export class InputMonitor {
  private child: ChildProcess | null = null;
  private stdoutBuf = '';
  private readonly matcher: TriggerMatcher;
  private readonly rolling = new RollingBuffer();
  private enabled = false;

  constructor(
    private readonly cbs: InputMonitorCallbacks = {},
    phrases?: string[],
  ) {
    this.matcher = new TriggerMatcher(phrases);
  }

  /** Spawn the helper (idle/disabled). Capture begins only on enable(). */
  start(): boolean {
    if (this.child) return true;
    const bin = resolveMonitorPath();
    if (!bin) {
      log.warn('input-monitor unavailable; keystroke awareness disabled');
      return false;
    }
    try {
      this.child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      log.warn('failed to spawn input-monitor', { err: String(e) });
      this.child = null;
      return false;
    }
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (d: string) => log.debug('input-monitor stderr', { d: d.slice(0, 200) }));
    this.child.on('exit', (code) => {
      log.info('input-monitor exited', { code });
      this.child = null;
      this.enabled = false;
    });
    return true;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line) this.handleEvent(line);
    }
  }

  private handleEvent(line: string): void {
    let ev: { t?: string; ch?: string; key?: string; on?: boolean; listen?: boolean };
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    switch (ev.t) {
      case 'key':
        if (typeof ev.ch === 'string') {
          this.rolling.push(ev.ch);
          const trig = this.matcher.pushChar(ev.ch);
          if (trig) this.fire(trig);
        }
        break;
      case 'special':
        if (typeof ev.key === 'string') {
          const trig = this.matcher.pushSpecial(ev.key);
          if (trig) this.fire(trig);
        }
        break;
      case 'secure':
        this.cbs.onSecureChange?.(!!ev.on);
        break;
      case 'perm':
        if (ev.listen === false) this.cbs.onPermissionMissing?.();
        break;
      case 'ready':
        log.info('input-monitor ready', { listen: ev.listen });
        if (ev.listen === false) this.cbs.onPermissionMissing?.();
        break;
      default:
        break;
    }
  }

  private fire(t: Trigger): void {
    if (t.kind === 'summon') this.cbs.onSummon?.(t.phrase);
    else if (t.kind === 'escape') this.cbs.onEscape?.();
  }

  /** Begin capturing — Clippy awake + eyes open. */
  enable(): void {
    if (!this.child && !this.start()) return;
    this.send('enable');
    this.enabled = true;
  }

  /** Stop capturing — sleep / eyes-closed. Wipes the rolling buffer. */
  disable(): void {
    this.send('disable');
    this.enabled = false;
    this.rolling.clear();
    this.matcher.reset();
  }

  /** Field/app switch: wipe recent context (privacy hygiene), keep capturing. */
  clearContext(): void {
    this.rolling.clear();
    this.matcher.reset();
  }

  /** Redacted snapshot of recent typing — the only thing eligible for distillation. */
  recentContext(): string {
    return this.enabled ? this.rolling.snapshot() : '';
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Terminate the helper entirely. */
  stop(): void {
    this.send('quit');
    this.child = null;
    this.enabled = false;
  }

  private send(cmd: string): void {
    try {
      this.child?.stdin?.write(`${cmd}\n`);
    } catch (e) {
      log.warn('input-monitor send failed', { cmd, err: String(e) });
    }
  }
}
