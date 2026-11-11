import { describe, it, expect, vi } from 'vitest';
import {
  newCtxState, planCapture, recordOutcome, heavyBudgetMs, windowCallFailed, extractProcessName, raceDeadline,
  isScreenQuestion, formatScreenDump, formatOcrContext, SCREEN_Q_OCR_MS,
  CTX_CACHE_MS, PAUSE_AFTER_TIMEOUTS, PAUSE_MS, WINDOW_DEADLINE_MS, HEAVY_DEADLINE_MS, TOTAL_BUDGET_MS,
} from '../src/main/screen-context';

describe('planCapture', () => {
  it('captures with tight deadlines on a fresh state', () => {
    expect(planCapture(newCtxState(), 1000)).toEqual({ kind: 'capture', windowMs: WINDOW_DEADLINE_MS, heavyMs: HEAVY_DEADLINE_MS });
    expect(WINDOW_DEADLINE_MS + HEAVY_DEADLINE_MS).toBeLessThanOrEqual(TOTAL_BUDGET_MS + 200);
  });
  it('reuses a capture younger than the cache window', () => {
    const s = recordOutcome(newCtxState(), 'ok', { text: 'Active: x', process: 'code.exe', at: 10_000 }, 10_000);
    expect(planCapture(s, 10_000 + CTX_CACHE_MS)).toMatchObject({ kind: 'cached' });
    expect(planCapture(s, 10_000 + CTX_CACHE_MS + 1)).toMatchObject({ kind: 'capture' });
  });
  it('pauses after repeated timeouts, then probes again', () => {
    let s = newCtxState();
    for (let i = 0; i < PAUSE_AFTER_TIMEOUTS; i++) s = recordOutcome(s, 'timeout', null, 5_000);
    expect(planCapture(s, 5_001)).toEqual({ kind: 'skip' });
    expect(planCapture(s, 5_000 + PAUSE_MS)).toMatchObject({ kind: 'capture' });
  });
  it('two timeouts alone do not pause; a success resets the count', () => {
    let s = newCtxState();
    s = recordOutcome(s, 'timeout', null, 1);
    s = recordOutcome(s, 'timeout', null, 2);
    expect(planCapture(s, 3).kind).toBe('capture');
    s = recordOutcome(s, 'ok', { text: 't', process: 'p', at: 3 }, 3);
    expect(s.consecutiveTimeouts).toBe(0);
    expect(s.pausedUntil).toBe(0);
  });
  it("'off' leaves the state untouched; 'partial' counts as a success", () => {
    const s = recordOutcome(newCtxState(), 'timeout', null, 1);
    expect(recordOutcome(s, 'off', null, 2)).toBe(s);
    expect(recordOutcome(s, 'partial', { text: 't', process: 'p', at: 2 }, 2).consecutiveTimeouts).toBe(0);
  });
});

describe('heavyBudgetMs', () => {
  it('uses what is left of the total budget, never more than the heavy cap', () => {
    const plan = { heavyMs: HEAVY_DEADLINE_MS };
    expect(heavyBudgetMs(plan, 50)).toBe(HEAVY_DEADLINE_MS);
    expect(heavyBudgetMs(plan, TOTAL_BUDGET_MS - 300)).toBe(300);
    expect(heavyBudgetMs(plan, TOTAL_BUDGET_MS + 500)).toBe(0);
  });
});

describe('window result helpers', () => {
  it('knows when the window tool failed', () => {
    expect(windowCallFailed('(could not get active window)')).toBe(true);
    expect(windowCallFailed('(get_active_window error: boom)')).toBe(true);
    expect(windowCallFailed('(no active window)')).toBe(false);
    expect(windowCallFailed('<screen-context-timeout>')).toBe(true);
    expect(windowCallFailed('')).toBe(true);
    expect(windowCallFailed(undefined)).toBe(true);
    expect(windowCallFailed('{"processName":"chrome"}')).toBe(false);
  });
  it('extracts the process name from either shape', () => {
    expect(extractProcessName('{"processName":"EXCEL","title":"x"}')).toBe('EXCEL');
    expect(extractProcessName('{"app":"Safari","pid":1}')).toBe('Safari');
    expect(extractProcessName('(no active window)')).toBe('');
    expect(extractProcessName('{}')).toBe('');
  });
});

