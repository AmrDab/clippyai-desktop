import { describe, it, expect, vi, beforeAll } from 'vitest';
import { EventEmitter } from 'events';

/**
 * clawdcursor v1.x contract (ported from clippyai-macos#22): submit_task is
 * fire-and-accept, so submitClawdTask polls agent_status until idle and sends
 * abort_task on timeout; MCP `isError` results surface as (error:…).
 * Everything external is faked — no daemon, no port 3847, no real token file.
 */

const state = vi.hoisted(() => ({
  calls: [] as string[],
  respond: (_tool: string): { text: string; isError?: boolean } => ({ text: '[]' }),
}));

vi.mock('electron', () => ({ Notification: class { show() {} } }));
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  serializeErr: (e: unknown) => e,
}));
vi.mock('os', async (orig) => {
  const real = (await orig()) as typeof import('os');
  const fs = await import('fs');
  const path = await import('path');
  const home = fs.mkdtempSync(path.join(real.tmpdir(), 'clawd-test-')); // token file lands here
  const mocked = { ...real, homedir: () => home };
  return { ...mocked, default: mocked };
});
vi.mock('child_process', async () => {
  const { promisify } = await import('util');
  const execFile = Object.assign(
    (_cmd: string, _args: string[], _opts: unknown, cb?: (e: Error | null) => void) => { cb?.(null); },
    { [promisify.custom]: async () => ({ stdout: '/fake/bin/clawdcursor\n', stderr: '' }) },
  );
  const spawn = () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {},
    });
    setTimeout(() => child.stdout.emit('data', Buffer.from('desktop control active on 127.0.0.1:3847\n')), 5);
    return child;
  };
  return { execFile, spawn, default: { execFile, spawn } };
});
vi.mock('http', () => {
  const request = (_opts: unknown, cb: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = Object.assign(new EventEmitter(), {
      body: '',
      write(b: string) { this.body += b; },
      destroy() {},
      end() {
        const rpc = JSON.parse(this.body);
        const tool = rpc.params?.name ?? rpc.method;
        state.calls.push(tool);
        const r = state.respond(tool);
        const res = Object.assign(new EventEmitter(), { statusCode: 200 });
        cb(res);
        res.emit('data', Buffer.from(JSON.stringify({
          jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: r.text }], isError: r.isError },
        })));
        res.emit('end');
      },
    });
    return req;
  };
  return { request, get: request, default: { request, get: request } };
});

import { ensureClawd, submitClawdTask, callClawdTool } from '../src/main/clawd-fallback';

beforeAll(async () => {
  state.respond = () => ({ text: '[]' });
  expect(await ensureClawd()).toBe(true);
});

describe('clawdcursor v1.x submit_task contract', () => {
  it('submits, polls agent_status until idle, reports the final step', async () => {
    state.calls.length = 0;
    let polls = 0;
    state.respond = (tool) => {
      if (tool === 'submit_task') return { text: JSON.stringify({ accepted: true, task: 'x' }) };
      if (tool === 'agent_status') {
        polls++;
        return { text: JSON.stringify(polls < 2
          ? { status: 'acting', currentStep: 'typing' }
          : { status: 'idle', lastResult: { success: true, steps: [{ description: 'Typed hello' }] } }) };
      }
      return { text: '' };
    };
    const r = await submitClawdTask('type hello', { appHint: 'notepad', timeoutMs: 10_000 });
    expect(state.calls).toEqual(['submit_task', 'agent_status', 'agent_status']);
    expect(r.text).toMatch(/^clawd_task finished \(1 steps\)\. Typed hello/);
  }, 15_000);

  it('surfaces an isError submit (e.g. --no-llm, busy) as CLAWD_TASK_FAILED', async () => {
    state.respond = () => ({ text: 'submit_task: no autonomous agent is attached', isError: true });
    const r = await submitClawdTask('do it');
    expect(r.text).toMatch(/^\(error:CLAWD_TASK_FAILED\) submit_task: no autonomous agent/);
  });

  it('reports a failed task result as an error', async () => {
    state.respond = (tool) => tool === 'agent_status'
      ? { text: JSON.stringify({ status: 'idle', lastResult: { success: false, steps: [{ description: 'Button not found' }] } }) }
      : { text: '{"accepted":true}' };
    const r = await submitClawdTask('click it', { timeoutMs: 10_000 });
    expect(r.text).toBe('(error:CLAWD_TASK_FAILED) clawdcursor reported the task failed. Button not found');
  }, 15_000);

  it('sends abort_task when the budget runs out', async () => {
    state.calls.length = 0;
    state.respond = (tool) => tool === 'agent_status'
      ? { text: JSON.stringify({ status: 'acting', currentStep: 'thinking hard' }) }
      : { text: '{"accepted":true}' };
    const r = await submitClawdTask('slow task', { timeoutMs: 100 });
    expect(r.text).toMatch(/^\(error:CLAWD_TASK_FAILED\) timed out after 100ms \(last status=acting, step=thinking hard\)/);
    expect(state.calls).toContain('abort_task');
  }, 15_000);

  it('callClawdTool tags an isError tool result', async () => {
    state.respond = () => ({ text: 'Agent is busy (status=acting).', isError: true });
    expect((await callClawdTool('smart_click', { target: 'OK' })).text).toBe('(error:CLAWD_FAILED) Agent is busy (status=acting).');
  });
});
