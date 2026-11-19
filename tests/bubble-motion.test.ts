import { describe, it, expect, vi } from 'vitest';
import { typeTotalMs, typedText, hasMarkdown, splitBanner, DeferredCollapse, shouldAutoMinimize, TYPE_MAX_MS, EXIT_MS, RECOIL_MS } from '../src/renderer/bubble-motion';

describe('typewriter', () => {
  it('types a short line at 18 ms per character', () => {
    expect(typeTotalMs('x'.repeat(20))).toBe(360);
  });
  it('never takes longer than 600 ms, however long the reply', () => {
    expect(typeTotalMs('x'.repeat(400))).toBe(TYPE_MAX_MS);
    expect(typedText('x'.repeat(400), TYPE_MAX_MS)).toHaveLength(400);
    expect(typedText('x'.repeat(400), 300)).toHaveLength(200);
  });
  it('starts empty and ends complete', () => {
    expect(typedText('hello', 0)).toBe('');
    expect(typedText('hello', 10_000)).toBe('hello');
    expect(typedText('', 100)).toBe('');
  });
  it('never splits an emoji (code points, not UTF-16 units)', () => {
    const text = 'v1.2 is available! 📎';
    for (let ms = 0; ms <= 600; ms += 7) {
      const part = typedText(text, ms);
      expect(part).not.toContain('�');
      expect(/[\uD800-\uDBFF]$/.test(part)).toBe(false); // no dangling high surrogate
      expect(text.startsWith(part)).toBe(true);
    }
    expect(typedText(text, 10_000)).toBe(text);
    expect(Array.from(typedText('📎📎📎', 18 * 3 - 1))).toHaveLength(3);
  });
});

describe('hasMarkdown', () => {
  it('spots bold, code and list lines', () => {
    expect(hasMarkdown('this is **bold**')).toBe(true);
    expect(hasMarkdown('run `npm test`')).toBe(true);
    expect(hasMarkdown('intro\n- one\n- two')).toBe(true);
    expect(hasMarkdown('plain sentence - with a dash')).toBe(false);
    expect(hasMarkdown('Sent!')).toBe(false);
  });
});

describe('splitBanner', () => {
  it('takes the first line as the title', () => {
    expect(splitBanner('I just updated to **v1.2**! What is new:\n- one\n- two'))
      .toEqual({ title: 'I just updated to **v1.2**! What is new:', body: '- one\n- two' });
  });
  it('else the first short sentence', () => {
    expect(splitBanner('I have an update ready (v1.2). It takes about 20 seconds.'))
      .toEqual({ title: 'I have an update ready (v1.2).', body: 'It takes about 20 seconds.' });
  });
  it('keeps an approval question whole, even with a full stop inside the bold part', () => {
    expect(splitBanner('Can I **open notes.txt**?')).toEqual({ title: 'Can I **open notes.txt**?', body: '' });
    expect(splitBanner('Can I **email Dr. Smith the file**?')).toEqual({ title: 'Can I **email Dr. Smith the file**?', body: '' });
    expect(splitBanner('Can I **run `a. b` now**?').body).toBe('');
  });
  it('never leaves a body with no words', () => {
    expect(splitBanner('v1.2 is ready! 📎')).toEqual({ title: 'v1.2 is ready! 📎', body: '' });
  });
});

describe('DeferredCollapse', () => {
  it('collapses after the exit fade', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const c = new DeferredCollapse(run);
    c.schedule();
    expect(c.pending).toBe(true);
    vi.advanceTimersByTime(EXIT_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(c.pending).toBe(false);
    vi.useRealTimers();
  });
  it('cancel (a show during the fade) means the window never collapses', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const c = new DeferredCollapse(run);
    c.schedule();
    vi.advanceTimersByTime(100);
    c.cancel();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it('a second hide restarts the wait instead of stacking timers', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const c = new DeferredCollapse(run);
    c.schedule();
    vi.advanceTimersByTime(100);
    c.schedule();
    vi.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(run).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  it('calls the timer functions unbound (Chromium throws Illegal invocation when this is the instance)', () => {
    const strict = function (this: unknown): never | number {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      return 1;
    };
    const c = new DeferredCollapse(vi.fn(), 10, strict as never, strict as never);
    expect(() => c.schedule()).not.toThrow();
    expect(() => c.cancel()).not.toThrow();
  });
});

describe('auto-minimize (shouldAutoMinimize)', () => {
  const idle = { idleMs: 30_000, autoHideMs: 30_000, pinned: false, hover: false, fieldFocused: false, draft: '', busy: false, waitingForUser: false };
  it('minimizes after the auto-hide setting of idle', () => {
    expect(shouldAutoMinimize(idle)).toBe(true);
    expect(shouldAutoMinimize({ ...idle, idleMs: 29_999 })).toBe(false);
  });
  it('0 = manual: never', () => {
    expect(shouldAutoMinimize({ ...idle, autoHideMs: 0, idleMs: 9e9 })).toBe(false);
  });
  it.each([
    ['hover', { hover: true }],
    ['the caret in the field', { fieldFocused: true }],
    ['a draft', { draft: 'half a thought' }],
    ['a running task', { busy: true }],
    ['a pending approval', { waitingForUser: true }],
    ['a pinned bubble', { pinned: true }],
  ])('%s keeps it open', (_what, over) => {
    expect(shouldAutoMinimize({ ...idle, idleMs: 9e9, ...over })).toBe(false);
  });
  it('a whitespace-only draft is not a draft', () => {
    expect(shouldAutoMinimize({ ...idle, draft: '  \n' })).toBe(true);
  });
  it('the recoil outlasts the plain exit, so the window shrinks after it', () => {
    expect(RECOIL_MS).toBeGreaterThan(EXIT_MS);
    expect(RECOIL_MS).toBeLessThanOrEqual(200);
  });
});