describe('raceDeadline', () => {
  it('returns the value when it wins', async () => {
    expect(await raceDeadline(Promise.resolve(7), 1000)).toEqual({ timedOut: false, value: 7 });
  });
  it('times out when the work is slower, without leaving a timer behind', async () => {
    vi.useFakeTimers();
    const never = new Promise<number>(() => { /* hangs */ });
    const p = raceDeadline(never, 500);
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toEqual({ timedOut: true });
    vi.useRealTimers();
  });
  it('propagates a rejection', async () => {
    await expect(raceDeadline(Promise.reject(new Error('x')), 1000)).rejects.toThrow('x');
  });
});

describe('isScreenQuestion', () => {
  it.each([
    'summarize what I have on my screen', "what's on my screen", 'what am I looking at', 'what app am I on',
    'which app is this', "can you see my desktop", 'read this page', 'summarize this', 'what does this error mean',
    'look at this', 'o que tem na minha tela', 'qué hay en mi pantalla', "qu'est-ce qu'il y a sur mon écran",
  ])('true: %s', (t) => expect(isScreenQuestion(t)).toBe(true));
  it.each([
    "what's the weather like today", 'hi', 'lol', 'draw a stickfigure in paint', 'tell me a joke', 'what is the capital of France',
  ])('false: %s', (t) => expect(isScreenQuestion(t)).toBe(false));
  it('OCR budget is 3 s', () => expect(SCREEN_Q_OCR_MS).toBe(3000));
});

describe('formatScreenDump', () => {
  const dump = {
    windows: [
      { handle: 1, title: 'Old', processName: 'notepad', processId: 5, isMinimized: true },
      { handle: 2, title: 'Inbox - Mail', processName: 'chrome', processId: 7, bounds: { x: 0 }, isMinimized: false },
    ],
    focusedProcessId: 7,
    uiTree: { name: 'Inbox - Mail', children: [{ name: 'Send', children: [{ name: 'a' }, { name: 'Send' }] }, [{ name: 'Compose' }, { name: '' }]] },
  };
  it('lists windows (non-minimized first) then the focused app names, deduped, no handles', () => {
    const out = formatScreenDump(JSON.stringify(dump));
    expect(out).toBe('Open windows: Inbox - Mail (chrome); Old (notepad)\nIn chrome: Inbox - Mail · Send · Compose');
    expect(out).not.toContain('handle');
  });
  it('accepts an array uiTree, caps windows at 8 and titles at 60 chars', () => {
    const windows = Array.from({ length: 12 }, (_, i) => ({ title: `${'T'.repeat(80)}${i}`, processName: 'p', processId: i }));
    const out = formatScreenDump(JSON.stringify({ windows, focusedProcessId: 99, uiTree: [{ name: 'Hello' }] }), 5000);
    expect(out.split('; ')).toHaveLength(8);
    expect(out).toContain(`${'T'.repeat(60)} (p)`);
    expect(out).toContain('In the focused app: Hello');
  });
  it('caps the whole result', () => {
    expect(formatScreenDump(JSON.stringify(dump), 40)).toHaveLength(40);
  });
  it('non-JSON is sliced, errors give empty', () => {
    expect(formatScreenDump('plain text here', 5)).toBe('plain');
    expect(formatScreenDump('{"error":"boom"}')).toBe('');
  });
});

describe('formatOcrContext', () => {
  it('collapses whitespace and caps', () => {
    expect(formatOcrContext('chrome', 'a  b\n\nc')).toBe('Screen text (read from chrome): a b c');
    expect(formatOcrContext('chrome', 'x'.repeat(5000))).toHaveLength(1500);
  });
});
