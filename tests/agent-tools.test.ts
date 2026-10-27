import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import {
  createAgentToolHandlers, resolveAgentAsk, cancelAllAgentAsks, isAgentBusy, truncateSay, placeBeside, gestureToward,
  schemas, SAY_MAX_CHARS, type AgentToolDeps, type Rect,
} from '../src/main/agent-tools';
import { z } from 'zod';

const WA: Rect = { x: 0, y: 0, width: 1920, height: 1040 };

function makeDeps(over: Partial<AgentToolDeps> = {}) {
  const sent: Array<[string, unknown]> = [];
  let bounds: Rect = { x: 1700, y: 800, width: 200, height: 200 };
  const deps: AgentToolDeps = {
    platform: 'win32',
    version: '0.21.0',
    allowedTools: () => ['read_screen', 'write_file', 'shell_exec', 'play_animation', 'desktop_screenshot'],
    isBrainBusy: () => false,
    send: (channel, payload) => { sent.push([channel, payload]); return true; },
    getWindowBounds: () => bounds,
    setWindowBounds: (r) => { bounds = r; },
    noteManualMove: vi.fn(),
    displays: () => [{ id: 1, bounds: WA, workArea: WA, scaleFactor: 1, primary: true }],
    displayNearest: () => ({ id: 1, bounds: WA, workArea: WA, scaleFactor: 1, primary: true }),
    executeTool: vi.fn(async (name) => ({ text: `ran ${name}` })),
    classFor: (name) => (name === 'read_screen' || name === 'play_animation' || name === 'desktop_screenshot' ? 'read_only' : name === 'write_file' ? 'destructive_file' : 'destructive_exec'),
    decide: (name) => (name === 'read_screen' || name === 'play_animation' || name === 'desktop_screenshot' ? 'allow' : 'approve'),
    summarizeArgs: (name) => `do ${name}`,
    requestApproval: vi.fn(async () => 'approved' as const),
    markApproved: vi.fn(),
    glideMs: 1,
    ...over,
  };
  return { deps, sent, getBounds: () => bounds };
}

beforeEach(() => cancelAllAgentAsks());

