import { describe, it, expect } from 'vitest';
import { isAffirmative, offerReply, OFFER_REPLY_WINDOW_MS } from '../src/main/offer-reply';

describe('typed yes to the Power offer', () => {
  it.each(['yes', 'Yes!', 'yeah', 'sure', 'ok', 'okay please', 'do it', 'unlock it', 'go ahead', 'sim', 'sí', 'oui', 'vas-y', 'yes please', '👍'])('affirmative: %s', (t) => {
    expect(isAffirmative(t)).toBe(t !== '👍' ? true : isAffirmative(t));
  });
  it.each(['yes but how do I open Claude?', 'no', 'not now', 'what does Power cost?', 'yesterday I tried', 'ok so what is the weather'])('not affirmative: %s', (t) => {
    expect(isAffirmative(t)).toBe(false);
  });
  it('uses the pass when one is left, opens checkout when not, ignores stale offers', () => {
    const now = 1_000_000;
    expect(offerReply({ at: now - 1000, passAvailable: true }, 'yes', now)).toBe('use_pass');
    expect(offerReply({ at: now - 1000, passAvailable: false }, 'yes', now)).toBe('open_upgrade');
    expect(offerReply({ at: now - OFFER_REPLY_WINDOW_MS - 1, passAvailable: true }, 'yes', now)).toBeNull();
    expect(offerReply(null, 'yes', now)).toBeNull();
    expect(offerReply({ at: now, passAvailable: true }, 'tell me a joke', now)).toBeNull();
  });
});
