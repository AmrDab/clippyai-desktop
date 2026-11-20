import { describe, it, expect, vi } from 'vitest';
import { replyOrSpeak, EMPTY_REPLY, FAILED_REPLY } from '../src/main/user-message-reply';

describe('replyOrSpeak — the bubble only shows what is spoken', () => {
  it('a normal reply is returned and not spoken a second time', async () => {
    const speak = vi.fn();
    expect(await replyOrSpeak(async () => 'Done!', speak)).toBe('Done!');
    expect(speak).not.toHaveBeenCalled();
  });

  it('an empty reply speaks the fallback (it used to be returned to nobody)', async () => {
    const speak = vi.fn();
    expect(await replyOrSpeak(async () => '', speak)).toBe(EMPTY_REPLY);
    expect(speak).toHaveBeenCalledWith({ text: EMPTY_REPLY, animate: 'Alert' });
  });

  it('a throw is logged and speaks the error line', async () => {
    const speak = vi.fn();
    const onError = vi.fn();
    const boom = new Error('boom');
    expect(await replyOrSpeak(async () => { throw boom; }, speak, onError)).toBe(FAILED_REPLY);
    expect(onError).toHaveBeenCalledWith(boom);
    expect(speak).toHaveBeenCalledWith({ text: FAILED_REPLY, animate: 'Alert', tint: 'error' });
  });
});
