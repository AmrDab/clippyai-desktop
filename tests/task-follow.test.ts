import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { taskFollowTarget, coversPoint, createTaskFollow, TASK_FOLLOW_GAP, TASK_FOLLOW_INTERVAL_MS, type TaskFollowWindow } from '../src/main/task-follow';

const wa = { x: 0, y: 0, width: 1920, height: 1040 };
const size = { width: 140, height: 110 };

describe('taskFollowTarget', () => {
  it('parks bottom-right of the cursor with a gap', () => {
    const t = taskFollowTarget({ x: 500, y: 400 }, size, wa);
    expect(t).toEqual({ x: 500 + TASK_FOLLOW_GAP, y: 400 + TASK_FOLLOW_GAP });
  });
  it('never covers the cursor, in any corner of the screen', () => {
    for (const c of [{ x: 5, y: 5 }, { x: 1915, y: 5 }, { x: 5, y: 1035 }, { x: 1915, y: 1035 }, { x: 960, y: 520 }]) {
      const t = taskFollowTarget(c, size, wa);
      expect(coversPoint({ ...t, ...size }, c)).toBe(false);
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x + size.width).toBeLessThanOrEqual(1920);
      expect(t.y + size.height).toBeLessThanOrEqual(1040);
    }
  });
  it('stays on-screen and clear near the right edge (drops below the cursor)', () => {
    const t = taskFollowTarget({ x: 1900, y: 400 }, size, wa);
    expect(t.x + size.width).toBeLessThanOrEqual(1920);
    expect(coversPoint({ ...t, ...size }, { x: 1900, y: 400 })).toBe(false);
  });
  it('respects a secondary display with negative origin', () => {
    const left = { x: -2560, y: 0, width: 2560, height: 1400 };
    const t = taskFollowTarget({ x: -10, y: 700 }, size, left);
    expect(t.x).toBeGreaterThanOrEqual(-2560);
    expect(t.x + size.width).toBeLessThanOrEqual(0);
    expect(coversPoint({ ...t, ...size }, { x: -10, y: 700 })).toBe(false);
  });
});

function fakeWin(b = { x: 100, y: 100, width: 140, height: 110 }) {
  const calls: string[] = [];
  const w = {
    bounds: { ...b },
    visible: true,
    calls,
    isDestroyed: () => false,
    isVisible: () => w.visible,
    showInactive: () => { calls.push('showInactive'); w.visible = true; },
    moveTop: () => { calls.push('moveTop'); },
    setAlwaysOnTop: (f: boolean, l?: string) => { calls.push(`aot:${f}:${l}`); },
    setVisibleOnAllWorkspaces: (v: boolean, o?: object) => { calls.push(`allspaces:${JSON.stringify(o)}`); },
    getBounds: () => ({ ...w.bounds }),
    setBounds: (r: typeof b) => { w.bounds = { ...r }; calls.push('setBounds'); },
  };
  return w;
}

describe('createTaskFollow lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make(over: Partial<Parameters<typeof createTaskFollow>[0]> = {}) {
    const cursor = { x: 800, y: 500 };
    const fm = { active: false, stopped: 0, resumed: 0 };
    const tf = createTaskFollow({
      cursor: () => cursor,
      workAreaNear: () => wa,
      platform: 'win32',
      followMeActive: () => fm.active,
      followMeStop: () => { fm.stopped++; fm.active = false; },
      followMeResume: () => { fm.resumed++; fm.active = true; },
      ...over,
    });
    return { tf, cursor, fm };
  }

  it('raises (no focus steal), follows, and leaves no timer after end()', () => {
    const { tf, cursor } = make();
    const w = fakeWin();
    w.visible = false;
    tf.begin(w as unknown as TaskFollowWindow, { easing: 0.5 });
    expect(w.calls).toContain('aot:true:screen-saver');
    expect(w.calls).toContain('showInactive');
    expect(w.calls).toContain('moveTop');
    expect(tf.isActive()).toBe(true);
    for (let i = 0; i < 30; i++) vi.advanceTimersByTime(TASK_FOLLOW_INTERVAL_MS);
    expect(w.bounds.x).toBe(cursor.x + TASK_FOLLOW_GAP);
    expect(w.bounds.y).toBe(cursor.y + TASK_FOLLOW_GAP);
    tf.end();
    expect(tf.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const n = w.calls.length;
    vi.advanceTimersByTime(1000);
    expect(w.calls.length).toBe(n);
  });

  it('steps aside immediately when the cursor jumps onto him', () => {
    const { tf, cursor } = make();
    const w = fakeWin({ x: 790, y: 490, width: 140, height: 110 });
    tf.begin(w as unknown as TaskFollowWindow, { easing: 0.05 });
    vi.advanceTimersByTime(TASK_FOLLOW_INTERVAL_MS);
    expect(coversPoint(w.bounds, cursor)).toBe(false);
  });

  it('pauses the user cursor-follow during the task and resumes it after', () => {
    const { tf, fm } = make();
    fm.active = true;
    const w = fakeWin();
    tf.begin(w as unknown as TaskFollowWindow);
    expect(fm.stopped).toBe(1);
    tf.end();
    expect(fm.resumed).toBe(1);
  });

  it('does not resume follow-me when it was not running', () => {
    const { tf, fm } = make();
    tf.begin(fakeWin() as unknown as TaskFollowWindow);
    tf.end();
    expect(fm.stopped).toBe(0);
    expect(fm.resumed).toBe(0);
  });

  it('joins all Spaces on macOS only, without transforming the process type', () => {
    const mac = make({ platform: 'darwin' });
    const w = fakeWin();
    mac.tf.begin(w as unknown as TaskFollowWindow);
    expect(w.calls.some((c) => c.startsWith('allspaces:') && c.includes('"skipTransformProcessType":true') && c.includes('"visibleOnFullScreen":true'))).toBe(true);
    mac.tf.end();
    const win = make({ platform: 'win32' });
    const w2 = fakeWin();
    win.tf.begin(w2 as unknown as TaskFollowWindow);
    expect(w2.calls.some((c) => c.startsWith('allspaces:'))).toBe(false);
    win.tf.end();
  });

  it('is idempotent and self-cleans if the window is destroyed', () => {
    const { tf } = make();
    const w = fakeWin();
    tf.begin(w as unknown as TaskFollowWindow);
    tf.begin(w as unknown as TaskFollowWindow);
    expect(vi.getTimerCount()).toBe(1);
    w.isDestroyed = () => true;
    vi.advanceTimersByTime(TASK_FOLLOW_INTERVAL_MS);
    expect(tf.isActive()).toBe(false);
  });
});