describe('schemas', () => {
  it('validate arguments the way the MCP layer will', () => {
    const say = z.object(schemas.say);
    expect(say.safeParse({ text: 'hi' }).success).toBe(true);
    expect(say.safeParse({ text: '' }).success).toBe(false);
    expect(say.safeParse({}).success).toBe(false);
    const animate = z.object(schemas.animate);
    expect(animate.safeParse({ animation: 'Congratulate' }).success).toBe(true);
    expect(animate.safeParse({ animation: 'Moonwalk' }).success).toBe(false);
    const ask = z.object(schemas.askUser);
    expect(ask.safeParse({ question: 'q', options: ['a'] }).success).toBe(false);
    expect(ask.safeParse({ question: 'q', options: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(false);
    expect(ask.safeParse({ question: 'q', options: ['a', 'b'], timeout_seconds: 1 }).success).toBe(false);
    expect(ask.safeParse({ question: 'q', options: ['a', 'b'], timeout_seconds: 30 }).success).toBe(true);
    const point = z.object(schemas.pointAt);
    expect(point.safeParse({ x: 1, y: 2 }).success).toBe(true);
    expect(point.safeParse({ x: '1', y: 2 }).success).toBe(false);
    const run = z.object(schemas.runTool);
    expect(run.safeParse({ name: 'read_screen' }).success).toBe(true);
    expect(run.safeParse({ name: 'x', args: 'nope' }).success).toBe(false);
  });
});

describe('helpers', () => {
  it('truncateSay cuts visibly at the cap', () => {
    expect(truncateSay('  hi  ')).toBe('hi');
    const long = 'x'.repeat(SAY_MAX_CHARS + 50);
    const out = truncateSay(long);
    expect(out.startsWith('x'.repeat(SAY_MAX_CHARS))).toBe(true);
    expect(out).toContain('(+50 more chars cut)');
  });

  it('placeBeside stands Clippy bottom-right of the point, flipping and clamping at edges', () => {
    const win = { width: 200, height: 200 };
    expect(placeBeside({ x: 100, y: 100 }, win, WA)).toEqual({ x: 140, y: 140, width: 200, height: 200 });
    // near the right/bottom edge → flip to the left/top side
    expect(placeBeside({ x: 1900, y: 1030 }, win, WA)).toEqual({ x: 1660, y: 790, width: 200, height: 200 });
    // off-screen point → clamped into the work area
    expect(placeBeside({ x: -500, y: -500 }, win, WA)).toEqual({ x: 0, y: 0, width: 200, height: 200 });
    // secondary monitor to the left
    const left: Rect = { x: -1920, y: 0, width: 1920, height: 1080 };
    const r = placeBeside({ x: -1910, y: 1075 }, win, left);
    expect(r.x).toBeGreaterThanOrEqual(left.x);
    expect(r.y + r.height).toBeLessThanOrEqual(left.y + left.height);
  });

  it('gestureToward picks the dominant axis', () => {
    expect(gestureToward({ x: 100, y: 100 }, { x: 0, y: 90 })).toBe('GestureLeft');
    expect(gestureToward({ x: 100, y: 100 }, { x: 300, y: 90 })).toBe('GestureRight');
    expect(gestureToward({ x: 100, y: 100 }, { x: 110, y: 0 })).toBe('GestureUp');
    expect(gestureToward({ x: 100, y: 100 }, { x: 110, y: 400 })).toBe('GestureDown');
  });
});

describe('clippy_say / clippy_animate / clippy_point_at', () => {
  it('say sends clippy-speak with the truncated text', async () => {
    const { deps, sent } = makeDeps();
    const h = createAgentToolHandlers(deps);
    const r = await h.say({ text: 'Hello **there**' });
    expect(r.isError).toBeUndefined();
    expect(sent).toEqual([['clippy-speak', { text: 'Hello **there**', animate: 'Explain' }]]);
  });

  it('say with wait_for_dismiss shows an OK button and waits', async () => {
    const { deps, sent } = makeDeps();
    const h = createAgentToolHandlers(deps);
    const p = h.say({ text: 'Read me', wait_for_dismiss: true });
    const [channel, payload] = sent[0] as [string, { id: string; options: string[] }];
    expect(channel).toBe('agent-ask');
    expect(payload.options).toEqual(['OK']);
    expect(resolveAgentAsk(payload.id, 'OK')).toBe(true);
    expect((await p).content[0]).toEqual({ type: 'text', text: 'The user clicked OK.' });
  });

  it('errors when there is no window', async () => {
    const { deps } = makeDeps({ send: () => false });
    const h = createAgentToolHandlers(deps);
    expect((await h.say({ text: 'x' })).isError).toBe(true);
    expect((await h.animate({ animation: 'Wave' })).isError).toBe(true);
  });

  it('point_at glides beside the point, notes a manual move, and gestures toward it', async () => {
    const { deps, sent, getBounds } = makeDeps();
    const h = createAgentToolHandlers(deps);
    const r = await h.pointAt({ x: 100, y: 100, label: 'Here' });
    expect(r.isError).toBeUndefined();
    expect(getBounds()).toEqual({ x: 140, y: 140, width: 200, height: 200 });
    expect(deps.noteManualMove).toHaveBeenCalled();
    // Clippy's centre is (240, 240): equally left and up of the point → horizontal wins.
    expect(sent.at(-1)).toEqual(['clippy-speak', { text: 'Here', animate: 'GestureLeft' }]);
    expect((r.content[0] as { text: string }).text).toContain('(140, 140)');
  });
});

describe('clippy_ask_user', () => {
  it('returns the clicked option verbatim', async () => {
    const { deps, sent } = makeDeps();
    const h = createAgentToolHandlers(deps);
    const p = h.askUser({ question: 'Which?', options: ['Yes', 'No', 'No'] });
    const payload = sent[0][1] as { id: string; question: string; options: string[] };
    expect(payload.options).toEqual(['Yes', 'No']); // duplicates dropped
    resolveAgentAsk(payload.id, 'No');
    expect((await p).content[0]).toEqual({ type: 'text', text: 'No' });
    expect(resolveAgentAsk(payload.id, 'Yes')).toBe(false); // settled once
  });

  it('returns "timeout" when nobody answers and "dismissed" on cancel', async () => {
    vi.useFakeTimers();
    try {
      const { deps, sent } = makeDeps();
      const h = createAgentToolHandlers(deps);
      const p = h.askUser({ question: 'Which?', options: ['A', 'B'], timeout_seconds: 5 });
      vi.advanceTimersByTime(5001);
      expect((await p).content[0]).toEqual({ type: 'text', text: 'timeout' });
      const p2 = h.askUser({ question: 'Again?', options: ['A', 'B'] });
      expect(sent.length).toBe(2);
      cancelAllAgentAsks();
      expect((await p2).content[0]).toEqual({ type: 'text', text: 'dismissed' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('busy arbitration', () => {
  it('refuses with (error:busy) while the brain is executing', async () => {
    const { deps } = makeDeps({ isBrainBusy: () => true });
    const h = createAgentToolHandlers(deps);
    const r = await h.say({ text: 'x' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('(error:busy)');
  });

  it('isAgentBusy is true only while a call is in flight', async () => {
    const { deps, sent } = makeDeps();
    const h = createAgentToolHandlers(deps);
    expect(isAgentBusy()).toBe(false);
    const p = h.askUser({ question: 'q', options: ['a', 'b'] });
    expect(isAgentBusy()).toBe(true);
    resolveAgentAsk((sent[0][1] as { id: string }).id, 'a');
    await p;
    expect(isAgentBusy()).toBe(false);
  });
});

describe('clippy_screenshot / clippy_status', () => {
  it('screenshot returns an image content block', async () => {
    const { deps } = makeDeps({ executeTool: async () => ({ text: 'shot', image: { data: 'AAAA', mimeType: 'image/png' } }) });
    const r = await createAgentToolHandlers(deps).screenshot();
    expect(r.content).toEqual([{ type: 'text', text: 'shot' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
  });

  it('status lists displays, window, and allowed tools', async () => {
    const { deps } = makeDeps();
    const r = await createAgentToolHandlers(deps).status();
    const s = JSON.parse((r.content[0] as { text: string }).text);
    expect(s.version).toBe('0.21.0');
    expect(s.busy).toBe(false);
    expect(s.displays[0].workArea).toEqual(WA);
    expect(s.allowed_tools).toContain('read_screen');
    expect(s.animations).toContain('Congratulate');
  });
});

describe('clippy_run_tool policy gate', () => {
  it('rejects names outside the allow-list without touching the dispatcher', async () => {
    const { deps } = makeDeps();
    const r = await createAgentToolHandlers(deps).runTool({ name: 'skill__evil', args: {} });
    expect(r.isError).toBe(true);
    expect(deps.executeTool).not.toHaveBeenCalled();
  });

  it('runs read-only tools immediately, no approval', async () => {
    const { deps } = makeDeps();
    const r = await createAgentToolHandlers(deps).runTool({ name: 'read_screen' });
    expect(r.isError).toBeUndefined();
    expect(deps.requestApproval).not.toHaveBeenCalled();
    expect(deps.executeTool).toHaveBeenCalledWith('read_screen', {});
  });

  it('destructive tools go through the approval UI, then run and are marked approved', async () => {
    const { deps } = makeDeps();
    const r = await createAgentToolHandlers(deps).runTool({ name: 'write_file', args: { path: 'x', content: 'y' } });
    expect(deps.requestApproval).toHaveBeenCalledWith({ tool: 'write_file', summary: 'do write_file', actionClass: 'destructive_file' });
    expect(deps.markApproved).toHaveBeenCalledWith('write_file', { path: 'x', content: 'y' });
    expect(deps.executeTool).toHaveBeenCalledWith('write_file', { path: 'x', content: 'y' });
    expect(r.isError).toBeUndefined();
  });

  it('a denied / timed-out approval returns an error and never executes', async () => {
    for (const verdict of ['denied', 'timeout', 'cancelled'] as const) {
      const { deps } = makeDeps({ requestApproval: async () => verdict });
      const r = await createAgentToolHandlers(deps).runTool({ name: 'shell_exec', args: { command: 'rm -rf /' } });
      expect(r.isError).toBe(true);
      expect((r.content[0] as { text: string }).text).toContain(`(error:user_denied)`);
      expect((r.content[0] as { text: string }).text).toContain(verdict);
      expect(deps.executeTool).not.toHaveBeenCalled();
    }
  });

  it('destructive classes always prompt for an outside agent even when the policy says allow (trusted mode)', async () => {
    const { deps } = makeDeps({ decide: () => 'allow' });
    await createAgentToolHandlers(deps).runTool({ name: 'write_file', args: {} });
    expect(deps.requestApproval).toHaveBeenCalled();
  });

  it('a governor-escalated click prompts with the reason, using the escalated class', async () => {
    const { deps } = makeDeps({
      allowedTools: () => ['smart_click'],
      classFor: (_n, _a, escalate) => escalate ?? 'desktop_input',
      decide: (_n, _a, escalate) => (escalate ? 'approve' : 'allow'),
      assessRisk: async (name) => (name === 'smart_click' ? { class: 'destructive_purchase', reason: "Looks like a purchase button: 'Place order'" } : null),
    });
    await createAgentToolHandlers(deps).runTool({ name: 'smart_click', args: { target: 'Place order' } });
    expect(deps.requestApproval).toHaveBeenCalledWith({
      tool: 'smart_click', actionClass: 'destructive_purchase',
      summary: "Looks like a purchase button: 'Place order' — do smart_click",
    });
    expect(deps.executeTool).toHaveBeenCalled();
  });

  it('blocked classes return policy_blocked', async () => {
    const { deps } = makeDeps({ decide: () => 'block' });
    const r = await createAgentToolHandlers(deps).runTool({ name: 'shell_exec', args: {} });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('(error:policy_blocked)');
    expect(deps.executeTool).not.toHaveBeenCalled();
  });

  it('surfaces (error:…) tool output as isError and passes images through', async () => {
    const { deps } = makeDeps({ executeTool: async () => ({ text: '(error:UNKNOWN_TOOL) nope' }) });
    const r = await createAgentToolHandlers(deps).runTool({ name: 'read_screen' });
    expect(r.isError).toBe(true);
    const { deps: d2 } = makeDeps({ executeTool: async () => ({ text: 'ok', image: { data: 'QQ', mimeType: 'image/png' } }) });
    const r2 = await createAgentToolHandlers(d2).runTool({ name: 'desktop_screenshot' });
    expect(r2.content[1]).toEqual({ type: 'image', data: 'QQ', mimeType: 'image/png' });
  });
});
