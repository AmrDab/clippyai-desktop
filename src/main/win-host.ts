/**
 * win-host.ts — v0.24 persistent PowerShell host (plan §2.4).
 *
 * Every Windows tool used to be a fresh `powershell.exe` (300–600 ms of
 * startup, plus a csc.exe compile for each inline `Add-Type`). This module
 * keeps ONE long-lived `powershell.exe -STA -NonInteractive` running
 * `assets/scripts/ps-bridge.ps1` and talks to it over stdin/stdout:
 *
 *   request  (one line, UTF-8):  {"id":7,"cmd":"run","script":"x.ps1","args":{...}}
 *                                {"id":8,"cmd":"eval","code":"..."}
 *   response (one line, UTF-8):  \x1e{"id":7,"ok":true,"exitCode":0,"ms":12,"out":"..."}
 *
 * Responses start with an ASCII record separator (\x1e) so anything a script
 * prints straight to the console (Write-Host, a stray [Console]::Write) can
 * never be mistaken for a protocol line — it is logged and dropped.
 *
 * Lifecycle: started lazily on the first request; requests run one at a time
 * (the host is single-threaded); each has its own timeout, and a timeout or
 * abort kills the host (a hung UIA call cannot be interrupted any other way)
 * — the next request starts a fresh one. A crash rejects the in-flight
 * request and restarts on demand. Repeated start failures / deaths back the
 * host off for a while, and every caller falls back to the old one-shot
 * `powershell.exe` spawn, so nothing depends on the host being healthy.
 *
 * Scripts run unchanged in both modes: in the host, `run` executes the .ps1
 * in-process with [Console]::Out redirected into a buffer, so the text a
 * caller gets back is the same stdout the one-shot spawn produced. Inline
 * `Add-Type` blocks compile once per host session instead of once per call.
 *
 * Electron-free on purpose (no logger/app import) so vitest can drive it
 * with a fake child process.
 */

import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

/** ASCII record separator — prefix of every protocol line from the host. */
export const RS = '\x1e';

export type PsArgValue = string | number | boolean;
export type PsArgs = Record<string, PsArgValue | undefined>;

export interface HostResponse {
  id: number;
  ok: boolean;
  out?: string;
  error?: string;
  exitCode?: number;
  ms?: number;
}

export type PsHostErrorCode = 'TIMEOUT' | 'HOST_DIED' | 'HOST_UNAVAILABLE' | 'ABORTED' | 'HOST_ERROR';

export class PsHostError extends Error {
  readonly code: PsHostErrorCode;
  constructor(code: PsHostErrorCode, message: string) {
    super(message);
    this.name = 'PsHostError';
    this.code = code;
  }
}

interface Pending {
  id: number;
  line: string;
  timeoutMs: number;
  resolve: (r: HostResponse) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface MiniLog {
  info: (msg: string, data?: unknown) => void;
  warn: (msg: string, data?: unknown) => void;
  debug: (msg: string, data?: unknown) => void;
}

const NOOP_LOG: MiniLog = { info: () => {}, warn: () => {}, debug: () => {} };

export interface PsHostOptions {
  /** Absolute path of ps-bridge.ps1 (resolved lazily, on first start). */
  bridgePath: () => string;
  /** Directory the host may run scripts from. */
  scriptsDir: () => string;
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /** How long a fresh host may take to print its ready line. */
  readyTimeoutMs?: number;
  /** How long a request waits for a host that is still starting before the caller falls back. */
  warmWaitMs?: number;
  /** Consecutive failures (start failure, crash, timeout) before backing off. */
  maxConsecutiveFailures?: number;
  /** First back-off window; doubles per further failure, capped at 5 min. */
  backoffMs?: number;
  log?: MiniLog;
  now?: () => number;
}

export const HOST_ARGS = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass'];

export class PsHost {
  private readonly opts: Required<Omit<PsHostOptions, 'log' | 'spawnFn' | 'now'>> & Pick<PsHostOptions, 'spawnFn'>;
  private readonly log: MiniLog;
  private readonly now: () => number;
  private child: ChildProcess | null = null;
  private state: 'idle' | 'starting' | 'ready' = 'idle';
  private ready: Promise<void> | null = null;
  private readySettle: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private chunks: string[] = [];
  private queue: Pending[] = [];
  private inflight: Pending | null = null;
  private nextId = 1;
  private failures = 0;
  private disabledUntil = 0;
  private closed = false;
  /** Children we killed on purpose — their exit is not counted as a crash. */
  private readonly expectedExits = new WeakSet<ChildProcess>();
  /** Info from the ready line (native helper / DPI mode), for logs + tests. */
  readyInfo: Record<string, unknown> = {};
  /** Monotonic count of host processes started (tests + telemetry). */
  starts = 0;

