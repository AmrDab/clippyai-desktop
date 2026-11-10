/**
 * telemetry.ts — envelope shape, scrubbing, opt-out, daily cap, dev no-op,
 * network failure. electron is mocked; fetch is stubbed (no real network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { tmp, electronApp } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nfs = require('fs') as typeof import('fs'); const nos = require('os') as typeof import('os'); const npath = require('path') as typeof import('path');
  const dir = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'telemetry-'));
  return { tmp: dir, electronApp: { isPackaged: true, getPath: () => dir, getVersion: () => '0.22.0', getLocale: () => 'en-US' } };
});
vi.mock('electron', () => ({ app: electronApp }));

import * as t from '../src/main/telemetry';

const HOME = os.homedir();
const fetchMock = vi.fn();

function sentBodies(): Array<Record<string, any>> {
  return fetchMock.mock.calls.flatMap((c) => JSON.parse(c[1].body));
}

beforeEach(() => {
  try { fs.rmSync(path.join(tmp, 'telemetry.json')); } catch { /* none */ }
  t.__resetForTests();
  electronApp.isPackaged = true;
  delete process.env.CLIPPY_TELEMETRY;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ status: 200 });
  vi.stubGlobal('fetch', fetchMock);
  t.initTelemetry({ getPlan: () => 'power' });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('envelope shape', () => {
  it('sends an Application Insights v2 Event envelope to v2.1/track', async () => {
    t.track('app_start', { cold_start_ms: 1234, trigger: 'boot' });
    expect(await t.flush()).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/.+\/v2\.1\/track$/);
    expect(init.method).toBe('POST');
    const [env] = JSON.parse(init.body);
    expect(env.name).toBe('Microsoft.ApplicationInsights.Event');
    expect(env.iKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(env.tags['ai.cloud.role']).toBe('clippy-desktop');
    expect(env.tags['ai.application.ver']).toBe('0.22.0');
    expect(env.tags['ai.device.os']).toBe(process.platform);
    expect(env.tags['ai.user.id']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(env.data.baseType).toBe('EventData');
    expect(env.data.baseData.ver).toBe(2);
    expect(env.data.baseData.name).toBe('app_start');
    expect(env.data.baseData.properties).toMatchObject({ plan: 'power', arch: process.arch, locale: 'en', trigger: 'boot' });
    expect(env.data.baseData.measurements).toEqual({ cold_start_ms: 1234 });
  });

  it('keeps one stable install id, persisted in userData', async () => {
    t.track('a');
    t.track('b');
    await t.flush();
    const ids = new Set(sentBodies().map((e) => e.tags['ai.user.id']));
    expect(ids.size).toBe(1);
    const file = JSON.parse(fs.readFileSync(path.join(tmp, 'telemetry.json'), 'utf8'));
    expect(file.installId).toBe([...ids][0]);
  });

  it('builds Exception and Metric envelopes', async () => {
    t.trackException(new TypeError('boom'), { where: 'main' });
    t.trackMetric('cold_start_ms', 900);
    await t.flush();
    const [ex, m] = sentBodies();
    expect(ex.data.baseType).toBe('ExceptionData');
    // No message text ever leaves — only an error code ('other' when there is none).
    expect(ex.data.baseData.exceptions[0]).toMatchObject({ typeName: 'TypeError', message: 'other' });
    expect(m.data.baseType).toBe('MetricData');
    expect(m.data.baseData.metrics[0]).toMatchObject({ name: 'cold_start_ms', value: 900 });
  });

  it('maps an unknown plan to "unknown" (never the key)', async () => {
    t.initTelemetry({ getPlan: () => 'CLIPPY-AB12-CD34-EF56' });
    t.track('x');
    await t.flush();
    expect(sentBodies()[0].data.baseData.properties.plan).toBe('unknown');
  });
});

describe('scrubbing', () => {
  it('removes home paths, other paths, emails, license keys, URLs, IPs and tokens', () => {
    const raw = [
      `ENOENT: open '${path.join(HOME, 'Documents', 'taxes 2025.xlsx')}'`,
      `C:\\Projects\\My Stuff\\secret.docx`,
      `/Volumes/Backup Drive/notes.txt and /home/bob/.ssh/id_rsa`,
      'mail jane.doe@example.com',
      'key CLIPPY-AB12-CD34-EF56 old CLIP-AAAA-BBBB-CCCC-DDDD',
      'GET https://bank.example.com/account?id=42&token=abc',
      'connect ECONNREFUSED 192.168.1.20:443',
      'token abcdefghijklmnopqrstuvwxyz0123456789ABCD',
      `user ${os.userInfo().username}`,
    ].join(' | ');
    const out = t.scrubText(raw, 5000);
    for (const leak of ['taxes', '2025.xlsx','Documents', 'Projects', 'Stuff', 'secret.docx', 'Backup', 'notes.txt', 'bob', 'id_rsa',
      'jane.doe', 'example.com', 'AB12', 'AAAA', 'bank', 'account', 'token=abc', '192.168', 'abcdefghijklmnop']) {
      expect(out, leak).not.toContain(leak);
    }
    expect(out).not.toContain(HOME);
    if (os.userInfo().username.length > 2) expect(out).not.toContain(os.userInfo().username);
    expect(out).toContain('<email>');
    expect(out).toContain('CLIPPY-****');
    expect(out).toContain('<url>');
    expect(out).toContain('<ip>');
  });

  it('keeps allow-listed hosts but drops their path + query', () => {
    expect(t.scrubText('fetch failed https://api.clippyai.app/v1/turn?key=CLIPPY-1234-5678-9ABC')).toBe('fetch failed https://api.clippyai.app');
  });

  it('keeps the app-relative tail of bundled stack frames', () => {
    const stack = `Error: x\n    at f (C:\\Users\\someone\\AppData\\Local\\Programs\\ClippyAI\\resources\\app.asar\\out\\main\\index.js:12:5)\n    at g (file:///Applications/ClippyAI.app/Contents/Resources/app.asar/out/main/brain.js:9:1)`;
    const out = t.scrubStack(stack);
    expect(out).toContain('<app>/out/main/index.js:12:5');
    expect(out).toContain('<app>/out/main/brain.js:9:1');
    expect(out).not.toContain('someone');
    expect(out).not.toContain('Applications');
  });

  it('caps stack length', () => {
    const big = 'Error: x\n' + Array.from({ length: 200 }, (_, i) => `    at fn${i} (<anonymous>)`).join('\n');
    expect(t.scrubStack(big).length).toBeLessThanOrEqual(2001);
  });

  it('scrubs exception messages, stacks and string props before sending', async () => {
    const err = new Error(`cannot read ${path.join(HOME, 'secret.txt')} for a@b.co`);
    err.stack = `Error: x\n    at y (${path.join(HOME, 'proj', 'z.js')}:1:1)`;
    t.trackException(err, { note: 'https://evil.example/x?q=1' });
    t.track('e', { where: 'C:\\Users\\Other Person\\Desktop\\x.txt' });
    await t.flush();
    const body = fetchMock.mock.calls[0][1].body as string;
    expect(body).not.toContain('secret.txt');
    expect(body).not.toContain('a@b.co');
    expect(body).not.toContain('evil.example');
    expect(body).not.toContain('Other Person');
    expect(body).not.toContain(JSON.stringify(HOME).slice(1, -1));
  });

  it('only sends known tool names; skills/unknown are bucketed', () => {
    expect(t.toolBucket('open_app')).toBe('open_app');
    expect(t.toolBucket('skill__my-private-skill')).toBe('skill');
    expect(t.toolBucket('mcp__someone__thing')).toBe('other');
  });
});

describe('opt-out + gating', () => {
  it('Settings toggle off: stops sends immediately and clears the queue', async () => {
    t.track('queued_before_optout');
    expect(t.__queueForTests().length).toBe(1);
    t.setTelemetryEnabled(false);
    expect(t.__queueForTests().length).toBe(0);
    t.track('after_optout');
    expect(await t.flush()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.isTelemetryEnabled()).toBe(false);
    // persisted
    t.__resetForTests();
    expect(t.isActive()).toBe(false);
    t.setTelemetryEnabled(true);
    expect(t.isActive()).toBe(true);
  });

  it('CLIPPY_TELEMETRY=0 disables everything', async () => {
    process.env.CLIPPY_TELEMETRY = '0';
    t.track('x');
    expect(await t.flush()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dev build (not packaged) is a no-op — writes nothing, sends nothing', async () => {
    electronApp.isPackaged = false;
    t.__resetForTests();
    try { fs.rmSync(path.join(tmp, 'telemetry.json')); } catch { /* none */ }
    t.track('x');
    t.trackException(new Error('y'));
    expect(t.__queueForTests().length).toBe(0);
    expect(await t.flush()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmp, 'telemetry.json'))).toBe(false);
  });

  it('dev build with CLIPPY_TELEMETRY=1 sends', async () => {
    electronApp.isPackaged = false;
    process.env.CLIPPY_TELEMETRY = '1';
    t.track('x');
    expect(await t.flush()).toBe(200);
  });
});

