/**
 * v0.24 — persistent PowerShell host client (plan §2.4). A fake child
 * process stands in for powershell.exe, so framing, ids, timeouts, restart,
 * back-off and one-shot fallback are exercised without spawning anything.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import os from 'os';

type Handler = (req: Record<string, unknown>, fake: FakeChild) => void;

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  killed = false;
  lines: string[] = [];
  constructor(private handler: Handler, readyLine: string | null) {
    super();
    let buf = '';
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          this.lines.push(line);
          if (line === 'EXIT') { setImmediate(() => this.exit(0)); continue; }
          this.handler(JSON.parse(line), this);
        }
        cb();
      },
    });
    if (readyLine !== null) setImmediate(() => this.stdout.write(readyLine));
  }
  reply(obj: Record<string, unknown>): void { this.stdout.write(`\x1e${JSON.stringify(obj)}\n`); }
  exit(code: number | null): void { if (!this.killed) { this.killed = true; this.emit('exit', code, null); } }
  killRequested = false;
  kill(): boolean { this.killRequested = true; setImmediate(() => this.exit(null)); return true; }
}

const READY = '\x1e{"ready":true,"native":"compiled","dpi":"process+thread"}\n';
const echo: Handler = (req, f) => setImmediate(() => f.reply({ id: req.id, ok: true, exitCode: 0, out: `echo:${req.cmd}:${(req.script ?? req.code) as string}` }));

// One-shot fallback goes through child_process.execFile — mock it.
const execFileMock = vi.fn((_f: string, args: string[], _o: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
  cb(null, { stdout: `oneshot:${args.join(' ')}`, stderr: '' });
});
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>();
  return { ...real, execFile: (...a: unknown[]) => (execFileMock as unknown as (...x: unknown[]) => void)(...a) };
});

import { PsHost, PsHostError, configurePsHost, psScript, psCommand, abortPsWork, oneShotScriptArgs, psStats, HOST_ARGS } from '../src/main/win-host';

function makeHost(handler: Handler = echo, opts: Partial<ConstructorParameters<typeof PsHost>[0]> = {}, readyLine: string | null = READY) {
  const children: FakeChild[] = [];
  const spawnFn = vi.fn(() => {
    const c = new FakeChild(handler, readyLine);
    children.push(c);
    return c as unknown as import('child_process').ChildProcess;
  });
  const host = new PsHost({ bridgePath: () => 'C:\\s\\ps-bridge.ps1', scriptsDir: () => 'C:\\s', spawnFn, readyTimeoutMs: 200, warmWaitMs: 500, ...opts });
  return { host, children, spawnFn };
}

// The host refuses to run off Windows (assertWin32); these tests fake the child, so pose as win32.
const originalPlatform = process.platform;
beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'win32' }); });
afterAll(() => { Object.defineProperty(process, 'platform', { value: originalPlatform }); });

beforeEach(() => { execFileMock.mockClear(); });
afterEach(() => { vi.useRealTimers(); });

describe('PsHost lifecycle', () => {
  it('starts lazily, with -STA -NonInteractive and the bridge script', async () => {
    const { host, spawnFn } = makeHost();
    expect(spawnFn).not.toHaveBeenCalled();
    const r = await host.request({ cmd: 'ping' }, 1000);
    expect(r).toMatchObject({ ok: true, out: 'echo:ping:undefined' });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('powershell.exe');
    expect(args).toEqual([...HOST_ARGS, '-File', 'C:\\s\\ps-bridge.ps1', '-ScriptsDir', 'C:\\s']);
    expect(args).toContain('-STA');
    expect(args).toContain('-NonInteractive');
    expect(host.readyInfo).toMatchObject({ dpi: 'process+thread' });
  });

  it('reuses one process for many requests, serially, matching ids', async () => {
    const seen: number[] = [];
    const { host, spawnFn, children } = makeHost((req, f) => {
      seen.push(req.id as number);
      // answer out of band later; only one request may be in flight at a time
      setTimeout(() => f.reply({ id: req.id, ok: true, exitCode: 0, out: String(req.code) }), 5);
    });
    const rs = await Promise.all([1, 2, 3, 4, 5].map((n) => host.request({ cmd: 'eval', code: `n${n}` }, 1000)));
    expect(rs.map((r) => r.out)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(children[0].lines).toHaveLength(5);
  });

  it('frames responses split across chunks, batched in one chunk, with CRLF/BOM and noise lines', async () => {
    const { host } = makeHost((req, f) => {
      const id = req.id as number;
      const body = JSON.stringify({ id, ok: true, exitCode: 0, out: 'é 你好 ' + 'x'.repeat(70_000) });
      if (id === 1) {
        // noise, then the response split into three chunks with CRLF
        f.stdout.write('WARNING: some Write-Host text\n');
        f.stdout.write('\x1e' + body.slice(0, 10));
        f.stdout.write(body.slice(10, 40000));
        f.stdout.write(body.slice(40000) + '\r\n');
      } else {
        f.stdout.write('\ufeff\x1e' + body + '\n');
      }
    });
    const a = await host.request({ cmd: 'eval', code: 'a' }, 1000);
    const b = await host.request({ cmd: 'eval', code: 'b' }, 1000);
    expect(a.out?.startsWith('é 你好 x')).toBe(true);
    expect(a.out).toHaveLength(5 + 70_000);
    expect(b.out).toHaveLength(5 + 70_000);
  });

  it('ignores a protocol line whose id does not match the in-flight request', async () => {
    const { host } = makeHost((req, f) => {
      f.reply({ id: 999, ok: true, out: 'stale' });
      setImmediate(() => f.reply({ id: req.id, ok: true, exitCode: 0, out: 'mine' }));
    });
    expect((await host.request({ cmd: 'ping' }, 1000)).out).toBe('mine');
  });

  it('per-request timeout rejects with TIMEOUT, kills the host, next request restarts it', async () => {
    let calls = 0;
    const { host, spawnFn, children } = makeHost((req, f) => {
      calls++;
      if (calls === 1) return; // hang
      f.reply({ id: req.id, ok: true, exitCode: 0, out: 'after-restart' });
    });
    await expect(host.request({ cmd: 'eval', code: 'hang' }, 50)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(children[0].killRequested).toBe(true);
    const r = await host.request({ cmd: 'ping' }, 1000);
    expect(r.out).toBe('after-restart');
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('after a timeout a fresh host is spawned with no new request, so the next one is not cold', async () => {
    const { host, spawnFn } = makeHost((req, f) => { if (req.cmd === 'eval') return; f.reply({ id: req.id, ok: true, exitCode: 0, out: 'x' }); });
    await expect(host.request({ cmd: 'eval', code: 'hang' }, 50)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await new Promise((r) => setTimeout(r, 30));
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(host.isReady()).toBe(true);
  });

  it('does not prewarm while backing off', async () => {
    const { host, spawnFn } = makeHost((req, f) => { if (req.cmd === 'eval') return; f.reply({ id: req.id, ok: true }); }, { maxConsecutiveFailures: 1, backoffMs: 60_000 });
    await expect(host.request({ cmd: 'eval', code: 'hang' }, 50)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(host.isAvailable()).toBe(false);
    host.prewarm();
    await new Promise((r) => setTimeout(r, 30));
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('abortAll and shutdown never respawn the host', async () => {
    const a = makeHost(() => { /* hang */ });
    const p = a.host.request({ cmd: 'eval', code: 'long' }, 60_000);
    await new Promise((r) => setTimeout(r, 20));
    a.host.abortAll();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    await new Promise((r) => setTimeout(r, 30));
    expect(a.spawnFn).toHaveBeenCalledTimes(1);

    const b = makeHost();
    await b.host.request({ cmd: 'ping' }, 1000);
    b.host.shutdown();
    b.host.prewarm();
    await new Promise((r) => setTimeout(r, 30));
    expect(b.spawnFn).toHaveBeenCalledTimes(1);
  });

  it('a crash mid-request rejects with HOST_DIED and the host restarts on demand', async () => {
    let calls = 0;
    const { host, spawnFn } = makeHost((req, f) => {
      calls++;
      if (calls === 1) { setImmediate(() => f.exit(1)); return; }
      f.reply({ id: req.id, ok: true, exitCode: 0, out: 'ok' });
    });
    await expect(host.request({ cmd: 'ping' }, 1000)).rejects.toMatchObject({ code: 'HOST_DIED' });
    expect((await host.request({ cmd: 'ping' }, 1000)).out).toBe('ok');
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('queued requests survive the death of the in-flight one (they were never sent)', async () => {
    let calls = 0;
    const { host, spawnFn } = makeHost((req, f) => {
      calls++;
      if (calls === 1) { setTimeout(() => f.exit(1), 5); return; }
      f.reply({ id: req.id, ok: true, exitCode: 0, out: `ok${req.code}` });
    });
    const first = host.request({ cmd: 'eval', code: '1' }, 1000);
    const second = host.request({ cmd: 'eval', code: '2' }, 1000);
    await expect(first).rejects.toMatchObject({ code: 'HOST_DIED' });
    expect((await second).out).toBe('ok2');
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('no ready line → HOST_UNAVAILABLE; repeated failures back off (no further spawns)', async () => {
    let t = 1_000_000;
    const { host, spawnFn } = makeHost(echo, { readyTimeoutMs: 20, maxConsecutiveFailures: 2, backoffMs: 60_000, now: () => t }, null);
    await expect(host.request({ cmd: 'ping' }, 100)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    await expect(host.request({ cmd: 'ping' }, 100)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(host.isAvailable()).toBe(false);
    await expect(host.request({ cmd: 'ping' }, 100)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(spawnFn).toHaveBeenCalledTimes(2);
    t += 61_000;
    expect(host.isAvailable()).toBe(true);
  });

  it('spawn throwing (powershell.exe missing) is a start failure, not an exception', async () => {
    const host = new PsHost({ bridgePath: () => 'x', scriptsDir: () => 'y', spawnFn: () => { throw new Error('ENOENT'); }, warmWaitMs: 100 });
    await expect(host.request({ cmd: 'ping' }, 100)).rejects.toBeInstanceOf(PsHostError);
  });

  it('a slow-to-start host makes the caller fall back after warmWaitMs but keeps warming', async () => {
    const { host, children } = makeHost(echo, { warmWaitMs: 20, readyTimeoutMs: 5000 }, null);
    await expect(host.request({ cmd: 'ping' }, 100)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(children).toHaveLength(1);
    children[0].stdout.write(READY);
    await new Promise((r) => setTimeout(r, 10));
    expect(host.isReady()).toBe(true);
    expect((await host.request({ cmd: 'ping' }, 100)).ok).toBe(true);
    expect(children).toHaveLength(1);
  });

  it('abortAll kills the busy host and rejects everything with ABORTED', async () => {
    const { host, children } = makeHost(() => { /* hang */ });
    const a = host.request({ cmd: 'eval', code: 'a' }, 5000);
    const b = host.request({ cmd: 'eval', code: 'b' }, 5000);
    await new Promise((r) => setTimeout(r, 20));
    expect(host.abortAll()).toBe(2);
    await expect(a).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(b).rejects.toMatchObject({ code: 'ABORTED' });
    expect(children[0].killRequested).toBe(true);
  });

  it('shutdown sends EXIT, closes stdin and refuses new work', async () => {
    const { host, children } = makeHost();
    await host.request({ cmd: 'ping' }, 1000);
    host.shutdown();
    await new Promise((r) => setTimeout(r, 10));
    expect(children[0].lines).toContain('EXIT');
    expect(children[0].killed).toBe(true);
    await expect(host.request({ cmd: 'ping' }, 100)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });
});

describe('PsHost shutdown while busy', () => {
  it('kills a host that is mid-request instead of waiting for it (update install)', async () => {
    const { host, children } = makeHost(() => { /* hang */ });
    const p = host.request({ cmd: 'eval', code: 'long' }, 60_000);
    await new Promise((r) => setTimeout(r, 20));
    host.shutdown();
    await expect(p).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(children[0].killRequested).toBe(true);
  });

  it('spawns the host outside the install dir (cwd = temp), hidden', async () => {
    const { host, spawnFn } = makeHost();
    await host.request({ cmd: 'ping' }, 1000);
    const opts = (spawnFn.mock.calls[0] as unknown as [string, string[], { cwd?: string; windowsHide?: boolean }])[2];
    expect(opts.cwd).toBe(os.tmpdir());
    expect(opts.windowsHide).toBe(true);
  });
});

describe('psScript / psCommand (caller helpers)', () => {
  it('builds the same one-shot argv the tools used before v0.24', () => {
    expect(oneShotScriptArgs('C:\\s\\focus-window.ps1', { Title: 'Notepad', ProcessId: 12, Restore: true, Skip: false, Missing: undefined }))
      .toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\s\\focus-window.ps1', '-Title', 'Notepad', '-ProcessId', '12', '-Restore']);
  });

  it('uses the host when it is up and returns its stdout', async () => {
    const { host } = makeHost((req, f) => f.reply({ id: req.id, ok: true, exitCode: 0, out: JSON.stringify(req.args) }));
    configurePsHost({ scriptsDir: () => 'C:\\s', host });
    const r = await psScript('focus-window.ps1', { Title: 'x', ProcessId: 3 }, { timeoutMs: 1000 });
    expect(r.via).toBe('host');
    expect(JSON.parse(r.stdout)).toEqual({ Title: 'x', ProcessId: 3 });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a non-zero script exit rejects like execFile did, with stdout attached', async () => {
    const { host } = makeHost((req, f) => f.reply({ id: req.id, ok: true, exitCode: 1, out: '{"ok":false,"error":"x"}' }));
    configurePsHost({ scriptsDir: () => 'C:\\s', host });
    await expect(psScript('com-excel-write.ps1', {}, { timeoutMs: 1000 })).rejects.toMatchObject({ code: 1, stdout: '{"ok":false,"error":"x"}' });
  });

  it('falls back to a one-shot spawn when the host cannot start', async () => {
    const { host } = makeHost(echo, { readyTimeoutMs: 10, warmWaitMs: 100 }, null);
    configurePsHost({ scriptsDir: () => 'C:\\s', host });
    const before = psStats.fallbacks;
    const r = await psScript('get-foreground-window.ps1', {}, { timeoutMs: 1000, idempotent: true });
    expect(r.via).toBe('spawn');
    // path.join uses the host separator, so a POSIX test host yields C:\s/...; production is win32-only.
    expect(r.stdout).toMatch(/-File C:\\s[\\/]get-foreground-window\.ps1/);
    expect(psStats.fallbacks).toBe(before + 1);
  });

  it('retries an idempotent call one-shot when the host dies mid-request, but never a side-effecting one', async () => {
    const { host } = makeHost((_req, f) => setImmediate(() => f.exit(1)));
    configurePsHost({ scriptsDir: () => 'C:\\s', host });
    const r = await psCommand('Get-Thing', { timeoutMs: 1000, idempotent: true });
    expect(r.via).toBe('spawn');
    expect(r.stdout).toContain('-Command Get-Thing');
    execFileMock.mockClear();
    await expect(psCommand('Click-Thing', { timeoutMs: 1000 })).rejects.toThrow(/died/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a host timeout surfaces as an ETIMEDOUT error and is NOT re-run one-shot', async () => {
    const { host } = makeHost(() => { /* hang */ });
    configurePsHost({ scriptsDir: () => 'C:\\s', host });
    await expect(psCommand('Slow', { timeoutMs: 30, idempotent: true })).rejects.toThrow(/timed out.*ETIMEDOUT/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('abortPsWork rejects in-flight host work as an AbortError', async () => {
    const { host } = makeHost(() => { /* hang */ });
    configurePsHost({ scriptsDir: () => 'C:\\s', host });
    const p = psCommand('Long', { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(abortPsWork()).toBeGreaterThanOrEqual(1);
    await expect(p).rejects.toThrow(/AbortError/);
  });

  it('rejects script names with path separators', async () => {
    await expect(psScript('..\\evil.ps1', {}, { timeoutMs: 100 })).rejects.toThrow(/invalid script name/);
  });
});

describe('non-Windows guard', () => {
  it('psScript / psCommand / oneShot refuse on darwin without spawning', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      await expect(psScript('focus-window.ps1', {}, { timeoutMs: 1000 })).rejects.toThrow(/Windows-only/);
      await expect(psCommand('Get-Thing', { timeoutMs: 1000 })).rejects.toThrow(/Windows-only/);
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: 'win32' });
    }
  });
});