  constructor(opts: PsHostOptions) {
    this.opts = {
      bridgePath: opts.bridgePath,
      scriptsDir: opts.scriptsDir,
      spawnFn: opts.spawnFn,
      readyTimeoutMs: opts.readyTimeoutMs ?? 15_000,
      warmWaitMs: opts.warmWaitMs ?? 4_000,
      maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 3,
      backoffMs: opts.backoffMs ?? 30_000,
    };
    this.log = opts.log ?? NOOP_LOG;
    this.now = opts.now ?? Date.now;
  }

  /** False while backing off after repeated failures, or after shutdown. */
  isAvailable(): boolean {
    return !this.closed && this.now() >= this.disabledUntil;
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  /** Send one request. Rejects with PsHostError; HOST_UNAVAILABLE means "never sent — fall back". */
  async request(msg: Record<string, unknown>, timeoutMs: number): Promise<HostResponse> {
    if (!this.isAvailable()) throw new PsHostError('HOST_UNAVAILABLE', this.closed ? 'host shut down' : 'host backing off after failures');
    if (this.state !== 'ready') {
      const ready = this.start();
      let warmTimer: ReturnType<typeof setTimeout> | undefined;
      const warm = new Promise<'cold'>((r) => { warmTimer = setTimeout(() => r('cold'), this.opts.warmWaitMs); });
      try {
        const which = await Promise.race([ready.then(() => 'ready' as const), warm]);
        if (which === 'cold') throw new PsHostError('HOST_UNAVAILABLE', `host still starting after ${this.opts.warmWaitMs}ms`);
      } catch (err) {
        if (err instanceof PsHostError) throw err;
        throw new PsHostError('HOST_UNAVAILABLE', `host failed to start: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (warmTimer) clearTimeout(warmTimer);
      }
    }
    return new Promise<HostResponse>((resolve, reject) => {
      const id = this.nextId++;
      const line = JSON.stringify({ ...msg, id });
      this.queue.push({ id, line, timeoutMs, resolve, reject });
      // The host may have died between "ready" and now — restart for this one.
      if (this.state === 'idle') this.afterDeath();
      else this.pump();
    });
  }

  /** Kill the host if it is doing anything and reject everything pending (sleep / cancel). */
  abortAll(): number {
    const n = this.queue.length + (this.inflight ? 1 : 0);
    if (n === 0) return 0;
    this.failAll(new PsHostError('ABORTED', 'aborted'));
    this.killChild();
    return n;
  }

  /** Clean shutdown on quit: ask the host to exit, hard-kill if it lingers. */
  shutdown(): void {
    this.closed = true;
    this.failAll(new PsHostError('HOST_UNAVAILABLE', 'host shut down'));
    const c = this.child;
    if (!c) return;
    this.expectedExits.add(c);
    try { c.stdin?.write('EXIT\n'); c.stdin?.end(); } catch { /* pipe already gone */ }
    const t = setTimeout(() => { try { c.kill(); } catch { /* already dead */ } }, 1000);
    t.unref?.();
    this.child = null;
    this.state = 'idle';
  }

  // ── internals ──────────────────────────────────────────────────────

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.state = 'starting';
    this.chunks = [];
    this.ready = new Promise<void>((resolve, reject) => { this.readySettle = { resolve, reject }; });
    this.ready.catch(() => { /* observed by request(); avoid unhandled rejection */ });
    let child: ChildProcess;
    try {
      const spawnFn = this.opts.spawnFn ?? spawn;
      child = spawnFn('powershell.exe', [...HOST_ARGS, '-File', this.opts.bridgePath(), '-ScriptsDir', this.opts.scriptsDir()], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.onStartFailed(err instanceof Error ? err.message : String(err));
      return this.ready;
    }
    this.child = child;
    this.starts++;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { if (this.child === child) this.onData(d); });
    child.stderr?.on('data', (d: string) => { if (this.child === child) this.log.debug('ps-host stderr', String(d).slice(0, 300)); });
    child.stdin?.on('error', () => { /* EPIPE — the exit handler does the bookkeeping */ });
    child.on('error', (err) => { if (this.child === child) this.onExit(child, `spawn error: ${err.message}`); });
    child.on('exit', (code, signal) => this.onExit(child, `exit code=${code} signal=${signal}`));
    this.readyTimer = setTimeout(() => {
      if (this.child === child && this.state === 'starting') {
        this.expectedExits.add(child);
        try { child.kill(); } catch { /* already dead */ }
        this.onStartFailed(`no ready line within ${this.opts.readyTimeoutMs}ms`);
      }
    }, this.opts.readyTimeoutMs);
    return this.ready;
  }

  private onData(chunk: string): void {
    let nl = chunk.indexOf('\n');
    if (nl < 0) { this.chunks.push(chunk); return; }
    let rest = chunk;
    while (nl >= 0) {
      this.chunks.push(rest.slice(0, nl));
      const line = this.chunks.join('');
      this.chunks = [];
      this.onLine(line.replace(/\r$/, ''));
      rest = rest.slice(nl + 1);
      nl = rest.indexOf('\n');
    }
    if (rest) this.chunks.push(rest);
  }

  private onLine(raw: string): void {
    const line = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    if (!line.startsWith(RS)) {
      if (line.trim()) this.log.debug('ps-host noise', line.slice(0, 200));
      return;
    }
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line.slice(1)); } catch {
      this.log.warn('ps-host: unparseable protocol line', line.slice(0, 200));
      return;
    }
    if (msg.ready === true) {
      if (this.state !== 'starting') return;
      if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
      this.state = 'ready';
      this.readyInfo = msg;
      this.log.info('ps-host ready', msg);
      this.readySettle?.resolve();
      this.readySettle = null;
      this.pump();
      return;
    }
    const p = this.inflight;
    if (!p || msg.id !== p.id) {
      this.log.debug('ps-host: response for unknown id', { id: msg.id });
      return;
    }
    if (p.timer) clearTimeout(p.timer);
    this.inflight = null;
    this.failures = 0;
    p.resolve(msg as unknown as HostResponse);
    this.pump();
  }

  private pump(): void {
    if (this.inflight || this.state !== 'ready' || !this.child) return;
    const p = this.queue.shift();
    if (!p) return;
    this.inflight = p;
    const child = this.child;
    p.timer = setTimeout(() => {
      if (this.inflight !== p) return;
      this.inflight = null;
      this.log.warn('ps-host request timed out — killing host', { id: p.id, timeoutMs: p.timeoutMs });
      p.reject(new PsHostError('TIMEOUT', `PowerShell host request timed out after ${p.timeoutMs}ms`));
      this.expectedExits.add(child);
      this.countFailure('timeout');
      this.killChild();
    }, p.timeoutMs);
    try {
      child.stdin?.write(p.line + '\n');
    } catch (err) {
      // The exit handler will reject p as HOST_DIED.
      this.log.warn('ps-host stdin write failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  private onExit(child: ChildProcess, why: string): void {
    if (this.child !== child) return; // stale child (already replaced / killed)
    const expected = this.expectedExits.has(child);
    const wasStarting = this.state === 'starting';
    this.child = null;
    this.state = 'idle';
    this.ready = null;
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
    if (wasStarting) {
      this.onStartFailed(why);
      return;
    }
    const p = this.inflight;
    this.inflight = null;
    if (p) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new PsHostError('HOST_DIED', `PowerShell host died mid-request (${why})`));
    }
    if (!expected) {
      this.log.warn('ps-host exited unexpectedly', { why });
      this.countFailure('crash');
    }
    this.afterDeath();
  }

  private onStartFailed(why: string): void {
    this.log.warn('ps-host failed to start', { why });
    this.child = null;
    this.state = 'idle';
    const settle = this.readySettle;
    this.readySettle = null;
    this.ready = null;
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
    this.countFailure('start');
    settle?.reject(new PsHostError('HOST_UNAVAILABLE', why));
    this.afterDeath();
  }

  /** Requests still queued were never sent: restart for them, or let them fall back. */
  private afterDeath(): void {
    if (this.queue.length === 0) return;
    if (!this.isAvailable()) {
      this.failAll(new PsHostError('HOST_UNAVAILABLE', 'host backing off after failures'));
      return;
    }
    this.start().catch(() => { /* start failure path already failed the queue */ });
  }

  private countFailure(kind: string): void {
    this.failures++;
    if (this.failures >= this.opts.maxConsecutiveFailures) {
      const extra = this.failures - this.opts.maxConsecutiveFailures;
      const wait = Math.min(this.opts.backoffMs * 2 ** extra, 5 * 60_000);
      this.disabledUntil = this.now() + wait;
      this.log.warn('ps-host backing off — callers use one-shot spawns', { failures: this.failures, kind, waitMs: wait });
    }
  }

  private failAll(err: Error): void {
    const all = this.inflight ? [this.inflight, ...this.queue] : [...this.queue];
    this.inflight = null;
    this.queue = [];
    for (const p of all) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private killChild(): void {
    const c = this.child;
    if (!c) return;
    this.expectedExits.add(c);
    try { c.kill(); } catch { /* already dead */ }
    // Do not wait for 'exit' — a hung host must not hold the next request.
    const settle = this.readySettle;
    this.child = null;
    this.state = 'idle';
    this.ready = null;
    this.readySettle = null;
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
    settle?.reject(new PsHostError('HOST_UNAVAILABLE', 'host killed while starting'));
    if (this.queue.length > 0) this.afterDeath();
  }
}

// ── Caller-facing helpers ──────────────────────────────────────────────

const SCRIPT_NAME_RE = /^[A-Za-z0-9_.-]+\.ps1$/;

/** One-shot argv for a script — identical to what tools.ts spawned pre-v0.24. */
export function oneShotScriptArgs(scriptPath: string, args: PsArgs): string[] {
  const out = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === false) continue;
    if (v === true) { out.push(`-${k}`); continue; }
    out.push(`-${k}`, String(v));
  }
  return out;
}

export interface PsCallOptions {
  timeoutMs: number;
  maxBuffer?: number;
  /** Safe to re-run with a one-shot spawn if the host dies mid-request (read-only calls). */
  idempotent?: boolean;
}

export interface PsCallResult { stdout: string; via: 'host' | 'spawn'; ms: number }

/** Shaped like Node's execFile rejection so existing catch blocks keep working. */
export class PsCallError extends Error {
  stdout: string;
  stderr = '';
  code: number | string;
  killed: boolean;
  constructor(message: string, stdout: string, code: number | string, killed = false) {
    super(message);
    this.stdout = stdout;
    this.code = code;
    this.killed = killed;
  }
}

let host: PsHost | null = null;
let scriptsDirFn: (() => string) | null = null;
let hostLog: MiniLog = NOOP_LOG;
const oneShotAborts = new Set<AbortController>();
/** Counters for the benchmark / support bundle. */
export const psStats = { host: 0, spawn: 0, fallbacks: 0 };

/**
 * Turn the host on (tools.ts initTools, win32 only). Until this is called —
 * e.g. in unit tests that mock execFile — every call is a one-shot spawn,
 * exactly as before v0.24.
 */
export function configurePsHost(opts: { scriptsDir: () => string; log?: MiniLog; host?: PsHost }): PsHost {
  scriptsDirFn = opts.scriptsDir;
  hostLog = opts.log ?? NOOP_LOG;
  host?.shutdown();
  host = opts.host ?? new PsHost({
    bridgePath: () => path.join(opts.scriptsDir(), 'ps-bridge.ps1'),
    scriptsDir: opts.scriptsDir,
    log: hostLog,
  });
  return host;
}

export function getPsHost(): PsHost | null { return host; }

/** Tell scripts where to live without enabling the host (one-shot only). */
export function setPsScriptsDir(fn: () => string): void { scriptsDirFn = fn; }

function resolveScript(script: string): string {
  if (!SCRIPT_NAME_RE.test(script)) throw new Error(`invalid script name: ${script}`);
  if (!scriptsDirFn) throw new Error('scripts dir not configured');
  return path.join(scriptsDirFn(), script);
}

async function oneShot(args: string[], opts: PsCallOptions): Promise<PsCallResult> {
  const ac = new AbortController();
  oneShotAborts.add(ac);
  const t0 = Date.now();
  try {
    const r = await execFileAsync('powershell.exe', args, {
      timeout: opts.timeoutMs,
      maxBuffer: opts.maxBuffer ?? 5 * 1024 * 1024,
      signal: ac.signal,
      windowsHide: true,
    } as Parameters<typeof execFileAsync>[2]);
    psStats.spawn++;
    const stdout = typeof r.stdout === 'string' ? r.stdout : (r.stdout as Buffer).toString('utf8');
    return { stdout, via: 'spawn', ms: Date.now() - t0 };
  } finally {
    oneShotAborts.delete(ac);
  }
}

function hostResultToCall(r: HostResponse, label: string, t0: number): PsCallResult {
  if (!r.ok) throw new PsCallError(`PowerShell host error in ${label}: ${r.error ?? 'unknown'}`, r.out ?? '', 'HOST_ERROR');
  const exitCode = r.exitCode ?? 0;
  if (exitCode !== 0) throw new PsCallError(`Command failed: ${label} (exit ${exitCode})`, r.out ?? '', exitCode);
  psStats.host++;
  return { stdout: r.out ?? '', via: 'host', ms: Date.now() - t0 };
}

async function viaHost(
  msg: Record<string, unknown>,
  label: string,
  fallbackArgs: string[],
  opts: PsCallOptions,
): Promise<PsCallResult> {
  const h = host;
  if (!h || !h.isAvailable()) return oneShot(fallbackArgs, opts);
  const t0 = Date.now();
  try {
    return hostResultToCall(await h.request(msg, opts.timeoutMs), label, t0);
  } catch (err) {
    if (!(err instanceof PsHostError)) throw err;
    if (err.code === 'HOST_UNAVAILABLE' || (err.code === 'HOST_DIED' && opts.idempotent)) {
      psStats.fallbacks++;
      hostLog.info('ps-host fallback to one-shot spawn', { label, reason: err.code });
      return oneShot(fallbackArgs, opts);
    }
    if (err.code === 'TIMEOUT') throw new PsCallError(`${label} timed out after ${opts.timeoutMs}ms (ETIMEDOUT)`, '', 'ETIMEDOUT', true);
    if (err.code === 'ABORTED') throw Object.assign(new Error(`${label}: The operation was aborted (AbortError)`), { name: 'AbortError' });
    throw new PsCallError(`${label}: ${err.message}`, '', err.code);
  }
}

/** Run a bundled .ps1 (by file name) — in the host when possible. */
export async function psScript(script: string, args: PsArgs, opts: PsCallOptions): Promise<PsCallResult> {
  const scriptPath = resolveScript(script);
  const clean: Record<string, PsArgValue> = {};
  for (const [k, v] of Object.entries(args)) if (v !== undefined) clean[k] = v;
  return viaHost({ cmd: 'run', script, args: clean }, script, oneShotScriptArgs(scriptPath, args), opts);
}

/** Run an inline PowerShell command — in the host when possible. */
export function psCommand(code: string, opts: PsCallOptions): Promise<PsCallResult> {
  return viaHost({ cmd: 'eval', code }, 'inline command', ['-NoProfile', '-NonInteractive', '-Command', code], opts);
}

/** Sleep / cancel: kill whatever PowerShell work is in flight. */
export function abortPsWork(): number {
  let n = host?.abortAll() ?? 0;
  for (const ac of oneShotAborts) { try { ac.abort(); n++; } catch { /* best effort */ } }
  oneShotAborts.clear();
  return n;
}

export function shutdownPsHost(): void {
  host?.shutdown();
}