describe('containment', () => {
  it('enforces the daily cap, persisted across restarts', async () => {
    for (let i = 0; i < t.DAILY_CAP + 50; i++) {
      t.track('spam');
      if (i % 100 === 99) await t.flush();
    }
    await t.flush();
    expect(sentBodies().length).toBe(t.DAILY_CAP);
    // "restart": module state reset, counter comes back from disk
    t.__resetForTests();
    t.track('after_restart');
    await t.flush();
    expect(sentBodies().length).toBe(t.DAILY_CAP);
  });

  it('dedupes the same exception after 3 per session (crash loop)', async () => {
    for (let i = 0; i < 20; i++) t.trackException(new Error('same thing'));
    await t.flush();
    expect(sentBodies().length).toBe(3);
  });

  it('network failure never throws; the batch is retried once with the next flush', async () => {
    fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));
    t.track('x');
    await expect(t.flush()).resolves.toBe(0);
    expect(t.__queueForTests().length).toBe(0);
    // the second flush resends the same batch (plus anything new)
    t.track('y');
    expect(await t.flush()).toBe(200);
    expect(sentBodies().map((b) => b.data.baseData.name)).toEqual(['x', 'x', 'y']);
  });

  it('a batch that fails twice is dropped, counted, and reported on the next start', async () => {
    fetchMock.mockResolvedValue({ status: 503 });
    t.track('x');
    await t.flush();
    await t.flush();
    fetchMock.mockClear();
    expect(await t.flush()).toBe(0); // nothing left to send
    expect(fetchMock).not.toHaveBeenCalled();
    t.__resetForTests();
    t.initTelemetry({ getPlan: () => 'free' });
    expect(t.startInfo().dropped).toBe(1);
  });

  it('does not retry a 4xx', async () => {
    fetchMock.mockResolvedValue({ status: 400 });
    t.track('x');
    await t.flush();
    fetchMock.mockClear();
    expect(await t.flush()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.isRetryableStatus(0)).toBe(true);
    expect(t.isRetryableStatus(429)).toBe(true);
    expect(t.isRetryableStatus(500)).toBe(true);
    expect(t.isRetryableStatus(400)).toBe(false);
    expect(t.isRetryableStatus(206)).toBe(false);
  });

  it('a throwing fetch implementation is contained', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('sync throw'); });
    t.track('x');
    await expect(t.flush()).resolves.toBe(0);
  });
});

