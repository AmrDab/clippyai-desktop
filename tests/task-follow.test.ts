import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTaskFollow, TASK_FRONT_INTERVAL_MS, type TaskFollowWindow } from '../src/main/task-follow';

function fakeWin() {
  const calls: string[] = [];
  const w = {
    visible: true,
    calls,
    isDestroyed: () => false,
    isVisible: () => w.visible,
    showInactive: () => { calls.push('showInactive'); w.visible = true; },
    moveTop: () => { calls.push('moveTop'); },
    setAlwaysOnTop: (f: boolean, l?: string) => { calls.push(`aot:${f}:${l}`); },
    setVisibleOnAllWorkspaces: (v: boolean, o?: object) => { calls.push(`allspaces:${JSON.stringify(o)}`); },
    // Present on a real BrowserWindow; task-follow must never call it (owner: don't follow the cursor).
    setBounds: () => { calls.push('setBounds'); },
  };
  return w;
}

describe('task-follow: stays in front during a task, never moves', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make(platform = 'win32') {
    const fm = { active: false, stopped: 0, resumed: 0 };
    const tf = createTaskFollow({
      platform,
      followMeActive: () => fm.active,
      followMeStop: () => { fm.stopped++; fm.active = false; },
      followMeResume: () => { fm.resumed++; fm.active = true; },
    });
    return { tf, fm };
  }

  it('raises without stealing focus, keeps him in front, never moves him, and leaves no timer after end()', () => {
    const { tf } = make();
    const w = fakeWin();
    w.visible = false;
    tf.begin(w as unknown as TaskFollowWindow);
    expect(w.calls).toContain('aot:true:screen-saver');
    expect(w.calls).toContain('showInactive');
    expect(w.calls).toContain('moveTop');
    expect(tf.isActive()).toBe(true);
    const before = w.calls.filter((c) => c === 'moveTop').length;
    vi.advanceTimersByTime(TASK_FRONT_INTERVAL_MS * 5);
    expect(w.calls.filter((c) => c === 'moveTop').length).toBeGreaterThan(before); // re-asserted
    expect(w.calls).not.toContain('setBounds');
    tf.end();
    expect(tf.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const n = w.calls.length;
    vi.advanceTimersByTime(5000);
    expect(w.calls.length).toBe(n);
  });

  it('pauses the user cursor-follow during the task and resumes it after', () => {
    const { tf, fm } = make();
    fm.active = true;
    tf.begin(fakeWin() as unknown as TaskFollowWindow);
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
    const mac = make('darwin');
    const w = fakeWin();
    mac.tf.begin(w as unknown as TaskFollowWindow);
    expect(w.calls.some((c) => c.startsWith('allspaces:') && c.includes('"skipTransformProcessType":true') && c.includes('"visibleOnFullScreen":true'))).toBe(true);
    mac.tf.end();
    const win = make('win32');
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
    vi.advanceTimersByTime(TASK_FRONT_INTERVAL_MS);
    expect(tf.isActive()).toBe(false);
  });
});
