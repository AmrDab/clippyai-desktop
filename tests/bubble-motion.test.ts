import { describe, it, expect, vi } from 'vitest';
import { typeTotalMs, typedText, hasMarkdown, DeferredCollapse, TYPE_MAX_MS, EXIT_MS } from '../src/renderer/bubble-motion';

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
});