describe('task health', () => {
  it('summarises a task: outcome, error kind, steps, bucketed time, tool failures by name only', async () => {
    t.taskBegin();
    t.taskToolFailed('open_app', '(error:PLATFORM_UNSUPPORTED) nope');
    t.taskToolFailed('open_app', '(error) x');
    t.taskToolFailed('skill__secret-thing', 'C:\\x');
    t.taskTurnError('timeout');
    t.taskEnd('done', null, 4);
    await t.flush();
    const e = sentBodies()[0].data.baseData;
    expect(e.name).toBe('task_end');
    expect(e.properties).toMatchObject({ outcome: 'error', error_kind: 'timeout', elapsed: '<5s', tool_failures: 'open_app:2,skill:1' });
    expect(e.measurements).toMatchObject({ steps: 4, platform_unsupported: 1, tool_failure_count: 3 });
  });

  it('maps user stop to cancelled and loop abort to error', async () => {
    t.taskBegin(); t.taskEnd('stopped', 'user_stop', 2);
    t.taskBegin(); t.taskEnd('stuck', 'loop_detector', 9);
    t.taskBegin(); t.taskEnd('done', null, 1);
    t.taskEnd('done', null, 1); // no begin → ignored
    await t.flush();
    const props = sentBodies().map((b) => b.data.baseData.properties);
    expect(props.map((p) => p.outcome)).toEqual(['cancelled', 'error', 'ok']);
    expect(props[1].error_kind).toBe('loop_detector');
  });

  it('elapsed buckets', () => {
    expect(t.elapsedBucket(100)).toBe('<5s');
    expect(t.elapsedBucket(20_000)).toBe('15-30s');
    expect(t.elapsedBucket(10 * 60_000)).toBe('>5m');
  });
});

