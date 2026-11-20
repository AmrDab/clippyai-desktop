import { describe, it, expect, vi } from 'vitest';
import { AbortRegistry, abortableDelay } from '../src/main/turn-abort';

describe('AbortRegistry', () => {
  it('aborts every registered wait once, and forgets them', () => {
    const reg = new AbortRegistry();
    const a = vi.fn();
    const b = vi.fn();
    reg.add(a);
    reg.add(b);
    expect(reg.abortAll()).toBe(2);
    expect(reg.abortAll()).toBe(0);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('a wait that ended on its own is not aborted later', () => {
    const reg = new AbortRegistry();
    const a = vi.fn();
    const remove = reg.add(a);
    remove();
    expect(reg.size).toBe(0);
    reg.abortAll();
    expect(a).not.toHaveBeenCalled();
  });

  it('one abort that throws does not keep the others alive', () => {
    const reg = new AbortRegistry();
    const b = vi.fn();
    reg.add(() => { throw new Error('boom'); });
    reg.add(b);
    expect(() => reg.abortAll()).not.toThrow();
    expect(b).toHaveBeenCalled();
  });
});

describe('abortableDelay', () => {
  it('Stop ends a 60 s wait at once (the retry back-off, the request)', async () => {
    const reg = new AbortRegistry();
    const started = Date.now();
    const p = abortableDelay(60_000, reg);
    reg.abortAll();
    expect(await p).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(reg.size).toBe(0);
  });

  it('runs its full time when nothing cancels, then unregisters', async () => {
    const reg = new AbortRegistry();
    expect(await abortableDelay(10, reg)).toBe(true);
    expect(reg.size).toBe(0);
  });
});
