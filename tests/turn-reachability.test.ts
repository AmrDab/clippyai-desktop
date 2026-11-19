import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { watchReachability, REACH_CHECK_AFTER_MS } from '../src/main/turn-reachability';

describe('turn-reachability: fail fast when the server is down', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not probe before the check delay', () => {
    const probe = vi.fn(async () => true);
    watchReachability({ probe, onUnreachable: vi.fn() });
    vi.advanceTimersByTime(REACH_CHECK_AFTER_MS - 1);
    expect(probe).not.toHaveBeenCalled();
  });

  it('ends the turn when the probe fails or throws', async () => {
    for (const probe of [async () => false, async () => { throw new Error('ENOTFOUND'); }]) {
      const onUnreachable = vi.fn();
      watchReachability({ probe, onUnreachable });
      await vi.advanceTimersByTimeAsync(REACH_CHECK_AFTER_MS);
      expect(onUnreachable).toHaveBeenCalledTimes(1);
    }
  });

  it('leaves a slow turn alone when the server answers', async () => {
    const onUnreachable = vi.fn();
    watchReachability({ probe: async () => true, onUnreachable });
    await vi.advanceTimersByTimeAsync(REACH_CHECK_AFTER_MS);
    expect(onUnreachable).not.toHaveBeenCalled();
  });

  it('never fires after cancel, even with a probe already in flight', async () => {
    let finish!: (ok: boolean) => void;
    const onUnreachable = vi.fn();
    const cancel = watchReachability({ probe: () => new Promise<boolean>((r) => { finish = r; }), onUnreachable });
    await vi.advanceTimersByTimeAsync(REACH_CHECK_AFTER_MS);
    cancel();
    finish(false);
    await vi.runAllTimersAsync();
    expect(onUnreachable).not.toHaveBeenCalled();
    const onUnreachable2 = vi.fn();
    watchReachability({ probe: async () => false, onUnreachable: onUnreachable2 })();
    await vi.advanceTimersByTimeAsync(REACH_CHECK_AFTER_MS);
    expect(onUnreachable2).not.toHaveBeenCalled();
  });
});