describe('quit', () => {
  it('holds the quit once, flushes (app_quit included), then quits', async () => {
    t.track('x');
    const preventDefault = vi.fn();
    let quitCalled!: () => void;
    const quitted = new Promise<void>((r) => { quitCalled = r; });
    t.onBeforeQuit({ preventDefault }, () => quitCalled());
    await quitted;
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(sentBodies().map((b) => b.data.baseData.name)).toEqual(['x', 'app_quit']);
    // second before-quit (from the re-issued quit) passes straight through
    t.onBeforeQuit({ preventDefault }, () => { throw new Error('must not re-quit'); });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('never holds the quit when telemetry is off', () => {
    t.setTelemetryEnabled(false);
    const preventDefault = vi.fn();
    t.onBeforeQuit({ preventDefault }, () => { /* noop */ });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('a hung endpoint cannot hold the quit past the 2 s budget', async () => {
    fetchMock.mockImplementation((_u: string, init: { signal: AbortSignal }) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    t.track('x');
    const start = Date.now();
    await new Promise<void>((r) => t.onBeforeQuit({ preventDefault: () => {} }, r));
    expect(Date.now() - start).toBeLessThan(t.QUIT_FLUSH_TIMEOUT_MS + 500);
  });
});

describe('hook helpers', () => {
  it('renderer_gone keeps only the page name', async () => {
    t.trackRendererGone({ getURL: () => 'file:///C:/Users/x/app.asar/out/renderer/game-overlay.html' }, { reason: 'crashed', exitCode: -1 });
    await t.flush();
    expect(sentBodies()[0].data.baseData.properties).toMatchObject({ page: 'game-overlay', reason: 'crashed' });
  });

  it('agent_connected sends the client name only, once', async () => {
    t.trackAgentClients(['Claude Code 1.2.3']);
    t.trackAgentClients(['Claude Code 1.2.3', 'cursor v0.9']);
    await t.flush();
    expect(sentBodies().map((b) => b.data.baseData.properties.client)).toEqual(['Claude Code', 'cursor']);
  });

  it('counts only new .dmp files', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dumps-'));
    fs.mkdirSync(path.join(d, 'reports'));
    fs.writeFileSync(path.join(d, 'reports', 'a.dmp'), 'x');
    fs.writeFileSync(path.join(d, 'reports', 'b.txt'), 'x');
    expect(t.countDumpsSince(d, 0)).toBe(1);
    expect(t.countDumpsSince(d, Date.now() + 60_000)).toBe(0);
  });
});

describe('free text never leaves as-is (security review)', () => {
  it('messageShape drops quoted content and long numbers, keeps codes', async () => {
    const t = await import('../src/main/telemetry');
    const s = t.messageShape(`ENOENT: no such file 'Tax Return 2026 final' and "my secret reply" id 123456`);
    expect(s).toBe('ENOENT');
    expect(t.messageShape(`can't open 'cut off quote with secret
line two`)).toBe('other');
  });
  it('scrubStack keeps frames only — not the message line', async () => {
    const t = await import('../src/main/telemetry');
    const out = t.scrubStack('TypeError: user wrote hello world\n    at foo (C:/Users/x/app/out/main/index.js:1:2)');
    expect(out).not.toContain('hello world');
    expect(out).toMatch(/^\s*at foo/);
    // a message line that merely starts with "at" is not a frame
    expect(t.scrubStack('Error: x\n at the bank my pin is 1234\n    at bar (C:/a/out/main/x.js:3:4)')).not.toContain('pin');
  });
  it('errorCode maps text to a code or other', async () => {
    const t = await import('../src/main/telemetry');
    expect(t.errorCode('getaddrinfo ENOTFOUND github.com')).toBe('ENOTFOUND');
    expect(t.errorCode('HttpError: 404 status 404 Not Found')).toBe('HTTP 404');
    expect(t.errorCode('something with the user name Bob')).toBe('other');
  });
});

describe('per-session seq', () => {
  it('numbers events 1..n so a gap means a lost event', async () => {
    t.track('a'); t.track('b'); t.trackMetric('m', 1); t.trackException(new Error('boom'));
    await t.flush();
    expect(sentBodies().map((b) => b.data.baseData.properties.seq)).toEqual(['1', '2', '3', '4']);
  });
});

describe('internal tag', () => {
  it('is added only on owner machines (CLIPPY_INTERNAL=1 or an internal file)', async () => {
    t.track('plain');
    await t.flush();
    process.env.CLIPPY_INTERNAL = '1';
    t.__resetForTests();
    t.initTelemetry({ getPlan: () => 'power' });
    t.track('mine');
    delete process.env.CLIPPY_INTERNAL;
    await t.flush();
    const bodies = sentBodies();
    expect(bodies[0].data.baseData.properties.internal).toBeUndefined();
    expect(bodies[1].data.baseData.properties.internal).toBe('true');
    t.__resetForTests();
    fs.writeFileSync(path.join(tmp, 'internal'), '');
    expect(t.isInternal()).toBe(true);
    fs.rmSync(path.join(tmp, 'internal'));
    t.__resetForTests();
    expect(t.isInternal()).toBe(false);
  });
});

describe('start info: prev_exit, first_run, prev_version', () => {
  it('pure decisions', () => {
    expect(t.decidePrevExit(true, false)).toBe('first_run');
    expect(t.decidePrevExit(true, true)).toBe('first_run');
    expect(t.decidePrevExit(false, true)).toBe('unclean');
    expect(t.decidePrevExit(false, false)).toBe('clean');
    expect(t.previousVersion('0.23.2', '0.24.0')).toBe('0.23.2');
    expect(t.previousVersion('0.24.0', '0.24.0')).toBeUndefined();
    expect(t.previousVersion('', '0.24.0')).toBeUndefined();
  });
  it('first run, then unclean when the marker was never removed, then clean after a quit', () => {
    expect(t.startInfo()).toMatchObject({ prev_exit: 'first_run', first_run: true });
    t.__resetForTests();
    t.initTelemetry({ getPlan: () => 'free' }); // the previous session left its marker behind
    expect(t.startInfo().prev_exit).toBe('unclean');
    expect(t.startInfo().first_run).toBeUndefined();
    t.onBeforeQuit({ preventDefault: () => {} }, () => {});
    t.__resetForTests();
    t.initTelemetry({ getPlan: () => 'free' });
    expect(t.startInfo().prev_exit).toBe('clean');
  });
});

describe('task_end fields', () => {
  async function ended(fn: () => void): Promise<{ properties: Record<string, string>; measurements: Record<string, number> }> {
    t.taskBegin(); fn(); t.taskEnd('done', null, 2, { completed: true, actions: 0 });
    await t.flush();
    return sentBodies().filter((b) => b.data.baseData.name === 'task_end').pop()!.data.baseData;
  }
  it('drops result; adds completed, actions, kind, ended_with and the speed fields', async () => {
    const e = await ended(() => {
      t.taskScreenCtx('timeout');
      t.taskBeforeTurn();
      t.taskTurn({ ms: 1800, provider: 'DeepSeek', finishReason: 'stop' });
      t.taskTurn({ ms: 900, provider: 'DeepSeek', finishReason: 'tool_calls' });
    });
    expect(e.properties.result).toBeUndefined();
    expect(e.properties).toMatchObject({
      completed: 'true', kind: 'chat', ended_with: 'answer', screen_ctx: 'timeout',
      pre_turn: '<250ms', model_time: '2.5-5s', provider: 'deepseek', finish_reason: 'tool_calls',
    });
    expect(e.measurements).toMatchObject({ actions: 0, steps: 2 });
  });
  it('kind is action when tools ran; tools_used lists name:count', async () => {
    t.taskBegin();
    t.taskToolUsed('open_app'); t.taskToolUsed('open_app'); t.taskToolUsed('skill__secret');
    t.taskEnd('done', null, 3, { completed: true, actions: 2 });
    await t.flush();
    const e = sentBodies().pop()!.data.baseData;
    expect(e.properties).toMatchObject({ kind: 'action', tools_used: 'open_app:2,skill:1' });
    expect(e.measurements.actions).toBe(2);
  });
  it('ended_with: upsell, cap, decline, error, answer', () => {
    expect(t.endedWith('', true, false)).toBe('upsell');
    expect(t.endedWith('', false, true)).toBe('cap');
    expect(t.endedWith('limit_reached', false, false)).toBe('cap');
    expect(t.endedWith('feature_locked', false, false)).toBe('decline');
    expect(t.endedWith('timeout', false, false)).toBe('error');
    expect(t.endedWith('', false, false)).toBe('answer');
  });
  it('screen_ctx defaults to off when no capture was recorded', async () => {
    const e = await ended(() => {});
    expect(e.properties.screen_ctx).toBe('off');
    expect(e.properties.pre_turn).toBeUndefined();
  });
});

describe('quit stats and the deliberate test exception', () => {
  it('app_quit carries uptime, tasks and proactive counters', async () => {
    t.taskBegin(); t.taskEnd('done', null, 1);
    t.noteProactive('shown'); t.noteProactive('shown'); t.noteProactive('muted');
    t.onBeforeQuit({ preventDefault: () => {} }, () => {});
    await t.flush();
    const q = sentBodies().find((b) => b.data.baseData.name === 'app_quit')!.data.baseData;
    expect(q.properties.uptime).toMatch(/^(<5s|5-15s|15-30s|30-60s|1-2m|2-5m|>5m)$/);
    expect(q.measurements).toMatchObject({ tasks: 1, proactive_shown: 2, proactive_muted: 1 });
  });
  it('sendTestException sends one TelemetryTestException', async () => {
    t.sendTestException();
    await new Promise((r) => setTimeout(r, 0));
    const ex = sentBodies().find((b) => b.name === 'Microsoft.ApplicationInsights.Exception');
    expect(ex!.data.baseData.exceptions[0].typeName).toBe('TelemetryTestException');
  });
});
